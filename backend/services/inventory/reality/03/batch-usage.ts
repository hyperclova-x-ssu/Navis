import type { PoolClient } from 'pg';

export async function allocateSaleLots(db: PoolClient, storeId: string, settlementId: string, at: string) {
  // Match cumulative ingredient demand to cumulative lot availability, earliest expiry first.
  await db.query(`
    WITH needs AS (
      SELECT l.allocation_id, i.item_id, sum(l.recognized_quantity * i.quantity_base) AS qty
      FROM inventory.sale_usage_line l
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) i(item_id uuid, quantity_base numeric)
      WHERE l.store_id = $1 AND l.settlement_id = $2
      GROUP BY l.allocation_id, i.item_id
    ), demand AS (
      SELECT *, sum(qty) OVER (PARTITION BY item_id ORDER BY allocation_id) AS end_qty FROM needs
    ), availability AS (
      SELECT b.batch_id, b.item_id, b.remaining_base,
        sum(b.remaining_base) OVER (PARTITION BY b.item_id ORDER BY b.expires_on, b.received_at, b.batch_id) AS end_qty
      FROM inventory.stock_batch b
      WHERE b.store_id = $1 AND b.received_at <= $3 AND b.remaining_base > 0 AND b.discarded_at IS NULL
        AND b.item_id IN (SELECT item_id FROM needs)
    ), allocated AS (
      INSERT INTO inventory.stock_batch_usage (store_id, settlement_id, allocation_id, batch_id, used_base)
      SELECT $1, $2, d.allocation_id, b.batch_id,
        least(d.end_qty, b.end_qty) - greatest(d.end_qty - d.qty, b.end_qty - b.remaining_base)
      FROM demand d JOIN availability b USING (item_id)
      WHERE d.end_qty - d.qty < b.end_qty AND b.end_qty - b.remaining_base < d.end_qty
      RETURNING batch_id, used_base
    ), totals AS (
      SELECT batch_id, sum(used_base) AS used FROM allocated GROUP BY batch_id
    )
    UPDATE inventory.stock_batch b SET remaining_base = b.remaining_base - t.used, revision = b.revision + 1
    FROM totals t WHERE b.store_id = $1 AND b.batch_id = t.batch_id
  `, [storeId, settlementId, at]);
}

export async function restoreSaleLots(db: PoolClient, storeId: string, settlementId: string, allocationIds: string[]) {
  // The remaining sale retains the original earliest-expiring allocations before later ones.
  await db.query(`
    WITH needs AS (
      SELECT l.allocation_id, i.item_id, sum((l.recognized_quantity - l.restored_quantity) * i.quantity_base) AS qty
      FROM inventory.sale_usage_line l
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) i(item_id uuid, quantity_base numeric)
      WHERE l.store_id = $1 AND l.settlement_id = $2 AND l.allocation_id = ANY($3::uuid[])
      GROUP BY l.allocation_id, i.item_id
    ), allocations AS (
      SELECT u.allocation_id, u.batch_id, u.used_base, u.restored_base, n.qty,
        sum(u.used_base) OVER (PARTITION BY u.allocation_id, b.item_id ORDER BY b.expires_on, b.received_at, b.batch_id) AS end_qty
      FROM inventory.stock_batch_usage u JOIN inventory.stock_batch b USING (store_id, batch_id)
      JOIN needs n ON n.allocation_id = u.allocation_id AND n.item_id = b.item_id
      WHERE u.store_id = $1 AND u.settlement_id = $2
    ), effects AS (
      SELECT allocation_id, batch_id, restored_base,
        least(used_base, greatest(0, end_qty - qty)) AS next_restored
      FROM allocations
    ), written AS (
      UPDATE inventory.stock_batch_usage u SET restored_base = e.next_restored
      FROM effects e WHERE u.store_id = $1 AND u.settlement_id = $2
        AND u.allocation_id = e.allocation_id AND u.batch_id = e.batch_id AND e.next_restored > e.restored_base
      RETURNING u.batch_id, e.next_restored - e.restored_base AS restored
    ), totals AS (
      SELECT batch_id, sum(restored) AS restored FROM written GROUP BY batch_id
    )
    UPDATE inventory.stock_batch b SET remaining_base = b.remaining_base + t.restored, revision = b.revision + 1
    FROM totals t WHERE b.store_id = $1 AND b.batch_id = t.batch_id AND b.discarded_at IS NULL
  `, [storeId, settlementId, allocationIds]);
}

export async function advanceUsageRevision(db: PoolClient, storeId: string, settlementId: string, at: string, allocationIds?: string[]) {
  const { rows } = await db.query<{ item_id: string }>(`
    UPDATE inventory.inventory_item i SET revision = i.revision + 1, updated_at = greatest(i.updated_at, $3::timestamptz)
    FROM (
      SELECT DISTINCT ingredient.item_id
      FROM inventory.sale_usage_line l
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) ingredient(item_id uuid)
      WHERE l.store_id = $1 AND l.settlement_id = $2 AND ($4::uuid[] IS NULL OR l.allocation_id = ANY($4))
    ) affected
    WHERE i.store_id = $1 AND i.item_id = affected.item_id
    RETURNING i.item_id
  `, [storeId, settlementId, at, allocationIds ?? null]);
  return rows.map(row => row.item_id).sort();
}
