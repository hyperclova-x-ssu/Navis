import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { validateInput } from '../../../../../frontend/server/promo/service.mjs';
import type { loadReferences } from '../../../../../frontend/server/promo/references.mjs';
import type { ObjectStorage } from '../../../../packages/object-storage/index.ts';
import { fingerprint, isUuid, sha256, type CatalogSnapshot, type FileBinding, type PromoInput } from '../../promo/contracts.ts';
import { insertPromoJob, PromoRouteError } from '../../promo/jobs.ts';
import { configuredPromoMediaStorage, createPromoMedia } from '../../promo/media.ts';
import type { PromoMenuPriceRead } from '../../promo/menu-facts.ts';
import { queuePhotoAnalysis } from '../../promo/photo-analysis-store.ts';
import { insertPhoto, photoPath, storePhoto, type PhotoUpload } from '../../promo/photo-assets.ts';
import { inStore } from '../../transaction.ts';
import { attest, publish, type PublicationPorts } from './publication.ts';
import { assetColumns, draftColumns, getDraft, preparedCommand, publicationColumns, receipt,
  type Asset, type Draft, type Owner, type Publication } from './state.ts';
import { attestation, badRequest, conflict, draftPatch, id, identifier, notFound, publicationCard, record,
  revision, unavailable, type Channel } from './wire.ts';

export const promoRealityPath = '/internal/v1/marketing/stores/:storeId/marketing/promo';
export type PromoRealityOptions = PublicationPorts & {
  gatewayToken: string;
  references: ReturnType<typeof loadReferences>;
  objectStorage?: ObjectStorage | null;
  // Account resolves rights and ready bytes for seed assets and eligible attachments in this store.
  catalogForOwner(owner: Owner, uploads: readonly Asset[], db?: PoolClient): Promise<CatalogSnapshot | null>;
  verifyUpload(owner: Owner, fileId: string): Promise<{ width: number; height: number } | null>;
  photoUpload?: {
    storage: Pick<ObjectStorage, 'put'>;
    read(owner: Owner, fileId: string): Promise<PhotoUpload | null>;
    catalogMenuId?(menuId: string): string;
    promoMenuId?(menuId: string): string;
  };
  bindPhoto?: (owner: Owner, photoId: string, attachment: FileBinding) => Promise<FileBinding>;
  readMenuPrice?: PromoMenuPriceRead;
  uploadTargets?: Partial<Record<Channel, string>>;
};

type Params = { storeId: string; draftId?: string; jobId?: string };
type Query = { cursor?: string; limit?: string };
type Request = FastifyRequest<{ Params: Params; Querystring: Query }>;
const sources = {
  assets: 'promo-assets', drafts: 'promo-drafts', publications: 'promo-publications',
} as const;
const uploaderDomains: Record<Channel, readonly string[]> = {
  'place-news': ['new.smartplace.naver.com', 'smartplace.naver.com'],
  clip: ['clip.naver.com', 'clipcreators.naver.com', 'creator.clip.naver.com', 'help.naver.com'],
  reels: ['instagram.com', 'www.instagram.com'],
  shorts: ['studio.youtube.com', 'www.youtube.com'],
};
const publicPromo = (storeId: string) => `/api/v1/stores/${storeId}/promo`;

function pageRequest(query: Query) {
  const data = record(query, ['cursor', 'limit']);
  const limit = data.limit === undefined ? 50 : Number(data.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (data.limit !== undefined && typeof data.limit !== 'string')) {
    throw badRequest();
  }
  return { limit, cursor: data.cursor === undefined ? null : identifier(data.cursor) };
}

function page<T>(items: T[], query: Query, key: (item: T) => string) {
  const { limit, cursor } = pageRequest(query);
  const sorted = items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) === key(b) ? 0 : 1));
  const filtered = cursor ? sorted.filter(item => key(item) > cursor) : sorted;
  const result = filtered.slice(0, limit);
  return {
    items: result, nextCursor: filtered.length > limit ? key(result[result.length - 1]) : null,
    asOf: new Date().toISOString(), sourceRevision: fingerprint(sorted),
  };
}

async function readAssets(db: PoolClient, storeId: string) {
  return (await db.query<Asset>(
    `SELECT ${assetColumns} FROM marketing.promo_asset WHERE store_id = $1 ORDER BY asset_id`, [storeId])).rows;
}

async function checkAssets(db: PoolClient, storeId: string, uploads: readonly Asset[]) {
  if (fingerprint(await readAssets(db, storeId)) !== fingerprint(uploads)) throw conflict();
}

