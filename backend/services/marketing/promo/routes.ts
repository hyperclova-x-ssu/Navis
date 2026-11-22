import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { validateInput } from '../../../../frontend/server/promo/service.mjs';
import { listReferences, type loadReferences } from '../../../../frontend/server/promo/references.mjs';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { isUuid, sha256, type CatalogSnapshot, type PromoArtifacts } from './contracts.ts';
import { enqueuePromo, getPromoJob, promoView, PromoRouteError, type ConfirmedCard } from './jobs.ts';
import { byteRange, configuredPromoMediaStorage, createPromoMedia } from './media.ts';

export const promoJobsPath = '/internal/v1/marketing/stores/:storeId/promo/jobs';
const referencesPath = '/internal/v1/marketing/stores/:storeId/promo/references';
type StoreParams = { storeId: string };
type JobParams = StoreParams & { jobId: string };

interface PromoRoutesOptions {
  confirmToken?: string;
  readToken: string;
  references: ReturnType<typeof loadReferences>;
  galleryReferences?: ReturnType<typeof loadReferences>;
  catalogForStore?: (storeId: string) => Promise<CatalogSnapshot | null>;
  artifacts: Pick<PromoArtifacts, 'read'>;
  objectStorage?: ObjectStorage | null;
}

function authenticate(request: FastifyRequest<{ Params: StoreParams }>, credential: Buffer) {
  const supplied = request.headers.authorization;
  if (!supplied || !timingSafeEqual(Buffer.from(sha256(supplied), 'hex'), credential)) {
    throw new PromoRouteError(401, 'UNAUTHENTICATED');
  }
  const { storeId } = request.params;
  const actorId = request.headers['x-navis-user-id'];
  if (!isUuid(storeId) || request.headers['x-navis-store-id'] !== storeId || !isUuid(actorId)
      || request.headers['x-navis-store-role'] !== 'owner') {
    throw new PromoRouteError(403, 'STORE_FORBIDDEN');
  }
  return { storeId, actorId };
}

function checkedCard(body: unknown, key: unknown): ConfirmedCard {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PromoRouteError(400, 'BAD_REQUEST');
  const card = body as Partial<ConfirmedCard>;
  const fields = ['source', 'proposalId', 'snapshotRevision', 'input'];
  if (Object.keys(card).some(field => !fields.includes(field)) || card.source !== 'card'
      || !isUuid(card.proposalId) || !Number.isSafeInteger(card.snapshotRevision) || card.snapshotRevision! < 0
      || !card.input || typeof card.input !== 'object' || Array.isArray(card.input)
      || key !== `navis:${card.proposalId}`) {
    throw new PromoRouteError(400, 'BAD_REQUEST');
  }
  return card as ConfirmedCard;
}

