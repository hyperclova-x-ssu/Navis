import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import pg, { type Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { loadReferences } from '../../../../frontend/server/promo/references.mjs';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { inStore } from '../transaction.ts';
import type { PromoArtifacts } from './contracts.ts';
import { registerPromoRoutes } from './routes.ts';

const storeId = randomUUID();
const actorId = randomUUID();
const token = randomUUID();
const headers = { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
  'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' };
const path = `/internal/v1/marketing/stores/${storeId}/promo/references`;
const refs = loadReferences();
const legacy: PromoArtifacts = {
  put: vi.fn(async () => 'legacy'),
  read: vi.fn(async () => ({ bytes: Buffer.from('previous local bytes'), mime: 'video/mp4' })),
};

test('requires a store owner and plays bundled galleries when object storage is off', async () => {
  const app = Fastify();
  registerPromoRoutes(app, {} as Pool, { readToken: token, references: refs, artifacts: legacy });
  try {
    const list = await app.inject({ url: path, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().references[0]).toMatchObject({ id: 'ref-1',
      previewUrl: `/api/v1/stores/${storeId}/promo/references/ref-1/preview.mp4` });
    const url = `${path}/ref-1/preview.mp4`;
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { ...headers, 'x-navis-store-id': randomUUID() } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: { ...headers, 'x-navis-store-role': 'staff' } })).statusCode).toBe(403);
    const expected = await readFile(refs.refs.get('ref-1')!.previewPath);
    const video = await app.inject({ url, headers: { ...headers, range: 'bytes=4-10' } });
    expect(video.statusCode).toBe(206);
    expect(video.headers['content-range']).toBe(`bytes 4-10/${expected.length}`);
    expect(video.rawPayload).toEqual(expected.subarray(4, 11));
  } finally { await app.close(); }
});

