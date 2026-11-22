import { randomUUID } from 'node:crypto';
import { appendOutbox, applyCommand, nextBusinessSequence, openDay } from '../../ledger.ts';
import { commandReceipt, integer, object, PosError } from '../../wire.ts';
import { page, listInput } from '../02/reads.ts';
import { readFinance, type FinanceTotals } from './finance.ts';
import { confirmed, currentDay, date, money, revision, text, type FinanceTx } from './input.ts';

const sources = ['pos.closings', 'pos.ledger', 'pos.finance'];
type Movement = { movementId: string; kind: 'in' | 'out'; amount: number; memo: string; at: Date };
type CashCount = { opening: number; actual: number | null; memo: string };
type Sales = FinanceTotals['sales'];
type ArchivedSales = Omit<Sales, 'byMethod'> & { byMethod?: Sales['byMethod'] };
type Snapshot<SaleTotals = Sales> = {
  totals: Omit<FinanceTotals, 'sales'> & { sales: SaleTotals };
  drawer: CashCount & { expected: number; difference: number | null; in: number; out: number;
    cashApproved: number; cashReturned: number; movements: Movement[] };
};
type StoredClose = {
  closingId: string; businessDate: string; closedAt: Date; reopenedAt: Date | null;
  snapshot: Snapshot<ArchivedSales>;
};
const historyColumns = `closing_id AS "closingId", business_date::text AS "businessDate", closed_at AS "closedAt",
  reopened_at AS "reopenedAt", snapshot`;

function closedView({ snapshot, ...row }: StoredClose) {
  return { ...row, ...snapshot, status: 'closed' as const, pendingBills: [] as string[], writable: false,
    revision: revision([row.closingId, row.closedAt, row.reopenedAt]) };
}

async function drawer(tx: FinanceTx, day: string, deposits: FinanceTotals['deposits']): Promise<Snapshot['drawer']> {
  const bind = [tx.storeId, day];
  const { rows: [saved] } = await tx.db.query<CashCount>(`
    SELECT opening::double precision AS opening, actual::double precision AS actual, memo
    FROM pos.drawer WHERE store_id = $1 AND business_date = $2
  `, bind);
  const count = saved ?? { opening: 0, actual: null, memo: '' };
  const { rows: movements } = await tx.db.query<Movement>(`
    SELECT movement_id AS "movementId", kind, amount::double precision AS amount, memo, at
    FROM pos.cash_movement WHERE store_id = $1 AND business_date = $2 AND canceled_at IS NULL
    ORDER BY at DESC, movement_id DESC
  `, bind);
  const moves = { in: 0n, out: 0n };
  for (const movement of movements) moves[movement.kind] += BigInt(movement.amount);
  const cashApproved = deposits.byMethodGross.cash, cashReturned = deposits.byMethodReturned.cash;
  const expected = BigInt(count.opening) + BigInt(cashApproved) - BigInt(cashReturned) + moves.in - moves.out;
  return { ...count, cashApproved, cashReturned, in: money(moves.in), out: money(moves.out), expected: money(expected),
    difference: count.actual === null ? null : money(BigInt(count.actual) - expected), movements };
}

export async function readClosing(tx: FinanceTx, day: string) {
  const bind = [tx.storeId, day];
  const { rows: [closed] } = await tx.db.query<StoredClose>(`
    SELECT ${historyColumns} FROM pos.closing_snapshot
    WHERE store_id = $1 AND business_date = $2 AND reopened_at IS NULL
  `, bind);
  if (closed) return closedView(closed);
  const { rows: [state] } = await tx.db.query<{ status: 'open' | 'closed'; seq: number }>(`
    SELECT status, seq FROM pos.business_day WHERE store_id = $1 AND business_date = $2
  `, bind);
  // A database provisioned before snapshot cutover can contain a closed day.
  // Preserve the lock and expose that the archived closing document is absent.
  const { totals } = await readFinance(tx, day, day);
  const cash = await drawer(tx, day, totals.deposits);
  const { rows: bills } = await tx.db.query<{ billId: string; revision: number }>(`
    SELECT bill_id AS "billId", revision FROM pos.bill WHERE store_id = $1 AND business_date = $2 AND status = 'open'
    ORDER BY bill_id
  `, bind);
  const status = state?.status ?? 'open';
  return { businessDate: day, status, totals, drawer: cash, pendingBills: bills.map(row => row.billId),
    closedAt: null, closingId: null, reopenedAt: null, writable: status === 'open' && day === await currentDay(tx),
    revision: revision([day, state?.seq ?? 0, status, totals, cash, bills]) };
}

