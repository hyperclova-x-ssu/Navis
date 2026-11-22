import { expect, it, vi } from 'vitest';
import { createNcpPromoStorage } from './ncp-storage.ts';

const env = { NAVIS_NCP_OBJECT_STORAGE_PROVIDER: 'live', NAVIS_NCP_SECRETS_DIR: '/fake' };
const values: Record<string, string> = { NCP_ACCESS_KEY: 'fake-access', NCP_SECRET_KEY: 'fake-secret', NCP_OBJECT_STORAGE_BUCKET: 'navis-test' };
const read = (path: string) => values[path.split('/').at(-1)!];
const now = () => new Date('2026-11-22T01:00:00Z');
const storeId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';

it('leaves Object Storage off and reads no files by default', () => {
  const load = vi.fn();
  expect(createNcpPromoStorage({}, { read: load })).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  expect(createNcpPromoStorage(env, { read: () => undefined })).toBeUndefined();
});

it('signs private put, read, and delete against the Korean path-style endpoint', async () => {
  const bytes = Buffer.from('clip');
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null))
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const storage = createNcpPromoStorage(env, { read, fetcher, now })!;
  await storage.write(artifactId, bytes, { storeId, mime: 'video/mp4' });
  await expect(storage.read(artifactId, { storeId })).resolves.toEqual(bytes);
  await storage.remove(artifactId, { storeId });
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toBe(`https://kr.object.ncloudstorage.com/navis-test/promo/${storeId}/${artifactId}`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toContain('/20261122/kr-standard/s3/aws4_request');
    expect(headers.get('x-amz-acl')).toBeNull();
    expect(init?.redirect).toBe('error');
  }
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET', 'DELETE']);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('content-type')).toBe('video/mp4');
});