function sendBytes(reply: FastifyReply, bytes: Buffer, mime: string, header?: string) {
  reply.type(mime).header('accept-ranges', 'bytes').header('x-content-type-options', 'nosniff');
  if (!header) return reply.send(bytes);
  const range = byteRange(header, bytes.length);
  if (!range) return reply.code(416).header('content-range', `bytes */${bytes.length}`).send();
  return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`)
    .send(bytes.subarray(range.start, range.end + 1));
}

export function registerPromoRoutes(app: FastifyInstance, database: Pool, options: PromoRoutesOptions) {
  const { confirmToken, catalogForStore } = options;
  if (!options.readToken || Boolean(confirmToken) !== Boolean(catalogForStore) || confirmToken === options.readToken) {
    throw new Error('Promo confirmation and read credentials must be distinct');
  }
  const confirm = confirmToken && Buffer.from(sha256(`Bearer ${confirmToken}`), 'hex');
  const read = Buffer.from(sha256(`Bearer ${options.readToken}`), 'hex');
  const storage = options.objectStorage === undefined ? configuredPromoMediaStorage() : options.objectStorage;
  const media = storage && createPromoMedia(database, storage);
  const gallery = options.galleryReferences ?? options.references;
  const authorizeRead = async (request: FastifyRequest<{ Params: JobParams }>) => {
    authenticate(request, read);
    if (!isUuid(request.params.jobId)) throw new PromoRouteError(404, 'NOT_FOUND');
  };
  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof PromoRouteError) return reply.code(error.status).send({ code: error.code, ...error.details });
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 413) return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE' });
      if (status === 415) return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      if (status === 400) return reply.code(400).send({ code: 'BAD_REQUEST' });
      request.log.error('Promo request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });

    if (confirm && catalogForStore) routes.post<{ Params: StoreParams }>(promoJobsPath, {
      bodyLimit: 16 * 1024,
      onRequest: async request => { authenticate(request, confirm); },
    }, async (request, reply) => {
      const scope = authenticate(request, confirm);
      const card = checkedCard(request.body, request.headers['idempotency-key']);
      const job = await enqueuePromo(database, scope, `navis:${card.proposalId}`, card, async () => {
        const snapshot = await catalogForStore(scope.storeId);
        if (!snapshot) throw new PromoRouteError(404, 'NOT_FOUND');
        const field = validateInput(card.input, snapshot.catalog, options.references);
        if (field) throw new PromoRouteError(400, 'BAD_REQUEST', { field });
        const ids = [...card.input.photoIds, snapshot.catalog.store.exteriorPhotoId];
        const photos = Object.fromEntries(ids.map(id => {
          const binding = Object.hasOwn(snapshot.photos, id) ? snapshot.photos[id] : undefined;
          if (!binding || !isUuid(binding.fileId) || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.resourceId)) {
            throw new PromoRouteError(400, 'BAD_REQUEST', { field: 'photoIds' });
          }
          return [id, binding];
        }));
        return { catalog: snapshot.catalog, exterior: snapshot.exterior, photos };
      });
      return reply.code(202).send(promoView(job));
    });

    routes.get<{ Params: JobParams }>(`${promoJobsPath}/:jobId`, { onRequest: authorizeRead }, async ({ params }) =>
      promoView(await getPromoJob(database, params.storeId, params.jobId)));

    routes.get<{ Params: StoreParams }>(referencesPath, async request => {
      const { storeId } = authenticate(request, read);
      const list = listReferences(gallery);
      const names = media ? await media.referenceNames(storeId) : undefined;
      return { ...list, storeId, references: list.references.flatMap(ref => {
        if (names && (!names.has(`reference/${ref.id}/poster.jpg`) || !names.has(`reference/${ref.id}/preview.mp4`))) return [];
        const base = `/api/v1/stores/${storeId}/promo/references/${ref.id}`;
        return [{ ...ref, posterUrl: `${base}/poster.jpg`, previewUrl: `${base}/preview.mp4` }];
      }) };
    });

    routes.get<{ Params: StoreParams & { referenceId: string; asset: string } }>(
      `${referencesPath}/:referenceId/:asset`, async (request, reply) => {
        const { storeId } = authenticate(request, read);
        const { referenceId, asset } = request.params;
        const ref = gallery.refs.get(referenceId);
        if (!ref || (asset !== 'poster.jpg' && asset !== 'preview.mp4')) throw new PromoRouteError(404, 'NOT_FOUND');
        const mime = asset === 'poster.jpg' ? 'image/jpeg' : 'video/mp4';
        if (media) {
          const row = await media.fixture(storeId, `reference/${referenceId}/${asset}`);
          if (!row) throw new PromoRouteError(404, 'NOT_FOUND');
          if (row.content_type !== mime) throw new PromoRouteError(503, 'UNAVAILABLE');
          return media.send(reply, row, { range: request.headers.range, privateCache: true });
        }
        const bytes = await readFile(asset === 'poster.jpg' ? ref.posterPath : ref.previewPath);
        reply.header('cache-control', 'private, max-age=3600');
        return sendBytes(reply, bytes, mime, request.headers.range);
      });

    routes.get<{ Params: JobParams; Querystring: { download?: string } }>(
      `${promoJobsPath}/:jobId/video.mp4`, { onRequest: authorizeRead }, async ({ params, headers, query }, reply) => {
        const job = await getPromoJob(database, params.storeId, params.jobId);
        if (job.status !== 'done' || !job.asset_id) throw new PromoRouteError(404, 'NOT_FOUND');
        const scope = { storeId: params.storeId, resourceId: params.jobId };
        const stored = await media?.findArtifact(scope, job.asset_id);
        if (stored && (!stored.ready || stored.purpose !== 'promo_output' || stored.bytes !== job.result?.sizeBytes)) {
          throw new PromoRouteError(503, 'UNAVAILABLE');
        }
        if (query.download === '1') reply.header('content-disposition', `attachment; filename="navis-promo-${job.job_id}.mp4"`);
        if (stored && media) return media.send(reply, stored, { range: headers.range });
        const { bytes, mime } = await options.artifacts.read(scope, job.asset_id);
        if (mime !== 'video/mp4' || bytes.length !== job.result?.sizeBytes) throw new PromoRouteError(503, 'UNAVAILABLE');
        return sendBytes(reply, bytes, mime, headers.range);
      });

    routes.get<{ Params: JobParams & { asset: string } }>(
      `${promoJobsPath}/:jobId/:asset`, { onRequest: authorizeRead }, async ({ params }, reply) => {
        const { asset, jobId, storeId } = params;
        const poster = asset === 'poster.jpg';
        if (!media || (!poster && asset !== 'scene.html')) throw new PromoRouteError(404, 'NOT_FOUND');
        const job = await getPromoJob(database, storeId, jobId);
        const fileId = poster ? job.result?.posterAssetId : job.result?.sceneAssetId;
        if (job.status !== 'done' || !fileId) throw new PromoRouteError(404, 'NOT_FOUND');
        const row = await media.findArtifact({ storeId, resourceId: jobId }, fileId);
        if (!row || !row.ready || row.purpose !== (poster ? 'promo_poster' : 'promo_scene')) {
          throw new PromoRouteError(503, 'UNAVAILABLE');
        }
        if (!poster) reply.header('content-disposition', 'attachment; filename="scene.html"')
          .header('content-security-policy', "default-src 'none'; sandbox");
        return media.send(reply, row);
      });
  });
}
