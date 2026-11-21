import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { dbConfig, dbPool } from '../../packages/db/index.ts';
import { runMigrations } from '../../packages/db/migrate.ts';
import { createInventoryApp } from './app.ts';
import { seed, syntheticStoreId } from './seed.ts';
import { withStoreTransaction } from './store-transaction.ts';

const cafeId = seedCatalog.store.storeId;
const emptyStoreId = '33123a19-6780-4d38-9bca-ce96efcf8560';
const syntheticMenu = {
  menuId: '33123a19-6780-4d38-9bca-ce96efcf8561',
  name: 'Synthetic store tea',
  category: 'drink',
  price: 3100,
  saleStatus: 'sold_out',
};
const retailItemId = '33123a19-6780-4d38-9bca-ce96efcf8562';
const extraMenuId = '33123a19-6780-4d38-9bca-ce96efcf8563';
const requestId = 'b'.repeat(32);
const route = '/internal/v1/inventory/catalog';
const gatewayToken = randomBytes(32).toString('hex');
const runtime = new Pool({ ...dbConfig('inventory', 'runtime', 'test'), max: 1 });
const migrate = dbPool('inventory', 'migrate', 'test');
const app = createInventoryApp(runtime, gatewayToken, false);
const headers = (storeId: string, overrides: Record<string, string | undefined> = {}) => Object.fromEntries(Object.entries({
  authorization: `Bearer ${gatewayToken}`,
  'x-navis-store-id': storeId,
  'x-navis-store-role': 'owner',
  'x-request-id': requestId,
  ...overrides,
}).filter(([, value]) => value !== undefined));
const urlFor = (storeId: string) => `${route}?storeId=${storeId}`;

