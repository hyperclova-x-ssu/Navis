import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import * as clients from '../../../workers/marketing-worker/promo/clients.ts';

const storeId = 'c05409a6-f082-5964-a787-c1ed3184988b';
const photoId = '33123a19-6780-4d38-9bca-ce96efcf8559';
const token = 'fixture-photo-worker';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('off by default keeps the worker on its existing photo source', () => {
  expect(clients.configuredPhotoContent).toBeTypeOf('function');
  expect(clients.configuredPhotoContent({})).toBeUndefined();
  expect(clients.configuredPhotoContent({ NAVIS_OBJECT_STORAGE_MODE: 'off' })).toBeUndefined();
});

test('stages scoped photo bytes through marketing before handing them to the renderer', async () => {
  expect(clients.configuredPhotoContent).toBeTypeOf('function');
  const directory = await mkdtemp(join(tmpdir(), 'navis-test-photo-content-'));
  const tokenFile = join(directory, 'worker-token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const server = createServer((req, reply) => {
    if (req.method !== 'GET' || req.url !== `/internal/photos/${photoId}/content`
        || req.headers.authorization !== `Bearer ${token}` || req.headers['x-navis-store-id'] !== storeId) {
      reply.writeHead(403).end();
      return;
    }
    reply.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not start');
    const reader = clients.configuredPhotoContent({
      NAVIS_OBJECT_STORAGE_MODE: 's3',
      NAVIS_MARKETING_BASE_URL: `http://127.0.0.1:${address.port}`,
      NAVIS_MARKETING_SMS_WORKER_TOKEN_FILE: tokenFile,
    })!;

    await expect(reader.read(storeId, photoId)).resolves.toEqual({ bytes: jpeg, mime: 'image/jpeg' });
    await expect(reader.stage(storeId, photoId, directory)).resolves.toEqual({ bytes: jpeg, mime: 'image/jpeg' });
    expect(await readFile(join(directory, photoId))).toEqual(jpeg);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid scope, non-images and oversized content never become staged worker files', async () => {
  expect(clients.createPhotoContentClient).toBeTypeOf('function');
  const directory = await mkdtemp(join(tmpdir(), 'navis-test-photo-content-'));
  const server = createServer((req, reply) => {
    if (req.headers['x-navis-store-id'] === storeId) {
      reply.writeHead(200, { 'content-type': 'text/html' }).end('<html/>');
      return;
    }
    reply.writeHead(200, { 'content-type': 'image/jpeg' }).end(Buffer.alloc(4 * 1024 * 1024 + 1));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not start');
    const reader = clients.createPhotoContentClient({ baseUrl: `http://127.0.0.1:${address.port}`, token });

    await expect(reader.stage(storeId, '../escape', directory)).rejects.toThrow('Invalid promo photo scope');
    await expect(reader.stage(storeId, photoId, directory)).rejects.toThrow('Invalid promo photo content type');
    await expect(reader.stage(photoId, photoId, directory)).rejects.toThrow('Invalid promo photo size');
    expect(await readdir(directory)).toEqual([]);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
