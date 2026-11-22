import type { PoolClient } from 'pg';
import { stockForItems } from '../../stock.ts';
import { date, pageInput, StockError, uuid, type Unit } from './wire.ts';

type ItemKind = 'ingredient' | 'retail';
export type ItemRecord = {
  itemId: string; sku: string | null; name: string | null; storedName: string | null; kind: ItemKind; unit: Unit | null;
  baseUnit: 'g' | 'mL' | 'pcs' | null; thresholdBase: string | null; trackRestock: boolean;
  trackExpiry: boolean; revision: number; updatedAt: Date | null; archivedAt: Date | null;
};
type VisibleItem = ItemRecord & { expiresOn: string | null; referenced: boolean };

export async function operatingDay(
  db: PoolClient, storeId: string, at: Date, clock: { timezone?: string; dayStart?: string }, write = false,
) {
  const existing = await db.query<{ day: string; closed: boolean }>(`
    SELECT business_date::text AS day, closed_at IS NOT NULL AS closed
    FROM inventory.business_day WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2 LIMIT 2
  `, [storeId, at]);
  if (existing.rows.length > 1) throw new StockError(503, 'OPERATING_CLOCK_UNAVAILABLE');
  const current = existing.rows[0];
  if (write && current?.closed) throw new StockError(409, 'DAY_CLOSED');
  if (!write && current) return current.day;
  const { timezone, dayStart } = clock;
  if (current && timezone === undefined && dayStart === undefined) return current.day;
  if (!timezone || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)
      || !dayStart || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(dayStart)) {
    throw new StockError(503, 'OPERATING_CLOCK_UNAVAILABLE');
  }
  const { rows: [bounds] } = await db.query<{ day: string; start: Date; end: Date }>(`
    SELECT day::text, (day + $3::time) AT TIME ZONE $2 AS start,
      (day + 1 + $3::time) AT TIME ZONE $2 AS "end"
    FROM (
      SELECT (($1::timestamptz AT TIME ZONE $2) - ($3::time - time '00:00'))::date AS day
      WHERE EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $2)
    ) operating
  `, [at, timezone, dayStart]);
  if (!bounds) throw new StockError(503, 'OPERATING_CLOCK_UNAVAILABLE');
  if (write) {
    await db.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
    // The runtime role can update only these clock columns on the transaction's RLS-scoped store.
    await db.query(`
      UPDATE inventory.store SET stock_timezone = $1, stock_day_start = $2
      WHERE (stock_timezone, stock_day_start) IS DISTINCT FROM ($1, $2::time)
    `, [timezone, dayStart]);
    if (current) return current.day;
    await db.query(`
      INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, $2, $3, $4) ON CONFLICT (store_id, business_date) DO NOTHING
    `, [storeId, bounds.day, bounds.start, bounds.end]);
    const { rows: [saved] } = await db.query<{ open: boolean }>(`
      SELECT closed_at IS NULL AND starts_at <= $3 AND ends_at > $3 AS open
      FROM inventory.business_day WHERE store_id = $1 AND business_date = $2
    `, [storeId, bounds.day, at]);
    if (!saved?.open) throw new StockError(409, 'DAY_CLOSED');
  }
  return bounds.day;
}

const itemColumns = `
  i.item_id AS "itemId", i.sku, i.name AS "storedName",
  coalesce(i.name, r.name) AS name, coalesce(r.kind, 'ingredient') AS kind,
  coalesce(i.display_unit, i.base_unit, CASE WHEN r.kind = 'retail' THEN 'pcs' END) AS unit,
  coalesce(i.base_unit, CASE WHEN r.kind = 'retail' THEN 'pcs' END) AS "baseUnit",
  i.threshold_base::text AS "thresholdBase", i.track_restock AS "trackRestock", i.track_expiry AS "trackExpiry",
  i.revision, i.updated_at AS "updatedAt", i.archived_at AS "archivedAt"
`;
const retailLookup = `LEFT JOIN LATERAL (
    SELECT kind, name FROM inventory.menu_item
    WHERE store_id = i.store_id AND inventory_item_id = i.item_id AND deleted_at IS NULL
    ORDER BY menu_id LIMIT 1
  ) r ON true`;

export async function referenced(db: PoolClient, storeId: string, itemId: string) {
  const { rows: [row] } = await db.query<{ active: boolean }>(`
    SELECT (EXISTS (
      SELECT 1 FROM inventory.recipe_current c JOIN inventory.recipe_version v
        USING (store_id, menu_id, component_id, version)
      WHERE c.store_id = $1 AND v.ingredients @> jsonb_build_array(jsonb_build_object('item_id', $2::uuid))
    ) OR EXISTS (
      SELECT 1 FROM inventory.purchase_order_line l JOIN inventory.purchase_order p USING (store_id, po_id)
      WHERE l.store_id = $1 AND l.item_id = $2 AND p.canceled_at IS NULL AND l.qty_ordered > coalesce((
        SELECT sum(g.qty) FROM inventory.goods_receipt g WHERE g.store_id = l.store_id AND g.pol_id = l.pol_id AND g.voided_at IS NULL
      ), 0)
    )) AS active
  `, [storeId, itemId]);
  return row.active;
}

