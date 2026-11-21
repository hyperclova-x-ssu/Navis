import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import {
  catalogQuerySchema, catalogResponseSchema, errorResponseSchema,
  type CatalogItem, type CatalogResponse,
} from '../../packages/contracts/index.ts';
import { ReceiptError, recordReceipt } from './receipts.ts';
import { registerForecastRoutes } from './forecast/routes.ts';
import { withStoreTransaction } from './store-transaction.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (token: string) => createHash('sha256').update(token).digest();
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

export function createInventoryApp(
  pool: Pool, gatewayToken: string, logging = true, now = () => new Date(), forecastToken?: string,
) {
  const gatewayDigest = digest(gatewayToken);
  const app = createApp('inventory', async () => {
    await pool.query('SELECT 1 FROM inventory.menu_item LIMIT 0');
    if (forecastToken) await pool.query('SELECT 1 FROM inventory.demand_forecast LIMIT 0');
  }, logging);

  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(gatewayDigest, digest(bearer))) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    }
  }

  app.get<{ Querystring: { storeId: string } }>('/internal/v1/inventory/catalog', {
    onRequest: authenticate,
    schema: {
      querystring: catalogQuerySchema,
      response: {
        200: catalogResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        403: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (req, reply) => {
    const requestedStore = req.query.storeId;
    if (!uuid.test(requestedStore)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST' });
    }

    const verifiedStore = req.headers['x-navis-store-id'];
    if (typeof verifiedStore !== 'string' || !uuid.test(verifiedStore)
        || verifiedStore.toLowerCase() !== requestedStore.toLowerCase()
        || req.headers['x-navis-store-role'] !== 'owner') {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }

    const items = await withStoreTransaction(pool, verifiedStore, async (client) => {
      const { rows } = await client.query<CatalogItem>(`
        SELECT menu_id AS "menuId", name, category, price::double precision AS price, sale_status AS "saleStatus"
        FROM inventory.menu_item
        WHERE store_id = $1 AND kind = 'menu' AND deleted_at IS NULL
        ORDER BY menu_id
      `, [verifiedStore]);
      return rows;
    }, { readOnly: true });

    return { items } satisfies CatalogResponse;
  });

  app.post<{ Params: { storeId: string } }>('/internal/v1/inventory/stores/:storeId/receipts', {
    onRequest: authenticate,
  }, async (req, reply) => {
    const { storeId } = req.params;
    const verifiedStore = req.headers['x-navis-store-id'];
    const key = req.headers['idempotency-key'];
    if (!isUuid(storeId)) return reply.code(400).send({ code: 'VALIDATION', reason: 'INVALID_REQUEST' });
    if (!isUuid(verifiedStore) || storeId.toLowerCase() !== verifiedStore.toLowerCase()
      || req.headers['x-navis-store-role'] !== 'owner' || !isUuid(req.headers['x-navis-user-id'])) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_:.~-]{1,160}$/.test(key)) {
      return reply.code(400).send({ code: 'VALIDATION', reason: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
      || !('polId' in body) || !isUuid(body.polId) || !('qty' in body)
      || typeof body.qty !== 'number' || !Number.isSafeInteger(body.qty) || body.qty < 1) {
      return reply.code(400).send({ code: 'VALIDATION', reason: 'INVALID_REQUEST' });
    }

    const store = verifiedStore.toLowerCase();
    const input = { polId: body.polId.toLowerCase(), qty: body.qty };
    try {
      return await withStoreTransaction(pool, store, (db) => recordReceipt(db, store, now(), key, input));
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      const code = error.status === 409 ? 'CONFLICT' : error.status === 404 ? 'NOT_FOUND' : 'VALIDATION';
      return reply.code(error.status).send({ code, reason: error.reason });
    }
  });

  registerForecastRoutes(app, pool, gatewayToken, forecastToken, now);
  return app;
}
