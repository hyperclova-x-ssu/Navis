import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RecipeIngredient } from '../recipes.ts';
import { lockStockStore } from '../reality/03/commands.ts';

export type ForecastKey = { storeId: string; targetDate: string; modelVersion: string };
export type MenuBaseline = { menuId: string; fourWeekQuantity: string };
type Scope = 'store' | 'menu' | 'ingredient';
type ForecastRow = { menu_id: string | null; item_id: string | null; expected: string; stale: boolean };
type CurrentMenu = {
  menu_id: string | null;
  selling: boolean | null;
  four_week_quantity: string;
  ingredients: RecipeIngredient[] | null;
};

function targetOf(row: ForecastRow): { scope: Scope; targetId: string | null } {
  if (row.menu_id) return { scope: 'menu', targetId: row.menu_id };
  if (row.item_id) return { scope: 'ingredient', targetId: row.item_id };
  return { scope: 'store', targetId: null };
}

export async function readForecast(db: PoolClient, { storeId, targetDate, modelVersion }: ForecastKey) {
  const { rows } = await db.query<ForecastRow>(`
    WITH catalog AS (
      SELECT coalesce(max(store_seq), 0) AS seq FROM inventory.outbox
      WHERE store_id = $1 AND event_type = 'inventory.catalog_changed.v1'
    )
    SELECT menu_id, item_id, expected::text,
      menu_id IS NULL AND item_id IS NULL AND seq > coalesce(catalog_seq, 0) AS stale
    FROM inventory.demand_forecast
    CROSS JOIN catalog
    WHERE store_id = $1 AND target_date = $2 AND model_version = $3
    ORDER BY (menu_id IS NOT NULL)::int + 2 * (item_id IS NOT NULL)::int, menu_id, item_id
  `, [storeId, targetDate, modelVersion]);
  return {
    targetDate, modelVersion, status: rows.length ? 'ready' as const : 'no_data' as const,
    results: rows.map(row => ({ ...targetOf(row), expected: row.expected })),
    ...(rows[0]?.stale ? { stale: true as const } : {}),
  };
}

export class ForecastInputConflict extends Error {}

