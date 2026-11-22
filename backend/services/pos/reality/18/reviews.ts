import { applyCommand } from '../../ledger.ts';
import { object, PosError } from '../../wire.ts';
import { money, revision as contentRevision, type FinanceTx } from '../09/input.ts';
import { cursorInput, limitInput, query, revisionInput, taxPeriod } from './input.ts';
import { unchangedReceipt, undoableReceipt } from './receipts.ts';

type ReviewImage = { status: 'checked' | 'unchecked'; expenseRevision: number; checkedBy: string; checkedAt: string };
type ItemDb = {
  expenseId: string; businessDate: string; category: string; amount: number; memo: string | null;
  expenseRevision: number; reviewStatus: 'checked' | 'unchecked' | null; reviewedRevision: number | null;
  reviewRevision: number | null; checkedAt: Date | null;
};

// A review item is a confirmed B09 expense whose owner-recorded evidence is `none` (the widget's
// "확인할 세무 자료"). A check holds only while the expense keeps the revision that was reviewed.
const itemRows = `
  SELECT e.expense_id AS "expenseId", e.business_date::text AS "businessDate", e.category,
    e.amount::double precision AS amount, e.memo, e.revision AS "expenseRevision",
    r.status AS "reviewStatus", r.expense_revision AS "reviewedRevision", r.revision AS "reviewRevision",
    r.checked_at AS "checkedAt",
    coalesce(r.status = 'checked' AND r.expense_revision = e.revision, false) AS checked
  FROM pos.expense e
  LEFT JOIN pos.tax_review r ON r.store_id = e.store_id AND r.expense_id = e.expense_id
  WHERE e.store_id = $1 AND e.status = 'confirmed' AND e.evidence = 'none'
`;

function itemDto(row: ItemDb) {
  const checked = row.reviewStatus === 'checked' && row.reviewedRevision === row.expenseRevision;
  return {
    refType: 'expense' as const, refId: row.expenseId, expenseId: row.expenseId, date: row.businessDate,
    category: row.category, amount: row.amount, memo: row.memo, reason: 'missing-evidence' as const,
    status: checked ? 'checked' as const : 'needs-check' as const, expenseRevision: row.expenseRevision,
    reviewRevision: row.reviewRevision, checkedAt: checked ? row.checkedAt?.toISOString() ?? null : null,
  };
}
export type TaxReviewItem = ReturnType<typeof itemDto>;

export async function reviewCounts(tx: FinanceTx, from: string, to: string) {
  const { rows: [row] } = await tx.db.query<{ total: string; checked: string }>(`
    WITH items AS (${itemRows} AND e.business_date BETWEEN $2 AND $3)
    SELECT count(*) AS total, count(*) FILTER (WHERE checked) AS checked FROM items
  `, [tx.storeId, from, to]);
  const total = money(row.total), checked = money(row.checked);
  return { total, checked, needsCheck: total - checked };
}

/** `GET /tax-reviews`: newest first. `status` filters to `needs-check` or `checked`; counts always cover the whole period. */
export async function listReviews(tx: FinanceTx, value: unknown) {
  const input = query(value, ['from', 'to', 'status', 'cursor', 'limit']);
  const { from, to } = await taxPeriod(tx, input);
  if (input.status !== undefined && input.status !== 'needs-check' && input.status !== 'checked') throw new PosError(400, 'INVALID_STATUS');
  const status = (input.status ?? null) as 'needs-check' | 'checked' | null;
  const limit = limitInput(input.limit);
  const cursor = cursorInput(input.cursor);
  const { rows } = await tx.db.query<ItemDb>(`
    WITH items AS (${itemRows} AND e.business_date BETWEEN $2 AND $3)
    SELECT * FROM items
    WHERE ($4::text IS NULL OR checked = ($4 = 'checked'))
      AND ($5::uuid IS NULL OR ("businessDate", "expenseId") < (SELECT "businessDate", "expenseId" FROM items WHERE "expenseId" = $5))
    ORDER BY "businessDate" DESC, "expenseId" DESC LIMIT $6
  `, [tx.storeId, from, to, status, cursor, limit + 1]);
  const items = rows.slice(0, limit).map(itemDto);
  const nextCursor = rows.length > limit ? items[limit - 1].expenseId : null;
  const counts = await reviewCounts(tx, from, to);
  return { from, to, items, nextCursor, reviewCount: counts.needsCheck, checkedCount: counts.checked, totalCount: counts.total,
    asOf: tx.at.toISOString(), sourceRevision: contentRevision({ from, to, items, nextCursor, counts }) };
}