test('protects generated poster and scene downloads with the existing job credential', async () => {
  const app = Fastify();
  registerPromoRoutes(app, {} as Pool, { readToken: token, references: refs, artifacts: legacy });
  try {
    const job = `/internal/v1/marketing/stores/${storeId}/promo/jobs/${randomUUID()}`;
    expect((await app.inject(`${job}/poster.jpg`)).statusCode).toBe(401);
    expect((await app.inject({ url: `${job}/scene.html`, headers: { ...headers, 'x-navis-store-role': 'staff' } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

export function fakeObjectStorage(): ObjectStorage & { objects: Map<string, { bytes: Buffer; mime: string }> } {
  const objects = new Map<string, { bytes: Buffer; mime: string }>();
  return {
    objects,
    async put(key, bytes, mime) { objects.set(key, { bytes: Buffer.from(bytes), mime }); },
    async get(key) {
      const object = objects.get(key);
      if (!object) return;
      return { body: Readable.from([object.bytes]), contentLength: object.bytes.length, contentType: object.mime };
    },
    async getRange(key, range) {
      const object = objects.get(key);
      if (!object) return;
      const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(startText), end = Number(endText);
      return { body: Readable.from([object.bytes.subarray(start, end + 1)]), contentLength: end - start + 1,
        contentType: object.mime, contentRange: `bytes ${start}-${end}/${object.bytes.length}` };
    },
    async remove(key) { objects.delete(key); },
  };
}

test.runIf(Boolean(process.env.NAVIS_OBJ_MEDIA_TEST_DB_URL))('persists job and gallery objects across adapters and scopes', async () => {
  const { backfillPromoJobMedia, createPromoMedia, seedPromoFixtureMedia } = await import('./media.ts');
  const pool = new pg.Pool({ connectionString: process.env.NAVIS_OBJ_MEDIA_TEST_DB_URL });
  const storage = fakeObjectStorage();
  const jobId = randomUUID();
  const scope = { storeId, resourceId: jobId };
  const video = Buffer.from('video bytes');
  try {
    await inStore(pool, storeId, db => db.query(`
      INSERT INTO marketing.promo_job (store_id, job_id, actor_id, action_key, request_hash, input, catalog_snapshot)
      VALUES ($1, $2, $3, $4, repeat('0', 64), '{}', '{}')`, [storeId, jobId, actorId, randomUUID()]));
    const first = createPromoMedia(pool, storage);
    const artifacts = first.artifacts(legacy);
    const fileId = await artifacts.put(scope, 'video-lease', 'promo_output', 'video/mp4', video);
    expect(await artifacts.put(scope, 'video-lease', 'promo_output', 'video/mp4', video)).toBe(fileId);
    await expect(artifacts.put(scope, 'video-lease', 'promo_output', 'video/mp4', Buffer.from('changed'))).rejects.toThrow();
    const restarted = createPromoMedia(pool, storage).artifacts(legacy);
    expect(await restarted.read(scope, fileId)).toEqual({ bytes: video, mime: 'video/mp4' });
    expect(await restarted.read(scope, randomUUID())).toEqual({ bytes: Buffer.from('previous local bytes'), mime: 'video/mp4' });
    expect(storage.objects.size).toBe(1);
    expect([...storage.objects.keys()][0]).toMatch(new RegExp(`^stores/${storeId}/promo/jobs/${jobId}/`));

    const poster = Buffer.from('jpeg bytes');
    const scene = Buffer.from('<!doctype html><title>local render</title>');
    const posterAssetId = await first.putArtifact(scope, 'poster-lease', 'promo_poster', 'image/jpeg', poster);
    const sceneAssetId = await first.putArtifact(scope, 'scene-lease', 'promo_scene', 'application/octet-stream', scene);
    const checkpointId = randomUUID();
    const checkpoint = Buffer.from(JSON.stringify({ html: scene.toString() }));
    await inStore(pool, storeId, db => db.query(`
      UPDATE marketing.promo_job SET status = 'done', finished_at = now(), asset_id = $3, result = $4
      WHERE store_id = $1 AND job_id = $2`, [storeId, jobId, fileId, { sizeBytes: video.length, posterAssetId, sceneAssetId }]));
    await inStore(pool, storeId, db => db.query(`
      INSERT INTO marketing.promo_checkpoint (store_id, job_id, stage, asset_id) VALUES ($1, $2, 'scenes', $3)`, [storeId, jobId, checkpointId]));
    const legacyCheckpoint = { async read() { return { bytes: checkpoint, mime: 'application/json' }; } };
    expect(await backfillPromoJobMedia(pool, storage, legacyCheckpoint, storeId)).toBe(1);
    expect(await backfillPromoJobMedia(pool, storage, legacyCheckpoint, storeId)).toBe(0);
    expect(await restarted.read(scope, checkpointId)).toEqual({ bytes: checkpoint, mime: 'application/json' });

    const gallery = Buffer.from('fixture clip');
    await seedPromoFixtureMedia(pool, storage, storeId, [{ name: 'reference/ref-1/preview.mp4', mime: 'video/mp4', bytes: gallery }]);
    const app = Fastify();
    registerPromoRoutes(app, pool, { readToken: token, references: refs, artifacts: legacy, objectStorage: storage });
    try {
      const job = `/internal/v1/marketing/stores/${storeId}/promo/jobs/${jobId}`;
      expect((await app.inject({ url: `${job}/video.mp4`, headers })).rawPayload).toEqual(video);
      expect((await app.inject({ url: `${job}/poster.jpg`, headers })).rawPayload).toEqual(poster);
      const html = await app.inject({ url: `${job}/scene.html`, headers });
      expect(html.rawPayload).toEqual(scene);
      expect(html.headers['content-type']).toBe('application/octet-stream');
      expect(html.headers['content-disposition']).toMatch(/^attachment;/);
      const url = `${path}/ref-1/preview.mp4`;
      const ranged = await app.inject({ url, headers: { ...headers, range: 'bytes=-4' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.rawPayload).toEqual(Buffer.from('clip'));
      expect(ranged.headers['content-range']).toBe('bytes 8-11/12');
      const another = randomUUID();
      expect((await app.inject({ url: url.replace(storeId, another), headers: { ...headers, 'x-navis-store-id': another } })).statusCode).toBe(404);
      const unknown = await app.inject({ url: `${path}/ref-1/wrong.mp4`, headers });
      expect(unknown.statusCode).toBe(404);
    } finally { await app.close(); }
  } finally { await pool.end(); }
});
