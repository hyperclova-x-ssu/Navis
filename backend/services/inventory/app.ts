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
import type { VerifyMenuPhoto } from './reality/01/commands.ts';
import { readMenu } from './reality/01/read.ts';
import { registerPlacePublication } from './reality/01/place-routes.ts';
import { registerPublicationApprovals } from './reality/01/publication-routes.ts';
import { registerMenuRoutes } from './reality/01/routes.ts';
import { registerCommerceStock } from './reality/03/commerce-routes.ts';
import { registerStockRoutes } from './reality/03/routes.ts';
import { date, StockError } from './reality/03/wire.ts';
import { registerPurchaseRoutes } from './reality/04/routes.ts';
import { registerSupplierMessages } from './reality/04/supplier-message.ts';
import { allowWorkloadReads, briefingReadPaths, couponReadPaths } from '../../packages/contracts/workload-read.ts';
import { withStoreTransaction } from './store-transaction.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (token: string) => createHash('sha256').update(token).digest();
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

export function createInventoryApp(
  pool: Pool, gatewayToken: string, logging = true, now = () => new Date(), forecastToken?: string,
  { verifyPhoto, posCatalogToken, briefingToken, couponToken, place, commerce, supplier }: {
    verifyPhoto?: VerifyMenuPhoto; posCatalogToken?: string; briefingToken?: string; couponToken?: string;
    place?: Parameters<typeof registerPlacePublication>[3]; commerce?: Parameters<typeof registerCommerceStock>[3];
    supplier?: Pick<Parameters<typeof registerSupplierMessages>[3], 'storeId' | 'workerToken'>;
  } = {},
) {
  const gatewayDigest = digest(gatewayToken);
  const app = createApp('inventory', async () => {
    await pool.query('SELECT 1 FROM inventory.menu_item LIMIT 0');
    if (forecastToken) await pool.query('SELECT 1 FROM inventory.demand_forecast LIMIT 0');
  }, logging);
  if (supplier && [gatewayToken, forecastToken, posCatalogToken, briefingToken, couponToken].includes(supplier.workerToken)) {
    throw new Error('Supplier dispatch requires a distinct Inventory workload credential');
  }
  if (briefingToken) allowWorkloadReads(app, gatewayToken, briefingToken, '/internal/v1/inventory/stores/:storeId',
    briefingReadPaths.inventory, [forecastToken, posCatalogToken]);
  if (couponToken) allowWorkloadReads(app, gatewayToken, couponToken, '/internal/v1/inventory/stores/:storeId',
    couponReadPaths.inventory, [forecastToken, posCatalogToken, briefingToken]);

  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(gatewayDigest, digest(bearer))) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    }
  }

  if (couponToken) app.get<{ Params: { storeId: string }; Querystring: { businessDate?: string } }>(
    '/internal/v1/inventory/stores/:storeId/coupon-expiring-lots', { onRequest: authenticate, exposeHeadRoute: false },
    async (req, reply) => {
      const { storeId } = req.params;
      if (!isUuid(storeId) || req.headers['x-navis-store-id'] !== storeId || !isUuid(req.headers['x-navis-user-id'])
        || req.headers['x-navis-store-role'] !== 'owner') return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      let day: string;
      try { day = date(req.query.businessDate, 'businessDate'); }
      catch (error) {
        if (!(error instanceof StockError)) throw error;
        return reply.code(400).send({ code: 'INVALID_REQUEST', field: error.field });
      }
      return withStoreTransaction(pool, storeId, async db => {
        type Candidate = { lotId: string; itemName: string; quantity: number; expiresOn: string; menuId: string };
        const { rows } = await db.query<Candidate>(`
          SELECT b.batch_id AS "lotId", coalesce(item.name, m.name) AS "itemName", b.expires_on::text AS "expiresOn",
            m.menu_id AS "menuId", floor(b.remaining_base / portion.quantity)::double precision AS quantity
          FROM inventory.stock_batch b
          JOIN inventory.inventory_item item USING (store_id, item_id)
          JOIN inventory.recipe_current c USING (store_id)
          JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
          JOIN inventory.menu_item m USING (store_id, menu_id)
          CROSS JOIN LATERAL (
            SELECT sum((ingredient->>'quantity_base')::numeric) AS quantity
            FROM jsonb_array_elements(v.ingredients) ingredient WHERE ingredient->>'item_id' = b.item_id::text
          ) portion
          WHERE b.store_id = $1 AND b.expires_on = $2::date AND b.discarded_at IS NULL AND c.menu_id = c.component_id
            AND item.archived_at IS NULL AND m.deleted_at IS NULL AND m.kind = 'menu' AND m.sale_status = 'selling'
            AND portion.quantity > 0 AND b.remaining_base >= portion.quantity
          ORDER BY b.batch_id, jsonb_array_length(v.ingredients), m.menu_id`, [storeId, day]);
        if (!rows.length) return { items: [] };
        const menuIds = [...new Set(rows.map(row => row.menuId))];
        const { items: recipes } = await readMenu(db, storeId, now(), { menuIds, limit: menuIds.length });
        const valid = new Set(recipes.filter(menu => menu.unitCost !== null).map(menu => menu.menuId));
        const items = new Map<string, Omit<Candidate, 'menuId'>>();
        for (const { menuId, ...lot } of rows) {
          if (valid.has(menuId) && !items.has(lot.lotId)) items.set(lot.lotId, lot);
        }
        return { items: [...items.values()] };
      }, { readOnly: true });
    },
  );

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
      const { rows } = await client.query<Omit<CatalogItem, 'seasonal'> & { seasonal: string | null }>(`
        SELECT menu_id AS "menuId", name, CASE category WHEN 'drink' THEN 'beverage' ELSE category END AS category,
               seasonal, price::double precision AS price, sale_status AS "saleStatus"
        FROM inventory.menu_item
        WHERE store_id = $1 AND kind = 'menu' AND deleted_at IS NULL
        ORDER BY menu_id
      `, [verifiedStore]);
      return rows.map(({ seasonal, ...menu }) => seasonal === null ? menu : { ...menu, seasonal });
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
  registerMenuRoutes(app, pool, gatewayToken, { now, verifyPhoto, posCatalogToken });
  registerStockRoutes(app, pool, gatewayToken, { now });
  registerPurchaseRoutes(app, pool, gatewayToken, { now, receiptStatusToken: posCatalogToken });
  if (place || commerce || supplier) registerPublicationApprovals(app, pool, gatewayToken);
  if (place) registerPlacePublication(app, pool, gatewayToken, place);
  if (commerce) registerCommerceStock(app, pool, gatewayToken, commerce);
  if (supplier) registerSupplierMessages(app, pool, gatewayToken, { ...supplier, now });
  return app;
}