async function expectDraft(db: PoolClient, storeId: string, draftId: string, expected: number) {
  const draft = await getDraft(db, storeId, draftId);
  if (draft.revision !== expected) throw conflict();
  return draft;
}

function validateSelections(input: Partial<PromoInput>, snapshot: CatalogSnapshot | null) {
  const menus = snapshot?.catalog.menus ?? [];
  const selected = new Set(input.menuIds ?? []);
  const photos = new Set(menus.filter(menu => selected.has(menu.menuId)).flatMap(menu => menu.photoIds));
  if ([...selected].some(id => !menus.some(menu => menu.menuId === id))
      || input.photoIds?.some(id => !photos.has(id) || !Object.hasOwn(snapshot!.photos, id))) {
    throw conflict('PROMO_SELECTION_UNAVAILABLE');
  }
}

export function registerPromoReality(app: FastifyInstance, pool: Pool, options: PromoRealityOptions) {
  if (!options.gatewayToken) throw new Error('Promo reality requires a gateway credential');
  const storage = options.objectStorage === undefined ? configuredPromoMediaStorage() : options.objectStorage;
  const media = storage && createPromoMedia(pool, storage);
  const uploadTargets = Object.fromEntries(Object.entries(options.uploadTargets ?? {}).map(([channel, raw]) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !uploaderDomains[channel as Channel]?.includes(url.hostname)) throw new Error('Invalid official promo uploader');
    return [channel, url.href];
  }));
  const token = Buffer.from(sha256(`Bearer ${options.gatewayToken}`), 'hex');
  function owner(request: FastifyRequest): Owner {
    const { storeId } = request.params as Params;
    const actorId = request.headers['x-navis-user-id'];
    if (!isUuid(storeId) || request.headers['x-navis-store-id'] !== storeId || !isUuid(actorId)
        || request.headers['x-navis-store-role'] !== 'owner') throw new PromoRouteError(403, 'STORE_FORBIDDEN');
    return { storeId, actorId };
  }
  async function snapshot(scope: Owner) {
    return options.catalogForOwner(scope, await inStore(pool, scope.storeId, db => readAssets(db, scope.storeId)));
  }
  function mutation(req: Request) {
    return { scope: owner(req), key: req.headers['idempotency-key'] };
  }

  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const supplied = request.headers.authorization;
      if (!supplied || !timingSafeEqual(Buffer.from(sha256(supplied), 'hex'), token)) {
        throw new PromoRouteError(401, 'UNAUTHENTICATED');
      }
      owner(request);
    });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof PromoRouteError) return reply.code(error.status).send({ code: error.code, ...error.details });
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 400 || status === 413 || status === 415) {
        return reply.code(status).send({ code: status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST' });
      }
      request.log.error('Promo reality request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });

    routes.get<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/assets`, async request => {
      const scope = owner(request);
      pageRequest(request.query);
      const current = await snapshot(scope);
      const catalog = current?.catalog;
      const items = (catalog?.photos ?? []).flatMap(photo => {
        const asset = Object.hasOwn(current!.photos, photo.photoId) && current!.photos[photo.photoId];
        return asset ? [{ ...photo, fileId: asset.sourceFileId ?? asset.fileId }] : [];
      });
      const listed = page(items, request.query, photo => photo.photoId);
      return {
        ...listed, store: catalog?.store ?? null, menus: catalog?.menus ?? [],
        eligiblePhotoCount: items.filter(photo => (catalog?.menus ?? []).some(menu => menu.menuId === photo.menuId)).length,
      };
    });

    async function registerAsset(request: Request) {
      const { scope, key } = mutation(request);
      const body = record(request.body, ['fileId', 'menuId', 'rightsConfirmed']);
      const fileId = id(body.fileId);
      const requestedMenuId = body.menuId === null ? null : identifier(body.menuId);
      const menuId = requestedMenuId && (options.photoUpload?.promoMenuId?.(requestedMenuId) ?? requestedMenuId);
      if (body.rightsConfirmed !== true) throw badRequest();
      const result = await preparedCommand(pool, scope, key, ['asset', fileId, menuId], async () => {
        const upload = options.photoUpload ? await options.photoUpload.read(scope, fileId) : undefined;
        const verified = options.photoUpload ? upload : await options.verifyUpload(scope, fileId);
        if (!verified) throw notFound();
        if (!Number.isInteger(verified.width) || !Number.isInteger(verified.height)
            || verified.width < 1 || verified.height < 1 || verified.width > 16384 || verified.height > 16384) throw unavailable();
        const uploads = menuId === null ? null : await inStore(pool, scope.storeId, db => readAssets(db, scope.storeId));
        const assetId = randomUUID();
        let pendingAnalysis: Parameters<typeof queuePhotoAnalysis>[2] | undefined;
        let menuName: string | undefined;
        if (uploads) {
          const catalog = await options.catalogForOwner(scope, uploads);
          const menu = catalog?.catalog.menus.find(menu => menu.menuId === menuId);
          if (!menu) throw notFound();
          menuName = menu.names.en;
          if (!upload && options.bindPhoto) {
            const resourceId = `analysis-${fileId}`;
            const binding = await options.bindPhoto(scope, resourceId, { fileId, resourceId });
            if (binding.sha256) pendingAnalysis = { ...binding, sha256: binding.sha256, menuName: menu.names.en };
          }
        }
        const storageMenuId = menuId && (options.photoUpload?.catalogMenuId?.(menuId) ?? menuId);
        const object = upload && options.photoUpload
          ? await storePhoto(options.photoUpload.storage, scope.storeId, upload, storageMenuId) : undefined;
        return async (db, receiptId) => {
          if (uploads) await checkAssets(db, scope.storeId, uploads);
          const photoId = object ? await insertPhoto(db, scope.storeId, object) : null;
          const { rowCount } = await db.query(`
            INSERT INTO marketing.promo_asset (store_id, asset_id, file_id, menu_id, width, height, photo_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (store_id, file_id) DO NOTHING`,
          [scope.storeId, assetId, fileId, menuId, verified.width, verified.height, photoId]);
          if (!rowCount) throw conflict('ASSET_ALREADY_REGISTERED');
          const analysis = object && photoId && menuName
            ? { sha256: object.sha256, fileId: photoId, resourceId: `photo-${photoId}`, menuName }
            : pendingAnalysis;
          if (analysis) await queuePhotoAnalysis(db, scope.storeId, analysis);
          return { receipt: receipt(receiptId, assetId, 1, sources.assets) };
        };
      });
      return result.value.receipt;
    }
    routes.post(`${promoRealityPath}/assets`, { bodyLimit: 2048 }, registerAsset);
    routes.post(photoPath, { bodyLimit: 2048 }, registerAsset);

    routes.get<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/drafts`, request => {
      const { storeId } = owner(request);
      const query = pageRequest(request.query);
      return inStore(pool, storeId, async db => {
        const { rows } = await db.query<Draft>(`SELECT ${draftColumns} FROM marketing.promo_draft
          WHERE store_id = $1 AND ($2::uuid IS NULL OR draft_id > $2) ORDER BY draft_id LIMIT $3`,
        [storeId, query.cursor === null ? null : id(query.cursor), query.limit + 1]);
        return page(rows, request.query, draft => draft.draftId);
      });
    });

    routes.post<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/drafts`, { bodyLimit: 16384 }, async request => {
      const { scope, key } = mutation(request);
      const input = draftPatch(request.body);
      const result = await preparedCommand(pool, scope, key, ['create-draft', input], async () => {
        const uploads = input.menuIds?.length || input.photoIds?.length
          ? await inStore(pool, scope.storeId, db => readAssets(db, scope.storeId))
          : null;
        if (uploads) validateSelections(input, await options.catalogForOwner(scope, uploads));
        return async (db, receiptId) => {
          if (uploads) await checkAssets(db, scope.storeId, uploads);
          const draftId = randomUUID();
          await db.query('INSERT INTO marketing.promo_draft (store_id, draft_id, input) VALUES ($1, $2, $3)',
            [scope.storeId, draftId, input]);
          return { receipt: receipt(receiptId, draftId, 1, sources.drafts) };
        };
      });
      return result.value.receipt;
    });

    routes.patch<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/drafts/:draftId`, { bodyLimit: 16384 }, async request => {
      const { scope, key } = mutation(request);
      const draftId = id(request.params.draftId);
      const body = record(request.body, ['expectedRevision', 'patch']);
      const expected = revision(body.expectedRevision);
      const patch = draftPatch(body.patch);
      if (!Object.keys(patch).length) throw badRequest();
      const result = await preparedCommand(pool, scope, key, ['patch-draft', draftId, expected, patch], async () => {
        const { draft, uploads } = await inStore(pool, scope.storeId, async db => ({
          draft: await expectDraft(db, scope.storeId, draftId, expected),
          uploads: await readAssets(db, scope.storeId),
        }));
        const input = { ...draft.input, ...patch };
        validateSelections(input, await options.catalogForOwner(scope, uploads));
        return async (db, receiptId) => {
          await expectDraft(db, scope.storeId, draftId, expected);
          await checkAssets(db, scope.storeId, uploads);
          await db.query(`UPDATE marketing.promo_draft SET input = $3, revision = $4, updated_at = clock_timestamp()
            WHERE store_id = $1 AND draft_id = $2`, [scope.storeId, draftId, input, expected + 1]);
          return { receipt: receipt(receiptId, draftId, expected + 1, sources.drafts) };
        };
      });
      return result.value.receipt;
    });

    routes.post<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/drafts/:draftId/generate`, { bodyLimit: 2048 }, async (request, reply) => {
      const { scope, key } = mutation(request);
      const draftId = id(request.params.draftId);
      const body = record(request.body, ['expectedRevision', 'confirmed']);
      const expected = revision(body.expectedRevision);
      if (body.confirmed !== true) throw badRequest();
      const result = await preparedCommand(pool, scope, key, ['generate', draftId, expected], async () => {
        const { draft, uploads } = await inStore(pool, scope.storeId, async db => ({
          draft: await expectDraft(db, scope.storeId, draftId, expected),
          uploads: await readAssets(db, scope.storeId),
        }));
        const current = await options.catalogForOwner(scope, uploads);
        if (!current || current.exterior.width < 1 || current.exterior.height < 1) throw conflict('PROMO_SELECTION_UNAVAILABLE');
        validateSelections(draft.input, current);
        const field = validateInput(draft.input, current.catalog, options.references);
        if (field) throw new PromoRouteError(400, 'BAD_REQUEST', { field });
        const input = draft.input as PromoInput;
        const menu = input.menuIds.length === 1 ? current.catalog.menus.find(item => item.menuId === input.menuIds[0]) : undefined;
        const price = menu && await options.readMenuPrice?.(scope, menu.names.ko);
        const promotionFacts = menu && price ? {
          menuName: menu.names[input.locale],
          price: new Intl.NumberFormat(input.locale, { style: 'currency', currency: 'KRW' }).format(price),
        } : undefined;
        const ids = [...input.photoIds, current.catalog.store.exteriorPhotoId];
        const photos = Object.fromEntries(await Promise.all(ids.map(async photoId => {
          if (!Object.hasOwn(current.photos, photoId)) throw conflict('PROMO_SELECTION_UNAVAILABLE');
          const binding = current.photos[photoId];
          id(binding.fileId);
          identifier(binding.resourceId);
          return [photoId, options.bindPhoto ? await options.bindPhoto(scope, photoId, binding) : binding] as const;
        })));
        return async (db, receiptId) => {
          await expectDraft(db, scope.storeId, draftId, expected);
          await checkAssets(db, scope.storeId, uploads);
          const job = await insertPromoJob(db, scope, `r1-b16:${receiptId}`, fingerprint([draftId, expected]), input,
            { ...current, photos, promotionFacts, takeIndex: expected - 1 });
          await db.query(`UPDATE marketing.promo_draft SET job_id = $3, revision = $4, updated_at = clock_timestamp()
            WHERE store_id = $1 AND draft_id = $2`, [scope.storeId, draftId, job.job_id, expected + 1]);
          return { receipt: receipt(receiptId, job.job_id, 1, sources.drafts, 'promo-jobs') };
        };
      });
      return reply.code(202).send(result.value.receipt);
    });

    routes.get<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/publications`, request => {
      const { storeId } = owner(request);
      const query = pageRequest(request.query);
      return inStore(pool, storeId, async db => {
        const { rows } = await db.query<Publication>(`SELECT ${publicationColumns} FROM marketing.promo_publication
          WHERE store_id = $1 AND ($2::uuid IS NULL OR publication_id > $2) ORDER BY publication_id LIMIT $3`,
        [storeId, query.cursor === null ? null : id(query.cursor), query.limit + 1]);
        const items = rows.map(publication => ({
          ...publication, videoUrl: `${publicPromo(storeId)}/jobs/${publication.jobId}/video.mp4?download=1`,
        }));
        return { ...page(items, request.query, publication => publication.publicationId), uploadTargets };
      });
    });

    routes.post<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/jobs/:jobId/attest`, { bodyLimit: 2048 }, request => {
      const { scope, key } = mutation(request);
      const { route, link } = attestation(request.body);
      return attest(pool, scope, key, id(request.params.jobId), route, link);
    });

    for (const channel of ['place-news', 'clip', 'reels', 'shorts'] as const) {
      routes.post<{ Params: Params; Querystring: Query }>(`${promoRealityPath}/jobs/:jobId/${channel}`, { bodyLimit: 32768 }, async (request, reply) => {
        const { scope, key } = mutation(request);
        const result = await publish(pool, options, scope, key, id(request.params.jobId), publicationCard(request.body, channel), media?.readArtifact);
        return reply.code(202).send(result);
      });
    }
  });
}
