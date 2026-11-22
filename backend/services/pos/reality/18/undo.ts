import { applyCommand } from '../../ledger.ts';
import { commandReceipt, object, PosError } from '../../wire.ts';
import type { FinanceTx } from '../09/input.ts';
import { taxSources } from './input.ts';
import { restorePayment, type PaymentImage } from './payments.ts';
import type { UndoKind } from './receipts.ts';
import { restoreReview } from './reviews.ts';

/**
 * `POST /tax/receipts/:receiptId/undo`. Only the owner who received the receipt can undo it, once, before its
 * server deadline and while the resource still has the revision the receipt produced.
 */
export function undoTax(tx: FinanceTx, key: string, receiptId: string, body: unknown) {
  object(body ?? {}, []);
  return applyCommand(tx, 'tax.undo', key, { receiptId }, async () => {
    const { rows: [undo] } = await tx.db.query<{
      kind: UndoKind; resourceId: string; deadline: Date; revision: number; before: object | null; undoneAt: Date | null;
    }>(`
      SELECT resource_kind AS kind, resource_id AS "resourceId", undo_until AS deadline, resource_revision AS revision,
        before_image AS before, undone_at AS "undoneAt"
      FROM pos.tax_undo WHERE store_id = $1 AND receipt_id = $2 AND actor_id = $3
    `, [tx.storeId, receiptId, tx.actorId]);
    if (!undo) throw new PosError(404, 'RECEIPT_NOT_FOUND');
    if (+tx.at >= +undo.deadline) throw new PosError(409, 'UNDO_EXPIRED', { undoUntil: undo.deadline.toISOString() });
    if (undo.undoneAt) throw new PosError(409, 'UNDO_UNAVAILABLE');
    const revision = undo.kind === 'tax-payment'
      ? await restorePayment(tx, undo.resourceId, undo.revision, undo.before as PaymentImage | null)
      : await restoreReview(tx, undo.resourceId, undo.revision, undo.before as Parameters<typeof restoreReview>[3]);
    await tx.db.query('UPDATE pos.tax_undo SET undone_at = $3 WHERE store_id = $1 AND receipt_id = $2', [tx.storeId, receiptId, tx.at]);
    return { ...commandReceipt(undo.resourceId, revision, [...taxSources]), resourceKind: undo.kind, undoneReceiptId: receiptId };
  });
}
