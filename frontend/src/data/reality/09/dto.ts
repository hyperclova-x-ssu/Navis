/**
 * REAL-PLAN F09 — the POS finance wire (backend `pos/reality/09`, API-240–251/274/276–278) and its projection into the browser's tables.
 * Amounts are integer won. Profit is recognized sales minus confirmed expenses (API-278); cost and contribution are `null` while any included
 * sale has an unknown cost (shown as "원가 미확인", never a made-up number).
 */
import type { PosDrawerSnapshot } from '../../../contracts/pos';
import type { DayClosing } from '../../db/management-types';
import type { Evidence, Expense, ExpenseCategory } from '../../db/types';
import type { AccountingDay } from '../../iteration7/accounting/types';
import { kstLocal } from '../02/clock';

export type Method = 'card' | 'easy_pay' | 'cash';
export type Purpose = 'sale' | 'charge_topup' | 'receivable_collection' | 'membership_sale' | 'custom_order';
export const METHODS: readonly Method[] = ['card', 'easy_pay', 'cash'];
export const PURPOSES: readonly Purpose[] = ['sale', 'charge_topup', 'receivable_collection', 'membership_sale', 'custom_order'];
type ByMethod = Readonly<Record<Method, number>>;

/**
 * B09-2 `sales.byMethod`: net recognized sales by recorded tender (returns and member reversals on their recognition day). `mixed` is the net subtotal of
 * sales originally settled with two or more positive methods: it OVERLAPS the other five and must never be added to them or to the total.
 */
export type SalesMethod = 'cash' | 'card' | 'easy_pay' | 'charge' | 'receivable' | 'mixed';
export const SALES_METHODS: readonly SalesMethod[] = ['cash', 'card', 'easy_pay', 'charge', 'receivable', 'mixed'];
export type SalesByMethodDto = Readonly<Record<SalesMethod, number>>;

export interface FinanceTotalsDto {
  readonly sales: {
    readonly gross: number; readonly discount: number; readonly refund: number; readonly total: number; readonly bySource: { readonly menu: number; readonly customPickup: number };
    /** Absent in a closing snapshot archived before B09-2 (and from a service that does not send it): shown as "not available", never as zeros. */
    readonly byMethod?: SalesByMethodDto;
  };
  readonly deposits: {
    readonly gross: number; readonly returned: number; readonly total: number;
    readonly byMethod: ByMethod; readonly byMethodGross: ByMethod; readonly byMethodReturned: ByMethod;
    readonly byPurpose: Readonly<Record<Purpose, number>>;
  };
  readonly expenses: number;
  /** `null` while any included recognition has an unknown sale-time cost. */
  readonly cost: number | null;
  readonly knownCost: number;
  readonly unknownCostSales: number;
  readonly unknownCostCount: number;
  readonly profit: number;
  readonly contribution: number | null;
  readonly orderCount: number;
  readonly realPaymentCount: number;
  readonly settlementActivity: { readonly chargeUsed: number; readonly receivableCreated: number; readonly receivableCollected: number; readonly chargeReversal: number; readonly receivableReversal: number };
}
export interface LedgerDto {
  readonly from: string; readonly to: string; readonly totals: FinanceTotalsDto;
  readonly days: readonly (FinanceTotalsDto & { readonly businessDate: string })[];
  readonly hours: readonly { readonly businessDate: string; readonly hour: number; readonly sales: number }[];
  readonly asOf: string; readonly sourceRevision: number;
}
export interface DepositDto {
  readonly depositId: string; readonly paymentId: string; readonly correctionId: string | null; readonly settlementId: string; readonly purpose: Purpose;
  readonly businessDate: string; readonly at: string; readonly kind: 'payment' | 'refund' | 'cancel';
  readonly splits: readonly { readonly method: Method; readonly amount: number }[]; readonly amount: number; readonly transactionNo: string;
}
export interface MarginDto {
  readonly marginId: string; readonly kind: 'menu' | 'custom-pickup'; readonly menuId: string | null; readonly name: string; readonly recipeVersion: string | null;
  readonly settlementId: string | null; readonly sourceId: string; readonly quantity: number; readonly sales: number; readonly discount: number; readonly refund: number;
  readonly unitPrice: number | null; readonly unitCost: number | null; readonly cost: number | null; readonly knownCost: number; readonly unknownCostCount: number;
  readonly contribution: number | null; readonly unitMargin: number | null;
}
export interface ExpenseDto {
  readonly expenseId: string; readonly businessDate: string; readonly category: ExpenseCategory; readonly amount: number; readonly evidence: Evidence;
  readonly memo: string | null; readonly supplierId: string | null; readonly receiptId: string | null; readonly status: 'candidate' | 'confirmed' | 'canceled';
  readonly revision: number; readonly undoUntil?: string | null;
}
export interface DrawerDto {
  readonly opening: number; readonly actual: number | null; readonly memo: string; readonly expected: number; readonly difference: number | null;
  readonly in: number; readonly out: number; readonly cashApproved: number; readonly cashReturned: number;
  readonly movements: readonly { readonly movementId: string; readonly kind: 'in' | 'out'; readonly amount: number; readonly memo: string; readonly at: string }[];
}
export interface ClosingDto {
  readonly businessDate: string; readonly status: 'open' | 'closed'; readonly revision: number;
  readonly totals: FinanceTotalsDto; readonly drawer: DrawerDto; readonly pendingBills: readonly string[]; readonly writable: boolean;
  readonly closingId: string | null; readonly closedAt: string | null; readonly reopenedAt: string | null;
}

