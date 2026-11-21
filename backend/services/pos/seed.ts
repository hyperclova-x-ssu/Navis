import type { Pool } from 'pg';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import type { MenuSnapshot } from './catalog.ts';
import { withStoreTransaction } from './transaction.ts';
import { fingerprint } from './wire.ts';

export async function seed(pool: Pool) {
  const { storeId, name, businessDayStart, timezone } = seedCatalog.store;
  const businessDate = manifest.cutoff.businessDate;
  await withStoreTransaction(pool, storeId, async (db) => {
    await db.query('INSERT INTO pos.store (store_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [storeId, name]);
    await db.query(`
      INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at, seq)
      VALUES ($1, $2, ($2::date + $3::time) AT TIME ZONE $4,
        (($2::date + 1) + $3::time) AT TIME ZONE $4, 153)
      ON CONFLICT DO NOTHING
    `, [storeId, businessDate, businessDayStart, timezone]);

    for (const menu of seedCatalog.menu) {
      const snapshot: MenuSnapshot = {
        name: menu.name, basePrice: menu.price, baseCost: menu.unitCost,
        recipeVersion: fingerprint(menu.recipeBase), saleStatus: menu.saleStatus,
        groups: menu.groups.map((group) => ({
          required: group.required,
          options: group.options.map((option) => ({
            optionId: option.optionId, name: option.name, extraPrice: option.extraPrice,
            extraCost: option.extraCost, recipeVersion: fingerprint(option.extraRecipe),
          })),
        })),
      };
      await db.query(`
        INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [storeId, menu.dbId, snapshot]);
    }
  }, { write: true });
}
