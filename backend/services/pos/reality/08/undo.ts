import type { CustomStage, CustomTemplate, PickupReservation } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { applyCommand } from '../../ledger.ts';
import { object, PosError, type PosTx } from '../../wire.ts';

export type UndoEffect =
  | { kind: 'template'; templateId: string; revision: number; previous: CustomTemplate | null }
  | { kind: 'reschedule'; customOrderId: string; revision: number; previous: PickupReservation }
  | { kind: 'payment'; customOrderId: string; revision: number; businessDate: string; settlementId: string; previousStage: CustomStage }
  | { kind: 'receive'; customOrderId: string; revision: number; businessDate: string };

export async function registerUndo<T extends { receiptId: string }>(tx: PosTx, receipt: T, commandType: string, key: string, effect: UndoEffect) {
  const undoUntil = new Date(tx.at.getTime() + 6000).toISOString();
  await tx.db.query(`INSERT INTO pos.custom_receipt_undo (store_id,receipt_id,actor_id,command_type,command_key,undo_until,effect)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tx.storeId, receipt.receiptId, tx.actorId, commandType, key, undoUntil, effect]);
  return { ...receipt, undoUntil };
}

export function undoCustomReceipt(tx: PosTx, key: string, id: string, body: unknown,
  apply: (effect: UndoEffect) => Promise<object>) {
  object(body, []);
  return applyCommand(tx, 'custom.undo', key, { id }, async () => {
    const { rows: [row] } = await tx.db.query<{ commandType: string; commandKey: string; effect: UndoEffect; deadline: Date; status: string }>(`
      SELECT c.command_type AS "commandType", c.command_key AS "commandKey", u.effect, u.undo_until AS deadline, c.status
      FROM pos.custom_receipt_undo u JOIN pos.command_ledger c USING (store_id,command_type,command_key)
      WHERE u.store_id=$1 AND u.receipt_id=$2 AND u.actor_id=$3`, [tx.storeId, id, tx.actorId]);
    if (!row) throw new PosError(404, 'RECEIPT_NOT_FOUND');
    if (row.deadline <= tx.at) throw new PosError(409, 'UNDO_EXPIRED');
    if (row.status !== 'committed') throw new PosError(409, 'UNDO_UNAVAILABLE');
    const receipt = await apply(row.effect);
    await tx.db.query(`UPDATE pos.command_ledger SET status='aborted'
      WHERE store_id=$1 AND command_type=$2 AND command_key=$3`, [tx.storeId, row.commandType, row.commandKey]);
    return receipt;
  });
}
