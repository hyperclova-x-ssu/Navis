import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dbPool } from '../../../packages/db/index.ts';
import { runMigrations } from '../../../packages/db/migrate.ts';
import { createSigningKeys } from '../keys.ts';
import { seed } from '../seed.ts';
import { createDemoSession } from '../sessions.ts';
import { registerAttachments } from './attachments.ts';
import { registerPromoInputRoutes } from './promo-input.ts';

const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrate = dbPool('account', 'migrate', 'test');
const pool = dbPool('account', 'runtime', 'test');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keys = await createSigningKeys(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
const workload = randomUUID();
const marketing = randomUUID();
const pos = randomUUID();
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ncYQAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(image).digest('hex');
const contentType = 'image/png';

function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; type: string }>();
  return {
    objects,
    put: vi.fn(async (key: string, bytes: Buffer, type: string) => { objects.set(key, { bytes, type }); }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object && { body: Readable.from([object.bytes]), contentLength: object.bytes.length, contentType: object.type };
    }),
    remove: vi.fn(async (key: string) => { objects.delete(key); }),
  };
}

async function app(objectStorage?: ReturnType<typeof fakeStorage>) {
  const server = Fastify();
  const options = { objectStorage, posToken: pos };
  registerAttachments(server, pool, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (req.headers.authorization !== `Bearer ${workload}`) return reply.code(401).send();
  }, options);
  registerPromoInputRoutes(server, pool, marketing, objectStorage);
  return server;
}

async function owner() {
  const issued = await createDemoSession(pool, keys);
  if (!issued) throw new Error('Missing test owner');
  const { store_id: storeId, sid, sub, role } = decodeJwt(issued.access.accessToken);
  return {
    storeId, actorId: sub,
    root: `/internal/v1/account/stores/${storeId}/files`,
    headers: { authorization: `Bearer ${workload}`, 'x-navis-store-id': String(storeId), 'x-navis-user-id': String(sub),
      'x-navis-session-id': String(sid), 'x-navis-store-role': String(role), 'idempotency-key': randomUUID() },
  };
}

async function reserve(server: Awaited<ReturnType<typeof app>>, session: Awaited<ReturnType<typeof owner>>, purpose: string) {
  const response = await server.inject({ method: 'POST', url: session.root, headers: session.headers,
    payload: { purpose, contentType, size: image.length, sha256 } });
  expect(response.statusCode).toBe(200);
  return response.json<{ fileId: string }>().fileId;
}

function upload(server: Awaited<ReturnType<typeof app>>, session: Awaited<ReturnType<typeof owner>>, fileId: string, bytes = image) {
  return server.inject({ method: 'PUT', url: `${session.root}/${fileId}/content`,
    headers: { ...session.headers, 'content-type': contentType }, payload: bytes });
}

beforeAll(async () => {
  await runMigrations('account', migrations, 'test');
  await seed(migrate);
});
afterAll(async () => { await Promise.all([migrate.end(), pool.end()]); });

it('keeps only scoped object metadata for custom order photos and verifies a fresh session can read the bytes', async () => {
  const storage = fakeStorage();
  const server = await app(storage);
  try {
    const session = await owner();
    const fileId = await reserve(server, session, 'custom-reference-photo');
    const key = `account/attachments/${session.storeId}/${fileId}/${sha256}`;
    const contentUrl = `${session.root}/${fileId}/content`;
    const complete = () => server.inject({ method: 'POST', url: `${session.root}/${fileId}/complete`, headers: session.headers });
    expect(await reserve(server, session, 'custom-reference-photo')).toBe(fileId);
    expect((await upload(server, session, fileId, Buffer.alloc(image.length))).statusCode).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
    expect((await complete()).statusCode).toBe(409);
    expect((await upload(server, session, fileId)).statusCode).toBe(204);
    expect(storage.objects.get(key)).toEqual({ bytes: image, type: contentType });
    expect((await complete()).json()).toEqual({ fileId, purpose: 'custom-reference-photo', contentType, size: image.length, sha256 });
    expect((await complete()).statusCode).toBe(200);
    const row = await migrate.query('SELECT object_key, bytes, state FROM account.attachment WHERE store_id=$1 AND file_id=$2',
      [session.storeId, fileId]);
    expect(row.rows).toEqual([{ object_key: key, bytes: null, state: 'complete' }]);
    const fresh = await owner();
    const auth = await server.inject({ method: 'GET', url: contentUrl });
    expect(auth.statusCode).toBe(401);
    const foreign = await server.inject({ method: 'GET', url: contentUrl,
      headers: { ...fresh.headers, 'x-navis-store-id': randomUUID() } });
    expect(foreign.statusCode).toBe(403);
    const read = await server.inject({ method: 'GET', url: contentUrl, headers: fresh.headers });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload).toEqual(image);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.headers['content-type']).toBe(contentType);
    const verify = await server.inject({ method: 'POST', url: `${session.root}/${fileId}/custom-reference-photo-verify`,
      headers: { authorization: `Bearer ${pos}` }, payload: { actorId: fresh.actorId } });
    expect(verify.statusCode).toBe(204);
    storage.objects.set(key, { bytes: Buffer.alloc(image.length), type: contentType });
    const corrupted = await server.inject({ method: 'GET', url: contentUrl, headers: fresh.headers });
    expect(corrupted.statusCode).toBe(503);
  } finally { await server.close(); }
});