beforeAll(async () => {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  await runMigrations('inventory', dir, 'test');
  await runMigrations('inventory', dir, 'test');
  await seed(migrate);
  await seed(migrate);

  await withStoreTransaction(migrate, emptyStoreId, async (client) => {
    await client.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [emptyStoreId]);
  });
  await withStoreTransaction(migrate, syntheticStoreId, async (client) => {
    await client.query(`
      INSERT INTO inventory.inventory_item (store_id, item_id)
      VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [syntheticStoreId, retailItemId]);
    await client.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status, deleted_at)
      VALUES ($1, $2, 'menu', 'Archived muffin', 'dessert', 2200, 'selling', '2026-11-17T06:45:00Z')
      ON CONFLICT DO NOTHING
    `, [syntheticStoreId, extraMenuId]);
    await client.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status, inventory_item_id)
      VALUES ($1, $2, 'retail', 'Bag of beans', 'retail', 12000, 'selling', $3)
      ON CONFLICT DO NOTHING
    `, [syntheticStoreId, '33123a19-6780-4d38-9bca-ce96efcf8564', retailItemId]);
  });
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([runtime.end(), migrate.end()]);
});

describe('inventory management catalog', () => {
  it('matches every SPA seed menu field and DB UUID in UUID order after a seed retry', async () => {
    const expected = seedCatalog.menu
      .map(({ dbId, name, category, price, saleStatus }) => ({ menuId: dbId, name, category, price, saleStatus }))
      .sort((a, b) => a.menuId.localeCompare(b.menuId));
    const res = await app.inject({ url: urlFor(cafeId.toUpperCase()), headers: headers(cafeId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBe(requestId);
    expect(res.json()).toEqual({ items: expected });
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.every(({ price }) => Number.isSafeInteger(price) && price > 0)).toBe(true);
  });

  it('reads the second store while excluding its archived menu and retail rows', async () => {
    const res = await app.inject({ url: urlFor(syntheticStoreId), headers: headers(syntheticStoreId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [syntheticMenu] });
  });

  it('returns an empty array for a verified store with no catalog rows', async () => {
    const res = await app.inject({ url: urlFor(emptyStoreId), headers: headers(emptyStoreId) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it.each([undefined, 'Bearer invalid-fixture'])('requires a gateway credential (%s)', async (authorization) => {
    const res = await app.inject({ url: urlFor(cafeId), headers: headers(cafeId, { authorization }) });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it.each([
    { 'x-navis-store-id': undefined },
    { 'x-navis-store-id': 'invalid' },
    { 'x-navis-store-id': syntheticStoreId },
    { 'x-navis-store-role': undefined },
    { 'x-navis-store-role': 'staff' },
  ])('denies a request without matching owner context (%j)', async (context) => {
    const res = await app.inject({ url: urlFor(cafeId), headers: headers(cafeId, context) });
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ code: 'STORE_FORBIDDEN' });
  });

  it.each(['', '?storeId=invalid', `?storeId=${cafeId}&storeId=${cafeId}`, `?storeId=${cafeId}&other=1`])(
    'rejects an invalid query (%s)', async (query) => {
      const res = await app.inject({ url: `${route}${query}`, headers: headers(cafeId) });
      expect(res.statusCode).toBe(400);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({ code: 'INVALID_REQUEST' });
    },
  );

  it('returns a redacted, uncached 503 when the database pool is unavailable', async () => {
    const closedPool = dbPool('inventory', 'runtime', 'test');
    await closedPool.end();
    const unavailable = createInventoryApp(closedPool, gatewayToken, false);
    try {
      const res = await unavailable.inject({ url: urlFor(cafeId), headers: headers(cafeId) });
      expect(res.statusCode).toBe(503);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
      expect((await unavailable.inject('/readyz')).statusCode).toBe(503);
    } finally {
      await unavailable.close();
    }
  });
});

describe('inventory database isolation', () => {
  it('enables and forces RLS on every store-scoped table and limits runtime privileges', async () => {
    const { rows } = await runtime.query(`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped
      WHERE n.nspname = 'inventory' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `);
    expect(rows).toEqual([
      'business_day', 'demand_forecast', 'goods_receipt', 'inventory_item', 'menu_item', 'outbox',
      'purchase_order', 'purchase_order_line', 'recipe_current', 'recipe_version', 'sale_usage',
      'sale_usage_correction', 'sale_usage_line', 'stock_daily_opening', 'stock_movement', 'store', 'supplier',
    ].map((name) => ({
      name, enabled: true, forced: true, owner: 'inventory_migrate',
    })));
    const role = await runtime.query(`
      SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `);
    expect(role.rows).toEqual([{ name: 'inventory_runtime', rolsuper: false, rolbypassrls: false }]);
    await expect(runtime.query('UPDATE inventory.menu_item SET price = 1 WHERE false')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT store_id FROM inventory.store')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT item_id FROM inventory.inventory_item')).rejects.toMatchObject({ code: '42501' });
  });

  it('restricts unfiltered runtime SELECTs to their transaction store and denies missing or empty scope', async () => {
    const sql = 'SELECT DISTINCT store_id FROM inventory.menu_item';
    expect((await runtime.query(sql)).rows).toEqual([]);
    for (const storeId of [cafeId, syntheticStoreId, '']) {
      await withStoreTransaction(runtime, storeId, async (client) => {
        expect((await client.query(sql)).rows).toEqual(storeId ? [{ store_id: storeId }] : []);
      });
    }
  });

  it('does not leave a scope on a reused PostgreSQL connection after a route or rollback', async () => {
    const unscoped = `
      SELECT pg_backend_pid() AS pid, nullif(current_setting('app.store_id', true), '') AS scope,
             (SELECT count(*)::int FROM inventory.menu_item) AS visible
    `;
    const { rows: before } = await runtime.query(unscoped);
    expect(before).toEqual([{ pid: expect.any(Number), scope: null, visible: 0 }]);
    for (const storeId of [cafeId, syntheticStoreId]) {
      expect((await app.inject({ url: urlFor(storeId), headers: headers(storeId) })).statusCode).toBe(200);
      expect((await runtime.query(unscoped)).rows).toEqual(before);
    }
    await expect(withStoreTransaction(runtime, cafeId, async () => {
      throw new Error('test rollback');
    })).rejects.toThrow('test rollback');
    expect((await runtime.query(unscoped)).rows).toEqual(before);
  });

  it('rejects a retail reference to another store even with migration access', async () => {
    await expect(withStoreTransaction(migrate, cafeId, (client) => client.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status, inventory_item_id)
      VALUES ($1, $2, 'retail', 'Foreign retail item', 'retail', 1000, 'selling', $3)
    `, [cafeId, '33123a19-6780-4d38-9bca-ce96efcf8565', retailItemId]))).rejects.toMatchObject({ code: '23503' });
  });

  it.each([0, 1.5])('rejects a price of %s KRW at the database', async (price) => {
    await expect(withStoreTransaction(migrate, syntheticStoreId, (client) => client.query(`
      UPDATE inventory.menu_item SET price = $1 WHERE menu_id = $2
    `, [price, syntheticMenu.menuId]))).rejects.toMatchObject({ code: '23514' });
  });
});
