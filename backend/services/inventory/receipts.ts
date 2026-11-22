import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { InventoryReceiptRecorded } from '../../packages/contracts/events.ts';
import { lockStockStore } from './reality/03/commands.ts';
import { maxSafe, milliquantity } from './reality/04/wire.ts';

export class ReceiptError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;

  constructor(status: 400 | 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

type ReceiptInput = { polId: string; qty: number; poId?: string; undoUntil?: string };
type ReceiptResult = { receiptId: string; qtyRemaining: number };
type OrderLine = { po_id: string; item_id: string; supplier_id: string; canceled: boolean; scheduled: boolean;
  remaining: string; base_per_unit: string; unit_price: string };

export async function lockPurchasing(db: PoolClient, storeId: string) {
  // Also used by the legacy private intake and the POS live confirmation check.
  await lockStockStore(db, storeId);
}

export async function appendPurchaseEvent(
  db: PoolClient, storeId: string, at: Date, event: string, aggregateId: string, payload: Record<string, unknown>,
) {
  await db.query(`
    WITH sequence AS (
      INSERT INTO inventory.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = inventory.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO inventory.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT $2, $1::uuid, $1, last_seq, $3, $4, $5, $6 FROM sequence
  `, [storeId, randomUUID(), event, aggregateId, at, payload]);
}

export async function recordReceipt(
  db: PoolClient, storeId: string, at: Date, key: string, { polId, qty, poId, undoUntil }: ReceiptInput,
): Promise<ReceiptResult> {
  await lockPurchasing(db, storeId);
  if (!Number.isFinite(qty) || qty < 1 || !/^\d+(?:\.\d{1,3})?$/.test(String(qty))) {
    throw new ReceiptError(400, 'ORDER_QTY_INVALID');
  }
  const quantity = milliquantity(qty);

  const { rows: [saved] } = await db.query<{ receipt_id: string; pol_id: string; qty: string; qty_remaining: string }>(`
    SELECT receipt_id, pol_id, qty, qty_remaining FROM inventory.goods_receipt
    WHERE store_id = $1 AND idempotency_key = $2
  `, [storeId, key]);
  if (saved) {
    if (saved.pol_id !== polId || milliquantity(saved.qty) !== quantity) throw new ReceiptError(409, 'IDEMPOTENCY_MISMATCH');
    return { receiptId: saved.receipt_id, qtyRemaining: Number(saved.qty_remaining) };
  }

  const { rows: [day] } = await db.query<{ business_date: string }>(`
    SELECT business_date::text FROM inventory.business_day
    WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2 AND closed_at IS NULL
  `, [storeId, at]);
  if (!day) throw new ReceiptError(409, 'DAY_CLOSED');

  const { rows: [line] } = await db.query<OrderLine>(`
    SELECT l.po_id, l.item_id, o.supplier_id, o.canceled_at IS NOT NULL AS canceled,
      o.due_date IS NOT NULL AS scheduled, l.base_per_unit, l.unit_price,
      l.qty_ordered - coalesce((
        SELECT sum(r.qty) FROM inventory.goods_receipt r WHERE r.store_id = l.store_id AND r.pol_id = l.pol_id AND r.voided_at IS NULL
      ), 0) AS remaining
    FROM inventory.purchase_order_line l
    JOIN inventory.purchase_order o USING (store_id, po_id)
    WHERE l.store_id = $1 AND l.pol_id = $2 AND ($3::uuid IS NULL OR l.po_id = $3)
  `, [storeId, polId, poId ?? null]);
  if (!line) throw new ReceiptError(404, 'ORDER_LINE_NOT_FOUND');
  if (!poId && line.scheduled) throw new ReceiptError(409, 'ORDER_REVISION_REQUIRED');
  const remaining = milliquantity(line.remaining) - quantity;
  if (line.canceled || remaining < 0n) throw new ReceiptError(409, 'RECEIPT_QUANTITY_UNAVAILABLE');

  const scaledDelta = quantity * BigInt(line.base_per_unit);
  if (scaledDelta % 1000n !== 0n) throw new ReceiptError(400, 'UNIT_PRECISION');
  const delta = scaledDelta / 1000n;
  const amount = (quantity * BigInt(line.unit_price) + 500n) / 1000n;
  if (amount > maxSafe || delta > maxSafe) throw new ReceiptError(409, 'RECEIPT_VALUE_UNSUPPORTED');

  const receiptId = randomUUID();
  const qtyRemaining = Number(`${remaining / 1000n}.${String(remaining % 1000n).padStart(3, '0')}`);
  await db.query(`
    INSERT INTO inventory.goods_receipt (store_id, receipt_id, pol_id, qty, qty_remaining, received_at, idempotency_key, undo_until)
    VALUES ($1, $2, $3, $4, trim_scale($5::numeric / 1000), $6, $7, $8)
  `, [storeId, receiptId, polId, qty, remaining.toString(), at, key, undoUntil ?? null]);
  await db.query(`
    INSERT INTO inventory.stock_movement (store_id, movement_id, item_id, business_date, kind, delta_base, channel, at, receipt_id, source_id)
    VALUES ($1, $2, $3, $4, 'receive', $5, 'store', $6, $7, $7)
  `, [storeId, randomUUID(), line.item_id, day.business_date, delta.toString(), at, receiptId]);

  const payload: InventoryReceiptRecorded['payload'] & { undoUntil?: string } = {
    receiptId, supplierId: line.supplier_id, businessDate: day.business_date, amount: Number(amount),
    ...(undoUntil ? { undoUntil } : {}),
  };
  await appendPurchaseEvent(db, storeId, at, 'inventory.receipt_recorded.v1', receiptId, payload);
  await db.query('UPDATE inventory.purchase_order SET revision = revision + 1 WHERE store_id = $1 AND po_id = $2', [storeId, line.po_id]);
  return { receiptId, qtyRemaining };
}
