import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createGateway } from '../../../../gateway/app.ts';
import { expect, it, vi } from 'vitest';
import { INPUT, PHOTO_META, fakeSpawn, refs, resultLine, sceneHtml, validStory } from '../../../../../frontend/server/promo/test/helpers.mjs';
import { validateInput } from '../../../../../frontend/server/promo/service.mjs';
import { createExamplePhotoSource } from '../../../../../frontend/server/promo/photo-source.mjs';
import { loadReferences } from '../../../../../frontend/server/promo/references.mjs';
import { createPromoWorker } from '../../../../workers/marketing-worker/promo/worker.ts';
import { createFakePromoProvider } from '../../../../workers/marketing-worker/promo/providers.ts';
import type { CatalogSnapshot, PromoArtifacts } from '../../promo/contracts.ts';
import { registerPromoRoutes } from '../../promo/routes.ts';
import { inStore } from '../../transaction.ts';
import { createPromoCatalog } from './catalog.ts';
import { naverPromoPublish } from './publication.ts';
import { promoRealityPath, registerPromoReality, type PromoRealityOptions } from './routes.ts';

import { PROMO_REFERENCE_IDS } from '../../../../../frontend/shared/promo-references.mjs';

const url = process.env.NAVIS_B16_TEST_DB_URL;

it('accepts generation input for every gallery template in the store catalog', () => {
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const catalog: CatalogSnapshot['catalog'] = source.listCatalog();
  const primary = catalog.menus.find(menu => menu.menuId === 'm-chestnut-latte')!;
  const runtime = createPromoCatalog({ photos: async () => [], verifyUpload: async () => null }, async () => catalog);
  for (const referenceId of PROMO_REFERENCE_IDS) {
    expect(validateInput({ ...INPUT, menuIds: [primary.menuId], photoIds: primary.photoIds.slice(0, 5), referenceId },
      catalog, runtime.references), referenceId).toBeNull();
  }
});

