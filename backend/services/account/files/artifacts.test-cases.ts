import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { dbConfig, dbPool } from '../../../packages/db/index.ts';
import { createAccountApp } from '../app.ts';
import { createSigningKeys } from '../keys.ts';
import { inStore } from '../transaction.ts';

export function definePromoArtifactTests() {
  describe('private promo artifacts', () => {
    const path = '/internal/v1/promo-artifacts';
    const publicPath = '/api/v1/promo-artifacts';
    const storeId = randomUUID();
    const otherStore = randomUUID();
    const runtime = dbPool('account', 'runtime', 'test');
    const migrate = dbPool('account', 'migrate', 'test');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const gatewayToken = randomBytes(32).toString('hex');
    const marketingToken = randomBytes(32).toString('hex');
    let storageDirectory: string;
    let app: ReturnType<typeof createAccountApp>;
    let now = Date.now();
    const workload = { authorization: `Bearer ${marketingToken}` };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1sAAAAASUVORK5CYII=', 'base64');
    const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    function input(resourceId = 'fin-01', bytes = png) {
      return {
        storeId, resourceId, artifactId: randomUUID(), purpose: 'promo_input',
        mime: 'image/png', sizeBytes: bytes.length, sha256: checksum(bytes),
      };
    }

    async function actor(store: string) {
      const sid = randomUUID();
      const sub = randomUUID();
      await migrate.query("INSERT INTO account.app_user (user_id, email, name) VALUES ($1, $2, 'Synthetic tester')", [sub, `${sub}@fixture.invalid`]);
      await migrate.query("INSERT INTO account.store_member VALUES ($1, $2, 'owner', now(), now())", [store, sub]);
      await migrate.query('INSERT INTO account.auth_session (store_id, sid, user_id) VALUES ($1, $2, $3)', [store, sid, sub]);
      return { sid, sub, store_id: store, role: 'owner' };
    }

    function post(url: string, payload: object, headers: Record<string, string> = workload) {
      return app.inject({ method: 'POST', url, payload, headers });
    }

    function upload(fileId: string, bytes: Buffer, store = storeId) {
      return app.inject({
        method: 'PUT', url: `${path}/${fileId}/bytes?storeId=${store}`,
        headers: { ...workload, 'content-type': 'application/octet-stream' }, payload: bytes,
      });
    }

    async function reserve(meta: ReturnType<typeof input>) {
      const response = await post(path, meta);
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('uploading');
      return response.json().fileId as string;
    }

    async function publish(meta: ReturnType<typeof input>, bytes: Buffer) {
      const fileId = await reserve(meta);
      expect((await upload(fileId, bytes)).statusCode).toBe(204);
      const verified = await post(`${path}/${fileId}/verify`, { storeId, resourceId: meta.resourceId });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toEqual({ fileId, status: 'ready' });
      return fileId;
    }

    async function storagePath(fileId: string) {
      const result = await migrate.query<{ storage_key: string }>(
        'SELECT storage_key FROM account.file_object WHERE file_id = $1', [fileId],
      );
      return join(storageDirectory, result.rows[0].storage_key);
    }

    beforeAll(async () => {
      storageDirectory = await mkdtemp(join(tmpdir(), 'navis-t312-'));
      const keys = await createSigningKeys(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      app = createAccountApp({
        pool: runtime, keys, gatewayToken, logging: false,
        promoFiles: { marketingToken, storageDirectory, now: () => now },
      });
      for (const store of [storeId, otherStore]) {
        await migrate.query(`
          INSERT INTO account.store (store_id, display_name, business_type, payment_style,
            pos_start_tab, settings_revision, created_at, updated_at)
          VALUES ($1, 'Synthetic file store', 'cafe', 'prepaid', 'order', 1, now(), now())
        `, [store]);
      }
    });

    afterAll(async () => {
      await app.close();
      await migrate.query('DELETE FROM account.file_object WHERE store_id IN ($1, $2)', [storeId, otherStore]);
      await migrate.query('DELETE FROM account.app_user WHERE user_id IN (SELECT user_id FROM account.store_member WHERE store_id IN ($1, $2))', [storeId, otherStore]);
      await migrate.query('DELETE FROM account.store WHERE store_id IN ($1, $2)', [storeId, otherStore]);
      await Promise.all([runtime.end(), migrate.end(), rm(storageDirectory, { recursive: true, force: true })]);
    });

    it('authenticates the marketing workload before registration and rejects the gateway credential', async () => {
      const meta = input();
      expect((await post(path, meta, {})).statusCode).toBe(401);
      expect((await post(path, meta, { authorization: `Bearer ${gatewayToken}` })).statusCode).toBe(401);
      expect((await post(path, { ...meta, storeId: randomUUID() })).statusCode).toBe(404);
      await reserve(meta);
    });

    it('converges on one artifact for concurrent registration and rejects a changed fingerprint', async () => {
      const meta = input();
      const [left, right] = await Promise.all([post(path, meta), post(path, meta)]);
      expect(left.statusCode).toBe(200);
      expect(right.json()).toEqual(left.json());
      const fileId = left.json().fileId;
      const conflicting = await post(path, { ...meta, sha256: '0'.repeat(64) });
      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json()).toEqual({ code: 'ARTIFACT_CONFLICT' });
      expect((await post(path, { ...meta, storeId: otherStore })).json().fileId).not.toBe(fileId);
    });

    it('keeps missing or invalid bytes unready and preserves verified bytes on repeat', async () => {
      const meta = input();
      const fileId = await reserve(meta);
      const url = `${path}/${fileId}/verify`;
      const scope = { storeId, resourceId: meta.resourceId };
      expect((await post(url, scope)).statusCode).toBe(409);
      expect((await upload(fileId, Buffer.alloc(png.length))).statusCode).toBe(400);
      expect((await post(url, scope)).statusCode).toBe(409);
      expect((await upload(fileId, png, otherStore)).statusCode).toBe(404);
      expect((await upload(fileId, png)).statusCode).toBe(204);
      expect((await post(url, scope)).json()).toEqual({ fileId, status: 'ready' });
      expect((await post(path, meta)).json()).toEqual({ fileId, status: 'ready' });
      expect((await upload(fileId, png)).statusCode).toBe(204);
      expect((await upload(fileId, Buffer.alloc(png.length))).statusCode).toBe(400);

      const objectPath = await storagePath(fileId);
      expect(await readFile(objectPath)).toEqual(png);
      await writeFile(objectPath, Buffer.alloc(png.length));
      expect((await post(url, scope)).statusCode).toBe(409);
    });

    it('issues a short-lived browser URL only to a current member for the same store and resource', async () => {
      const meta = input();
      const fileId = await publish(meta, png);
      const member = await actor(storeId);
      const outsider = await actor(otherStore);
      const url = `${path}/${fileId}/browser-grant`;
      const binding = { resourceId: meta.resourceId, actor: member };
      const sameStoreOtherFile = await publish(input(meta.resourceId), png);
      expect((await post(url, { ...binding, actor: outsider })).statusCode).toBe(404);
      expect((await post(url, { ...binding, resourceId: 'different-photo' })).statusCode).toBe(404);
      expect((await post(url, { ...binding, actor: { ...member, sid: randomUUID() } })).statusCode).toBe(401);
      expect((await app.inject(`${publicPath}/${fileId}`)).statusCode).toBe(401);

      const granted = await post(url, binding);
      expect(granted.statusCode).toBe(200);
      const { url: download, expiresAt } = granted.json();
      const response = await app.inject(download);
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(png);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject(download.replace(fileId, sameStoreOtherFile))).statusCode).toBe(401);

      await migrate.query('UPDATE account.auth_session SET revoked_at = now() WHERE store_id = $1 AND sid = $2', [storeId, member.sid]);
      expect((await post(url, binding)).statusCode).toBe(401);
      now = Date.parse(expiresAt);
      const expired = await app.inject(download);
      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toEqual({ code: 'TOKEN_EXPIRED' });
    });

    it('delivers only a ready, eligible photo to the fake model over the workload path', async () => {
      const meta = input();
      const fileId = await publish(meta, png);
      const scope = { storeId, resourceId: meta.resourceId };
      const url = `${path}/${fileId}/model-input`;
      expect((await post(url, scope, {})).statusCode).toBe(401);
      expect((await post(url, { ...scope, storeId: otherStore })).statusCode).toBe(404);
      expect((await post(url, { ...scope, resourceId: 'unselected-photo' })).statusCode).toBe(404);

      const response = await post(url, scope);
      expect(response.statusCode).toBe(200);
      const fakeModel = (photo: { mime: string; base64: string }) => {
        expect(photo.mime).toBe('image/png');
        expect(Buffer.from(photo.base64, 'base64')).toEqual(png);
      };
      fakeModel(response.json());

      const bytes = Buffer.from('{}');
      const checkpoint = await publish({ ...input('pj-123456789abc', bytes), purpose: 'promo_checkpoint', mime: 'application/json' }, bytes);
      const member = await actor(storeId);
      const checkpointUrl = `${path}/${checkpoint}`;
      expect((await post(`${checkpointUrl}/model-input`, { storeId, resourceId: 'pj-123456789abc' })).statusCode).toBe(404);
      expect((await post(`${checkpointUrl}/browser-grant`, { resourceId: 'pj-123456789abc', actor: member })).statusCode).toBe(404);
      expect((await post(`${checkpointUrl}/read`, { storeId, resourceId: 'pj-123456789abc' })).rawPayload).toEqual(bytes);

      const pending = await reserve(input());
      expect((await post(`${path}/${pending}/model-input`, scope)).statusCode).toBe(409);
    });

    it('cleans day-old uploads for one store while preserving referenced ready bytes', async () => {
      const meta = input();
      const abandoned = await reserve(meta);
      expect((await upload(abandoned, png)).statusCode).toBe(204);
      const output = Buffer.from('synthetic-video');
      const outputMeta = { ...input('pj-123456789abc', output), purpose: 'promo_output', mime: 'video/mp4' };
      const ready = await publish(outputMeta, output);
      const fresh = await reserve(input());
      const outsider = (await post(path, { ...input(), storeId: otherStore })).json().fileId;
      await migrate.query("UPDATE account.file_object SET created_at = now() - interval '25 hours' WHERE file_id IN ($1, $2, $3)",
        [abandoned, ready, outsider]);
      const abandonedPath = await storagePath(abandoned);
      expect(await readFile(abandonedPath)).toEqual(png);
      expect((await post(`${path}/cleanup`, { storeId })).json()).toEqual({ deleted: 1 });
      expect((await post(`${path}/cleanup`, { storeId })).json()).toEqual({ deleted: 0 });
      await expect(readFile(abandonedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(await storagePath(ready))).toEqual(output);
      const granted = await post(`${path}/${ready}/browser-grant`, {
        resourceId: outputMeta.resourceId, actor: await actor(storeId),
      });
      expect(granted.statusCode).toBe(200);
      const response = await app.inject(granted.json().url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('video/mp4');
      expect(response.rawPayload).toEqual(output);
      const rows = await migrate.query('SELECT file_id, status FROM account.file_object WHERE file_id IN ($1, $2)', [fresh, outsider]);
      expect(rows.rows).toEqual(expect.arrayContaining([
        { file_id: fresh, status: 'uploading' }, { file_id: outsider, status: 'uploading' },
      ]));
      expect((await post(path, meta)).json()).toEqual({ fileId: abandoned, status: 'uploading' });
    });

    it('forces store scope for the runtime role and leaves no scope on a reused connection', async () => {
      const fileId = await reserve(input());
      const read = 'SELECT file_id FROM account.file_object WHERE file_id = $1';
      const reused = new Pool({ ...dbConfig('account', 'runtime', 'test'), max: 1 });
      try {
        const visible = await inStore(reused, storeId, (client) => client.query(read, [fileId]));
        const hidden = await inStore(reused, otherStore, (client) => client.query(read, [fileId]));
        expect(visible.rows).toEqual([{ file_id: fileId }]);
        expect(hidden.rows).toEqual([]);
        expect((await reused.query(read, [fileId])).rows).toEqual([]);
      } finally {
        await reused.end();
      }
      const policy = await migrate.query(`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'account.file_object'::regclass
      `);
      expect(policy.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });
  });
}
