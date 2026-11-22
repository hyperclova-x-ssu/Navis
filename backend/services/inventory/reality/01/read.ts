import type { PoolClient } from 'pg';
import type { RecipeIngredient } from '../../recipes.ts';
import { category as menuCategory, recipePart, type BaseUnit, type Category, type CategoryInput, type OptionGroup, type RecipeLine, type SaleStatus } from './wire.ts';

export type MenuState = {
  name: string; category: CategoryInput; price: number; memo: string | null; prepMin: number; saleStatus: SaleStatus;
  photoKey: string | null; photoFileId: string | null; deletedAt: string | null;
  groups: OptionGroup[]; recipeLines: RecipeLine[] | null;
};

export type MenuRow = MenuState & { menuId: string; revision: number };
type MenuReadRow = MenuRow & { seasonal: string | null };

const columns = `
  menu_id AS "menuId", revision, name, category, price::double precision AS price, memo,
  prep_min AS "prepMin", sale_status AS "saleStatus", photo_key AS "photoKey",
  photo_file_id AS "photoFileId", deleted_at::text AS "deletedAt", option_groups AS groups, recipe_lines AS "recipeLines"
`;
type Component = { menu_id: string; component_id: string; version: string; ingredients: RecipeIngredient[] };
type PriceTerm = { item_id: string; unit_price: string; base_per_unit: string };
type Ingredient = { item_id: string; base_unit: BaseUnit };

const cost = (parts: readonly RecipeIngredient[], terms: ReadonlyMap<string, PriceTerm>) => {
  let numerator = 0n;
  let denominator = 1n;
  for (const part of parts) {
    const term = terms.get(part.item_id);
    if (!term) return null;
    const per = BigInt(term.base_per_unit);
    numerator = numerator * per + denominator * BigInt(part.quantity_base) * BigInt(term.unit_price);
    denominator *= per;
  }
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  return rounded > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(rounded);
};

function project(
  row: MenuReadRow, components: ReadonlyMap<string, Component>,
  terms: ReadonlyMap<string, PriceTerm>, units: ReadonlyMap<string, BaseUnit>,
) {
  const base = components.get(row.menuId);
  const lines = row.recipeLines ?? base?.ingredients.flatMap(({ item_id, quantity_base }) => {
    const unit = units.get(item_id);
    // Legacy recipe versions used the same inventory UUIDs but carried no grid row ID or display unit.
    return unit ? [{ recipeLineId: item_id, itemId: item_id, quantity: quantity_base, unit }] : [];
  }) ?? [];
  const { deletedAt: _deletedAt, ...menu } = row;
  return {
    ...menu,
    category: menuCategory(menu.category),
    recipeLines: lines.map(line => ({ ...line, cost: cost([{
      item_id: line.itemId, quantity_base: recipePart(line).quantityBase,
    }], terms) })),
    recipeVersion: base?.version ?? null,
    unitCost: base?.ingredients.length ? cost(base.ingredients, terms) : null,
    groups: row.groups.map(group => ({
      ...group,
      options: group.options.map(option => {
        const version = components.get(option.optionId);
        return { ...option, extraCost: version ? cost(version.ingredients, terms) : null, recipeVersion: version?.version ?? null };
      }),
    })),
  };
}

export type MenuDto = ReturnType<typeof project>;

export function posSnapshot(menu: MenuDto) {
  const { menuId, name, category, seasonal, price, unitCost, prepMin, saleStatus, photoKey, photoFileId, recipeVersion, revision, groups } = menu;
  return {
    menuId, name, category, seasonal, basePrice: price, baseCost: unitCost, prepMin, saleStatus, photoKey, photoFileId, recipeVersion, revision,
    groups: groups.filter(group => !group.archivedAt).map(({ groupId, name, required, options }) => ({
      groupId, name, required,
      options: options.filter(option => !option.archivedAt).map(({ optionId, name, extraPrice, extraCost, recipeVersion }) => ({
        optionId, name, extraPrice, extraCost, recipeVersion,
      })),
    })),
  };
}

