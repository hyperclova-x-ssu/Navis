import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

type RecipeLine = { itemId: string; quantityBase: number; unitDimension: string };
export type RecipeIngredient = { item_id: string; quantity_base: number };

export async function saveRecipeVersion(
  db: PoolClient, storeId: string, menuId: string, componentId: string, lines: readonly RecipeLine[],
  { seed = false } = {},
): Promise<string> {
  const canonical = lines.map(({ itemId, quantityBase, unitDimension }) => ({ itemId, quantityBase, unitDimension }));
  const version = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const { rows } = await db.query<{ recipe_key: string; item_id: string; base_unit: string }>(`
    SELECT recipe_key, item_id, base_unit FROM inventory.inventory_item
    WHERE store_id = $1 AND recipe_key = ANY($2::text[])
  `, [storeId, lines.map((line) => line.itemId)]);
  const items = new Map(rows.map((item) => [item.recipe_key, item]));
  if (lines.length !== items.size) throw new Error('Recipe requires distinct inventory items');
  const ingredients = lines.map(({ itemId, quantityBase, unitDimension }): RecipeIngredient => {
    const item = items.get(itemId);
    if (!item || item.base_unit !== unitDimension || !Number.isSafeInteger(quantityBase) || quantityBase <= 0) {
      throw new Error('Recipe quantity or inventory unit is invalid');
    }
    return { item_id: item.item_id, quantity_base: quantityBase };
  });
  await db.query(`
    INSERT INTO inventory.recipe_version (store_id, menu_id, component_id, version, ingredients)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [storeId, menuId, componentId, version, JSON.stringify(ingredients)]);
  const activate = seed ? 'DO NOTHING' : 'DO UPDATE SET version = EXCLUDED.version';
  await db.query(`
    INSERT INTO inventory.recipe_current (store_id, menu_id, component_id, version)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (store_id, menu_id, component_id) ${activate}
  `, [storeId, menuId, componentId, version]);
  return version;
}

/** Read the current version for estimates. Sale usage resolves the versions in the POS event. */
export async function readCurrentRecipe(db: PoolClient, storeId: string, menuId: string, optionIds: readonly string[]) {
  const components = [menuId, ...new Set(optionIds)];
  const { rows } = await db.query<{ component_id: string; ingredients: RecipeIngredient[] }>(`
    SELECT c.component_id, v.ingredients
    FROM inventory.recipe_current c JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
    WHERE c.store_id = $1 AND c.menu_id = $2 AND c.component_id = ANY($3::uuid[])
  `, [storeId, menuId, components]);
  if (rows.length !== components.length) throw new Error('Current recipe component is unavailable');
  const quantities = new Map<string, bigint>();
  for (const { ingredients } of rows) {
    for (const { item_id, quantity_base } of ingredients) {
      quantities.set(item_id, (quantities.get(item_id) ?? 0n) + BigInt(quantity_base));
    }
  }
  return Object.fromEntries([...quantities].map(([itemId, quantity]) => [itemId, quantity.toString()]));
}
