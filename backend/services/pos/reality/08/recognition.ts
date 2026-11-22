import { randomUUID } from 'node:crypto';
import { PosError, type PosTx } from '../../wire.ts';
import { recognizeCustomPickup } from '../09/custom-pickup.ts';
import type { Order } from './records.ts';

export async function originalRecognition(tx: PosTx, order: Order) {
  const { rows: [original] } = await tx.db.query<{ recognitionId: string }>(`
    SELECT recognition_id AS "recognitionId" FROM pos.custom_pickup_recognition
    WHERE store_id=$1 AND custom_order_id=$2`, [tx.storeId, order.customOrderId]);
  return original?.recognitionId ?? null;
}

type Adjustment =
  | { kind: 'receive' | 'undo'; amount: number; day: string }
  | { kind: 'refund'; amount: number; day: string; correctionId: string; at: Date };

export async function adjustRecognition(tx: PosTx, order: Order, input: Adjustment) {
  const id = randomUUID();
  await tx.db.query(`INSERT INTO pos.custom_pickup_adjustment
    (store_id,adjustment_id,correction_id,custom_order_id,business_date,at,kind,amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tx.storeId, id, input.kind === 'refund' ? input.correctionId : null,
    order.customOrderId, input.day, input.kind === 'refund' ? input.at : tx.at, input.kind, input.amount]);
  return id;
}

/** The first handover is pinned by B09. A handover after an undo restores revenue on its own open day. */
export async function recognizeHandover(tx: PosTx, order: Order, day: string) {
  if (!order.quoteAmount || !order.settlementId) throw new PosError(409, 'PAYMENT_REQUIRED');
  const original = await originalRecognition(tx, order);
  if (original) {
    const { rows: [latest] } = await tx.db.query<{ balance: string }>(`
      SELECT coalesce(sum(amount),0) AS balance FROM pos.custom_pickup_adjustment
      WHERE store_id=$1 AND custom_order_id=$2`, [tx.storeId, order.customOrderId]);
    if (Number(latest.balance) !== -order.quoteAmount) throw new PosError(409, 'CUSTOM_PICKUP_ALREADY_RECOGNIZED');
    return adjustRecognition(tx, order, { kind: 'receive', amount: order.quoteAmount, day });
  }
  return recognizeCustomPickup(tx, { customOrderId: order.customOrderId, businessDate: day,
    name: order.receipt.productLabel, amount: order.quoteAmount, settlementId: order.settlementId });
}