export async function itemForWrite(db: PoolClient, storeId: string, itemId: string, includeArchived = false) {
  const { rows: [row] } = await db.query<ItemRecord>(`
    SELECT ${itemColumns}
    FROM inventory.inventory_item i ${retailLookup}
    WHERE i.store_id = $1 AND i.item_id = $2 AND ($3 OR i.archived_at IS NULL)
    FOR UPDATE OF i
  `, [storeId, itemId, includeArchived]);
  if (!row) throw new StockError(404, 'STOCK_ITEM_NOT_FOUND');
  return row;
}

async function page<T>(db: PoolClient, storeId: string, at: Date, rows: T[], limit: number, id: (row: T) => string) {
  const { rows: [source] } = await db.query<{ last_seq: string }>(
    'SELECT last_seq FROM inventory.outbox_scope WHERE scope_key = $1', [storeId],
  );
  const items = rows.slice(0, limit);
  return { items, asOf: at.toISOString(), sourceRevision: Number(source?.last_seq ?? 0),
    nextCursor: rows.length > limit ? id(items[items.length - 1]) : null };
}

export async function listItems(
  db: PoolClient, storeId: string, at: Date, businessDate: string, query: unknown, itemId?: string,
) {
  const { cursor, limit, filters } = pageInput(query, ['businessDate', 'kind']);
  const { kind } = filters;
  if (kind !== undefined && kind !== 'ingredient' && kind !== 'retail') throw new StockError(400, 'INVALID_REQUEST', 'kind');
  const { rows } = await db.query<VisibleItem>(`
    SELECT ${itemColumns}, b.expires_on::text AS "expiresOn",
      (EXISTS (
        SELECT 1 FROM inventory.recipe_current c JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
        WHERE c.store_id = i.store_id AND v.ingredients @> jsonb_build_array(jsonb_build_object('item_id', i.item_id))
      ) OR EXISTS (
        SELECT 1 FROM inventory.purchase_order_line l JOIN inventory.purchase_order p USING (store_id, po_id)
        WHERE l.store_id = i.store_id AND l.item_id = i.item_id AND p.canceled_at IS NULL AND l.qty_ordered > coalesce((
          SELECT sum(g.qty) FROM inventory.goods_receipt g WHERE g.store_id = l.store_id AND g.pol_id = l.pol_id AND g.voided_at IS NULL
        ), 0)
      )) AS referenced
    FROM inventory.inventory_item i ${retailLookup}
    LEFT JOIN LATERAL (
      SELECT min(expires_on) AS expires_on FROM inventory.stock_batch b
      WHERE b.store_id = i.store_id AND b.item_id = i.item_id AND b.remaining_base > 0 AND b.discarded_at IS NULL
    ) b ON true
    WHERE i.store_id = $1 AND i.archived_at IS NULL
      AND ($2::uuid IS NULL OR i.item_id > $2) AND ($3::uuid IS NULL OR i.item_id = $3)
      AND ($4::text IS NULL OR coalesce(r.kind, 'ingredient') = $4)
    ORDER BY i.item_id LIMIT $5
  `, [storeId, cursor, itemId ?? null, kind ?? null, limit + 1]);
  const balances = await stockForItems(db, storeId, businessDate, rows.map(row => row.itemId));
  const items = rows.map(({ archivedAt: _archivedAt, storedName: _storedName, ...row }, i) => ({ ...row, ...balances[i], businessDate }));
  if (itemId) {
    if (!items[0]) throw new StockError(404, 'STOCK_ITEM_NOT_FOUND');
    return items[0];
  }
  return { ...await page(db, storeId, at, items, limit, row => row.itemId), businessDate };
}

export async function listBatches(db: PoolClient, storeId: string, at: Date, query: unknown) {
  const { cursor, limit, filters } = pageInput(query, ['itemId', 'expiresOn']);
  const id = filters.itemId === undefined ? null : uuid(filters.itemId, 'itemId');
  const expiry = filters.expiresOn === undefined ? null : date(filters.expiresOn, 'expiresOn');
  const { rows } = await db.query<{ batchId: string }>(`
    SELECT batch_id AS "batchId", item_id AS "itemId", quantity_base::text AS "quantityBase",
      remaining_base::text AS "remainingQuantityBase", expires_on::text AS "expiresOn",
      received_at AS "receivedAt", discarded_at AS "discardedAt", revision
    FROM inventory.stock_batch
    WHERE store_id = $1 AND ($2::uuid IS NULL OR item_id = $2) AND ($3::uuid IS NULL OR batch_id > $3)
      AND ($4::date IS NULL OR expires_on = $4)
    ORDER BY batch_id LIMIT $5
  `, [storeId, id, cursor, expiry, limit + 1]);
  return page(db, storeId, at, rows, limit, row => row.batchId);
}