export async function saveForecast(db: PoolClient, key: ForecastKey, menus: MenuBaseline[], at: Date) {
  const { storeId, targetDate, modelVersion } = key;
  const ordered = [...menus].sort((a, b) => a.menuId.localeCompare(b.menuId));
  const input = JSON.stringify(ordered);
  const fingerprint = createHash('sha256').update(input).digest('hex');
  const keyValues = [storeId, targetDate, modelVersion];
  // Serialize concurrent retries before reading the recorded fingerprint or any recipes.
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('navis:forecast:' || $1, 0))",
    [keyValues.join('/')],
  );
  const { rows: [saved] } = await db.query<{ input_fingerprint: string }>(`
    SELECT input_fingerprint FROM inventory.demand_forecast
    WHERE store_id = $1 AND target_date = $2 AND model_version = $3 AND menu_id IS NULL AND item_id IS NULL
  `, keyValues);
  if (saved) {
    if (saved.input_fingerprint !== fingerprint) throw new ForecastInputConflict();
    return readForecast(db, key);
  }

  // Take the catalog command lock so the captured event sequence and current recipes describe the same version.
  await lockStockStore(db, storeId);
  const { rows: current } = await db.query<CurrentMenu>(`
    SELECT m.menu_id, (m.kind = 'menu' AND m.deleted_at IS NULL AND m.sale_status = 'selling') AS selling,
      s."fourWeekQuantity" AS four_week_quantity, v.ingredients
    FROM jsonb_to_recordset($2::jsonb) AS s("menuId" uuid, "fourWeekQuantity" text)
    LEFT JOIN inventory.menu_item m ON m.store_id = $1 AND m.menu_id = s."menuId"
    LEFT JOIN inventory.recipe_current c
      ON (c.store_id, c.menu_id, c.component_id) = (m.store_id, m.menu_id, m.menu_id)
    LEFT JOIN inventory.recipe_version v
      ON (v.store_id, v.menu_id, v.component_id, v.version) = (c.store_id, c.menu_id, c.component_id, c.version)
  `, [storeId, input]);

  let total = 0n;
  const ingredients = new Map<string, bigint>();
  const estimates: { menuId?: string; itemId?: string; total: bigint }[] = [];
  for (const row of current) {
    if (!row.menu_id) return readForecast(db, key);
    if (!row.selling) continue;
    const quantity = BigInt(row.four_week_quantity);
    if (!row.ingredients && quantity > 0n) return readForecast(db, key);
    estimates.push({ menuId: row.menu_id, total: quantity });
    total += quantity;
    for (const { item_id, quantity_base } of row.ingredients ?? []) {
      ingredients.set(item_id, (ingredients.get(item_id) ?? 0n) + quantity * BigInt(quantity_base));
    }
  }
  estimates.push({ total });
  for (const [itemId, total] of ingredients) estimates.push({ itemId, total });

  const values = estimates.map(({ menuId, itemId, total }) => ({
    forecast_id: randomUUID(), menu_id: menuId, item_id: itemId, total: total.toString(),
  }));
  await db.query(`
    WITH catalog AS (
      SELECT coalesce(max(store_seq), 0) AS seq FROM inventory.outbox
      WHERE store_id = $1 AND event_type = 'inventory.catalog_changed.v1'
    ), written AS (
      INSERT INTO inventory.demand_forecast
        (forecast_id, store_id, target_date, model_version, menu_id, item_id, expected, generated_at, input_fingerprint, catalog_seq)
      SELECT v.forecast_id, $1::uuid, $2, $3, v.menu_id, v.item_id, v.total * 0.25, $4,
        CASE WHEN v.menu_id IS NULL AND v.item_id IS NULL THEN $5 END,
        CASE WHEN v.menu_id IS NULL AND v.item_id IS NULL THEN seq END
      FROM jsonb_to_recordset($6::jsonb) AS v(forecast_id uuid, menu_id uuid, item_id uuid, total numeric)
      CROSS JOIN catalog
      RETURNING forecast_id, target_date, model_version, menu_id, item_id, generated_at
    ), reserved AS (
      INSERT INTO inventory.outbox_scope (scope_key, last_seq) VALUES ($1::uuid::text, $7::bigint)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = inventory.outbox_scope.last_seq + EXCLUDED.last_seq
      RETURNING last_seq - $7::bigint AS previous_seq
    )
    INSERT INTO inventory.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT gen_random_uuid(), $1::uuid, $1::uuid::text,
      previous_seq + row_number() OVER (ORDER BY (menu_id IS NOT NULL)::int + 2 * (item_id IS NOT NULL)::int, menu_id, item_id),
      'inventory.forecast_generated.v1', forecast_id, generated_at,
      jsonb_build_object('storeId', $1::uuid, 'targetDate', target_date, 'modelVersion', model_version,
        'scope', CASE WHEN menu_id IS NOT NULL THEN 'menu' WHEN item_id IS NOT NULL THEN 'ingredient' ELSE 'store' END,
        'targetId', coalesce(menu_id, item_id))
    FROM written CROSS JOIN reserved
  `, [...keyValues, at, fingerprint, JSON.stringify(values), values.length]);
  return readForecast(db, key);
}

export async function readForecastBusinessDay(db: PoolClient, storeId: string, at: Date) {
  const { rows } = await db.query<{ targetDate: string }>(`
    SELECT business_date::text AS "targetDate" FROM inventory.business_day
    WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2
    LIMIT 2
  `, [storeId, at]);
  if (rows.length > 1) throw new Error('Overlapping inventory business days');
  if (rows[0]) return rows[0];
  const { rows: [projected] } = await db.query<{ targetDate: string | null }>(`
    SELECT (($1::timestamptz AT TIME ZONE stock_timezone) - (stock_day_start - time '00:00'))::date::text AS "targetDate"
    FROM inventory.store
  `, [at]);
  return { targetDate: projected?.targetDate ?? null };
}
