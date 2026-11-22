import { randomUUID } from 'node:crypto';
import { appendOutbox, applyCommand } from '../../ledger.ts';
import { commandReceipt, integer, object, PosError, uuid } from '../../wire.ts';
import { page } from '../02/reads.ts';
import { currentDay, date, period, text, type FinanceTx } from './input.ts';

const categories = ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other'] as const;
const evidenceKinds = ['receipt', 'tax-invoice', 'card', 'none'] as const;
const expenseStatuses = ['confirmed', 'canceled'] as const;
const candidateStatuses = ['candidate', ...expenseStatuses] as const;
const sources = ['pos.expenses', 'pos.ledger', 'pos.closings', 'pos.finance'];
type Category = typeof categories[number];
type Evidence = typeof evidenceKinds[number];
type Expense = {
  expenseId: string; businessDate: string; category: Category; evidence: Evidence; amount: number;
  memo: string | null; supplierId: string | null; receiptId: string | null; revision: number; status: 'confirmed' | 'canceled';
};
type Candidate = Omit<Expense, 'status' | 'receiptId'> & {
  status: typeof candidateStatuses[number]; receiptId: string; undoUntil: string | null;
};
export type ReadReceiptStatus = (scope: { storeId: string; actorId: string; receiptId: string }) =>
  Promise<{ status: 'pending' | 'active' | 'voided' }>;

const expenseColumns = `expense_id AS "expenseId", business_date::text AS "businessDate", category,
  amount::double precision AS amount, evidence, memo, supplier_id AS "supplierId", receipt_id AS "receiptId", revision, status`;
const candidateColumns = `expense_id AS "expenseId", business_date::text AS "businessDate", 'ingredients' AS category,
  amount::double precision AS amount, 'receipt' AS evidence, NULL AS memo, supplier_id AS "supplierId",
  receipt_id AS "receiptId", revision, status, undo_until AS "undoUntil"`;

export async function readExpense(tx: FinanceTx, expenseId: string) {
  const { rows: [row] } = await tx.db.query<Expense>(`
    SELECT ${expenseColumns} FROM pos.expense WHERE store_id = $1 AND expense_id = $2
  `, [tx.storeId, expenseId]);
  if (!row) throw new PosError(404, 'EXPENSE_NOT_FOUND');
  return row;
}

export async function listExpenses(tx: FinanceTx, query: unknown, candidates = false) {
  const { from, to, cursor, limit, filter } = await period(tx, query, candidates ? candidateStatuses : expenseStatuses);
  const table = candidates ? 'pos.expense_candidate' : 'pos.expense';
  const columns = candidates ? candidateColumns : expenseColumns;
  const { rows } = await tx.db.query<Expense | Candidate>(`
    SELECT ${columns} FROM ${table}
    WHERE store_id = $1 AND business_date BETWEEN $2 AND $3 AND status = $4
      AND ($5::uuid IS NULL OR (business_date, expense_id) < (
        SELECT business_date, expense_id FROM ${table} WHERE store_id = $1 AND expense_id = $5))
    ORDER BY business_date DESC, expense_id DESC LIMIT $6
  `, [tx.storeId, from, to, filter ?? (candidates ? 'candidate' : 'confirmed'), cursor, limit + 1]);
  return page(tx, rows, limit, row => row.expenseId);
}

function category(value: unknown) {
  const match = categories.find(item => item === value);
  if (!match) throw new PosError(400, 'INVALID_EXPENSE_CATEGORY');
  return match;
}

async function verifyExpenseDays(tx: FinanceTx, days: string[]) {
  const today = await currentDay(tx);
  if (days.some(day => day > today)) throw new PosError(400, 'EXPENSE_DATE_FUTURE', { businessDate: today });
  const closed = await tx.db.query(`
    SELECT 1 FROM pos.business_day WHERE store_id = $1 AND business_date = ANY($2::date[]) AND status = 'closed'
  `, [tx.storeId, days]);
  if (closed.rowCount) throw new PosError(409, 'DAY_CLOSED');
}

async function expenseEvent(tx: FinanceTx, row: Expense, previousBusinessDate?: string) {
  await tx.db.query(`
    UPDATE pos.business_day SET seq = seq + 1 WHERE store_id = $1 AND business_date = ANY($2::date[]) AND status = 'open'
  `, [tx.storeId, [row.businessDate, previousBusinessDate ?? row.businessDate]]);
  await appendOutbox(tx, 'pos.expense_changed.v1', row.expenseId, {
    expenseId: row.expenseId, businessDate: row.businessDate, revision: row.revision, status: row.status,
    ...(previousBusinessDate && { previousBusinessDate }),
  });
}

