/**
 * REAL-PLAN F09 — the `money` domain on the F00 port: expenses, ledger, margin and day close over the POS finance API
 * (`/api/v1/stores/{storeId}/pos`, backend `pos/reality/09`).
 *
 * `load()` reads the ledger window's deposits, expenses and candidates, today's closing and the closing history, and the menu rows of the
 * three margin periods; it fills the tables the existing selectors read (`expense`, `dailySales`, `dayClosing`) and `realFinance`, which the
 * accounting cards, the ledger and margin models and the closing overlay read. Commands keep their names and arguments; money writes wait for the
 * server receipt (no optimistic preview) and an owner expense can be undone through its receipt while `undoUntil` lasts.
 */
import { TODAY } from '../../db/time';
import type { DataTables } from '../../db/types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter } from '../00';
import { MARGIN_KEYS, toDayClosings, toExpense, type ClosingDto, type DepositDto, type ExpenseDto, type LedgerDto, type MarginDto, type RealFinanceSnapshot } from './dto';
import { financeWindow, marginRange } from './views';

const pos = '/pos';
const receiptBase = '/pos/finance';
const saved = 'data.management.notice.saved';
const item = (base: string, id: string) => `${pos}${base}/${encodeURIComponent(id)}`;
const expenseKey = (id: string) => `expense:${id}`;
const closingKey = (id: string) => `closing:${id}`;

function revision(ctx: CommandContext, key: string): number {
  const value = ctx.revision(key);
  if (value === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return value;
}

/** B09 reasons → message keys (`data.management.error.*`, existing wording). Unknown reasons show the generic message. */
const errorKeys: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['EXPENSE_DATE_FUTURE', 'LIKELY_DUPLICATE_EXPENSE', 'STALE_REVISION', 'STALE_CLOSING', 'PAYMENTS_UNAVAILABLE', 'CLOSING_BLOCKED', 'RECEIPT_PENDING', 'RECEIPT_VOIDED', 'RECEIPT_STATUS_UNAVAILABLE'].map(reason => [reason, `data.management.error.${reason}`])),
  DAY_CLOSED: 'data.management.error.EXPENSE_DAY_CLOSED',
  CLOSING_REOPEN_UNAVAILABLE: 'data.management.error.STALE_CLOSING',
  INVALID_EXPENSE_CATEGORY: 'data.error.categoryInvalid',
  INVALID_BUSINESS_DATE: 'data.error.dateInvalid',
  FINANCE_TOTAL_UNAVAILABLE: 'data.management.error.PAYMENTS_UNAVAILABLE',
};