export async function listClosings(tx: FinanceTx, query: unknown) {
  const { from, to, cursor, limit } = listInput(query, [], true);
  const { rows } = await tx.db.query<StoredClose>(`
    SELECT ${historyColumns} FROM pos.closing_snapshot WHERE store_id = $1
      AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3)
      AND ($4::uuid IS NULL OR (business_date, closed_at, closing_id) < (
        SELECT business_date, closed_at, closing_id FROM pos.closing_snapshot WHERE store_id = $1 AND closing_id = $4))
    ORDER BY business_date DESC, closed_at DESC, closing_id DESC LIMIT $5
  `, [tx.storeId, from, to, cursor, limit + 1]);
  return page(tx, rows.map(closedView), limit, row => row.closingId);
}

async function verifyOpenClosing(tx: FinanceTx, day: string, expectedRevision: number) {
  if (day !== await openDay(tx)) throw new PosError(409, 'DAY_CLOSED');
  const closing = await readClosing(tx, day);
  if (closing.closingId !== null) throw new PosError(409, 'DAY_CLOSED');
  if (closing.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION');
  return closing;
}

async function closingEvent(tx: FinanceTx, closingId: string, businessDate: string, status: 'open' | 'closed', currentRevision: number) {
  await appendOutbox(tx, 'pos.closing_changed.v1', closingId, { closingId, businessDate, status, revision: currentRevision });
}

export function closeDay(tx: FinanceTx, key: string, body: unknown) {
  const input = object(body, ['businessDate', 'expectedRevision']);
  const day = date(input.businessDate), expectedRevision = integer(input.expectedRevision, 0);
  return applyCommand(tx, 'closing.close', key, { day, expectedRevision }, async () => {
    const closing = await verifyOpenClosing(tx, day, expectedRevision);
    if (closing.pendingBills.length) throw new PosError(409, 'CLOSING_BLOCKED', { pendingBills: closing.pendingBills });
    const closingId = randomUUID();
    const snapshot: Snapshot = { totals: closing.totals, drawer: closing.drawer };
    await tx.db.query(`
      INSERT INTO pos.closing_snapshot (store_id, business_date, closing_id, closed_by, closed_at, snapshot)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [tx.storeId, day, closingId, tx.actorId, tx.at, snapshot]);
    await tx.db.query("UPDATE pos.business_day SET status = 'closed', seq = seq + 1 WHERE store_id = $1 AND business_date = $2",
      [tx.storeId, day]);
    const currentRevision = revision([closingId, tx.at, null]);
    await closingEvent(tx, closingId, day, 'closed', currentRevision);
    return { ...commandReceipt(closingId, currentRevision, sources), closingId, businessDate: day };
  });
}

export function reopenDay(tx: FinanceTx, key: string, closingId: string, body: unknown) {
  const input = object(body, ['confirmed', 'expectedRevision']);
  confirmed(input.confirmed);
  const expectedRevision = integer(input.expectedRevision, 0);
  return applyCommand(tx, 'closing.reopen', key, { closingId, expectedRevision }, async () => {
    const day = await currentDay(tx);
    const closing = await readClosing(tx, day);
    if (closing.closingId !== closingId) throw new PosError(409, 'CLOSING_REOPEN_UNAVAILABLE');
    if (closing.revision !== expectedRevision) throw new PosError(409, 'STALE_REVISION');
    await tx.db.query('UPDATE pos.closing_snapshot SET reopened_at = $3, reopened_by = $4 WHERE store_id = $1 AND closing_id = $2',
      [tx.storeId, closingId, tx.at, tx.actorId]);
    await tx.db.query("UPDATE pos.business_day SET status = 'open', seq = seq + 1 WHERE store_id = $1 AND business_date = $2",
      [tx.storeId, day]);
    const next = await readClosing(tx, day);
    await closingEvent(tx, closingId, day, 'open', next.revision);
    return { ...commandReceipt(closingId, next.revision, sources), closingId, businessDate: day };
  });
}

export function changeDrawer(tx: FinanceTx, key: string, day: string, body: unknown) {
  const input = object(body, ['opening', 'actual', 'memo', 'expectedRevision']);
  const expectedRevision = integer(input.expectedRevision, 0);
  const opening = input.opening === undefined ? undefined : integer(input.opening, 0);
  const actual = input.actual === null || input.actual === undefined ? input.actual : integer(input.actual, 0);
  const memo = input.memo === undefined ? undefined : text(input.memo, 100);
  if (opening === undefined && actual === undefined && memo === undefined) throw new PosError(400, 'INVALID_REQUEST');
  return applyCommand(tx, 'drawer.change', key, { day, opening, actual, memo, expectedRevision }, async () => {
    const current = await verifyOpenClosing(tx, day, expectedRevision);
    await tx.db.query(`
      INSERT INTO pos.drawer (store_id, business_date, opening, actual, memo) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (store_id, business_date) DO UPDATE
        SET opening = EXCLUDED.opening, actual = EXCLUDED.actual, memo = EXCLUDED.memo
    `, [tx.storeId, day, opening ?? current.drawer.opening, actual === undefined ? current.drawer.actual : actual,
      memo ?? current.drawer.memo]);
    await nextBusinessSequence(tx, day);
    const next = await readClosing(tx, day);
    return { ...commandReceipt(day, next.revision, sources), businessDate: day };
  });
}

export function addCashMovement(tx: FinanceTx, key: string, body: unknown) {
  const input = object(body, ['businessDate', 'kind', 'amount', 'memo', 'expectedRevision']);
  const { kind } = input;
  if (kind !== 'in' && kind !== 'out') throw new PosError(400, 'INVALID_CASH_MOVEMENT_KIND');
  const day = date(input.businessDate), expectedRevision = integer(input.expectedRevision, 0);
  const amount = integer(input.amount, 1), memo = input.memo === undefined ? '' : text(input.memo, 100);
  return applyCommand(tx, 'drawer.add_movement', key, { day, kind, amount, memo, expectedRevision }, async () => {
    await verifyOpenClosing(tx, day, expectedRevision);
    const movementId = randomUUID();
    await tx.db.query(`
      INSERT INTO pos.cash_movement (store_id, business_date, movement_id, actor_id, kind, amount, memo, at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [tx.storeId, day, movementId, tx.actorId, kind, amount, memo, tx.at]);
    await nextBusinessSequence(tx, day);
    const next = await readClosing(tx, day);
    return { ...commandReceipt(movementId, next.revision, sources), movementId, businessDate: day };
  });
}

export function removeCashMovement(tx: FinanceTx, key: string, movementId: string, body: unknown) {
  const input = object(body, ['confirmed', 'expectedRevision']);
  confirmed(input.confirmed);
  const expectedRevision = integer(input.expectedRevision, 0);
  return applyCommand(tx, 'drawer.remove_movement', key, { movementId, expectedRevision }, async () => {
    const { rows: [row] } = await tx.db.query<{ day: string }>(`
      SELECT business_date::text AS day FROM pos.cash_movement
      WHERE store_id = $1 AND movement_id = $2 AND canceled_at IS NULL
    `, [tx.storeId, movementId]);
    if (!row) throw new PosError(404, 'CASH_MOVEMENT_NOT_FOUND');
    await verifyOpenClosing(tx, row.day, expectedRevision);
    await tx.db.query('UPDATE pos.cash_movement SET canceled_at = $3, canceled_by = $4 WHERE store_id = $1 AND movement_id = $2',
      [tx.storeId, movementId, tx.at, tx.actorId]);
    await nextBusinessSequence(tx, row.day);
    const next = await readClosing(tx, row.day);
    return { ...commandReceipt(movementId, next.revision, sources), movementId, businessDate: row.day };
  });
}
