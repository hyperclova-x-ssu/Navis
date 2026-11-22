import type { PoolClient } from 'pg';

export type StockQuantity = {
  usedQuantityBase: string;
  rawQuantityBase: string;
  availableQuantityBase: string;
  deficitQuantityBase: string;
};

export type StockBalance = StockQuantity & { openingQuantityBase: string };

export async function stockForItem(
  db: PoolClient, storeId: string, businessDate: string, itemId: string, channel: 'store' | 'online' = 'store',
): Promise<StockQuantity | null> {
  const [balance] = await stockForItems(db, storeId, businessDate, [itemId]);
  const stock = channel === 'store' ? balance?.stock : balance?.onlineStock;
  if (!stock) return null;
  const { usedQuantityBase, rawQuantityBase, availableQuantityBase, deficitQuantityBase } = stock;
  return { usedQuantityBase, rawQuantityBase, availableQuantityBase, deficitQuantityBase };
}

export async function stockForItems(db: PoolClient, storeId: string, businessDate: string, itemIds: string[]) {
  type ChannelBalance = StockBalance & { itemId: string; channel: 'store' | 'online' };
  const { rows } = await db.query<ChannelBalance>(`
    WITH opening AS (
      SELECT DISTINCT ON (item_id, channel) item_id, channel, business_date, quantity_base
      FROM inventory.stock_daily_opening
      WHERE store_id = $1 AND business_date <= $2 AND item_id = ANY($3::uuid[])
      ORDER BY item_id, channel, business_date DESC
    ), usage AS (
      SELECT o.item_id, s.business_date,
        sum((l.recognized_quantity - l.restored_quantity) * i.quantity_base) AS used
      FROM inventory.sale_usage s
      JOIN inventory.sale_usage_line l USING (store_id, settlement_id)
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) AS i(item_id uuid, quantity_base numeric)
      JOIN opening o ON o.item_id = i.item_id AND o.channel = 'store' AND s.business_date >= o.business_date
      WHERE s.store_id = $1 AND s.business_date BETWEEN (SELECT min(business_date) FROM opening) AND $2
      GROUP BY o.item_id, s.business_date
    ), entries AS (
      SELECT item_id, 'store' AS channel, business_date, 0 AS delta, used FROM usage
      UNION ALL
      SELECT m.item_id, m.channel, m.business_date, m.delta_base, 0
      FROM inventory.stock_movement m JOIN opening o ON o.item_id = m.item_id AND o.channel = m.channel
      WHERE m.store_id = $1 AND m.business_date BETWEEN o.business_date AND $2
    ), balance AS (
      SELECT o.item_id, o.channel,
        o.quantity_base + coalesce(sum(e.delta - e.used) FILTER (WHERE e.business_date < $2), 0) AS opening,
        coalesce(sum(e.used) FILTER (WHERE e.business_date = $2), 0) AS used,
        o.quantity_base + coalesce(sum(e.delta - e.used), 0) AS raw
      FROM opening o LEFT JOIN entries e USING (item_id, channel)
      GROUP BY o.item_id, o.channel, o.quantity_base
    )
    SELECT item_id AS "itemId", channel, opening::text AS "openingQuantityBase",
      used::text AS "usedQuantityBase", raw::text AS "rawQuantityBase",
      greatest(0, raw)::text AS "availableQuantityBase", greatest(0, -raw)::text AS "deficitQuantityBase"
    FROM balance
  `, [storeId, businessDate, itemIds]);
  const balances = new Map(itemIds.map(itemId => [itemId, {
    itemId, stock: null as StockBalance | null, onlineStock: null as StockBalance | null,
  }]));
  for (const { itemId, channel, ...stock } of rows) {
    balances.get(itemId)![channel === 'store' ? 'stock' : 'onlineStock'] = stock;
  }
  return [...balances.values()];
}
