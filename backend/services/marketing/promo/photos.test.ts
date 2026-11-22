import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { refs } from '../../../../frontend/server/promo/test/helpers.mjs';
import { createGateway } from '../../../gateway/app.ts';
import { createObjectStorage, type ObjectStorage } from '../../../packages/object-storage/index.ts';
import { demoIdentity } from '../../account/identity.ts';
import { menuSeedFileId } from '../../inventory/reality/01/menu-photo-seed.ts';
import { registerPromoReality } from '../reality/16/routes.ts';
import { inStore } from '../transaction.ts';
import { sha256 } from './contracts.ts';
import { registerPhotoReads } from './photo-routes.ts';

const url = process.env.NAVIS_OBJ_TEST_DB_URL;
const gatewayToken = 'fake-photo-gateway';
const workerToken = 'fake-photo-worker';
const ownerHeaders = (storeId: string, userId: string = demoIdentity.userId) => ({
  authorization: `Bearer ${gatewayToken}`, 'x-navis-store-id': storeId,
  'x-navis-user-id': userId, 'x-navis-store-role': 'owner',
});
const privatePath = (storeId: string) => `/internal/v1/marketing/stores/${storeId}/marketing/photos`;

it('returns the bundled menu representative to the demo store when storage is off', async () => {
  const app = Fastify();
  const pool = new pg.Pool();
  registerPhotoReads(app, pool, { gatewayToken, bundledStoreId: demoIdentity.storeId });
  try {
    const response = await app.inject({ url: privatePath(demoIdentity.storeId), headers: ownerHeaders(demoIdentity.storeId) });
    expect(response.statusCode).toBe(200);
    const photos = response.json().items;
    const item = photos.find((photo: { photoId: string }) => photo.photoId === menuSeedFileId(demoIdentity.storeId, 'm-americano'));
    const bytes = await readFile(new URL('../../../../frontend/public/menu-photos/cafe-americano-01.jpeg', import.meta.url));
    expect(item).toMatchObject({ contentUrl: '/menu-photos/cafe-americano-01.jpeg', sha256: sha256(bytes) });
    const other = randomUUID();
    expect((await app.inject({ url: privatePath(other), headers: ownerHeaders(other) })).json().items).toEqual([]);
  } finally {
    await app.close();
    await pool.end();
  }
});

