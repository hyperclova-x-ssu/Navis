import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { InventoryReceiptRecorded } from '../../packages/contracts/events.ts';

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

export class ReceiptError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;

  constructor(status: 400 | 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

type ReceiptInput = { polId: string; qty: number };
type ReceiptResult = { receiptId: string; qtyRemaining: number };
type OrderLine = { item_id: string; supplier_id: string; canceled: boolean; remaining: string; base_per_unit: string; unit_price: string };

export async function recordReceipt(
  db: PoolClient, storeId: string, at: Date, key: string, { polId, qty }: ReceiptInput,
): Promise<ReceiptResult> {
  // Serialize receipts per producer/store, including retries and competing writes to the same order.
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('navis:inventory:receipt:' || $1::text, 0))`, [storeId]);

  const { rows: [saved] } = await db.query<{ receipt_id: string; pol_id: string; qty: string; qty_remaining: string }>(`
    SELECT receipt_id, pol_id, qty, qty_remaining FROM inventory.goods_receipt
    WHERE store_id = $1 AND idempotency_key = $2
  `, [storeId, key]);
  if (saved) {
    if (saved.pol_id !== polId || BigInt(saved.qty) !== BigInt(qty)) throw new ReceiptError(409, 'IDEMPOTENCY_MISMATCH');
    return { receiptId: saved.receipt_id, qtyRemaining: Number(saved.qty_remaining) };
  }

  const { rows: [day] } = await db.query<{ business_date: string }>(`
    SELECT business_date::text FROM inventory.business_day
    WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2 AND closed_at IS NULL
  `, [storeId, at]);
  if (!day) throw new ReceiptError(409, 'DAY_CLOSED');

  const { rows: [line] } = await db.query<OrderLine>(`
    SELECT l.item_id, o.supplier_id, o.canceled_at IS NOT NULL AS canceled, l.base_per_unit, l.unit_price,
      l.qty_ordered - coalesce((
        SELECT sum(r.qty) FROM inventory.goods_receipt r WHERE r.store_id = l.store_id AND r.pol_id = l.pol_id
      ), 0) AS remaining
    FROM inventory.purchase_order_line l
    JOIN inventory.purchase_order o USING (store_id, po_id)
    WHERE l.store_id = $1 AND l.pol_id = $2
  `, [storeId, polId]);
  if (!line) throw new ReceiptError(404, 'ORDER_LINE_NOT_FOUND');
  const quantity = BigInt(qty);
  if (line.canceled || quantity > BigInt(line.remaining)) throw new ReceiptError(409, 'RECEIPT_QUANTITY_UNAVAILABLE');

  const delta = quantity * BigInt(line.base_per_unit);
  const amount = quantity * BigInt(line.unit_price);
  if (amount === 0n || amount > maxSafe || delta > maxSafe) throw new ReceiptError(409, 'RECEIPT_VALUE_UNSUPPORTED');

  const receiptId = randomUUID();
  const remaining = BigInt(line.remaining) - quantity;
  await db.query(`
    INSERT INTO inventory.goods_receipt (store_id, receipt_id, pol_id, qty, qty_remaining, received_at, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [storeId, receiptId, polId, qty, remaining.toString(), at, key]);
  await db.query(`
    INSERT INTO inventory.stock_movement (store_id, movement_id, item_id, business_date, kind, delta_base, channel, at, receipt_id)
    VALUES ($1, $2, $3, $4, 'receive', $5, 'store', $6, $7)
  `, [storeId, randomUUID(), line.item_id, day.business_date, delta.toString(), at, receiptId]);

  const payload: InventoryReceiptRecorded['payload'] = {
    receiptId, supplierId: line.supplier_id, businessDate: day.business_date, amount: Number(amount),
  };
  await db.query(`
    WITH sequence AS (
      INSERT INTO inventory.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = inventory.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO inventory.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT $2, $1::uuid, $1, last_seq, 'inventory.receipt_recorded.v1', $3, $4, $5 FROM sequence
  `, [storeId, randomUUID(), receiptId, at, payload]);

  return { receiptId, qtyRemaining: Number(remaining) };
}
