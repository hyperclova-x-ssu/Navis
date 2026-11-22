/**
 * REAL-PLAN F09 — what the money widgets read once `DataTables.realFinance` is loaded: the accounting cards (`AccountingViewRead`), the ledger model
 * and the margin model. All figures are the service's: this file only sums its days and never recomputes sales, cost or profit.
 */
import type { QueryCondition } from '../../../contracts';
import { periodOf } from '../../conditions';
import type { DataSnapshot, Expense } from '../../db/types';
import { addDays, daysBetween, dateRange, inRange, LAST_MONTH_END, LAST_MONTH_START, TODAY } from '../../db/time';
import { fromBase, toBase } from '../../derive/common';
import { deriveRecipeCost } from '../../derive/stock';
import type { LedgerExpenseRow, LedgerModel, MarginMenuRow, MarginModel, WidgetView } from '../../models/types';
import { categoryKey, evidenceKey, percentChange, rateOf, ready, round1, sum, type ModelContext } from '../../models/util';
import type { AccountingTransactionRead, AccountingViewRead } from '../../pos/projection';
import { kstLocal } from '../02/clock';
import { toAccountingDay, toDrawerSnapshot, totalsIn, MARGIN_KEYS, type DepositDto, type MarginDto, type MarginKey, type RealFinanceSnapshot } from './dto';

type Range = { readonly start: string; readonly end: string };

/** The ledger window: last month, the last 60 days (for comparisons) and today. At most 62 days, inside the service's 92-day bound. */
export const financeWindow = (today = TODAY): { readonly from: string; readonly to: string } => {
  const last60 = addDays(today, -59);
  return { from: LAST_MONTH_START < last60 ? LAST_MONTH_START : last60, to: today };
};
export const marginRange = (key: MarginKey, today = TODAY): Range => ({ start: key === 'today' ? today : addDays(today, key === 'last7' ? -6 : -29), end: today });
const marginKeyOf = (period: Range, fin: RealFinanceSnapshot): MarginKey | null =>
  MARGIN_KEYS.find(key => { const range = marginRange(key, fin.today); return range.start === period.start && range.end === period.end; }) ?? null;

/* ── accounting cards ─────────────────────────────────────────────────────────────────────────────────────── */
const unknownCostRows = (items: readonly MarginDto[]) => items.filter(row => row.cost === null)
  .map(row => ({ recognitionId: row.marginId, sourceId: row.sourceId, amount: row.sales, cost: null, label: row.name }));

const transactionOf = (row: DepositDto): AccountingTransactionRead => {
  const signed = row.kind === 'payment' ? 1 : -1;
  return {
    id: row.depositId, transactionNo: row.transactionNo, at: kstLocal(row.at), purpose: row.purpose,
    kind: row.kind === 'payment' ? 'receipt' : row.kind, amount: signed * row.amount, salesAmount: null,
    methods: row.splits.map(split => ({ method: split.method, amount: signed * split.amount })), settlementKinds: [],
    settlementId: row.settlementId, paymentId: row.paymentId, ...(row.correctionId ? { originalId: row.paymentId } : {}),
    sourceRef: { kind: 'payment', id: row.paymentId },
  };
};

/** The five period cards of the accounting presentation (today, month, 7 and 30 days, last month) and the frozen closings. */
export function realAccountingPresentation(fin: RealFinanceSnapshot): { readonly views: readonly AccountingViewRead[]; readonly history: readonly AccountingViewRead[] } {
  const today = fin.today;
  const oldestDepositDay = fin.deposits.at(-1)?.businessDate;
  const view = (period: Range): AccountingViewRead => {
    const key = marginKeyOf(period, fin);
    const isToday = period.start === today && period.end === today;
    return {
      status: 'ready', period, source: 'http', summary: toAccountingDay(totalsIn(fin, period.start, period.end), key ? unknownCostRows(fin.margins[key]) : []),
      transactions: fin.deposits.filter(row => inRange(row.businessDate, period.start, period.end)).map(transactionOf),
      ...(!fin.depositsComplete && oldestDepositDay && oldestDepositDay >= period.start ? {
        depositCoverage: { start: oldestDepositDay, end: today, complete: false },
      } : {}),
      ...(key ? { unknownCostSales: unknownCostRows(fin.margins[key]) } : {}),
      ...(isToday ? { drawer: toDrawerSnapshot(fin.closing.drawer) } : {}),
    } as AccountingViewRead;
  };
  const views = [view({ start: today, end: today }), view({ start: `${today.slice(0, 7)}-01`, end: today }), view({ start: addDays(today, -6), end: today }),
    view({ start: addDays(today, -29), end: today }), view({ start: LAST_MONTH_START, end: LAST_MONTH_END })];
  const history = fin.closings.filter(row => row.closingId && !row.reopenedAt).map(row => ({
    status: 'ready', period: { start: row.businessDate, end: row.businessDate }, source: 'http', summary: toAccountingDay(row.totals), transactions: [], drawer: toDrawerSnapshot(row.drawer),
  } as AccountingViewRead));
  return { views, history };
}

