import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { inStore } from '../transaction.ts';
import { PromoRouteError } from './jobs.ts';
import { isUuid, sha256 } from './contracts.ts';
import { bundledPhotoList } from './bundled-photos.ts';
import { photoContentUrl, photoPath, readPhoto, readPhotoCatalog, type PhotoCursor } from './photo-assets.ts';

type BrowserParams = { storeId: string; photoId: string };
type CatalogQuery = { cursor?: string; limit?: string };
type Options = { gatewayToken: string; workerToken?: string; bundledStoreId?: string; storage?: Pick<ObjectStorage, 'get'> };

function authorize(request: FastifyRequest, tokenHash: Buffer) {
  const value = request.headers.authorization;
  if (!value || !timingSafeEqual(Buffer.from(sha256(value), 'hex'), tokenHash)) {
    throw new PromoRouteError(401, 'UNAUTHENTICATED');
  }
}

function catalogQuery(query: CatalogQuery) {
  const { limit, cursor } = query;
  const size = limit === undefined ? 100 : Number(limit);
  const match = typeof cursor === 'string' && /^([01]):(.+)$/.exec(cursor);
  if (Object.keys(query).some(key => key !== 'limit' && key !== 'cursor')
    || (limit !== undefined && (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit)))
    || !Number.isInteger(size) || size < 1 || size > 100 || (cursor !== undefined && (!match || !isUuid(match[2])))) {
    throw new PromoRouteError(400, 'BAD_REQUEST');
  }
  const after: PhotoCursor | null = match ? { other: match[1] === '1', id: match[2] } : null;
  return { size, after };
}

function page<T extends { photoId: string; other: boolean }>(rows: T[], size: number) {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items: items.map(({ other: _other, ...photo }) => photo),
    nextCursor: last && rows.length > size ? `${Number(last.other)}:${last.photoId}` : null,
  };
}

export function registerPhotoReads(app: FastifyInstance, pool: Pool, { gatewayToken, workerToken, bundledStoreId, storage }: Options) {
  if (!gatewayToken || (storage && (!workerToken || gatewayToken === workerToken))) {
    throw new Error('Photo routes require distinct gateway and worker credentials');
  }
  const gateway = Buffer.from(sha256(`Bearer ${gatewayToken}`), 'hex');
  const worker = workerToken && Buffer.from(sha256(`Bearer ${workerToken}`), 'hex');
  const fallback = bundledStoreId && !storage ? bundledPhotoList(bundledStoreId).sort((a, b) => a.photoId.localeCompare(b.photoId)) : [];

  async function sendContent(req: FastifyRequest, reply: FastifyReply, storeId: string, photoId: string, browser: boolean) {
    if (!isUuid(storeId) || !isUuid(photoId)) throw new PromoRouteError(400, 'BAD_REQUEST');
    const photo = storage && await inStore(pool, storeId, db => readPhoto(db, storeId, photoId));
    if (!photo) throw new PromoRouteError(404, 'NOT_FOUND');
    const etag = `"${photo.sha256}"`;
    const cache = () => reply.header('cache-control', 'private, max-age=86400').header('etag', etag).header('vary', 'Authorization');
    if (browser && req.headers['if-none-match']?.split(',').some(value => {
      const match = value.trim();
      return match === '*' || match.replace(/^W\//, '') === etag;
    })) return cache().code(304).send();

    const object = await storage!.get(photo.objectKey);
    if (!object || object.contentLength !== photo.bytes || object.contentType !== photo.contentType) {
      object?.body.destroy();
      throw new PromoRouteError(503, 'UNAVAILABLE');
    }
    if (browser) cache();
    return reply.type(photo.contentType).header('content-length', photo.bytes).header('x-content-type-options', 'nosniff').send(object.body);
  }

  function browserStore(req: FastifyRequest<{ Params: BrowserParams }>) {
    authorize(req, gateway);
    const { storeId } = req.params;
    if (!isUuid(storeId) || req.headers['x-navis-store-id'] !== storeId || !isUuid(req.headers['x-navis-user-id'])
      || req.headers['x-navis-store-role'] !== 'owner') throw new PromoRouteError(403, 'STORE_FORBIDDEN');
    return storeId;
  }

  app.register(async routes => {
    routes.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'no-store'); });
    routes.setErrorHandler((error, req, reply) => {
      if (error instanceof PromoRouteError) return reply.code(error.status).send({ code: error.code });
      req.log.error('Marketing photo read failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    routes.get<{ Params: BrowserParams; Querystring: CatalogQuery }>(photoPath, async req => {
      const storeId = browserStore(req);
      const { size, after } = catalogQuery(req.query);
      if (storage) {
        const rows = await inStore(pool, storeId, db => readPhotoCatalog(db, storeId, after, size + 1));
        return page(rows.map(photo => ({ ...photo, contentUrl: photoContentUrl(storeId, photo.photoId) })), size);
      }
      const rows = storeId === bundledStoreId && !after?.other
        ? fallback.filter(photo => !after || photo.photoId > after.id).map(photo => ({ ...photo, other: false })) : [];
      return page(rows, size);
    });
    routes.get<{ Params: BrowserParams }>(`${photoPath}/:photoId/content`, (req, reply) =>
      sendContent(req, reply, browserStore(req), req.params.photoId, true));
    if (worker) routes.get<{ Params: { photoId: string } }>('/internal/photos/:photoId/content', (req, reply) => {
      authorize(req, worker);
      const storeId = req.headers['x-navis-store-id'];
      if (!isUuid(storeId)) throw new PromoRouteError(400, 'BAD_REQUEST');
      return sendContent(req, reply, storeId, req.params.photoId, false);
    });
  });
}
