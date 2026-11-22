import { commandReceipt } from '../../wire.ts';
import type { FinanceTx } from '../09/input.ts';
import { taxSources, undoMillis } from './input.ts';

export type UndoKind = 'tax-payment' | 'tax-review';

/** Stores the visible receipt with its server deadline. The same actor can undo it once while the revision is unchanged. */
export async function undoableReceipt(tx: FinanceTx, kind: UndoKind, resourceId: string, revision: number, before: object | null) {
  const receipt = commandReceipt(resourceId, revision, [...taxSources]);
  const undoUntil = new Date(+tx.at + undoMillis).toISOString();
  await tx.db.query(`
    INSERT INTO pos.tax_undo (store_id, receipt_id, resource_kind, resource_id, actor_id, undo_until, resource_revision, before_image)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [tx.storeId, receipt.receiptId, kind, resourceId, tx.actorId, undoUntil, revision, before]);
  return { ...receipt, undoUntil };
}

export function unchangedReceipt(resourceId: string, revision: number) {
  return { ...commandReceipt(resourceId, revision, []), changed: false as const };
}