/** Sale-time sales per menu of a period the service was asked for (today, 7 or 30 days); `null` for any other period. */
export function realMenuSales(fin: RealFinanceSnapshot, start: string, end: string): ReadonlyMap<string, number> | null {
  const key = marginKeyOf({ start, end }, fin);
  if (!key) return null;
  return new Map([...menuStats(fin.margins[key])].map(([menuId, stat]) => [menuId, stat.netSales]));
}
/** The service's recognized sales by store-local hour of one business day. */
export const realHourlySales = (fin: RealFinanceSnapshot, date: string): readonly (readonly [number, number])[] =>
  fin.hours.filter(row => row.businessDate === date).map(row => [row.hour, row.sales] as const);

/* ── ledger ───────────────────────────────────────────────────────────────────────────────────────────────── */
const CATEGORY_ORDER = ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other'] as const;
const lengthOf = (p: Range): number => daysBetween(p.start, p.end) + 1;
/** Comparison base: the same weekday last week for one day, otherwise the previous period of the same length. */
const basePeriod = (p: Range): Range => p.start === p.end ? { start: addDays(p.start, -7), end: addDays(p.end, -7) } : { start: addDays(p.start, -lengthOf(p)), end: addDays(p.start, -1) };
const trendDates = (p: Range): string[] => lengthOf(p) <= 7 ? dateRange(addDays(p.end, -6), p.end) : dateRange(p.start, p.end);
const covered = (fin: RealFinanceSnapshot, p: Range) => p.start >= fin.from && p.end <= fin.to;

function expenseRow(snapshot: DataSnapshot, e: Expense): LedgerExpenseRow {
  const supplier = e.supplierId ? snapshot.tables.supplier.find(s => s.supplierId === e.supplierId) : undefined;
  return { expenseId: e.expenseId, date: e.businessDate, category: e.category, categoryKey: categoryKey(e.category), amount: e.amount, supplierId: e.supplierId,
    supplierNameKey: supplier?.nameKey ?? null, evidence: e.evidence, evidenceKey: evidenceKey(e.evidence), status: e.status === 'candidate' ? 'candidate' : 'confirmed', memo: e.memo, receiptId: e.receiptId };
}

export function realLedger(ctx: ModelContext, condition: QueryCondition, variant: string): WidgetView<LedgerModel, 'ledger'> {
  const snapshot = ctx.snapshot, fin = snapshot.tables.realFinance!, expenses = snapshot.tables.expense;
  const period = periodOf('ledger', condition) ?? { start: fin.today, end: fin.today };
  const totals = totalsIn(fin, period.start, period.end);
  const split = totals.sales.byMethod;
  const confirmed = expenses.filter(e => e.status === 'confirmed' && inRange(e.businessDate, period.start, period.end));
  const total = sum(confirmed.map(e => e.amount));
  const net = totals.sales.total;
  const expenseByDate = new Map<string, number>();
  for (const e of expenses) if (e.status === 'confirmed') expenseByDate.set(e.businessDate, (expenseByDate.get(e.businessDate) ?? 0) + e.amount);
  const point = (date: string) => { const dayNet = fin.days[date]?.sales.total ?? 0, spent = expenseByDate.get(date) ?? 0; return { date, net: dayNet, expenses: spent, netProfit: dayNet - spent }; };
  const base = basePeriod(period), baseNet = covered(fin, base) ? totalsIn(fin, base.start, base.end).sales.total : 0;
  const model: LedgerModel = {
    period, netProfit: net - total, profitRate: rateOf(net - total, net),
    // B09-2: the service splits recognized sales by recorded tender. Without the field (an older service) the rows stay hidden (`byMethodKnown: false`).
    sales: { net, gross: totals.sales.gross, discount: totals.sales.discount, refund: totals.sales.refund,
      byMethod: { card: split?.card ?? 0, cash: split?.cash ?? 0, easyPay: split?.easy_pay ?? 0 }, byMethodKnown: split !== undefined },
    comparison: covered(fin, base) && baseNet > 0 ? { base, baseNet, delta: { value: percentChange(net, baseNet), kind: 'percent' } } : null,
    expenses: { total, byCategory: CATEGORY_ORDER.map(category => ({ category, categoryKey: categoryKey(category), amount: sum(confirmed.filter(e => e.category === category).map(e => e.amount)) })).filter(c => c.amount > 0),
      items: confirmed.map(e => expenseRow(snapshot, e)) },
    candidates: expenses.filter(e => e.status === 'candidate' && inRange(e.businessDate, period.start, period.end)).map(e => expenseRow(snapshot, e)),
    remaining: net - total,
    trend: trendDates(period).filter(date => fin.days[date]).map(point), periodTrend: dateRange(period.start, period.end).map(point),
    missingEvidenceCount: confirmed.filter(e => e.evidence === 'none').length,
  };
  return ready('ledger', condition, variant, model);
}