/** The three periods whose menu rows are read (the margin widget's chips). */
export type MarginKey = 'today' | 'last7' | 'last30';
export const MARGIN_KEYS: readonly MarginKey[] = ['today', 'last7', 'last30'];

/** Plain data kept in `DataTables.realFinance`: everything the ledger, margin, accounting cards and the closing overlay read. */
export interface RealFinanceSnapshot {
  readonly today: string;
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  /** Days with any recognized sale, deposit or expense in `[from, to]` (a missing day is a day without records). */
  readonly days: Readonly<Record<string, FinanceTotalsDto>>;
  readonly hours: readonly { readonly businessDate: string; readonly hour: number; readonly sales: number }[];
  /** The deposits (tender and returns) of `today`. */
  readonly deposits: readonly DepositDto[];
  readonly depositsComplete: boolean;
  readonly margins: Readonly<Record<MarginKey, readonly MarginDto[]>>;
  readonly marginsComplete: boolean;
  readonly closing: ClosingDto;
  readonly closings: readonly ClosingDto[];
}

const zeroMethods = (): ByMethod => ({ card: 0, easy_pay: 0, cash: 0 });
const zeroSalesMethods = (): SalesByMethodDto => ({ cash: 0, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 });
export const emptyTotals = (): FinanceTotalsDto => ({
  sales: { gross: 0, discount: 0, refund: 0, total: 0, bySource: { menu: 0, customPickup: 0 }, byMethod: zeroSalesMethods() },
  deposits: { gross: 0, returned: 0, total: 0, byMethod: zeroMethods(), byMethodGross: zeroMethods(), byMethodReturned: zeroMethods(),
    byPurpose: { sale: 0, charge_topup: 0, receivable_collection: 0, membership_sale: 0, custom_order: 0 } },
  expenses: 0, cost: 0, knownCost: 0, unknownCostSales: 0, unknownCostCount: 0, profit: 0, contribution: 0, orderCount: 0, realPaymentCount: 0,
  settlementActivity: { chargeUsed: 0, receivableCreated: 0, receivableCollected: 0, chargeReversal: 0, receivableReversal: 0 },
});