export async function listMovements(db: PoolClient, storeId: string, at: Date, currentDay: string, query: unknown) {
  const { cursor, limit, filters: { itemId, businessDate, from, to } } = pageInput(query, ['itemId', 'businessDate', 'from', 'to']);
  if ((businessDate !== undefined && (from !== undefined || to !== undefined)) || (from === undefined) !== (to === undefined)) {
    throw new StockError(400, 'INVALID_REQUEST', 'businessDate');
  }
  const first = date(from ?? businessDate ?? currentDay, from === undefined ? 'businessDate' : 'from');
  const last = date(to ?? businessDate ?? currentDay, to === undefined ? 'businessDate' : 'to');
  const span = +new Date(last) - +new Date(first);
  if (span < 0 || span > 30 * 86400000) throw new StockError(400, 'INVALID_REQUEST', 'to');
  const { rows } = await db.query<{ movementId: string }>(`
    WITH days AS (
      SELECT business_date, starts_at FROM inventory.business_day WHERE store_id = $1 AND business_date BETWEEN $2 AND $3
    ), sales AS (
      SELECT s.settlement_id, s.business_date, coalesce(s.recorded_at, d.starts_at) AS at, l.allocation_id,
        (l.line_identity->>'menuId')::uuid AS menu_id, i.item_id, l.recognized_quantity AS qty,
        sum(i.quantity_base) AS ingredient_base
      FROM inventory.sale_usage s JOIN inventory.sale_usage_line l USING (store_id, settlement_id)
      LEFT JOIN days d USING (business_date)
      CROSS JOIN LATERAL jsonb_to_recordset(l.ingredients) i(item_id uuid, quantity_base numeric)
      WHERE s.store_id = $1 AND s.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.item_id = $4)
      GROUP BY s.settlement_id, s.business_date, s.recorded_at, d.starts_at, l.allocation_id,
        l.line_identity, l.recognized_quantity, i.item_id
    ), history AS (
      SELECT m.movement_id, m.item_id, m.business_date, m.at,
        CASE WHEN m.kind = 'adjust' AND m.reason = 'receipt_undo' THEN 'receive' ELSE m.kind END AS kind,
        m.channel, m.delta_base::numeric,
        coalesce(m.receipt_id, m.source_id, m.movement_id) AS source_id, null::uuid AS menu_id, m.reason, null::int AS menu_qty
      FROM inventory.stock_movement m
      WHERE m.store_id = $1 AND m.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR m.item_id = $4)
      UNION ALL
      SELECT md5(concat_ws('/', 'opening', o.item_id, o.business_date, o.channel))::uuid,
        o.item_id, o.business_date, d.starts_at, 'opening', o.channel, o.quantity_base, o.item_id, null::uuid, null, null
      FROM inventory.stock_daily_opening o JOIN days d USING (business_date)
      WHERE o.store_id = $1 AND ($4::uuid IS NULL OR o.item_id = $4)
      UNION ALL
      SELECT md5(concat_ws('/', 'sale', allocation_id, item_id))::uuid, item_id, business_date, at,
        'usage', 'store', -qty * ingredient_base, settlement_id, menu_id, 'sale_recognized', qty
      FROM sales
      UNION ALL
      SELECT md5(concat_ws('/', 'correction', c.correction_id, s.allocation_id, s.item_id))::uuid,
        s.item_id, s.business_date, coalesce(c.recorded_at, s.at), 'usage', 'store',
        line.quantity * s.ingredient_base, c.correction_id, s.menu_id, 'sale_corrected', -line.quantity
      FROM inventory.sale_usage_correction c JOIN sales s USING (settlement_id)
      CROSS JOIN LATERAL jsonb_to_recordset(c.correction->'lines') line("allocationId" uuid, quantity int)
      WHERE c.store_id = $1 AND c.correction->>'usageEffect' = 'restore' AND line."allocationId" = s.allocation_id
    )
    SELECT movement_id AS "movementId", item_id AS "itemId", business_date::text AS "businessDate", at,
      kind, channel, delta_base::text AS "deltaBase", source_id AS "sourceId", menu_id AS "menuId",
      reason, menu_qty AS "menuQuantity"
    FROM history WHERE $5::uuid IS NULL OR movement_id > $5 ORDER BY movement_id LIMIT $6
  `, [storeId, first, last, itemId === undefined ? null : uuid(itemId, 'itemId'), cursor, limit + 1]);
  return page(db, storeId, at, rows, limit, row => row.movementId);
}
