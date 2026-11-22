import assert from 'node:assert/strict';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import { dbPool } from '../../packages/db/index.ts';
import { withStoreTransaction as withInventoryStore } from '../../services/inventory/store-transaction.ts';
import { withStoreTransaction as withPosStore } from '../../services/pos/transaction.ts';

const [start, businessDate] = process.argv.slice(2);
const { storeId } = manifest.store;
const account = dbPool('account', 'migrate');
const inventory = dbPool('inventory', 'migrate');
const pos = dbPool('pos', 'migrate');
const seoulOpening = date => new Date(Date.parse(`${date}T05:00:00+09:00`)).toISOString();

try {
  const { rows: stores } = await account.query(`
    SELECT timezone, business_day_start::text AS cutoff, created_at FROM account.store WHERE store_id = $1
  `, [storeId]);
  assert.equal(stores.length, 1);
  assert.equal(stores[0].timezone, 'Asia/Seoul');
  assert.equal(stores[0].cutoff, '05:00:00');
  assert.equal(stores[0].created_at.toISOString(), seoulOpening(start));
  for (const [service, pool, withStore] of [
    ['inventory', inventory, withInventoryStore],
    ['pos', pos, withPosStore],
  ]) {
    const { rows } = await withStore(pool, storeId, db => db.query(`
      SELECT business_date::text, starts_at, ends_at FROM ${service}.business_day WHERE store_id = $1
    `, [storeId]), { readOnly: true });
    assert.deepEqual(rows.map(row => row.business_date), [businessDate]);
    assert.equal(rows[0].starts_at.toISOString(), seoulOpening(businessDate));
    assert.equal(+rows[0].ends_at - +rows[0].starts_at, 24 * 60 * 60 * 1000);
  }
  const { rows: openings } = await withInventoryStore(inventory, storeId, db => db.query(`
    SELECT business_date::text, count(*)::integer AS count FROM inventory.stock_daily_opening
    WHERE store_id = $1 GROUP BY business_date
  `, [storeId]), { readOnly: true });
  assert.deepEqual(openings.map(row => row.business_date), [businessDate]);
  assert.ok(openings[0].count > 0);
  const { rows: orders } = await withInventoryStore(inventory, storeId, db => db.query(`
    SELECT ordered_on::text FROM inventory.purchase_order WHERE store_id = $1
  `, [storeId]), { readOnly: true });
  assert.deepEqual(orders, [{ ordered_on: businessDate }]);
  console.info(`PASS Account seeded at ${seoulOpening(start)}, POS and Inventory business day ${businessDate}, ${openings[0].count} stock openings`);
} finally {
  await Promise.all([account.end(), inventory.end(), pos.end()]);
}
