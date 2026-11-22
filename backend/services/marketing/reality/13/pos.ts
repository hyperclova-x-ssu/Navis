import type { PoolClient } from 'pg';
import type { StreamEnvelope } from '../../../../packages/streams/envelope.ts';
import { isUuid } from '../../promo/contracts.ts';
import { day, type Period, type Sale } from './sources.ts';

async function consume(db: PoolClient, event: StreamEnvelope) {
  const { storeId, eventId, eventType, occurredAt, payload } = event;
  if (!isUuid(storeId) || !isUuid(payload.settlementId) || !Array.isArray(payload.lines)) {
    throw new Error('Invalid POS sales input');
  }
  const recognized = eventType === 'pos.sale_recognized.v1';
  if (!recognized && payload.usageEffect !== 'restore') return;
  const businessDate = day(payload.businessDate);
  const lines = payload.lines.map(line => {
    if (!isUuid(line?.allocationId) || typeof line.menuId !== 'string' || line.menuId.length < 1 ||
      line.menuId.length > 160 || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 2147483647) {
      throw new Error('Invalid POS sales line');
    }
    return { allocationId: line.allocationId, menuId: line.menuId,
      quantity: recognized ? line.quantity : -line.quantity };
  });
  await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
  await db.query(`
    INSERT INTO marketing.local_sale_delta (store_id, event_id, settlement_id, allocation_id, menu_id,
      quantity, business_date, occurred_at)
    SELECT $1, $2, $3, row."allocationId", row."menuId", row.quantity, $4, $5
    FROM jsonb_to_recordset($6::jsonb) AS row("allocationId" uuid, "menuId" text, quantity integer)
    ON CONFLICT (store_id, event_id, allocation_id) DO NOTHING`,
  [storeId, eventId, payload.settlementId, businessDate, occurredAt, JSON.stringify(lines)]);
}

export const localPosHandlers = {
  'pos.sale_recognized.v1': consume,
  'pos.sale_corrected.v1': consume,
};

export async function readProjectedSales(db: PoolClient, storeId: string, range: Period) {
  const result = await db.query<Sale>(`
    SELECT original.settlement_id AS "settlementId", original.menu_id AS "menuId",
      original.occurred_at AS "occurredAt", original.business_date::text AS "businessDate",
      sum(delta.quantity)::integer AS quantity
    FROM marketing.local_sale_delta original
    JOIN marketing.local_sale_delta delta USING (store_id, settlement_id, allocation_id)
    WHERE original.store_id = $1 AND original.quantity > 0 AND original.business_date BETWEEN $2 AND $3
    GROUP BY original.settlement_id, original.occurred_at, original.business_date, original.menu_id
    HAVING sum(delta.quantity) > 0
    ORDER BY original.occurred_at, original.settlement_id, original.menu_id`, [storeId, range.from, range.to]);
  return result.rows.map(row => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString() }));
}
