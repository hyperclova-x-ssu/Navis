import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { isUuid, sha256 } from '../promo/contracts.ts';
import { enqueueSensAttempt, getSensAttempt, sensReceipt } from './ledger.ts';
import { confirmedCard, SensError, type SensPolicy } from './policy.ts';

export const sensAttemptsPath = '/internal/v1/marketing/stores/:storeId/sens/attempts';
type StoreParams = { storeId: string };
type ReceiptParams = StoreParams & { receiptId: string };

function owner(request: FastifyRequest<{ Params: StoreParams }>, token: Buffer) {
  const authorization = request.headers.authorization;
  if (!authorization || !timingSafeEqual(Buffer.from(sha256(authorization), 'hex'), token)) {
    throw new SensError('UNAUTHENTICATED');
  }
  const { storeId } = request.params;
  const actorId = request.headers['x-navis-user-id'];
  if (!isUuid(storeId) || request.headers['x-navis-store-id'] !== storeId || !isUuid(actorId)
    || request.headers['x-navis-store-role'] !== 'owner') {
    throw new SensError('FORBIDDEN');
  }
  return { storeId, actorId };
}

export function registerSensRoutes(app: FastifyInstance, pool: Pool, options: {
  confirmToken: string; readToken: string; policy: SensPolicy;
}) {
  if (!options.confirmToken || !options.readToken || options.confirmToken === options.readToken) {
    throw new Error('SMS confirmation and read credentials must be distinct');
  }
  const confirm = Buffer.from(sha256(`Bearer ${options.confirmToken}`), 'hex');
  const read = Buffer.from(sha256(`Bearer ${options.readToken}`), 'hex');

  app.register(async routes => {
    routes.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof SensError) {
        if (error.retryAfter) reply.header('retry-after', String(error.retryAfter));
        return reply.code(error.status).send({ code: error.code });
      }
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 413) return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE' });
      if (status === 415) return reply.code(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      if (status === 400) return reply.code(400).send({ code: 'BAD_REQUEST' });
      request.log.error('Test SMS request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    routes.post<{ Params: StoreParams }>(sensAttemptsPath, {
      bodyLimit: 2 * 1024,
      onRequest: async request => { owner(request, confirm); },
    }, async (request, reply) => {
      const scope = owner(request, confirm);
      const card = confirmedCard(request.body, request.headers['idempotency-key']);
      const attempt = await enqueueSensAttempt(pool, scope, card, options.policy);
      const settled = ['accepted', 'blocked', 'failed'].includes(attempt.state);
      return reply.code(settled ? 200 : 202).send(sensReceipt(attempt));
    });
    routes.get<{ Params: ReceiptParams }>(`${sensAttemptsPath}/:receiptId`,
      { onRequest: async request => { owner(request, read); } }, async request => {
        const scope = owner(request, read);
        if (!isUuid(request.params.receiptId)) throw new SensError('NOT_FOUND');
        return sensReceipt(await getSensAttempt(pool, scope, request.params.receiptId));
      });
  });
}
