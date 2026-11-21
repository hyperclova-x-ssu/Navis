import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import {
  cancelReservation, ClaimError, lockClaim, readClaim, reserveClaim, settleClaim, withCustomerStore, type Claim,
} from './claims.ts';
import { isRecord, isUuid, type ClaimKind, type PosClient } from './pos-client.ts';

type Params = { storeId: string; id: string };
type Options = { gatewayToken?: string; pos?: PosClient; now?: () => Date; logging?: boolean; consume?: boolean };
const root = '/internal/v1/customer/stores/:storeId';
const hash = (value: string) => createHash('sha256').update(value).digest();
const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });

function view(claim: Claim) {
  const { claimId, kind, sourceId, sourceVersion, state, settlementId, billId, orderId, releaseReason } = claim;
  return {
    claimId, kind, sourceId, sourceVersion, state, settlementId, billId, orderId, releaseReason,
    ...(claim.posBound && { commandKey: claim.commandKey }),
  };
}

function identity(req: FastifyRequest<{ Params: Params }>) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9_:.~-]{1,160}$/.test(key)) {
    throw new ClaimError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const body = req.body;
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.sourceVersion !== 'number'
    || !Number.isInteger(body.sourceVersion) || body.sourceVersion < 1 || body.sourceVersion > 2_147_483_647) {
    throw new ClaimError(400, 'INVALID_REQUEST');
  }
  return { sourceId: req.params.id, sourceVersion: body.sourceVersion, actorId: req.headers['x-navis-user-id'] as string,
    requestKey: key };
}

export function createCustomerApp(pool: Pool, { gatewayToken, pos, now = () => new Date(), logging = true, consume }: Options = {}) {
  const app = createApp('customer', async () => {
    await pool.query(gatewayToken || consume ? 'SELECT 1 FROM customer.pos_claim LIMIT 0' : 'SELECT 1');
  }, logging);
  if (!gatewayToken) return app;
  if (!pos) throw new Error('Customer claim routes require a POS client');
  const posClient = pos;
  const expected = hash(gatewayToken);

  async function authenticate(req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(expected, hash(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const store = req.headers['x-navis-store-id'];
    if (!isUuid(store) || req.params.storeId !== store || !isUuid(req.headers['x-navis-user-id'])
      || req.headers['x-navis-store-role'] !== 'owner') return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    if (!isUuid(req.params.id)) return reply.code(400).send({ code: 'VALIDATION', reason: 'INVALID_REQUEST' });
  }

  async function getClaim(storeId: string, claimId: string) {
    const claim = await withCustomerStore(pool, storeId, db => readClaim(db, storeId, claimId));
    if (!claim) throw new ClaimError(404, 'CLAIM_NOT_FOUND');
    return claim;
  }

  async function reconcile(storeId: string, claim: Claim, abandon = false) {
    if (claim.state !== 'held') return claim;
    // POS may have accepted a bind before its response was lost. Retry with the same IDs.
    // Until a bind is confirmed, the key stays private so it cannot be used as a walk-in approval.
    if (!claim.posBound && !await posClient.bind(storeId, claim)) return getClaim(storeId, claim.claimId);
    const outcome = abandon ? await posClient.abort(storeId, claim) : await posClient.outcome(storeId, claim.commandKey);
    return withCustomerStore(pool, storeId, async db => {
      const current = await lockClaim(db, storeId, claim.claimId);
      if (!current) throw new ClaimError(404, 'CLAIM_NOT_FOUND');
      return settleClaim(db, storeId, current, outcome);
    });
  }

  type Handler = (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => Promise<unknown>;
  function route(method: 'GET' | 'POST', path: string, handle: Handler) {
    app.route<{ Params: Params }>({
      method, url: root + path, onRequest: authenticate,
      async handler(req, reply) {
        try {
          return await handle(req, reply);
        } catch (error) {
          if (!(error instanceof ClaimError)) throw error;
          const code = error.status === 409 ? 'CONFLICT' : error.status === 404 ? 'NOT_FOUND' : 'VALIDATION';
          return reply.code(error.status).send({ code, reason: error.reason });
        }
      },
    });
  }

  const respond = (reply: FastifyReply, claim: Claim) => reply.code(claim.state === 'held' ? 202 : 200).send(view(claim));

  const reserve = (kind: ClaimKind): Handler => async (req, reply) => {
    const { storeId } = req.params;
    const request = identity(req);
    const businessDate = seoulDate.format(new Date(now().getTime() - 5 * 60 * 60 * 1000));
    const claim = await withCustomerStore(pool, storeId, db => reserveClaim(db, storeId, kind, request, businessDate));
    return respond(reply, await reconcile(storeId, claim));
  };

  route('POST', '/reservations/:id/first-order-claim', reserve('reservation_first_order'));
  route('POST', '/memberships/:id/use-claim', reserve('membership_use'));
  route('POST', '/reservations/:id/cancel', async (req) => {
    const { storeId } = req.params;
    const request = identity(req);
    return withCustomerStore(pool, storeId, db => cancelReservation(db, storeId, request));
  });
  route('GET', '/claims/:id', async ({ params: { storeId, id } }) => view(await getClaim(storeId, id)));
  for (const operation of ['reconcile', 'abort'] as const) {
    route('POST', `/claims/:id/${operation}`, async (req, reply) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 0) throw new ClaimError(400, 'INVALID_REQUEST');
      const { storeId, id } = req.params;
      return respond(reply, await reconcile(storeId, await getClaim(storeId, id), operation === 'abort'));
    });
  }
  return app;
}
