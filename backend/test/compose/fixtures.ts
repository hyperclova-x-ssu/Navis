import assert from 'node:assert/strict';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { dbPool } from '../../packages/db/index.ts';
import { syntheticStoreId } from '../../services/inventory/seed.ts';
import { withStoreTransaction } from '../../services/inventory/store-transaction.ts';

const { storeId } = seedCatalog.store;
const [operation, from, to] = process.argv.slice(2);

if (operation === 'expected') {
  const items = seedCatalog.menu.map(({ dbId, name, category, price, saleStatus }) => ({
    menuId: dbId, name, category, price, saleStatus,
  })).sort((a, b) => a.menuId.localeCompare(b.menuId));
  console.log(JSON.stringify({ storeId, syntheticStoreId, items }));
} else if (operation === 'price') {
  const menu = seedCatalog.menu.find(item => item.menuId === 'm-cafe-latte');
  assert.ok(menu);
  const before = Number(from);
  const after = Number(to);
  assert.ok([before, after].every(value => Number.isSafeInteger(value) && value > 0));
  assert.ok((before === menu.price && after === menu.price + 100) || (before === menu.price + 100 && after === menu.price));

  const pool = dbPool('inventory', 'migrate', 'local');
  try {
    await withStoreTransaction(pool, storeId, async client => {
      const result = await client.query(`
        UPDATE inventory.menu_item SET price = $1
        WHERE store_id = $2 AND menu_id = $3 AND price = $4
      `, [after, storeId, menu.dbId, before]);
      assert.equal(result.rowCount, 1, 'Expected one synthetic café menu row at the previous price');
    });
  } finally {
    await pool.end();
  }
} else {
  throw new Error('Use expected or price <before> <after>');
}
