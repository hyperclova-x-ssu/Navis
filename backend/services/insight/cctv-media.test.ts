import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import pg, { type Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import type { ObjectStorage } from '../../packages/object-storage/index.ts';
import { createInsightApp } from './app.ts';

const storeId = randomUUID();
const token = randomUUID();
const path = `/internal/v1/insight/stores/${storeId}/insight/cctv-samples/store-sample.mp4`;
const headers = { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
  'x-navis-user-id': randomUUID(), 'x-navis-store-role': 'owner' };

test('keeps the CCTV sample bundled in storage off mode and protects the route', async () => {
  vi.stubEnv('NAVIS_OBJECT_STORAGE_MODE', 'off');
  const app = createInsightApp({} as Pool, { gatewayToken: token, logging: false });
  try {
    expect((await app.inject(path)).statusCode).toBe(401);
    expect((await app.inject({ url: path, headers: { ...headers, 'x-navis-store-role': 'staff' } })).statusCode).toBe(403);
    const off = await app.inject({ url: path, headers });
    expect(off.statusCode).toBe(404);
    expect(off.json()).toEqual({ code: 'CCTV_SAMPLE_BUNDLED' });
  } finally {
    vi.unstubAllEnvs();
    await app.close();
  }
});

test('serves a private conditional response and rejects invalid ranges before accessing the bucket', async () => {
  const bytes = Buffer.from('cctv example');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const row = { object_key: 'catalog-clip', sha256, bytes: bytes.length, content_type: 'video/mp4' };
  const client = { query: async (sql: string) => ({ rows: sql.includes('FROM insight.cctv_sample_media') ? [row] : [] }), release() {} };
  const pool = { connect: async () => client } as unknown as Pool;
  const storage: ObjectStorage = {
    put: vi.fn(), remove: vi.fn(), getRange: vi.fn(),
    get: vi.fn(async () => ({ body: Readable.from([bytes]), contentLength: bytes.length, contentType: 'video/mp4' })),
  };
  const app = createInsightApp(pool, { gatewayToken: token, logging: false, cctvObjectStorage: storage });
  try {
    const cached = await app.inject({ url: path, headers: { ...headers, 'if-none-match': `W/"${sha256}"` } });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers.etag).toBe(`"${sha256}"`);
    expect(cached.headers.vary).toBe('Authorization');
    expect(cached.headers['cache-control']).toBe('private, max-age=86400');
    expect(cached.body).toBe('');
    expect(storage.get).not.toHaveBeenCalled();

    for (const range of [`bytes=-${'9'.repeat(40)}`, 'bytes=-0', 'bytes=999-', 'bytes=0-1,3-4']) {
      const invalid = await app.inject({ url: path, headers: { ...headers, range } });
      expect(invalid.statusCode).toBe(416);
      expect(invalid.headers['content-range']).toBe(`bytes */${bytes.length}`);
    }
    expect(storage.getRange).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

test.runIf(Boolean(process.env.NAVIS_OBJ_MEDIA_INSIGHT_TEST_DB_URL))('streams the saved store sample and keeps other stores isolated', async () => {
  const { seedCctvSampleMedia } = await import('./cctv.ts');
  const pool = new pg.Pool({ connectionString: process.env.NAVIS_OBJ_MEDIA_INSIGHT_TEST_DB_URL });
  const clips = new Map<string, Buffer>();
  const storage: ObjectStorage = {
    async put(key, bytes) { clips.set(key, Buffer.from(bytes)); },
    async get(key) {
      const bytes = clips.get(key);
      if (bytes) return { body: Readable.from([bytes]), contentLength: bytes.length, contentType: 'video/mp4' };
    },
    async getRange(key, range) {
      const bytes = clips.get(key);
      if (bytes && range === 'bytes=1-3') return { body: Readable.from([bytes.subarray(1, 4)]), contentLength: 3,
        contentType: 'video/mp4', contentRange: `bytes 1-3/${bytes.length}` };
    },
    async remove(key) { clips.delete(key); },
  };
  const app = createInsightApp(pool, { gatewayToken: token, logging: false, cctvObjectStorage: storage });
  try {
    await seedCctvSampleMedia(pool, storage, storeId, 'store-sample.mp4', Buffer.from('cctv example'));
    const video = await app.inject({ url: path, headers: { ...headers, range: 'bytes=1-3' } });
    expect(video.statusCode).toBe(206);
    expect(video.body).toBe('ctv');
    expect(video.headers['content-range']).toBe('bytes 1-3/12');
    expect(video.headers['cache-control']).toBe('private, max-age=86400');
    const another = randomUUID();
    const inaccessible = await app.inject({ url: path.replace(storeId, another), headers: { ...headers, 'x-navis-store-id': another } });
    expect(inaccessible.statusCode).toBe(404);
    expect(inaccessible.json().code).toBe('NOT_FOUND');
    expect([...clips.keys()][0]).toMatch(new RegExp(`^stores/${storeId}/insight/cctv-samples/`));
  } finally { await app.close(); await pool.end(); }
});
