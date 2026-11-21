import type { PoolClient } from 'pg';

type StockQuantity = {
  usedQuantityBase: string;
  rawQuantityBase: string;
  availableQuantityBase: string;
  deficitQuantityBase: string;
};

export async function stockForItem(
  db: PoolClient, storeId: string, businessDate: string, itemId: string, channel: 'store' | 'online' = 'store',
): Promise<StockQuantity | null> {
  const { rows } = await db.query<StockQuantity>(`
    WITH usage AS (
      SELECT coalesce(sum((l.recognized_quantity - l.restored_quantity) * i.quantity_base), 0) AS used
      FROM inventory.sale_usage s
      JOIN inventory.sale_usage_line l USING (store_id, settlement_id)
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) AS i(item_id uuid, quantity_base numeric)
      WHERE s.store_id = $1 AND s.business_date = $2 AND i.item_id = $3 AND $4 = 'store'
    ), movements AS (
      SELECT coalesce(sum(delta_base), 0) AS delta
      FROM inventory.stock_movement
      WHERE store_id = $1 AND business_date = $2 AND item_id = $3 AND channel = $4
    ), balance AS (
      SELECT used, o.quantity_base + delta - used AS raw
      FROM inventory.stock_daily_opening o CROSS JOIN usage CROSS JOIN movements
      WHERE store_id = $1 AND business_date = $2 AND item_id = $3 AND channel = $4
    )
    SELECT used::text AS "usedQuantityBase", raw::text AS "rawQuantityBase",
      greatest(0, raw)::text AS "availableQuantityBase", greatest(0, -raw)::text AS "deficitQuantityBase"
    FROM balance
  `, [storeId, businessDate, itemId, channel]);
  return rows[0] ?? null;
}
