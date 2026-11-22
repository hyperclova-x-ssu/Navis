import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createObjectStorage } from './index.ts';

const env = {
  NAVIS_OBJECT_STORAGE_MODE: 's3',
  NAVIS_OBJECT_STORAGE_ENDPOINT: 'http://minio:9000',
  NAVIS_OBJECT_STORAGE_REGION: 'kr-standard',
  NAVIS_OBJECT_STORAGE_BUCKET: 'trial-bucket',
  NAVIS_OBJECT_STORAGE_ACCESS_KEY_FILE: '/fake/access',
  NAVIS_OBJECT_STORAGE_SECRET_KEY_FILE: '/fake/secret',
};

it('leaves storage off by default without reading secret files', () => {
  const read = vi.fn();
  expect(createObjectStorage({}, { read })).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(() => createObjectStorage({ ...env, NAVIS_OBJECT_STORAGE_BUCKET: 'invalid/bucket' }, { read })).toThrow();
  expect(read).not.toHaveBeenCalled();
});

it('signs path-style writes, streams full and partial reads, and treats a missing object as absent', async () => {
  const bytes = Buffer.from('stored bytes');
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request);
    if (request.method === 'PUT') return new Response();
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.url.endsWith('/missing')) return new Response('missing', { status: 404 });
    if (request.headers.get('range')) return new Response('stored', { status: 206, headers: {
      'content-length': '6', 'content-range': 'bytes 0-5/12', 'content-type': 'image/jpeg',
    } });
    return new Response(Uint8Array.from(bytes), { headers: { 'content-length': '12', 'content-type': 'image/jpeg' } });
  };
  const storage = createObjectStorage(env, { fetcher, read: () => 'fake-key', now: () => new Date('2026-11-22T12:00:00Z') })!;
  await storage.put('photos/café a.jpeg', bytes, 'image/jpeg');
  expect(calls[0].url).toBe('http://minio:9000/trial-bucket/photos/caf%C3%A9%20a.jpeg');
  expect(calls[0].headers.get('authorization')).toMatch(/\/20261122\/kr-standard\/s3\/aws4_request,/);
  expect(calls[0].redirect).toBe('error');
  expect(Buffer.from(await calls[0].arrayBuffer())).toEqual(bytes);
  const photo = await storage.get('photos/café a.jpeg');
  expect(photo).toMatchObject({ body: expect.any(Readable), contentLength: bytes.length, contentType: 'image/jpeg' });
  expect(await photo!.body.toArray().then(Buffer.concat)).toEqual(bytes);
  const partial = await storage.getRange('photos/café a.jpeg', 'bytes=0-5');
  expect(partial).toMatchObject({ contentLength: 6, contentRange: 'bytes 0-5/12' });
  expect((await partial!.body.toArray().then(Buffer.concat)).toString()).toBe('stored');
  expect(calls[2].headers.get('authorization')).toContain('range;');
  expect(await storage.get('missing')).toBeUndefined();
  await storage.remove('photos/café a.jpeg');
  await expect(storage.get('photos/../outside')).rejects.toThrow();
  await expect(storage.getRange('photos/single', 'bytes=0-3,5-6')).rejects.toThrow();
  expect(calls).toHaveLength(5);
});
