import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../../infra/http.ts';
import { allowWorkloadReads, briefingReadPaths, couponReadPaths } from '../../packages/contracts/workload-read.ts';
import { preparePosRoute, type PosRouteHandler } from './preflight.ts';
import { parseBill } from './catalog.ts';
import { abortCommand, commandOutcome, linkClaim, parseClaim } from './claims.ts';
import { correctPayment, createReversalTokens, parseReversal, quoteReversal, receipt } from './reversals.ts';
import { registerNaverOrderRoutes, type PosNaverOptions } from './reality/02/naver/routes.ts';
import { registerPosRealityRoutes } from './reality/02/routes.ts';
import type { CustomerMemberClient } from './reality/05/customer-client.ts';
import { registerMemberAccountRoutes, registerMemberArchiveRoute } from './reality/05/routes.ts';
import type { VerifyReference } from './reality/08/input.ts';
import { registerCustomOrderRoutes } from './reality/08/routes.ts';
import type { ReadReceiptStatus } from './reality/09/expenses.ts';
import { registerFinanceRoutes } from './reality/09/routes.ts';
import type { VerifyTaxEvidence } from './reality/18/evidence-client.ts';
import { registerTaxRoutes } from './reality/18/routes.ts';
import type { ReadPosCatalog } from './catalog.ts';
import { beginApproval, createBill, finishApproval, parseApproval, parseFinish, setPreparation } from './sales.ts';
import { withStoreTransaction } from './transaction.ts';
import { isUuid, object, PosError, uuid, validKey } from './wire.ts';

type Params = { storeId: string; id?: string; key?: string };
type Options = {
  gatewayToken?: string;
  customerToken?: string;
  briefingToken?: string;
  couponToken?: string;
  memberCustomer?: CustomerMemberClient;
  now?: () => Date;
  approve?: () => boolean;
  logging?: boolean;
  operating?: boolean;
  readCatalog?: ReadPosCatalog;
  readReceiptStatus?: ReadReceiptStatus;
  verifyReference?: VerifyReference;
  verifyTaxEvidence?: VerifyTaxEvidence;
  naverOrders?: PosNaverOptions;
};

const root = '/internal/v1/pos/stores/:storeId';
const tokenHash = (value: string) => createHash('sha256').update(value).digest();

function operatingClock(headers: FastifyRequest['headers']) {
  const timezone = headers['x-navis-store-timezone'];
  const dayStart = headers['x-navis-business-day-start'];
  if (typeof timezone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)
    || typeof dayStart !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(dayStart)) return;
  return { timezone, dayStart };
}

async function ensureOperatingDay(db: PoolClient, storeId: string, at: Date, clock: { timezone: string; dayStart: string }) {
  const { timezone, dayStart } = clock;
  await db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
  await db.query(`
    WITH operating AS (
      SELECT (($2::timestamptz AT TIME ZONE $3) - ($4::time - time '00:00'))::date AS business_date
    )
    INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
    SELECT $1, business_date, (business_date + $4::time) AT TIME ZONE $3, (business_date + 1 + $4::time) AT TIME ZONE $3
    FROM operating
    ON CONFLICT (store_id, business_date) DO NOTHING
  `, [storeId, at, timezone, dayStart]);
}

export function createPosApp(pool: Pool, {
  gatewayToken, customerToken, briefingToken, couponToken, memberCustomer, now = () => new Date(), approve = () => true, logging = true,
  operating = false, readCatalog, readReceiptStatus, verifyReference, verifyTaxEvidence, naverOrders,
}: Options = {}) {
  if (gatewayToken && gatewayToken === customerToken) throw new Error('POS service credentials must be distinct');
  const app = createApp('pos', async () => {
    await pool.query(gatewayToken || customerToken ? 'SELECT 1 FROM pos.outbox LIMIT 0' : 'SELECT 1');
  }, logging);

  function routes(token: string, caller: 'gateway' | 'customer' | 'customer-owner', requireClock = false) {
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
          || (caller !== 'customer' && (req.headers['x-navis-store-role'] !== 'owner' || !isUuid(actorId)))) {
        return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      }
    };

    return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, mode: 'read' | 'write' | 'command', handler: PosRouteHandler) => {
      app.route<{ Params: Params }>({
        method, url: root + path, onRequest: authenticate,
        async handler(req, reply) {
          try {
            const storeId = uuid(req.params.storeId);
            const headers = req.headers;
            const key = headers['idempotency-key'];
            if (mode === 'command' && !validKey(key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
            const actorId = caller === 'gateway' ? uuid(headers['x-navis-user-id']) : '';
            const clock = caller === 'gateway' ? operatingClock(headers) : undefined;
            const ensureDay = operating && caller === 'gateway' && mode === 'command';
            if ((requireClock || ensureDay) && !clock) throw new PosError(503, 'OPERATING_CLOCK_UNAVAILABLE');
            const prepared = await preparePosRoute(pool, { storeId, actorId, clock }, now, handler,
              req.params, req.body, typeof key === 'string' ? key : '', req.query);
            const result = await withStoreTransaction(pool, storeId,
              async (db) => {
                const at = prepared.at ?? now();
                if (ensureDay && clock) await ensureOperatingDay(db, storeId, at, clock);
                return prepared.apply(db, at);
              },
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
    if (briefingToken) allowWorkloadReads(app, gatewayToken, briefingToken, root, briefingReadPaths.pos, [customerToken]);
    if (couponToken) allowWorkloadReads(app, gatewayToken, couponToken, root, couponReadPaths.pos, [customerToken, briefingToken]);
    const owner = routes(gatewayToken, 'gateway');
    const tokens = createReversalTokens(gatewayToken);
    if (operating) {
      registerPosRealityRoutes(owner, tokens, {
        readCatalog: readCatalog ?? (async () => { throw new Error('Inventory catalog lookup unavailable'); }),
      });
      if (memberCustomer) registerMemberAccountRoutes(owner, { customer: memberCustomer, readCatalog });
      const clockOwner = routes(gatewayToken, 'gateway', true);
      registerFinanceRoutes(clockOwner, { readReceiptStatus });
      registerTaxRoutes(clockOwner, { verifyEvidence: verifyTaxEvidence });
      if (naverOrders) registerNaverOrderRoutes(app, pool, { ...naverOrders, gatewayToken, now });
      registerCustomOrderRoutes(clockOwner, { customer: memberCustomer, verifyReference, reversalSecret: gatewayToken });
    } else {
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
  }

  if (customerToken) {
    const customer = routes(customerToken, 'customer');
    if (operating) {
      routes(customerToken, 'customer-owner')('GET', '/booking-tables', 'read', async ({ db, storeId }) => {
        const { rows } = await db.query<{ tableId: string; label: string; seats: number; layoutTableId: string | null }>(`
          SELECT table_id AS "tableId", label, seats, layout_table_id AS "layoutTableId"
          FROM pos.store_table WHERE store_id=$1 AND state <> 'archived' ORDER BY table_id`, [storeId]);
        const tables = rows.map(row => {
          const number = row.layoutTableId?.match(/^T([1-9][0-9]*)$/)?.[1];
          return { ...row, number: number && Number.isSafeInteger(Number(number)) ? Number(number) : null };
        });
        return { enabled: tables.length > 0, tables };
      });
    }
    if (operating && memberCustomer) registerMemberArchiveRoute(customer, { customer: memberCustomer, readCatalog });
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