export const moneyAdapter: DomainAdapter = {
  domain: 'money',
  /** Own receipts plus the other domains' effects on sales, tender and cost (POS sale/receipt/correction, member funding, purchase receipts and pickups). */
  sources: ['money', 'ledger', 'margin', 'pos.expenses', 'pos.ledger', 'pos.closings', 'pos.finance', 'pos.sales', 'pos.receipts', 'pos.member-accounts',
    'pos.member-funding', 'pos.custom-orders', 'pickup', 'purchasing'],
  tables: ['expense', 'dailySales', 'dayClosing', 'realFinance'],
  clear: () => ({ realFinance: undefined, expense: [], dailySales: [], dayClosing: [] }),
  errorKeys,
  async load({ reads, signal }) {
    const { from, to } = financeWindow(TODAY);
    const list = <T>(resource: string, path: string, query: Readonly<Record<string, string | number>>) => reads.all<T>({ resource, path, query: { limit: 50, ...query } }, { signal });
    const [ledger, deposits, expenses, candidates, closing, closings, ...margins] = await Promise.all([
      reads.one<LedgerDto>({ resource: 'ledger', path: `${pos}/ledger`, query: { from, to } }, { signal }),
      list<DepositDto>('deposits', `${pos}/deposits`, { from, to }),
      list<ExpenseDto>('expenses', `${pos}/expenses`, { from, to }),
      list<ExpenseDto>('expense-candidates', `${pos}/expense-candidates`, { from, to }),
      reads.one<ClosingDto>({ resource: 'closing', path: `${pos}/closings/${TODAY}` }, { signal }),
      reads.page<ClosingDto>({ resource: 'closings', path: `${pos}/closings`, query: { limit: 50 } }, { signal }),
      ...MARGIN_KEYS.map(key => { const range = marginRange(key, TODAY); return list<MarginDto>(`margins:${key}`, `${pos}/margins`, { from: range.start, to: range.end }); }),
    ]);
    const fin: RealFinanceSnapshot = {
      today: TODAY, from: ledger.from, to: ledger.to, asOf: ledger.asOf,
      days: Object.fromEntries(ledger.days.map(({ businessDate, ...totals }) => [businessDate, totals])), hours: ledger.hours,
      deposits: deposits.items, depositsComplete: deposits.complete,
      margins: Object.fromEntries(MARGIN_KEYS.map((key, index) => [key, margins[index]!.items])) as RealFinanceSnapshot['margins'],
      marginsComplete: margins.every(page => page.complete),
      closing, closings: closings.items,
    };
    const tables: Partial<DataTables> = {
      expense: [...expenses.items.filter(row => row.status === 'confirmed'), ...candidates.items.filter(row => row.status === 'candidate')].map(toExpense),
      dailySales: ledger.days.map(day => ({ businessDate: day.businessDate, gross: day.sales.gross, discount: day.sales.discount, refund: day.sales.refund,
        recognizedNet: day.sales.total, card: day.sales.byMethod?.card ?? 0, cash: day.sales.byMethod?.cash ?? 0, easyPay: day.sales.byMethod?.easy_pay ?? 0 })),
      dayClosing: toDayClosings(closings.items, closing),
      realFinance: fin,
    };
    return {
      tables, asOf: ledger.asOf,
      revisions: Object.fromEntries([
        ...[...expenses.items, ...candidates.items].map(row => [expenseKey(row.expenseId), row.revision]),
        [closingKey(closing.businessDate), closing.revision], ...(closing.closingId ? [[closingKey(closing.closingId), closing.revision]] : []),
      ]),
      sourceRevision: Math.max(ledger.sourceRevision, deposits.sourceRevision, expenses.sourceRevision, candidates.sourceRevision, closings.sourceRevision, closing.revision, ...margins.map(page => page.sourceRevision)),
      complete: [deposits, expenses, candidates, ...margins].every(page => page.complete),
    };
  },
  commands: [
    defineBinding({ type: 'ledger.recordExpense', receiptBase, noticeKey: saved, request: ({ date, category, amount, evidence, memo, supplierId, confirmDuplicate }) => ({
      method: 'POST', path: `${pos}/expenses`, body: { date, category, amount, evidence, memo, supplierId, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) },
    }) }),
    defineBinding({ type: 'ledger.updateExpense', receiptBase, noticeKey: saved, request: ({ expenseId, date, category, amount, memo }, ctx) => ({
      method: 'PATCH', path: item('/expenses', expenseId), body: { date, category, amount, memo }, expectedRevision: revision(ctx, expenseKey(expenseId)),
    }) }),
    defineBinding({ type: 'ledger.confirmCandidate', receiptBase, noticeKey: saved, request: ({ expenseId }, ctx) => ({
      method: 'POST', path: `${item('/expense-candidates', expenseId)}/confirm`, body: {}, expectedRevision: revision(ctx, expenseKey(expenseId)),
    }) }),
    /** The local `expectedGeneration` has no service counterpart (an open day has no closing row): the revision of the last read of that day is sent, and a changed day answers 409. */
    defineBinding({ type: 'closing.closeDay', noticeKey: 'data.management.notice.closed', request: ({ date }, ctx) => ({
      method: 'POST', path: `${pos}/closings`, body: { businessDate: date }, expectedRevision: revision(ctx, closingKey(date)),
    }) }),
    defineBinding({ type: 'closing.undoDay', noticeKey: 'data.management.notice.reopened', request: ({ closingId }, ctx) => ({
      method: 'POST', path: `${item('/closings', closingId)}/reopen`, body: { confirmed: true }, expectedRevision: revision(ctx, closingKey(closingId)),
    }) }),
    defineBinding({ type: 'closing.setDrawer', noticeKey: saved, request: ({ date, opening, actual, memo, expectedRevision }, ctx) => ({
      method: 'PATCH', path: `${item('/closings', date)}/drawer`, body: { opening, actual, memo }, expectedRevision: expectedRevision ?? revision(ctx, closingKey(date)),
    }) }),
    defineBinding({ type: 'closing.addMovement', noticeKey: saved, request: ({ date, kind, amount, memo, expectedRevision }, ctx) => ({
      method: 'POST', path: `${pos}/cash-movements`, body: { businessDate: date, kind, amount, memo }, expectedRevision: expectedRevision ?? revision(ctx, closingKey(date)),
    }) }),
    defineBinding({ type: 'closing.removeMovement', noticeKey: saved, request: ({ date, movementId, expectedRevision }, ctx) => ({
      method: 'DELETE', path: item('/cash-movements', movementId), body: { confirmed: true }, expectedRevision: expectedRevision ?? revision(ctx, closingKey(date)),
    }) }),
  ],
};