async function undoableExpense(tx: FinanceTx, row: Expense, before: Expense | null) {
  const receipt = commandReceipt(row.expenseId, row.revision, sources);
  const undoUntil = new Date(+tx.at + 6_000).toISOString();
  await tx.db.query(`
    INSERT INTO pos.expense_undo (store_id, receipt_id, expense_id, actor_id, undo_until, expense_revision, before_image)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [tx.storeId, receipt.receiptId, row.expenseId, tx.actorId, undoUntil, row.revision, before]);
  await expenseEvent(tx, row, before?.businessDate);
  return { ...receipt, expenseId: row.expenseId, undoUntil };
}

export function recordExpense(tx: FinanceTx, key: string, body: unknown) {
  const input = object(body, ['date', 'category', 'amount', 'evidence', 'memo', 'supplierId', 'confirmDuplicate']);
  const evidence = evidenceKinds.find(kind => kind === (input.evidence ?? 'receipt'));
  if (!evidence) throw new PosError(400, 'INVALID_EVIDENCE');
  if (input.confirmDuplicate !== undefined && typeof input.confirmDuplicate !== 'boolean') throw new PosError(400, 'INVALID_REQUEST');
  const expense = {
    businessDate: date(input.date), category: category(input.category), evidence,
    amount: integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_AMOUNT'),
    memo: input.memo === undefined ? null : text(input.memo, 250) || null,
    supplierId: input.supplierId === undefined ? null : uuid(input.supplierId),
  };
  const confirmDuplicate = input.confirmDuplicate === true;
  return applyCommand(tx, 'expense.record', key, { ...expense, confirmDuplicate }, async () => {
    await verifyExpenseDays(tx, [expense.businessDate]);
    if (!confirmDuplicate) {
      const { rows: [duplicate] } = await tx.db.query<{ expenseId: string }>(`
        SELECT expense_id AS "expenseId" FROM pos.expense WHERE store_id = $1 AND business_date = $2
          AND category = $3 AND amount = $4 AND supplier_id IS NOT DISTINCT FROM $5::uuid
          AND lower(memo) IS NOT DISTINCT FROM lower($6::text) AND status = 'confirmed'
        ORDER BY expense_id LIMIT 1
      `, [tx.storeId, expense.businessDate, expense.category, expense.amount, expense.supplierId, expense.memo]);
      if (duplicate) throw new PosError(409, 'LIKELY_DUPLICATE_EXPENSE', {
        ...duplicate, date: expense.businessDate, category: expense.category, amount: expense.amount,
      });
    }
    const row: Expense = { ...expense, expenseId: randomUUID(), receiptId: null, status: 'confirmed', revision: 1 };
    await tx.db.query(`
      INSERT INTO pos.expense (store_id, expense_id, business_date, category, amount, evidence, memo, supplier_id, status, revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',1)
    `, [tx.storeId, row.expenseId, row.businessDate, row.category, row.amount, row.evidence, row.memo, row.supplierId]);
    return undoableExpense(tx, row, null);
  });
}

export function updateExpense(tx: FinanceTx, key: string, expenseId: string, body: unknown) {
  const input = object(body, ['date', 'category', 'amount', 'memo', 'expectedRevision']);
  const expectedRevision = integer(input.expectedRevision, 1);
  const change = {
    ...(input.date === undefined ? {} : { businessDate: date(input.date) }),
    ...(input.category === undefined ? {} : { category: category(input.category) }),
    ...(input.amount === undefined ? {} : { amount: integer(input.amount, 1, Number.MAX_SAFE_INTEGER, 'INVALID_AMOUNT') }),
    ...(input.memo === undefined ? {} : { memo: text(input.memo, 250) || null }),
  };
  return applyCommand(tx, 'expense.update', key, { expenseId, change, expectedRevision }, async () => {
    const old = await readExpense(tx, expenseId);
    if (old.status !== 'confirmed') throw new PosError(404, 'EXPENSE_NOT_FOUND');
    if (old.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION');
    const row = { ...old, ...change, revision: old.revision + 1 };
    await verifyExpenseDays(tx, [old.businessDate, row.businessDate]);
    if (old.receiptId && (old.amount !== row.amount || old.businessDate !== row.businessDate)) {
      throw new PosError(409, 'RECEIPT_EXPENSE_LOCKED');
    }
    if (row.businessDate === old.businessDate && row.category === old.category && row.memo === old.memo && row.amount === old.amount) {
      return { ...commandReceipt(expenseId, old.revision, []), expenseId, changed: false };
    }
    await saveExpense(tx, row);
    return undoableExpense(tx, row, old);
  });
}

async function saveExpense(tx: FinanceTx, row: Expense) {
  await tx.db.query(`
    UPDATE pos.expense SET business_date = $3, category = $4, amount = $5, memo = $6, status = $7, revision = $8
    WHERE store_id = $1 AND expense_id = $2
  `, [tx.storeId, row.expenseId, row.businessDate, row.category, row.amount, row.memo, row.status, row.revision]);
}

export function confirmCandidate(tx: FinanceTx, key: string, expenseId: string, body: unknown, readReceiptStatus?: ReadReceiptStatus) {
  const expectedRevision = integer(object(body, ['expectedRevision']).expectedRevision, 1);
  return applyCommand(tx, 'expense.confirm', key, { expenseId, expectedRevision }, async () => {
    const { rows: [source] } = await tx.db.query<Candidate>(`
      SELECT ${candidateColumns} FROM pos.expense_candidate WHERE store_id = $1 AND expense_id = $2
    `, [tx.storeId, expenseId]);
    if (!source) throw new PosError(404, 'EXPENSE_CANDIDATE_NOT_FOUND');
    if (source.status !== 'candidate' || source.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION');
    await verifyExpenseDays(tx, [source.businessDate]);
    const receipt = await readReceiptStatus?.({ storeId: tx.storeId, actorId: tx.actorId, receiptId: source.receiptId })
      .catch(() => undefined);
    if (receipt?.status === 'pending') throw new PosError(409, 'RECEIPT_PENDING');
    if (receipt?.status === 'voided') throw new PosError(409, 'RECEIPT_VOIDED');
    if (receipt?.status !== 'active') throw new PosError(503, 'RECEIPT_STATUS_UNAVAILABLE');
    const changed = await tx.db.query(`
      UPDATE pos.expense_candidate SET status = 'confirmed', revision = revision + 1
      WHERE store_id = $1 AND expense_id = $2 AND status = 'candidate' AND revision = $3
    `, [tx.storeId, expenseId, expectedRevision]);
    if (!changed.rowCount) throw new PosError(409, 'STALE_REVISION');
    const { rows: [row] } = await tx.db.query<Expense>(`
      INSERT INTO pos.expense (store_id, expense_id, receipt_id, business_date, category, amount, evidence, supplier_id, status, revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',1)
      ON CONFLICT (store_id, expense_id) DO UPDATE SET status = 'confirmed', revision = pos.expense.revision + 1
      RETURNING ${expenseColumns}
    `, [tx.storeId, expenseId, source.receiptId, source.businessDate, source.category, source.amount, source.evidence, source.supplierId]);
    return undoableExpense(tx, row, null);
  });
}

export function undoExpense(tx: FinanceTx, key: string, receiptId: string, body: unknown) {
  object(body ?? {}, []);
  return applyCommand(tx, 'expense.undo', key, { receiptId }, async () => {
    const { rows: [undo] } = await tx.db.query<{
      expenseId: string; deadline: Date; expenseRevision: number; before: Expense | null; undoneAt: Date | null;
    }>(`
      SELECT expense_id AS "expenseId", undo_until AS deadline, expense_revision AS "expenseRevision",
        before_image AS before, undone_at AS "undoneAt"
      FROM pos.expense_undo WHERE store_id = $1 AND receipt_id = $2 AND actor_id = $3
    `, [tx.storeId, receiptId, tx.actorId]);
    if (!undo) throw new PosError(404, 'RECEIPT_NOT_FOUND');
    if (+tx.at >= +undo.deadline) throw new PosError(409, 'UNDO_EXPIRED');
    const row = await readExpense(tx, undo.expenseId);
    if (undo.undoneAt || row.revision !== undo.expenseRevision) throw new PosError(409, 'UNDO_UNAVAILABLE');
    await verifyExpenseDays(tx, [row.businessDate, undo.before?.businessDate ?? row.businessDate]);
    const next: Expense = { ...(undo.before ?? row), status: undo.before ? 'confirmed' : 'canceled', revision: row.revision + 1 };
    await saveExpense(tx, next);
    if (!undo.before && row.receiptId) await tx.db.query(`
      UPDATE pos.expense_candidate SET status = 'candidate', revision = revision + 1
      WHERE store_id = $1 AND receipt_id = $2 AND status = 'confirmed'
    `, [tx.storeId, row.receiptId]);
    await tx.db.query('UPDATE pos.expense_undo SET undone_at = $3 WHERE store_id = $1 AND receipt_id = $2', [tx.storeId, receiptId, tx.at]);
    await expenseEvent(tx, next, row.businessDate);
    return { ...commandReceipt(row.expenseId, next.revision, sources), expenseId: row.expenseId };
  });
}
