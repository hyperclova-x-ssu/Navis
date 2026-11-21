import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import { parseBill } from './catalog.ts';
import { abortCommand, commandOutcome, linkClaim, parseClaim } from './claims.ts';
import { correctPayment, createReversalTokens, parseReversal, quoteReversal, receipt } from './reversals.ts';
import { beginApproval, createBill, finishApproval, parseApproval, parseFinish, setPreparation } from './sales.ts';
import { withStoreTransaction } from './transaction.ts';
import { isUuid, object, PosError, uuid, validKey, type PosTx } from './wire.ts';

type Params = { storeId: string; id?: string; key?: string };
type Handler = (tx: PosTx, params: Params, body: unknown, key: string) => Promise<unknown>;
type Options = {
  gatewayToken?: string;
  customerToken?: string;
  now?: () => Date;
  approve?: () => boolean;
  logging?: boolean;
};

const root = '/internal/v1/pos/stores/:storeId';
const tokenHash = (value: string) => createHash('sha256').update(value).digest();

export function createPosApp(pool: Pool, {
  gatewayToken, customerToken, now = () => new Date(), approve = () => true, logging = true,
}: Options = {}) {
  if (gatewayToken && gatewayToken === customerToken) throw new Error('POS service credentials must be distinct');
  const app = createApp('pos', async () => {
    await pool.query(gatewayToken || customerToken ? 'SELECT 1 FROM pos.outbox LIMIT 0' : 'SELECT 1');
  }, logging);

  function routes(token: string, caller: 'gateway' | 'customer') {
    const expected = tokenHash(token);
    const authenticate = async (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
      if (!bearer || !timingSafeEqual(expected, tokenHash(bearer))) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
      const store = req.headers['x-navis-store-id'];
      const actorId = req.headers['x-navis-user-id'];
      if (!isUuid(store) || store !== req.params.storeId.toLowerCase()
          || (caller === 'gateway' && (req.headers['x-navis-store-role'] !== 'owner' || !isUuid(actorId)))) {
        return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      }
    };

    return (method: 'GET' | 'POST', path: string, mode: 'read' | 'write' | 'command', handler: Handler) => {
      app.route<{ Params: Params }>({
        method, url: root + path, onRequest: authenticate,
        async handler(req, reply) {
          try {
            const storeId = uuid(req.params.storeId);
            const headers = req.headers;
            const key = headers['idempotency-key'];
            if (mode === 'command' && !validKey(key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
            const actorId = caller === 'gateway' ? uuid(headers['x-navis-user-id']) : '';
            const result = await withStoreTransaction(pool, storeId,
              (db) => handler({ db, storeId, actorId, at: now() }, req.params, req.body, typeof key === 'string' ? key : ''),
              { write: mode !== 'read', readOnly: mode === 'read' });
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false && 'code' in result) {
              const status = result.code === 'CONFLICT' ? 409 : result.code === 'PREVIEW_FAILURE' ? 422
                : result.code === 'NOT_FOUND' ? 404 : 400;
              return reply.code(status).send(result);
            }
            return result;
          } catch (error) {
            if (error instanceof PosError) return reply.code(error.statusCode).send(error.result);
            throw error;
          }
        },
      });
    };
  }

  if (gatewayToken) {
    const owner = routes(gatewayToken, 'gateway');
    const tokens = createReversalTokens(gatewayToken);
    owner('POST', '/bills', 'command', (tx, _params, body, key) => createBill(tx, key, parseBill(body)));
    owner('POST', '/approvals', 'command', (tx, _params, body, key) => beginApproval(tx, key, parseApproval(body)));
    owner('POST', '/approvals/:id/finish', 'command', (tx, { id }, body, key) =>
      finishApproval(tx, key, uuid(id), parseFinish(body), approve));
    owner('GET', '/payments/:id/receipt', 'read', (tx, { id }) => receipt(tx, uuid(id)));
    owner('POST', '/payments/:id/reversal-quote', 'read', (tx, { id }, body) =>
      quoteReversal(tx, tokens, uuid(id), parseReversal(body)));
    owner('POST', '/corrections', 'command', (tx, _params, body, key) => {
      const { quoteToken, confirmed } = object(body, ['quoteToken', 'confirmed']);
      if (confirmed !== true) throw new PosError(400, 'CONFIRMATION_REQUIRED');
      if (typeof quoteToken !== 'string' || !quoteToken || quoteToken.length > 8192) throw new PosError(400, 'INVALID_REQUEST');
      return correctPayment(tx, tokens, key, quoteToken);
    });
    owner('POST', '/orders/:id/preparation', 'command', (tx, { id }, body, key) => {
      const { status } = object(body, ['status']);
      if (status !== 'preparing' && status !== 'completed') throw new PosError(400, 'INVALID_REQUEST');
      return setPreparation(tx, key, uuid(id), status);
    });
  }

  if (customerToken) {
    const customer = routes(customerToken, 'customer');
    customer('POST', '/claims', 'write', (tx, _params, body) => linkClaim(tx, parseClaim(body)));
    customer('GET', '/outcomes/:key', 'read', (tx, { key }) => {
      if (!validKey(key)) throw new PosError(400, 'INVALID_REQUEST');
      return commandOutcome(tx, key);
    });
    customer('POST', '/outcomes/:key/abort', 'write', (tx, { key }, body) => {
      if (!validKey(key)) throw new PosError(400, 'INVALID_REQUEST');
      return abortCommand(tx, key, uuid(object(body, ['claimId']).claimId));
    });
  }
  return app;
}
