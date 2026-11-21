import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { validateInput } from '../../../../frontend/server/promo/service.mjs';
import type { loadReferences } from '../../../../frontend/server/promo/references.mjs';
import { isUuid, sha256, type CatalogSnapshot, type PromoArtifacts } from './contracts.ts';
import { enqueuePromo, getPromoJob, promoView, PromoRouteError, type ConfirmedCard } from './jobs.ts';

export const promoJobsPath = '/internal/v1/marketing/stores/:storeId/promo/jobs';
type StoreParams = { storeId: string };
type JobParams = StoreParams & { jobId: string };

interface PromoRoutesOptions {
  confirmToken: string;
  readToken: string;
  references: ReturnType<typeof loadReferences>;
  catalogForStore(storeId: string): Promise<CatalogSnapshot | null>;
  artifacts: Pick<PromoArtifacts, 'read'>;
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

function byteRange(header: string, size: number) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!range || (!range[1] && !range[2])) return null;
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export function registerPromoRoutes(app: FastifyInstance, database: Pool, options: PromoRoutesOptions) {
  if (!options.confirmToken || !options.readToken || options.confirmToken === options.readToken) {
    throw new Error('Promo confirmation and read credentials must be distinct');
  }
  const confirm = Buffer.from(sha256(`Bearer ${options.confirmToken}`), 'hex');
  const read = Buffer.from(sha256(`Bearer ${options.readToken}`), 'hex');
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

    routes.post<{ Params: StoreParams }>(promoJobsPath, {
      bodyLimit: 16 * 1024,
      onRequest: async request => { authenticate(request, confirm); },
    }, async (request, reply) => {
      const scope = authenticate(request, confirm);
      const card = checkedCard(request.body, request.headers['idempotency-key']);
      const job = await enqueuePromo(database, scope, `navis:${card.proposalId}`, card, async () => {
        const snapshot = await options.catalogForStore(scope.storeId);
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

    routes.get<{ Params: JobParams; Querystring: { download?: string } }>(
      `${promoJobsPath}/:jobId/video.mp4`, { onRequest: authorizeRead }, async ({ params, headers, query }, reply) => {
        const job = await getPromoJob(database, params.storeId, params.jobId);
        if (job.status !== 'done' || !job.asset_id) throw new PromoRouteError(404, 'NOT_FOUND');
        const { bytes, mime } = await options.artifacts.read({ storeId: params.storeId, resourceId: params.jobId }, job.asset_id);
        if (mime !== 'video/mp4' || bytes.length !== job.result?.sizeBytes) throw new PromoRouteError(503, 'UNAVAILABLE');
        reply.type(mime).header('accept-ranges', 'bytes').header('x-content-type-options', 'nosniff');
        if (query.download === '1') reply.header('content-disposition', `attachment; filename="navis-promo-${job.job_id}.mp4"`);
        if (!headers.range) return reply.send(bytes);
        const range = byteRange(headers.range, bytes.length);
        if (!range) return reply.code(416).header('content-range', `bytes */${bytes.length}`).send();
        return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`)
          .send(bytes.subarray(range.start, range.end + 1));
      });
  });
}
