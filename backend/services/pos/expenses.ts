import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope, InventoryReceiptRecorded } from '../../packages/contracts/events.ts';
import { isUuid } from './wire.ts';

/** Call inside the same store-scoped POS transaction as consumer dedupe and checkpoint. */
export async function recordReceiptExpenseCandidate(
  db: PoolClient, event: InventoryReceiptRecorded & { payload: { undoUntil?: string } },
) {
  const { storeId, payload } = event;
  if (event.producer !== 'inventory' || event.eventType !== 'inventory.receipt_recorded.v1'
      || event.schemaVersion !== 1 || !isUuid(storeId) || storeId !== event.scopeKey
      || !payload || !isUuid(payload.receiptId) || event.aggregateId !== payload.receiptId
      || !isUuid(payload.supplierId) || !Number.isSafeInteger(payload.amount) || payload.amount < 0
      || typeof payload.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.businessDate)) {
    throw new Error('Invalid inventory receipt envelope');
  }
  const date = new Date(`${payload.businessDate}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== payload.businessDate) {
    throw new Error('Invalid inventory receipt business date');
  }
  const { receiptId, supplierId, businessDate, amount, undoUntil } = payload;
  if (undoUntil !== undefined && (typeof undoUntil !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(undoUntil)
      || !Number.isFinite(Date.parse(undoUntil)))) throw new Error('Invalid inventory receipt envelope');
  await db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
  const added = await db.query<{ expenseId: string }>(`
    INSERT INTO pos.expense_candidate (store_id, receipt_id, expense_id, supplier_id, business_date, amount, undo_until)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (store_id, receipt_id) DO NOTHING
    RETURNING expense_id AS "expenseId"
  `, [storeId, receiptId, randomUUID(), supplierId, businessDate, amount, undoUntil ?? null]);
  if (added.rows[0]) return added.rows[0].expenseId;
  const { rows } = await db.query<{ expenseId: string }>(`
    SELECT expense_id AS "expenseId" FROM pos.expense_candidate
    WHERE store_id = $1 AND receipt_id = $2 AND supplier_id = $3 AND business_date = $4 AND amount = $5
      AND undo_until IS NOT DISTINCT FROM $6::timestamptz
  `, [storeId, receiptId, supplierId, businessDate, amount, undoUntil ?? null]);
  if (!rows[0]) throw new Error('Receipt candidate payload changed');
  return rows[0].expenseId;
}

export type InventoryReceiptVoided = EventEnvelope<'inventory', 'inventory.receipt_voided.v1', { receiptId: string }>;

/** The inventory receipt stream orders the original receipt before its void. */
export async function voidReceiptExpenseCandidate(db: PoolClient, event: InventoryReceiptVoided) {
  const { storeId, payload } = event;
  if (event.producer !== 'inventory' || event.eventType !== 'inventory.receipt_voided.v1'
      || event.schemaVersion !== 1 || !isUuid(storeId) || storeId !== event.scopeKey
      || !isUuid(payload?.receiptId) || event.aggregateId !== payload.receiptId) {
    throw new Error('Invalid inventory receipt envelope');
  }
  const changed = await db.query(`
    UPDATE pos.expense_candidate SET status = 'canceled', revision = revision + 1
    WHERE store_id = $1 AND receipt_id = $2 AND status = 'candidate'
  `, [storeId, payload.receiptId]);
  if (changed.rowCount) return;
  const existing = await db.query(`
    SELECT 1 FROM pos.expense_candidate WHERE store_id = $1 AND receipt_id = $2 AND status = 'canceled'
  `, [storeId, payload.receiptId]);
  if (!existing.rowCount) throw new Error('Receipt candidate cannot be voided');
}
