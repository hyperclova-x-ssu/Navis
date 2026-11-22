import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { InjectOptions } from 'light-my-request';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { readForecastBusinessDay } from '../../forecast/forecast.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { registerStockRoutes } from './routes.ts';

const pool = dbPool('inventory', 'runtime', 'test');
const setup = dbPool('inventory', 'migrate', 'test');
const store = randomUUID();
const actor = randomUUID();
const token = randomUUID();
let now = new Date('2026-11-21T02:00:00Z');
const root = `/internal/v1/inventory/stores/${store}`;
const headers = (key: string = randomUUID()) => ({
  authorization: `Bearer ${token}`, 'idempotency-key': key,
  'x-navis-user-id': actor, 'x-navis-store-role': 'owner', 'x-navis-store-id': store,
  'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00:00',
});
function service() {
  const app = createApp('inventory', async () => {}, false);
  registerStockRoutes(app, pool, token, { now: () => now });
  return app;
}
const app = service();
const request = (method: InjectOptions['method'], path: string, payload?: object, key?: string) =>
  app.inject({ method, url: root + path, headers: headers(key), payload });

beforeAll(() => runMigrations('inventory', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test'), 30_000);
afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), setup.end()]);
});

it('persists an exact stock count, safety level and lot, and replays the original receipt', async () => {
  const key = randomUUID();
  const draft = { sku: 'MILK', name: '우유', unit: 'L', stock: 1.25, threshold: 0.45 };
  expect((await request('POST', '/items', { ...draft, stock: 1.2501 })).json()).toMatchObject({ code: 'VALIDATION', reason: 'UNIT_PRECISION' });
  const created = await request('POST', '/items', draft, key);
  expect(created.statusCode, created.body).toBe(201);
  const { resourceId: itemId, revision } = created.json();
  expect((await request('POST', '/items', draft, key)).json()).toEqual(created.json());
  expect((await request('POST', '/items', { ...draft, threshold: 2 }, key)).json()).toMatchObject({ reason: 'IDEMPOTENCY_MISMATCH' });
  expect((await request('PATCH', `/items/${itemId}`, { stock: 1, expectedRevision: revision + 1 })).json())
    .toMatchObject({ reason: 'STALE_REVISION' });
  const updated = await request('PATCH', `/items/${itemId}`, { stock: 1, threshold: 0.55, expectedRevision: revision });
  expect(updated.statusCode, updated.body).toBe(200);
  const batch = await request('POST', '/stock-batches', {
    itemId, expectedRevision: updated.json().revision, quantity: 0.4, expiresOn: '2026-11-22',
  });
  expect(batch.statusCode, batch.body).toBe(201);
  expect((await request('GET', `/stock-movements?itemId=${itemId}`)).json()).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ kind: 'opening', deltaBase: '1250' }),
      expect.objectContaining({ kind: 'adjust', deltaBase: '-250' }),
    ]),
  });

  const second = service();
  try {
    const result = await second.inject({ url: root + `/items/${itemId}`, headers: headers() });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      itemId, thresholdBase: '550', expiresOn: '2026-11-22', stock: { availableQuantityBase: '1000' },
    });
    const otherStore = randomUUID();
    const absent = await second.inject({
      url: `/internal/v1/inventory/stores/${otherStore}/items/${itemId}`,
      headers: { ...headers(), 'x-navis-store-id': otherStore },
    });
    expect(absent.statusCode).toBe(404);
    expect((await second.inject({ url: root + '/items', headers: { ...headers(), 'x-navis-store-role': 'member' } })).statusCode).toBe(403);
  } finally {
    await second.close();
  }
  const batches = (await request('GET', `/stock-batches?itemId=${itemId}`)).json();
  expect(batches).toMatchObject({ items: [{ batchId: batch.json().resourceId, remainingQuantityBase: '400', revision: 1 }] });
  expect((await request('GET', '/stock-batches?expiresOn=2026-11-22')).json())
    .toMatchObject({ items: [{ batchId: batch.json().resourceId }] });
  expect((await request('GET', '/stock-batches?expiresOn=2026-11-21')).json()).toMatchObject({ items: [] });
  expect((await request('GET', '/stock-batches?expiresOn=2026-02-30')).json()).toMatchObject({ reason: 'INVALID_REQUEST', field: 'expiresOn' });
  const discardPath = `/stock-batches/${batch.json().resourceId}/discard`;
  expect((await request('POST', discardPath, { expectedRevision: 1 })).json()).toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
  const discarded = await request('POST', discardPath, { expectedRevision: 1, confirmed: true });
  expect(discarded.statusCode, discarded.body).toBe(200);
  expect((await request('GET', `/items/${itemId}`)).json()).toMatchObject({ expiresOn: null, stock: { rawQuantityBase: '600' } });
  expect((await pool.query('SELECT 1 FROM inventory.inventory_item WHERE item_id = $1', [itemId])).rowCount).toBe(0);
  const event = await withStoreTransaction(pool, store, db => db.query(
    "SELECT payload FROM inventory.outbox WHERE store_id = $1 AND event_type = 'inventory.stock_changed.v1' AND aggregate_id = $2",
    [store, discarded.json().receiptId],
  ));
  expect(event.rows).toMatchObject([{ payload: { storeId: store, itemIds: [itemId], operation: 'discard_batch' } }]);

  now = new Date('2026-11-22T02:00:00Z');
  expect((await request('GET', `/items/${itemId}`)).json()).toMatchObject({
    businessDate: '2026-11-22', stock: { openingQuantityBase: '600', rawQuantityBase: '600' },
  });
  expect(await withStoreTransaction(pool, store, db => readForecastBusinessDay(db, store, now), { readOnly: true }))
    .toEqual({ targetDate: '2026-11-22' });
});