it.runIf(Boolean(url))('writes the S3 catalog from either upload route, commits one receipt, and reads it under RLS after restart', async () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const app = Fastify();
  const fresh = Fastify();
  const storeId = randomUUID();
  const other = randomUUID();
  const actorId = randomUUID();
  const fileId = randomUUID();
  const bytes = await readFile(new URL('../../../../frontend/public/menu-photos/cafe-americano-01.jpeg', import.meta.url));
  const source = { width: 40, height: 30, bytes, contentType: 'image/jpeg' };
  const menuId = 'm-americano';
  const objects = new Map<string, Buffer>();
  const fake: ObjectStorage = {
    async put(key, body) { objects.set(key, body); },
    async get(key) {
      const body = objects.get(key);
      if (body) return { body: Readable.from([body]), contentLength: body.length, contentType: 'image/jpeg' };
    },
    async remove(key) { objects.delete(key); },
  };
  const transport = createObjectStorage() ?? fake;
  const storage: ObjectStorage = { ...transport, put: vi.fn(transport.put) };
  const upload = vi.fn(async (_owner, id) => id === fileId ? source : null);
  registerPromoReality(app, pool, {
    gatewayToken, references: refs, artifacts: { read: async () => ({ bytes, mime: 'image/jpeg' }) },
    catalogForOwner: async () => ({ catalog: { sourceId: 'test', store: { name: 'Test', location: '', exteriorPhotoId: '', exteriorUrl: '' },
      menus: [{ menuId, names: { ko: '아메리카노', en: 'Americano', 'zh-Hans': '美式', 'zh-Hant': '美式' }, photoIds: [] }], photos: [] },
    photos: {}, exterior: { width: 0, height: 0 } }),
    verifyUpload: upload, photoUpload: { storage, read: upload },
  });
  registerPhotoReads(fresh, pool, { gatewayToken, workerToken, storage });
  const keyPair = await generateKeyPair('ES256');
  const jwk = { ...await exportJWK(keyPair.publicKey), kid: 'account-fixture', alg: 'ES256', use: 'sig' };
  const gateway = createGateway({
    accountUrl: 'http://account.test', inventoryUrl: 'http://inventory.test', accountOrigin: 'https://demo.example',
    accountToken: randomUUID(), inventoryToken: randomUUID(), logging: false,
    marketingRecords: { url: await fresh.listen({ host: '127.0.0.1', port: 0 }), token: gatewayToken },
    fetcher: async (input, init) => {
      const target = new URL(String(input));
      if (target.hostname !== 'account.test') return fetch(input, init);
      if (target.pathname.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (target.pathname.endsWith('/authorize')) return new Response(null, { status: 204 });
      throw new Error('Unexpected Account path');
    },
  });
  const session = await new SignJWT({ store_id: storeId, role: 'owner', sid: randomUUID() })
    .setSubject(actorId).setIssuer('navis-account').setAudience('navis-api').setIssuedAt().setExpirationTime('5m')
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(keyPair.privateKey);
  const browser = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${session}` };
  try {
    const root = privatePath(storeId);
    const headers = { ...ownerHeaders(storeId, actorId), 'idempotency-key': 'photo-upload' };
    const payload = { fileId, menuId, rightsConfirmed: true };
    const unauthorized = await app.inject({ method: 'POST', url: root, headers: { ...headers, 'x-navis-store-role': 'staff' }, payload });
    expect(unauthorized.statusCode).toBe(403);
    expect(upload).not.toHaveBeenCalled();
    const created = await app.inject({ method: 'POST', url: root, headers, payload });
    expect(created.statusCode, created.body).toBe(200);
    const retried = await app.inject({ method: 'POST', url: `${root.replace(/\/photos$/, '')}/promo/assets`, headers, payload });
    expect(retried.json()).toEqual(created.json());
    expect(storage.put).toHaveBeenCalledTimes(1);
    const status = await inStore(pool, storeId, async db => ({
      analysis: (await db.query('SELECT image_sha256, resource_id FROM marketing.promo_photo_analysis')).rows,
      outbox: (await db.query("SELECT event_type FROM marketing.outbox WHERE store_id=$1", [storeId])).rows,
    }));
    const list = await gateway.inject({ url: `/api/v1/stores/${storeId}/marketing/photos`, headers: browser });
    const hash = sha256(bytes);
    const [photo] = list.json().items;
    expect(list.statusCode).toBe(200);
    expect(photo).toEqual({ photoId: expect.any(String), menuId, sha256: hash, width: 40, height: 30,
      contentUrl: `/api/v1/stores/${storeId}/marketing/photos/${photo.photoId}/content` });
    expect(status.analysis).toEqual([{ image_sha256: hash, resource_id: `photo-${photo.photoId}` }]);
    expect(status.outbox).toEqual([{ event_type: 'marketing.promo_status_changed.v1' }]);
    const content = `${root}/${photo.photoId}/content`;
    const served = await gateway.inject({ url: photo.contentUrl, headers: browser });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(bytes);
    expect(served.headers).toMatchObject({ etag: `"${hash}"`, 'cache-control': 'private, max-age=86400' });
    expect((await gateway.inject({ url: photo.contentUrl, headers: { ...browser, 'if-none-match': `W/"${hash}"` } })).statusCode).toBe(304);
    const internal = `/internal/photos/${photo.photoId}/content`;
    const worker = { authorization: `Bearer ${workerToken}`, 'x-navis-store-id': storeId };
    expect((await fresh.inject({ url: internal, headers: worker })).rawPayload).toEqual(bytes);
    expect((await fresh.inject({ url: internal, headers: { ...worker, 'x-navis-store-id': other } })).statusCode).toBe(404);
    expect((await fresh.inject({ url: content, headers: worker })).statusCode).toBe(401);
    expect((await fresh.inject({ url: `${privatePath(other)}/${photo.photoId}/content`, headers: ownerHeaders(other) })).statusCode).toBe(404);
    expect((await pool.query('SELECT id FROM marketing.photo_asset WHERE id=$1', [photo.photoId])).rowCount).toBe(0);
  } finally {
    await Promise.all([app.close(), fresh.close(), gateway.close()]);
    await pool.end();
  }
});