/* ── margin ───────────────────────────────────────────────────────────────────────────────────────────────── */
type MenuStat = { qty: number; netSales: number; cost: number | null };

/** Per-menu sale-time figures of one period: cost is `null` as soon as one of the menu's recognitions has no cost. */
function menuStats(items: readonly MarginDto[]): Map<string, MenuStat> {
  const stats = new Map<string, MenuStat>();
  for (const row of items) {
    if (!row.menuId) continue;
    const own = stats.get(row.menuId) ?? { qty: 0, netSales: 0, cost: 0 as number | null };
    own.qty += row.quantity; own.netSales += row.sales;
    own.cost = own.cost === null || row.cost === null ? null : own.cost + row.cost;
    stats.set(row.menuId, own);
  }
  return stats;
}

function marginRows(snapshot: DataSnapshot, stats: ReadonlyMap<string, MenuStat>): MarginMenuRow[] {
  return snapshot.tables.menuItem.filter(menu => !menu.deletedAt || stats.has(menu.menuId)).map(menu => {
    const own = stats.get(menu.menuId) ?? { qty: 0, netSales: 0, cost: 0 as number | null };
    const costMissing = own.cost === null;
    const current = deriveRecipeCost(snapshot, menu.menuId);
    const unitCost = costMissing ? null : current.cost;
    return {
      menuId: menu.menuId, name: menu.name ?? { key: menu.nameKey }, unitMargin: unitCost === null ? null : menu.price - unitCost,
      contribution: own.cost === null ? null : own.netSales - own.cost, nameKey: menu.nameKey, categoryKey: menu.categoryKey, price: menu.price, unitCost,
      qty: own.qty, netSales: own.netSales, cost: own.cost, grossProfit: own.cost === null ? null : own.netSales - own.cost,
      rate: costMissing ? null : current.rate, costMissing: costMissing || unitCost === null,
      recipe: current.recipeLines.map(part => ({ nameKey: part.nameKey, qty: { value: fromBase(toBase(part.quantity, part.unit) ?? 0, part.inventoryUnit), unit: part.inventoryUnit }, cost: part.cost ?? 0 })),
      costEffectiveFrom: menu.costEffectiveFrom,
    };
  });
}

export function realMargin(ctx: ModelContext, condition: QueryCondition, variant: string): WidgetView<MarginModel, 'margin'> {
  const snapshot = ctx.snapshot, fin = snapshot.tables.realFinance!;
  const period = periodOf('margin', condition) ?? { start: fin.today, end: fin.today };
  const totals = totalsIn(fin, period.start, period.end);
  const netSales = totals.sales.total, cost = totals.cost, grossProfit = cost === null ? null : netSales - cost;
  const rate = grossProfit === null ? null : rateOf(grossProfit, netSales);
  const base = basePeriod(period);
  const baseTotals = covered(fin, base) ? totalsIn(fin, base.start, base.end) : null;
  const baseRate = baseTotals && baseTotals.cost !== null ? rateOf(baseTotals.sales.total - baseTotals.cost, baseTotals.sales.total) : null;
  const key = marginKeyOf(period, fin);
  const menus = marginRows(snapshot, key ? menuStats(fin.margins[key]) : new Map())
    .sort((a, b) => Number(b.costMissing) - Number(a.costMissing) || (a.rate ?? Infinity) - (b.rate ?? Infinity) || a.menuId.localeCompare(b.menuId));
  const model: MarginModel = {
    period, netSales, cost, grossProfit, rate,
    comparison: rate !== null && baseRate !== null ? { base, baseRate, delta: { value: round1(rate - baseRate), kind: 'pp' } } : null,
    trend: trendDates(period).filter(date => fin.days[date]).map(date => {
      const day = fin.days[date]!, dayCost = day.cost;
      return { date, netSales: day.sales.total, cost: dayCost ?? 0, rate: dayCost === null ? null : rateOf(day.sales.total - dayCost, day.sales.total) };
    }),
    menus, costMissing: cost === null,
  };
  return ready('margin', condition, variant, model);
}