/** Sum of day totals. Every figure is additive; cost and contribution go `null` as soon as one included day has an unknown cost. */
export function sumTotals(list: readonly FinanceTotalsDto[]): FinanceTotalsDto {
  const total = emptyTotals();
  const n = (pick: (t: FinanceTotalsDto) => number) => list.reduce((sum, t) => sum + pick(t), 0);
  const methods = (pick: (t: FinanceTotalsDto) => ByMethod): ByMethod => ({ card: n(t => pick(t).card), easy_pay: n(t => pick(t).easy_pay), cash: n(t => pick(t).cash) });
  // The split is additive per field (mixed too, as an overlapping subtotal); one day without it makes the whole sum "not available" instead of a partial figure.
  const byMethod = list.every(t => t.sales.byMethod)
    ? Object.fromEntries(SALES_METHODS.map(method => [method, n(t => t.sales.byMethod![method])])) as Record<SalesMethod, number> : undefined;
  const sales = { gross: n(t => t.sales.gross), discount: n(t => t.sales.discount), refund: n(t => t.sales.refund), total: n(t => t.sales.total),
    bySource: { menu: n(t => t.sales.bySource.menu), customPickup: n(t => t.sales.bySource.customPickup) }, ...(byMethod ? { byMethod } : {}) };
  const knownCost = n(t => t.knownCost), unknownCostCount = n(t => t.unknownCostCount), expenses = n(t => t.expenses);
  const cost = unknownCostCount > 0 ? null : knownCost;
  return {
    ...total, sales,
    deposits: { gross: n(t => t.deposits.gross), returned: n(t => t.deposits.returned), total: n(t => t.deposits.total),
      byMethod: methods(t => t.deposits.byMethod), byMethodGross: methods(t => t.deposits.byMethodGross), byMethodReturned: methods(t => t.deposits.byMethodReturned),
      byPurpose: Object.fromEntries(PURPOSES.map(purpose => [purpose, n(t => t.deposits.byPurpose[purpose])])) as Record<Purpose, number> },
    expenses, cost, knownCost, unknownCostSales: n(t => t.unknownCostSales), unknownCostCount,
    profit: sales.total - expenses, contribution: cost === null ? null : sales.total - cost,
    orderCount: n(t => t.orderCount), realPaymentCount: n(t => t.realPaymentCount),
    settlementActivity: { chargeUsed: n(t => t.settlementActivity.chargeUsed), receivableCreated: n(t => t.settlementActivity.receivableCreated),
      receivableCollected: n(t => t.settlementActivity.receivableCollected), chargeReversal: n(t => t.settlementActivity.chargeReversal),
      receivableReversal: n(t => t.settlementActivity.receivableReversal) },
  };
}

/** Totals of `[start, end]` from the loaded days. */
export const totalsIn = (fin: RealFinanceSnapshot, start: string, end: string): FinanceTotalsDto =>
  sumTotals(Object.entries(fin.days).filter(([day]) => day >= start && day <= end).map(([, totals]) => totals));

/**
 * The accounting day the cards render. The service does not split recognized sales by membership source, so those groups stay 0 and the card hides them
 * (`source: 'http'`). With B09-2's `sales.byMethod` the tender rows (card, easy pay, cash) and the sales settled by charge or on receivable come from the
 * service; without it (an archived snapshot) the tender rows are zero placeholders the card never shows (it says "not available") and charge/receivable
 * fall back to the member-account activity.
 */