async function readItem(tx: FinanceTx, expenseId: string) {
  const { rows: [row] } = await tx.db.query<ItemDb>(`${itemRows} AND e.expense_id = $2`, [tx.storeId, expenseId]);
  if (!row) throw new PosError(404, 'TAX_ITEM_NOT_FOUND');
  return row;
}

/** `tax.markChecked({refId})` with the expense revision the owner saw. Repeating a current check changes nothing. */
export function checkReview(tx: FinanceTx, key: string, expenseId: string, body: unknown) {
  const input = object(body, ['expenseRevision']);
  const expenseRevision = revisionInput(input.expenseRevision);
  return applyCommand(tx, 'tax.review.check', key, { expenseId, expenseRevision }, async () => {
    const row = await readItem(tx, expenseId);
    if (row.expenseRevision !== expenseRevision) throw new PosError(409, 'STALE_REVISION', { revision: row.expenseRevision });
    const current = itemDto(row);
    if (current.status === 'checked') return { ...unchangedReceipt(expenseId, row.reviewRevision!), item: current };
    const before: ReviewImage | null = row.reviewStatus ? {
      status: row.reviewStatus, expenseRevision: row.reviewedRevision!, checkedBy: '', checkedAt: '' } : null;
    if (before) {
      const { rows: [previous] } = await tx.db.query<{ checkedBy: string; checkedAt: Date }>(`
        SELECT checked_by AS "checkedBy", checked_at AS "checkedAt" FROM pos.tax_review WHERE store_id = $1 AND expense_id = $2
      `, [tx.storeId, expenseId]);
      before.checkedBy = previous.checkedBy;
      before.checkedAt = previous.checkedAt.toISOString();
    }
    const { rows: [saved] } = await tx.db.query<{ revision: number }>(`
      INSERT INTO pos.tax_review (store_id, expense_id, status, expense_revision, revision, checked_by, checked_at)
      VALUES ($1, $2, 'checked', $3, 1, $4, $5)
      ON CONFLICT (store_id, expense_id) DO UPDATE SET status = 'checked', expense_revision = EXCLUDED.expense_revision,
        revision = pos.tax_review.revision + 1, checked_by = EXCLUDED.checked_by, checked_at = EXCLUDED.checked_at
      RETURNING revision
    `, [tx.storeId, expenseId, expenseRevision, tx.actorId, tx.at]);
    const receipt = await undoableReceipt(tx, 'tax-review', expenseId, saved.revision, before);
    return { ...receipt, expenseId, item: itemDto(await readItem(tx, expenseId)) };
  });
}

export async function restoreReview(tx: FinanceTx, expenseId: string, revision: number, before: ReviewImage | null) {
  const { rows: [row] } = await tx.db.query<{ revision: number; expenseRevision: number; checkedBy: string; checkedAt: Date }>(`
    SELECT revision, expense_revision AS "expenseRevision", checked_by AS "checkedBy", checked_at AS "checkedAt"
    FROM pos.tax_review WHERE store_id = $1 AND expense_id = $2
  `, [tx.storeId, expenseId]);
  if (!row || row.revision !== revision) throw new PosError(409, 'UNDO_UNAVAILABLE');
  const next = before ?? { status: 'unchecked' as const, expenseRevision: row.expenseRevision,
    checkedBy: row.checkedBy, checkedAt: row.checkedAt.toISOString() };
  await tx.db.query(`
    UPDATE pos.tax_review SET status = $3, expense_revision = $4, checked_by = $5, checked_at = $6, revision = $7
    WHERE store_id = $1 AND expense_id = $2
  `, [tx.storeId, expenseId, next.status, next.expenseRevision, next.checkedBy, next.checkedAt, revision + 1]);
  return revision + 1;
}