it('transfers retail units atomically, rejects stale or excessive transfers and guards undo', async () => {
  now = new Date('2026-11-22T02:00:00Z');
  const itemId = randomUUID();
  const menuId = randomUUID();
  await withStoreTransaction(setup, store, async db => {
    await db.query('INSERT INTO inventory.store VALUES ($1) ON CONFLICT DO NOTHING', [store]);
    await db.query(`
      INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, '2026-11-22', '2026-11-21T20:00Z', '2026-11-22T20:00Z') ON CONFLICT DO NOTHING
    `, [store]);
    await db.query("INSERT INTO inventory.inventory_item (store_id, item_id, base_unit) VALUES ($1, $2, 'pcs')", [store, itemId]);
    await db.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, category, name, price, sale_status, inventory_item_id)
      VALUES ($1, $2, 'retail', 'retail', '텀블러', 9000, 'selling', $3)
    `, [store, menuId, itemId]);
    await db.query(`
      INSERT INTO inventory.stock_daily_opening (store_id, business_date, item_id, channel, quantity_base)
      VALUES ($1, '2026-11-22', $2, 'store', 12), ($1, '2026-11-22', $2, 'online', 2)
    `, [store, itemId]);
  });
  const transfer = { itemId, qty: 5, from: 'store', to: 'online', expectedRevision: 1 };
  expect((await request('POST', '/channel-transfers', { ...transfer, qty: 13 })).json()).toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  const results = await Promise.all([request('POST', '/channel-transfers', transfer), request('POST', '/channel-transfers', transfer)]);
  const successful = results.find(result => result.statusCode === 200);
  expect(results.map(result => result.statusCode).sort(), results.map(result => result.body).join('\n')).toEqual([200, 409]);
  expect((await request('GET', `/items/${itemId}`)).json()).toMatchObject({
    stock: { rawQuantityBase: '7' }, onlineStock: { rawQuantityBase: '7' },
  });
  expect((await request('POST', `/stock/receipts/${successful!.json().receiptId}/undo`, {})).statusCode).toBe(200);
  const restored = (await request('GET', `/items/${itemId}`)).json();
  expect(restored).toMatchObject({
    stock: { rawQuantityBase: '12' }, onlineStock: { rawQuantityBase: '2' },
  });
  const repeated = await request('POST', '/channel-transfers', { ...transfer, expectedRevision: restored.revision });
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json().undoUntil).toBe(new Date(now.getTime() + 6000).toISOString());
  now = new Date(now.getTime() + 6000);
  expect((await request('POST', `/stock/receipts/${repeated.json().receiptId}/undo`, {})).json())
    .toMatchObject({ reason: 'UNDO_EXPIRED' });
  expect((await request('GET', `/items/${itemId}`)).json()).toMatchObject({
    stock: { rawQuantityBase: '7' }, onlineStock: { rawQuantityBase: '7' },
  });
});