export function toAccountingDay(totals: FinanceTotalsDto, unknownCostSales: AccountingDay['unknownCostSales'] = []): AccountingDay {
  const { sales, deposits, settlementActivity: activity } = totals;
  const split = sales.byMethod;
  const none = { direct: 0, coupon: 0, membership: 0 };
  return {
    sales: { total: sales.total, byRealMethodSale: split ? { card: split.card, easy_pay: split.easy_pay, cash: split.cash } : zeroMethods(),
      chargeUsed: split ? split.charge : activity.chargeUsed, receivableCreated: split ? split.receivable : activity.receivableCreated, membershipCount: 0,
      subscriptionDaily: 0, membershipExpiry: 0, customPickup: sales.bySource.customPickup, refund: sales.refund, gross: sales.gross, discount: sales.discount, discountBySource: none,
      ...(split ? { byMethod: split } : {}) },
    deposits: { total: deposits.total, byMethod: deposits.byMethod, byPurpose: deposits.byPurpose, grossReceived: deposits.gross, returned: deposits.returned, pendingReceived: 0 },
    settlementActivity: { chargeTopup: deposits.byPurpose.charge_topup, chargeUsed: activity.chargeUsed, receivableCreated: activity.receivableCreated,
      receivableCollected: activity.receivableCollected, membershipSold: deposits.byPurpose.membership_sale, membershipCount: 0, subscriptionDaily: 0,
      membershipExpiry: 0, customAdvance: deposits.byPurpose.custom_order, customPickup: sales.bySource.customPickup },
    orderCount: totals.orderCount, realPaymentCount: totals.realPaymentCount, discountBySource: none,
    cost: totals.knownCost, expenses: totals.expenses, profit: totals.profit, unknownCostSales,
  };
}

export function toDrawerSnapshot(drawer: DrawerDto): PosDrawerSnapshot {
  return {
    opening: drawer.opening, actual: drawer.actual, memo: drawer.memo,
    movements: drawer.movements.map((move, index) => ({ movementId: move.movementId, at: kstLocal(move.at), seq: drawer.movements.length - index, kind: move.kind, amount: move.amount, memo: move.memo })),
    approvedCash: drawer.cashApproved, cashPayments: drawer.cashApproved, pendingCash: 0, cashCanceled: 0, cashRefunded: 0, cashReturned: drawer.cashReturned,
    cashNet: drawer.cashApproved - drawer.cashReturned, in: drawer.in, out: drawer.out, expected: drawer.expected, difference: drawer.difference,
  };
}

export function toExpense(row: ExpenseDto): Expense {
  return { expenseId: row.expenseId, businessDate: row.businessDate, category: row.category, amount: row.amount, supplierId: row.supplierId, receiptId: row.receiptId,
    evidence: row.evidence, status: row.status, memo: row.memo === null ? null : { raw: row.memo } };
}

/**
 * The closings the selectors read: every frozen snapshot (a reopened one is kept as `reopened`) in closing order, so the latest row of a day is its
 * current state. `generation` is the service's revision of that closing; the overlay sends it back as the expected revision.
 */
export function toDayClosings(closings: readonly ClosingDto[], current: ClosingDto): DayClosing[] {
  const rows = [...closings];
  if (current.status === 'closed' && current.closingId && !rows.some(row => row.closingId === current.closingId)) rows.push(current);
  return rows.filter(row => row.closingId && row.closedAt).sort((a, b) => a.closedAt!.localeCompare(b.closedAt!) || a.closingId!.localeCompare(b.closingId!)).map(row => {
    const { sales, deposits } = row.totals;
    return {
      closingId: row.closingId!, businessDate: row.businessDate, generation: row.revision, scenario: 'normal' as const,
      status: row.reopenedAt ? 'reopened' as const : 'closed' as const, closedAt: kstLocal(row.closedAt!), ...(row.reopenedAt ? { reopenedAt: kstLocal(row.reopenedAt) } : {}),
      accountingSnapshot: toAccountingDay(row.totals),
      salesSnapshot: { gross: sales.gross, discount: sales.discount, refund: sales.refund, net: sales.total, byMethod: deposits.byMethod,
        methodCounts: { card: 0, easy_pay: 0, cash: 0 }, paymentCount: row.totals.realPaymentCount, refundCount: 0 },
      paymentRevision: 0, drawerSnapshot: toDrawerSnapshot(row.drawer),
    };
  });
}