it('queues confirmed ref-1 with an Americano first and no inventory access', async () => {
  const storeId = randomUUID(), actorId = randomUUID(), draftId = randomUUID(), token = randomUUID();
  const catalog: CatalogSnapshot['catalog'] = createExamplePhotoSource({ sourceId: 'cafe' }).listCatalog();
  const coffee = catalog.menus.find(menu => menu.menuId === 'm-americano')!;
  const cake = catalog.menus.find(menu => menu.menuId === 'm-strawberry-cake')!;
  const input = { ...INPUT, menuIds: [coffee.menuId, cake.menuId], photoIds: cake.photoIds.slice(0, 5) };
  const photos = Object.fromEntries([...input.photoIds, catalog.store.exteriorPhotoId].map(photoId =>
    [photoId, { fileId: randomUUID(), resourceId: photoId }]));
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM marketing.promo_draft')) return { rows: [{ draftId, input, revision: 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO marketing.promo_job')) {
      expect(args?.[5]).toEqual(input);
      expect(args?.[6]).not.toHaveProperty('countdownStock');
      return { rows: [{ job_id: args?.[1] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool;
  const app = Fastify();
  registerPromoReality(app, pool, {
    gatewayToken: token, references: loadReferences(),
    catalogForOwner: async () => ({ catalog, photos, exterior: { width: 720, height: 1280 } }),
    verifyUpload: vi.fn(), artifacts: { read: vi.fn() },
  });
  try {
    const generate = (key: string) => app.inject({ method: 'POST', url: `${promoRealityPath.replace(':storeId', storeId)}/drafts/${draftId}/generate`,
      payload: { expectedRevision: 1, confirmed: true }, headers: { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
        'x-navis-user-id': actorId, 'x-navis-store-role': 'owner', 'idempotency-key': key } });
    const result = await generate('test-generate');
    expect(result.statusCode, result.body).toBe(202);
    expect(result.json().affectedSources).toContain('promo-jobs');
    delete photos[input.photoIds[0]];
    const missing = await generate('test-missing-photo');
    expect(missing.statusCode).toBe(409);
    expect(missing.json().code).toBe('PROMO_SELECTION_UNAVAILABLE');
  } finally {
    await app.close();
  }
});

it.runIf(Boolean(url))('persists owner assets, drafts, a FAKE job and separate publication receipts across fresh clients',
  async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const storeId = randomUUID(), otherStore = randomUUID(), actorId = randomUUID(), readToken = randomUUID();
    const uploadId = randomUUID();
    const source = createExamplePhotoSource({ sourceId: 'cafe' });
    const cafe: CatalogSnapshot['catalog'] = source.listCatalog();
    const venue = { ...cafe, store: { ...cafe.store, location: '서울 동작구 상도동 999-12' } };
    const primary = venue.menus.find(menu => menu.menuId === 'm-chestnut-latte')!;
    const input = { ...INPUT, menuIds: [primary.menuId], photoIds: primary.photoIds.slice(0, 5) };
    const video = await readFile(new URL('../../../../../frontend/server/promo/references/ref-1/preview.mp4', import.meta.url));
    const files = new Map<string, { scope: string; bytes: Buffer; mime: string }>();
    const artifacts: PromoArtifacts = {
      async put(scope, _identity, _purpose, mime, bytes) {
        const fileId = randomUUID();
        files.set(fileId, { scope: JSON.stringify(scope), bytes, mime });
        return fileId;
      },
      async read(scope, fileId) {
        const file = files.get(fileId);
        if (!file || file.scope !== JSON.stringify(scope)) throw new Error('Missing scoped artifact');
        return file;
      },
    };
    const seed = await Promise.all(source.listPhotoIds().map(async photoId => {
      const info = source.photoInfo(photoId)!;
      const photo = (await source.readPhoto(photoId))!;
      const fileId = await artifacts.put({ storeId, resourceId: photoId }, photoId, 'promo_input', photo.mediaType, photo.bytes);
      return { ...info, fileId, binding: { fileId, resourceId: photoId } };
    }));
    let beforeCatalog: (() => Promise<void>) | undefined;
    let checkIdle = true;
    const catalog = createPromoCatalog({
      async photos(owner, uploads) {
        if (checkIdle) expect(pool.idleCount).toBe(pool.totalCount);
        await beforeCatalog?.();
        if (owner.storeId !== storeId) return [];
        return [...seed, ...uploads.map(upload => ({
          ...upload, photoId: upload.assetId.replaceAll('-', ''), binding: { fileId: upload.fileId, resourceId: upload.assetId },
        }))];
      },
      async verifyUpload(owner, fileId) {
        expect(pool.idleCount).toBe(pool.totalCount);
        return owner.storeId === storeId && fileId === uploadId ? { width: 32, height: 48 } : null;
      },
    }, async owner => owner.storeId === storeId ? venue : null);
    const news = vi.fn(async () => ({ news: { ref: 'place-1' }, readBack: 'confirmed' as const }));
    const clips = vi.fn(async () => ({ clip: { ref: 'clip-1', state: 'processing' as const, link: null } }));
    const readClip = vi.fn(async () => ({ ref: 'clip-1', state: 'published' as const, link: 'https://clip.naver.com/a' }));
    const ports: PromoRealityOptions = {
      ...catalog, gatewayToken: readToken, artifacts, objectStorage: null,
      readMenuPrice: async (scope, name) => scope.storeId === storeId && name === primary.names.ko ? 4900 : null,
      naver: naverPromoPublish(() => ({ news: { create: news }, clips: { upload: clips, read: readClip } })),
    };
    const app = Fastify();
    const fresh = Fastify();
    for (const service of [app, fresh]) {
      registerPromoReality(service, pool, ports);
      registerPromoRoutes(service, pool, {
        confirmToken: randomUUID(), readToken, references: refs, artifacts, objectStorage: null, catalogForStore: async () => null,
      });
    }
    const gatewayProof = process.env.NAVIS_B16_TEST_GATEWAY === '1';
    const keyPair = await generateKeyPair('ES256');
    const jwk = { ...await exportJWK(keyPair.publicKey), kid: 'account-fixture', alg: 'ES256', use: 'sig' };
    const gateway = gatewayProof ? createGateway({
      accountUrl: 'http://account.test', inventoryUrl: 'http://inventory.test', accountOrigin: 'https://demo.example',
      accountToken: randomUUID(), inventoryToken: randomUUID(), logging: false,
      marketingRecords: { url: await app.listen({ host: '127.0.0.1', port: 0 }), token: readToken },
      fetcher: async (input, init) => {
        const target = new URL(String(input));
        if (target.hostname !== 'account.test') return fetch(input, init);
        if (target.pathname.endsWith('/jwks')) return Response.json({ keys: [jwk] });
        if (target.pathname.endsWith('/authorize')) return new Response(null, { status: 204 });
        if (target.pathname === `/internal/v1/account/stores/${storeId}/operating-clock`) {
          return Response.json({ timezone: 'Asia/Seoul', businessDayStart: '05:00' });
        }
        throw new Error('Unexpected Account path');
      },
    }) : null;
    async function newSession() {
      return new SignJWT({ store_id: storeId, role: 'owner', sid: randomUUID() })
        .setSubject(actorId).setIssuer('navis-account').setAudience('navis-api').setIssuedAt().setExpirationTime('5m')
        .setProtectedHeader({ alg: 'ES256', kid: jwk.kid }).sign(keyPair.privateKey);
    }
    const browserToken = await newSession();
    const call = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object, key = randomUUID(),
      store = storeId, role = 'owner', service = app) => {
      if (gateway && store === storeId && role === 'owner') {
        return gateway.inject({
          method, url: `/api/v1/stores/${storeId}/marketing/promo${path}`,
          headers: { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${browserToken}`, 'idempotency-key': key }, payload,
        });
      }
      return service.inject({
      method, url: `${promoRealityPath.replace(':storeId', store)}${path}`,
      headers: { authorization: `Bearer ${readToken}`, 'x-navis-store-id': store, 'x-navis-user-id': actorId,
        'x-navis-store-role': role, 'idempotency-key': key },
      payload,
      });
    };
    try {
      const assetResponse = await call('GET', '/assets');
      expect(assetResponse.statusCode, assetResponse.body).toBe(200);
      const assets = assetResponse.json();
      expect(assets.eligiblePhotoCount).toBe(177);
      const allAssets: { photoId: string; menuId: string | null }[] = [...assets.items];
      let cursor: string | null = assets.nextCursor;
      for (let page = 1; cursor && page < 4; page++) {
        const next = await call('GET', `/assets?cursor=${encodeURIComponent(cursor)}`);
        expect(next.statusCode, next.body).toBe(200);
        const body = next.json();
        expect(body.sourceRevision).toBe(assets.sourceRevision);
        allAssets.push(...body.items);
        cursor = body.nextCursor;
      }
      expect(cursor).toBeNull();
      expect(allAssets).toHaveLength(180);
      expect(new Set(allAssets.map(photo => photo.photoId)).size).toBe(180);
      expect(allAssets.filter(photo => photo.menuId === primary.menuId).map(photo => photo.photoId)).toEqual([
        'cafe-chestnut-latte-01', 'cafe-chestnut-latte-02', 'cafe-chestnut-latte-03',
        'cafe-chestnut-latte-04', 'cafe-chestnut-latte-05', 'cafe-chestnut-latte-06',
      ]);
      const upload = await call('POST', '/assets', { fileId: uploadId, menuId: primary.menuId, rightsConfirmed: true });
      expect(upload.statusCode).toBe(200);
      expect((await call('GET', '/assets', undefined, randomUUID(), storeId, 'owner', fresh)).json().eligiblePhotoCount).toBe(178);
      expect((await call('GET', '/assets', undefined, randomUUID(), otherStore)).json().items).toEqual([]);
      const rejected = await call('POST', '/assets', { fileId: uploadId, menuId: null, rightsConfirmed: true }, randomUUID(), otherStore);
      expect(rejected.statusCode).toBe(404);
      expect((await call('POST', '/drafts', {}, randomUUID(), storeId, 'staff')).statusCode).toBe(403);
      const draft = (await call('POST', '/drafts', input)).json();
      const patch = { expectedRevision: 1, patch: { memo: '변경' } };
      const draftPath = `/drafts/${draft.resourceId}`;
      beforeCatalog = async () => {
        beforeCatalog = undefined;
        // A different command updates this draft while Account is resolving the catalog.
        await inStore(pool, storeId, db => db.query(
          'UPDATE marketing.promo_draft SET revision = 2 WHERE draft_id = $1', [draft.resourceId]), { serialize: true });
      };
      expect((await call('PATCH', draftPath, patch)).statusCode).toBe(409);
      patch.expectedRevision = 2;
      expect((await call('PATCH', draftPath, patch)).json().revision).toBe(3);
      expect((await call('PATCH', draftPath, patch)).statusCode).toBe(409);
      expect((await call('GET', '/drafts', undefined, randomUUID(), storeId, 'owner', fresh)).json().items)
        .toMatchObject([{ revision: 3, input: { memo: '변경' } }]);
      expect((await call('POST', `${draftPath}/generate`, { expectedRevision: 2 })).statusCode).toBe(400);
      const key = randomUUID();
      const card = { expectedRevision: 3, confirmed: true };
      checkIdle = false;
      const [generated, replay] = await Promise.all([
        call('POST', `${draftPath}/generate`, card, key), call('POST', `${draftPath}/generate`, card, key),
      ]);
      expect(generated.statusCode).toBe(202);
      expect(replay.json()).toEqual(generated.json());
      const jobId = generated.json().resourceId;
      await inStore(pool, storeId, async db => {
        const { rows } = await db.query('SELECT event_type FROM marketing.outbox WHERE aggregate_id = $1', [jobId]);
        expect(rows).toEqual([{ event_type: 'marketing.promo_job_queued.v1' }]);
        const read = await db.query('SELECT catalog_snapshot FROM marketing.promo_job WHERE job_id = $1', [jobId]);
        expect(read.rows[0].catalog_snapshot.promotionFacts).toEqual({ menuName: primary.names.ko, price: '₩4,900' });
        // Redis queue delivery is covered by the existing worker tests.
        await db.query('UPDATE marketing.promo_job SET dispatched_at = now() WHERE store_id = $1 AND job_id = $2', [storeId, jobId]);
      });
      const story = validStory();
      const scenes = story.scenes.map((scene, index) => ({
        ...scene, photoIds: [input.photoIds[index] && index < 2 ? input.photoIds[index] : venue.store.exteriorPhotoId],
      }));
      const texts = story.texts.map(text => ({ ...text, text: text.textId === 'store-name' ? venue.store.name
        : text.textId === 'store-location' ? venue.store.location : text.text }));
      const html = sceneHtml({ s1Photo: input.photoIds[0], s2Photo: input.photoIds[1],
        storeName: venue.store.name, storeLocation: venue.store.location })
        .replaceAll('store-exterior', venue.store.exteriorPhotoId);
      const studioCalls: string[] = [];
      let disconnected = false;
      const storyOutput = { scenes, texts, ending: story.ending };
      const spawn = fakeSpawn(() => ({ stdout: resultLine({ html }) })) as unknown as
        ReturnType<Parameters<typeof createFakePromoProvider>[0]['claudeSpawn']>;
      const provider = createFakePromoProvider({
        env: {},
        naverFetch: stage => async (url, init) => {
          studioCalls.push(stage);
          if (stage === 'story') {
            expect(String(url)).toMatch(/\/HCX-007$/);
            expect(JSON.parse(String(init?.body))).toMatchObject({
              thinking: { effort: 'none' }, responseFormat: { type: 'json' },
            });
            disconnected = true;
            throw new Error('FAKE story response disconnected');
          }
          expect(String(url)).toMatch(/\/HCX-005$/);
          return Response.json({ status: { code: '20000' }, result: {
            finishReason: 'stop', message: { role: 'assistant', content: JSON.stringify(PHOTO_META) },
          } });
        },
        claudeSpawn: () => spawn,
        reconcile: async stage => stage === 'story' && disconnected
          ? { state: 'received', output: storyOutput, usage: null } : { state: 'unknown' },
      });
      const worker = createPromoWorker({
        database: pool, artifacts, objectStorage: null, provider, references: refs, meter: { record: async () => {} },
        music: [], musicDir: '.', checkScene: async () => ({ violations: [], checkMs: 0 }),
        renderVideo: async ({ outFile }) => { await writeFile(outFile, video); },
        checkVideo: async () => ({ info: { durationSec: 10, width: 720, height: 1280, fps: 30 }, violations: [] }),
        retryDelayMs: 0,
      });
      for (let stage = 0; stage < 5; stage++) await worker.runNext(storeId, AbortSignal.timeout(5_000));
      expect(studioCalls.filter(stage => stage === 'story')).toHaveLength(1);
      const jobs = `/internal/v1/marketing/stores/${storeId}/promo/jobs/${jobId}`;
      const headers = { authorization: `Bearer ${readToken}`, 'x-navis-store-id': storeId,
        'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' };
      expect((await fresh.inject({ method: 'GET', url: jobs, headers })).json().status).toBe('done');
      const download = await fresh.inject({ method: 'GET', url: `${jobs}/video.mp4?download=1`, headers });
      expect(download.headers['content-disposition']).toMatch(/^attachment/);
      expect(download.rawPayload).toEqual(video);

      const path = `/jobs/${jobId}`;
      const newsCard = { confirmed: true, text: '오늘의 메뉴' };
      const publishKey = randomUUID();
      expect((await call('POST', `${path}/place-news`, { text: newsCard.text })).statusCode).toBe(400);
      const posted = await call('POST', `${path}/place-news`, newsCard, publishKey);
      expect(posted.statusCode).toBe(202);
      expect((await call('POST', `${path}/place-news`, newsCard, publishKey)).json()).toEqual(posted.json());
      expect(news).toHaveBeenCalledTimes(1);
      expect(clips).not.toHaveBeenCalled();
      const clipCard = { confirmed: true, description: '소개', hashtags: [],
        category: 'food', visibility: 'public', aiUsed: true, sponsored: false, commentsAllowed: true };
      const clipKey = randomUUID();
      const clip = await call('POST', `${path}/clip`, clipCard, clipKey);
      expect(clip.statusCode).toBe(202);
      expect((await call('POST', `${path}/clip`, clipCard, clipKey)).json()).toEqual(clip.json());
      expect(clips).toHaveBeenCalledTimes(1);
      expect(readClip).toHaveBeenCalledWith('clip-1');
      const link = { confirmed: true, route: 'shorts', link: 'https://youtube.com/shorts/test' };
      expect((await call('POST', `${path}/shorts`, { confirmed: true, description: '' })).json().code).toBe('MANUAL_UPLOAD_REQUIRED');
      expect((await call('POST', `${path}/attest`, link)).statusCode).toBe(400);
      expect((await call('POST', `${path}/attest`, { ...link, extraConfirmed: true })).statusCode).toBe(200);
      const list = await call('GET', '/publications', undefined, randomUUID(), storeId, 'owner', fresh);
      expect(list.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId, channel: 'place-news', state: 'published' }),
        expect.objectContaining({ jobId, channel: 'clip', state: 'published' }),
        expect.objectContaining({ jobId, channel: 'shorts', method: 'attestation', state: 'published', link: link.link }),
      ]));
      if (gateway) {
        const freshHeaders = { host: 'demo.example', origin: 'https://demo.example', authorization: `Bearer ${await newSession()}` };
        const reloaded = await gateway.inject({ method: 'GET', headers: freshHeaders,
          url: `/api/v1/stores/${storeId}/marketing/promo/publications` });
        expect(reloaded.json().items).toHaveLength(3);
        const file = await gateway.inject({ method: 'GET', headers: freshHeaders,
          url: `/api/v1/stores/${storeId}/promo/jobs/${jobId}/video.mp4?download=1` });
        expect(file.headers['content-disposition']).toMatch(/^attachment/);
        expect(file.rawPayload).toEqual(video);
      }
      expect((await pool.query('SELECT count(*) FROM marketing.promo_publication')).rows[0].count).toBe('0');
      for (const referenceId of PROMO_REFERENCE_IDS) {
        const draft = await call('POST', '/drafts', { ...input, referenceId });
        expect(draft.statusCode).toBe(200);
        const result = await call('POST', `/drafts/${draft.json().resourceId}/generate`, { expectedRevision: 1, confirmed: true });
        expect(result.statusCode, `${referenceId}: ${result.body}`).toBe(202);
        if (referenceId === 'ref-1') {
          const { rows: [saved] } = await inStore(pool, storeId, db => db.query(`
            SELECT catalog_snapshot FROM marketing.promo_job WHERE job_id = $1`, [result.json().resourceId]));
          expect(saved.catalog_snapshot).not.toHaveProperty('countdownStock');
        }
        await inStore(pool, storeId, db => db.query(`
          UPDATE marketing.promo_job SET status = 'failed', finished_at = now(), fail_reason = 'CANCELLED_BY_RESTART'
          WHERE job_id = $1`, [result.json().resourceId]));
      }
    } finally {
      await Promise.all([gateway?.close(), app.close(), fresh.close()]);
      await pool.end();
    }
  }, 30_000);