export async function readMenu(
  db: PoolClient, storeId: string, asOf: Date,
  { menuIds = null, cursor = null, category = null, saleStatus = null, limit = 1 }: {
    menuIds?: string[] | null; cursor?: string | null; category?: Category | null; saleStatus?: SaleStatus | null; limit?: number;
  } = {},
) {
  const { rows: [result] } = await db.query<{
    menus: MenuReadRow[]; components: Component[]; terms: PriceTerm[]; ingredients: Ingredient[]; revision: number;
  }>(`
    WITH page AS (
      SELECT ${columns}, seasonal FROM inventory.menu_item
      WHERE store_id = $1 AND kind = 'menu' AND deleted_at IS NULL
        AND ($2::uuid[] IS NULL OR menu_id = ANY($2))
        AND ($3::uuid IS NULL OR menu_id > $3)
        AND ($4::text IS NULL OR category = $4 OR ($4 = 'beverage' AND category = 'drink'))
        AND ($5::text IS NULL OR sale_status = $5)
      ORDER BY menu_id
      LIMIT $6
    ), components AS (
      SELECT c.menu_id, c.component_id, c.version, v.ingredients
      FROM inventory.recipe_current c
      JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
      JOIN page ON page."menuId" = c.menu_id
      WHERE c.store_id = $1
    ), used_items AS (
      SELECT DISTINCT (ingredient->>'item_id')::uuid AS item_id
      FROM components c CROSS JOIN LATERAL jsonb_array_elements(c.ingredients) AS ingredient
    ), legacy_terms AS (
      SELECT DISTINCT ON (p.item_id) p.item_id, p.unit_price::text, p.base_per_unit::text
      FROM inventory.purchase_order_line p JOIN inventory.purchase_order o USING (store_id, po_id)
      JOIN used_items u USING (item_id)
      WHERE p.store_id = $1 AND o.canceled_at IS NULL AND o.ordered_on <= ($7::timestamptz AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY p.item_id, o.ordered_on DESC, o.po_id DESC, p.pol_id DESC
    ), terms AS (
      SELECT u.item_id, coalesce(p.unit_price::text, l.unit_price) AS unit_price,
        coalesce(p.base_per_unit::text, l.base_per_unit) AS base_per_unit
      FROM used_items u
      LEFT JOIN inventory.purchase_item p ON p.store_id = $1 AND p.item_id = u.item_id AND p.archived_at IS NULL
      LEFT JOIN legacy_terms l ON l.item_id = u.item_id
      WHERE p.item_id IS NOT NULL OR l.item_id IS NOT NULL
    ), ingredients AS (
      SELECT i.item_id, i.base_unit FROM inventory.inventory_item i JOIN used_items u USING (item_id)
      WHERE i.store_id = $1 AND i.base_unit IS NOT NULL
    )
    SELECT coalesce((SELECT jsonb_agg(page ORDER BY page."menuId") FROM page), '[]') AS menus,
           coalesce((SELECT jsonb_agg(components) FROM components), '[]') AS components,
           coalesce((SELECT jsonb_agg(terms) FROM terms), '[]') AS terms,
           coalesce((SELECT jsonb_agg(ingredients) FROM ingredients), '[]') AS ingredients,
           coalesce((SELECT last_seq FROM inventory.outbox_scope WHERE scope_key = $1::text), 0)::double precision AS revision
  `, [storeId, menuIds, cursor, category, saleStatus, limit + 1, asOf]);
  const costs = new Map(result.terms.map(term => [term.item_id, term]));
  const units = new Map(result.ingredients.map(({ item_id, base_unit }) => [item_id, base_unit]));
  const recipes = new Map<string, Map<string, Component>>();
  for (const component of result.components) {
    const menu = recipes.get(component.menu_id) ?? new Map();
    menu.set(component.component_id, component);
    recipes.set(component.menu_id, menu);
  }
  const items = result.menus.slice(0, limit).map(row => project(row, recipes.get(row.menuId) ?? new Map(), costs, units));
  return {
    items,
    nextCursor: result.menus.length > limit ? items.at(-1)!.menuId : null,
    asOf: asOf.toISOString(),
    sourceRevision: result.revision,
  };
}

export async function readMenuState(db: PoolClient, storeId: string, menuId: string) {
  const { rows: [row] } = await db.query<MenuRow>(`
    SELECT ${columns} FROM inventory.menu_item
    WHERE store_id = $1 AND menu_id = $2 AND kind = 'menu'
    FOR UPDATE
  `, [storeId, menuId]);
  return row;
}
