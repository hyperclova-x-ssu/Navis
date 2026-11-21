import type { Pool } from 'pg';
import content from '../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import { generate } from '../../../db/seed/ansungjalbu/generate.mjs';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import { saveRecipeVersion } from './recipes.ts';
import { withStoreTransaction } from './store-transaction.ts';

export const syntheticStoreId = '33123a19-6780-4d38-9bca-ce96efcf8559';
export const syntheticReceiptLineId = '33123a19-6780-4d38-9bca-ce96efcf8557';

interface MenuSeedRow {
  store_id: string;
  menu_id: string;
  kind: 'menu' | 'retail';
  name: string;
  category: 'drink' | 'dessert' | 'retail';
  price: number;
  sale_status: 'selling' | 'sold_out';
  inventory_item_id: string | null;
  deleted_at: string | null;
}

export async function seed(pool: Pool): Promise<void> {
  const { rows } = generate(content, manifest.generator);
  // The JS generator infers empty row arrays from its dynamic table registry.
  const cafeId = (rows.store[0] as { store_id: string }).store_id;
  const menuRows: MenuSeedRow[] = rows.menu_item;
  const businessDate = manifest.cutoff.businessDate;
  const { businessDayStart, timezone } = seedCatalog.store;
  const openings: { business_date: string; item_id: string; channel: string; quantity_base: number }[] = rows.stock_daily_opening;

  await withStoreTransaction(pool, cafeId, async (client) => {
    await client.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [cafeId]);
    await client.query(`
      INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, $2, ($2::date + $3::time) AT TIME ZONE $4, (($2::date + 1) + $3::time) AT TIME ZONE $4)
      ON CONFLICT DO NOTHING
    `, [cafeId, businessDate, businessDayStart, timezone]);
    const ingredients = seedCatalog.items.map((item) => ({
      item_id: item.dbId, recipe_key: item.itemId, base_unit: item.unitDimension,
    }));
    await client.query(`
      INSERT INTO inventory.inventory_item (store_id, item_id, recipe_key, base_unit)
      SELECT $1, item_id, recipe_key, base_unit FROM jsonb_to_recordset($2::jsonb)
        AS i(item_id uuid, recipe_key text, base_unit text)
      ON CONFLICT DO NOTHING
    `, [cafeId, JSON.stringify(ingredients)]);
    for (const row of menuRows) {
      await client.query(`
        INSERT INTO inventory.menu_item (
          store_id, menu_id, kind, name, category, price, sale_status, inventory_item_id, deleted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
      `, [row.store_id, row.menu_id, row.kind, row.name, row.category, row.price, row.sale_status,
        row.inventory_item_id, row.deleted_at]);
    }
    for (const menu of seedCatalog.menu) {
      await saveRecipeVersion(client, cafeId, menu.dbId, menu.dbId, menu.recipeBase, { seed: true });
      for (const group of menu.groups) {
        for (const option of group.options) {
          await saveRecipeVersion(client, cafeId, menu.dbId, option.optionId, option.extraRecipe, { seed: true });
        }
      }
    }

    await client.query(`
      INSERT INTO inventory.stock_daily_opening (store_id, business_date, item_id, channel, quantity_base)
      SELECT $1, $2, item_id, channel, quantity_base FROM jsonb_to_recordset($3::jsonb)
        AS o(item_id uuid, channel text, quantity_base bigint)
      ON CONFLICT DO NOTHING
    `, [cafeId, businessDate, JSON.stringify(openings.filter((row) => row.business_date === businessDate))]);

    const milk = seedCatalog.items.find((item) => item.itemId === 'i-milk')!;
    const supplier = seedCatalog.suppliers.find((item) => item.dbId === milk.purchase.supplierDbId)!;
    const poId = '33123a19-6780-4d38-9bca-ce96efcf8558';
    await client.query(`
      INSERT INTO inventory.supplier (store_id, supplier_id, name)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    `, [cafeId, supplier.dbId, supplier.name]);
    await client.query(`
      INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
    `, [cafeId, poId, supplier.dbId, businessDate]);
    await client.query(`
      INSERT INTO inventory.purchase_order_line
        (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
      VALUES ($1, $2, $3, $4, 10, $5, $6, $7) ON CONFLICT DO NOTHING
    `, [cafeId, syntheticReceiptLineId, poId, milk.dbId, milk.purchase.unit, milk.purchase.basePerUnit, milk.purchase.unitPrice]);
  });

  await withStoreTransaction(pool, syntheticStoreId, async (client) => {
    await client.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [syntheticStoreId]);
    await client.query(`
      INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status)
      VALUES ($1, '33123a19-6780-4d38-9bca-ce96efcf8561', 'menu', 'Synthetic store tea', 'drink', 3100, 'sold_out')
      ON CONFLICT DO NOTHING
    `, [syntheticStoreId]);
  });
}