it('leaves a failed upload pending and does not expose a revoked receipt when object deletion needs a retry', async () => {
  const storage = fakeStorage();
  const server = await app(storage);
  try {
    const session = await owner();
    const fileId = await reserve(server, session, 'receipt-evidence');
    const fileUrl = `${session.root}/${fileId}`;
    const complete = () => server.inject({ method: 'POST', url: `${fileUrl}/complete`, headers: session.headers });
    const revoke = () => server.inject({ method: 'DELETE', url: fileUrl, headers: session.headers });
    storage.put.mockRejectedValueOnce(new Error('backend unavailable'));
    const failure = await upload(server, session, fileId);
    expect(failure.statusCode).toBe(503);
    expect(failure.json()).toEqual({ code: 'UNAVAILABLE', reason: 'FILE_STORAGE_UNAVAILABLE' });
    expect((await complete()).statusCode).toBe(409);
    expect((await upload(server, session, fileId)).statusCode).toBe(204);
    expect((await complete()).statusCode).toBe(200);
    storage.remove.mockRejectedValueOnce(new Error('backend unavailable'));
    expect((await revoke()).statusCode).toBe(503);
    expect((await server.inject({ method: 'GET', url: `${fileUrl}/content`, headers: session.headers })).statusCode).toBe(404);
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204);
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(storage.objects.size).toBe(0);
    const { rows } = await migrate.query('SELECT object_key, bytes, state FROM account.attachment WHERE store_id=$1 AND file_id=$2',
      [session.storeId, fileId]);
    expect(rows).toEqual([{ object_key: null, bytes: null, state: 'revoked' }]);
    const events = await migrate.query('SELECT payload->>\'state\' AS state FROM account.outbox WHERE aggregate_id=$1 ORDER BY store_seq', [fileId]);
    expect(events.rows).toEqual([{ state: 'complete' }, { state: 'revoked' }]);
  } finally { await server.close(); }
});

it('can read legacy database bytes after enabling object storage', async () => {
  const server = await app();
  const storage = fakeStorage();
  const switched = await app(storage);
  try {
    const session = await owner();
    const fileId = await reserve(server, session, 'tax-evidence');
    const fileUrl = `${session.root}/${fileId}`;
    expect((await upload(server, session, fileId)).statusCode).toBe(204);
    expect((await server.inject({ method: 'POST', url: `${fileUrl}/complete`, headers: session.headers })).statusCode).toBe(200);
    const read = await switched.inject({ method: 'GET', url: `${fileUrl}/content`, headers: session.headers });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload).toEqual(image);
    expect(storage.get).not.toHaveBeenCalled();
    const row = await migrate.query('SELECT object_key, bytes FROM account.attachment WHERE store_id=$1 AND file_id=$2',
      [session.storeId, fileId]);
    expect(row.rows).toEqual([{ object_key: null, bytes: image }]);
  } finally { await Promise.all([switched.close(), server.close()]); }
});

it('serves S3-backed owner uploads to the authorized promo input consumer', async () => {
  const storage = fakeStorage();
  const server = await app(storage);
  try {
    const session = await owner();
    const fileId = await reserve(server, session, 'promo-photo');
    expect((await upload(server, session, fileId)).statusCode).toBe(204);
    expect((await server.inject({ method: 'POST', url: `${session.root}/${fileId}/complete`, headers: session.headers })).statusCode).toBe(200);
    const response = await server.inject({ method: 'POST', url: `/internal/v1/account/stores/${session.storeId}/promo-input/${fileId}/bytes`,
      headers: { authorization: `Bearer ${marketing}` }, payload: { actorId: session.actorId } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-navis-photo-width']).toBe('1');
    expect(response.rawPayload).toEqual(image);
    expect(storage.get).toHaveBeenCalledTimes(2);
  } finally { await server.close(); }
});
