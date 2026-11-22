import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { isUuid, PosError } from '../../../wire.ts';
import { listOrders, orderRefPattern, readOrder, runFulfillment, type NaverOrderPort, type OwnerScope } from './orders.ts';
import { readSettlements, readSmartStoreStatuses, type PaymentReadPort } from './payments.ts';

export type PosNaverPort = NaverOrderPort & PaymentReadPort;
/** The store connected to this workload's NAVER account and its provider port. */
export type PosNaverOptions = { storeId: string; naver: PosNaverPort };
type Options = PosNaverOptions & { gatewayToken: string; now?: () => Date };
type Request = FastifyRequest<{ Params: { storeId: string; id?: string } }>;

const root = '/internal/v1/pos/stores/:storeId/naver';
const digest = (value: string) => createHash('sha256').update(value).digest();

export function registerNaverOrderRoutes(app: FastifyInstance, pool: Pool, { gatewayToken, storeId: connected, naver, now = () => new Date() }: Options) {
  if (!isUuid(connected)) throw new Error('POS NAVER routes require the connected store ID');
  const credential = digest(gatewayToken);
  async function authorize(req: Request, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(credential, digest(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const store = req.params.storeId.toLowerCase();
    if (!isUuid(store) || req.headers['x-navis-store-id'] !== store || !isUuid(req.headers['x-navis-user-id'])
      || req.headers['x-navis-store-role'] !== 'owner') return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    // Other stores have no NAVER account here; nothing about the connected store is exposed to them.
    if (store !== connected) return reply.code(404).send(new PosError(404, 'NAVER_NOT_CONNECTED').result);
  }

  function route(method: 'GET' | 'POST', path: string, handler: (scope: OwnerScope, req: Request) => Promise<unknown>) {
    app.route<{ Params: Request['params'] }>({
      method, url: root + path, onRequest: authorize, exposeHeadRoute: false, bodyLimit: 16 * 1024,
      async handler(req, reply) {
        const scope = { storeId: connected, actorId: req.headers['x-navis-user-id'] as string };
        if (req.params.id !== undefined && !orderRefPattern.test(req.params.id)) {
          return reply.code(400).send(new PosError(400, 'INVALID_REQUEST').result);
        }
        try {
          return await handler(scope, req);
        } catch (error) {
          if (error instanceof PosError) return reply.code(error.statusCode).send(error.result);
          throw error;
        }
      },
    });
  }

  route('GET', '/orders', (scope, req) => listOrders(pool, naver, scope, req.query, now()));
  route('GET', '/orders/:id', (scope, req) => readOrder(pool, naver, scope, req.params.id!));
  for (const kind of ['prepare', 'pickup'] as const) {
    route('POST', `/orders/:id/${kind}`, (scope, req) => runFulfillment({
      pool, naver, scope, ref: req.params.id!, kind, key: req.headers['idempotency-key'], raw: req.body, now,
    }));
  }
  route('GET', '/npay/payments/:id', (scope, req) => readSettlements(naver, scope, 'paymentId', req.params.id!, req.query, now()));
  route('GET', '/npay/pay-histories/:id', (scope, req) => readSettlements(naver, scope, 'payHistId', req.params.id!, req.query, now()));
  // Read-only: a POST only because up to 300 IDs exceed the gateway's query bound.
  route('POST', '/smartstore/order-statuses', (scope, req) => readSmartStoreStatuses(naver, scope, req.body, now()));
}
