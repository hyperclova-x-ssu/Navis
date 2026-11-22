import type { ExpenseCategory, Expense, DataTables, DataSnapshot } from '../db/types';
import { isArchivedCafeDay, seedHistory } from '../db/cafe-fixtures';
import { addDays, daysBetween, dateOf, dateRange, inRange, LEGACY_GRANT_EVALUATION_NOW, MONTH_START, timeOf, TODAY } from '../db/time';
import { fromBase, toBase } from '../derive/common';
import { deriveRecipeCost } from '../derive/stock';
import { selectTaxPayments } from '../derive/operations';
import { selectCashReceiptTotals } from '../../pos/reversals/receipt';
import { canceledSettlement } from '../../pos/domain/settlement';
import { periodOf } from '../conditions';
import type { GrantRow, LedgerExpenseRow, LedgerModel, MarginMenuRow, MarginModel, Period, TaxItemRow, TaxModel } from './types';
import { selectAccountingPresentation, selectMoneyRead } from '../pos/projection';
import { selectAccountingDay } from '../iteration7/accounting';
import { realLedger, realMargin } from '../reality/09/views';
import { realTaxModel } from '../reality/18/views';
import { categoryKey, evidenceKey, note, percentChange, rateOf, ready, round1, sum, type Projector } from './util';

const CATEGORY_ORDER: readonly ExpenseCategory[] = ['ingredients', 'operations', 'supplies', 'labor', 'rent', 'other'];
const lengthOf = (p: Period): number => daysBetween(p.start, p.end) + 1;
/** Comparison base: same weekday last week for one day, otherwise the previous period of the same length. */
const basePeriod = (p: Period): Period => (p.start === p.end ? { start: addDays(p.start, -7), end: addDays(p.end, -7) } : { start: addDays(p.start, -lengthOf(p)), end: addDays(p.start, -1) });
const trendDates = (p: Period): string[] => (lengthOf(p) <= 7 ? dateRange(addDays(p.end, -6), p.end) : dateRange(p.start, p.end));

const netOfRow = (r: DataTables['dailySales'][number]): number => r.recognizedNet ?? r.gross - r.discount - r.refund;
function salesIn(t: DataTables, p: Period) {
  const rows = t.dailySales.filter((r) => inRange(r.businessDate, p.start, p.end));
  return { rows, complete: rows.length === lengthOf(p), net: sum(rows.map(netOfRow)) };
}

function expenseRow(t: DataTables, e: Expense): LedgerExpenseRow {
  const supplier = e.supplierId ? t.supplier.find((s) => s.supplierId === e.supplierId) : undefined;
  return {
    expenseId: e.expenseId, date: e.businessDate, category: e.category, categoryKey: categoryKey(e.category), amount: e.amount,
    supplierId: e.supplierId, supplierNameKey: supplier?.nameKey ?? null, evidence: e.evidence, evidenceKey: evidenceKey(e.evidence),
    status: e.status === 'candidate' ? 'candidate' : 'confirmed', memo: e.memo, receiptId: e.receiptId,
  };
}
export const confirmedIn = (t: DataTables, p: Period): Expense[] => t.expense.filter((e) => e.status === 'confirmed' && inRange(e.businessDate, p.start, p.end));

export const projectLedger: Projector<'ledger'> = (ctx, condition, variant) => {
  if (ctx.snapshot.tables.realFinance) return realLedger(ctx, condition, variant);
  const t = ctx.snapshot.tables;
  const period = periodOf('ledger', condition) ?? { start: TODAY, end: TODAY };
  const sales = salesIn(t, period);
  const base = basePeriod(period);
  const baseSales = base.start === seedHistory.comparison.date && period.start === TODAY && period.end === TODAY
    ? { complete: true, net: seedHistory.comparison.net } : salesIn(t, base);
  const totals = sales.rows.reduce((a, r) => ({ gross: a.gross + r.gross, discount: a.discount + r.discount, refund: a.refund + r.refund, card: a.card + r.card, cash: a.cash + r.cash, easyPay: a.easyPay + r.easyPay }), { gross: 0, discount: 0, refund: 0, card: 0, cash: 0, easyPay: 0 });
  const noExpenses = variant === 'no-expenses';
  const confirmed = noExpenses ? [] : confirmedIn(t, period);
  const total = sum(confirmed.map((e) => e.amount));
  const byDate = new Map(t.dailySales.map((r) => [r.businessDate, netOfRow(r)]));
  const expenseByDate = new Map<string, number>();
  if (!noExpenses) for (const expense of t.expense) {
    if (expense.status === 'confirmed') expenseByDate.set(expense.businessDate, (expenseByDate.get(expense.businessDate) ?? 0) + expense.amount);
  }
  const trendPoint = (date: string) => {
    const net = byDate.get(date) ?? 0;
    const expenses = expenseByDate.get(date) ?? 0;
    return { date, net, expenses, netProfit: net - expenses };
  };
  const model: LedgerModel = {
    period, netProfit: sales.net - total, profitRate: rateOf(sales.net - total, sales.net),
    sales: { net: sales.net, gross: totals.gross, discount: totals.discount, refund: totals.refund, byMethod: { card: totals.card, cash: totals.cash, easyPay: totals.easyPay } },
    comparison: baseSales.complete && baseSales.net > 0 ? { base, baseNet: baseSales.net, delta: { value: percentChange(sales.net, baseSales.net), kind: 'percent' } } : null,
    expenses: {
      total,
      byCategory: CATEGORY_ORDER.map((category) => ({ category, categoryKey: categoryKey(category), amount: sum(confirmed.filter((e) => e.category === category).map((e) => e.amount)) })).filter((c) => c.amount > 0),
      items: confirmed.map((e) => expenseRow(t, e)),
    },
    candidates: noExpenses ? [] : t.expense.filter((e) => e.status === 'candidate' && inRange(e.businessDate, period.start, period.end)).map((e) => expenseRow(t, e)),
    remaining: noExpenses ? null : sales.net - total,
    trend: trendDates(period).filter((d) => byDate.has(d)).map(trendPoint),
    periodTrend: dateRange(period.start, period.end).map(trendPoint),
    missingEvidenceCount: confirmed.filter((e) => e.evidence === 'none').length,
  };
  return ready('ledger', condition, variant, model, noExpenses ? [note('ledger', 'no-expenses')] : undefined);
};

/* 마진 */
function marginRows(snapshot: DataSnapshot, p: Period, missingCostMenu: string | null): MarginMenuRow[] {
  const t = snapshot.tables;
  const rows = t.menuDaily.filter((r) => inRange(r.businessDate, p.start, p.end));
  return t.menuItem.filter((menu) => !menu.deletedAt || rows.some((r) => r.menuId === menu.menuId && r.qty > 0)).map((menu) => {
    const own = rows.filter((r) => r.menuId === menu.menuId);
    const qty = sum(own.map((r) => r.qty));
    const netSales = sum(own.map((r) => r.netSales));
    const costMissing = menu.menuId === missingCostMenu || own.some((r) => r.unitCost === null);
    const cost = costMissing ? null : sum(own.map((r) => r.totalCost ?? Math.round(r.qty * (r.unitCost ?? 0))));
    const grossProfit = cost === null ? null : netSales - cost;
    const current = deriveRecipeCost(snapshot, menu.menuId);
    const unitCost = costMissing ? null : current.cost;
    const recognizedGross = snapshot.pos
      ? snapshot.pos.bills.filter(b => b.status === 'paid' && b.recognizedAt).reduce((n, b) => n + b.settlementLines.filter(l => l.menuId === menu.menuId).reduce((n, l) => n + l.recognizedQty * (l.basePriceAtSale + l.optionPriceAtSale) - canceledSettlement(snapshot.pos!, b.billId, l.allocationId).gross, 0), 0)
      : t.paymentLine.filter(l => l.menuId === menu.menuId && t.payment.some(payment => payment.paymentId === l.paymentId && payment.businessDate === TODAY && payment.kind === 'payment')).reduce((n, l) => n + (l.grossAmount ?? l.qty * l.unitPriceAtSale), 0);
    return {
      menuId: menu.menuId, name: menu.name ?? { key: menu.nameKey }, unitMargin: unitCost === null ? null : menu.price - unitCost, contribution: cost === null ? null : (p.start === TODAY && p.end === TODAY ? recognizedGross : netSales) - cost, nameKey: menu.nameKey, categoryKey: menu.categoryKey, price: menu.price, unitCost, qty, netSales, cost, grossProfit,
      rate: costMissing ? null : current.rate, costMissing: costMissing || unitCost === null,
      recipe: current.recipeLines.map((part) => ({ nameKey: part.nameKey, name: part.name, qty: { value: fromBase(toBase(part.quantity, part.unit) ?? 0, part.inventoryUnit), unit: part.inventoryUnit }, cost: part.cost ?? 0 })), costEffectiveFrom: menu.costEffectiveFrom,
    };
  });
}
function marginTotals(snapshot: DataSnapshot, p: Period, missingCostMenu: string | null) {
  const menus = marginRows(snapshot, p, missingCostMenu);
  const custom = (snapshot.pos?.customRecognitions ?? []).filter(r=>inRange(r.businessDate,p.start,p.end));
  const canonical=snapshot.pos?.money && p.start<=snapshot.pos.businessDate && p.end>=snapshot.pos.businessDate &&
    (snapshot.pos.orders.length || !isArchivedCafeDay(snapshot.pos.businessDate))
    ? selectAccountingDay(selectMoneyRead(snapshot),{date:snapshot.pos.businessDate}) : null;
  const netSales = sum(menus.map((m) => m.netSales)) + (canonical?canonical.sales.total-snapshot.tables.menuDaily.filter(r=>r.businessDate===snapshot.pos!.businessDate).reduce((n,r)=>n+r.netSales,0):sum(custom.map(r=>r.amount)));

  const costMissing = menus.some((m) => m.qty > 0 && m.cost === null) || (canonical?canonical.unknownCostSales.reduce((n,r)=>n+r.amount,0):custom.reduce((n,r)=>n+r.amount,0)) > 0;
  const cost = costMissing ? null : sum(menus.map((m) => m.cost ?? 0));
  const grossProfit = cost === null ? null : netSales - cost;
  return { menus, netSales, cost, grossProfit, costMissing, rate: grossProfit === null ? null : rateOf(grossProfit, netSales) };
}

export const projectMargin: Projector<'margin'> = (ctx, condition, variant) => {
  if (ctx.snapshot.tables.realFinance) return realMargin(ctx, condition, variant);
  const t = ctx.snapshot.tables;
  const period = periodOf('margin', condition) ?? { start: TODAY, end: TODAY };
  const missing = variant === 'missing-cost' ? 'm-saltbread' : null;
  const now = marginTotals(ctx.snapshot, period, missing);
  const base = basePeriod(period);
  const hasBase = dateRange(base.start, base.end).every((d) => t.dailySales.some((r) => r.businessDate === d));
  const baseDay = seedHistory.comparison;
  const baseRate = base.start === baseDay.date && period.start === TODAY && period.end === TODAY
    ? rateOf(baseDay.net - baseDay.cost, baseDay.net)
    : hasBase ? marginTotals(ctx.snapshot, base, null).rate : null;
  const trend = trendDates(period).filter((d) => t.dailySales.some((r) => r.businessDate === d)).map((date) => {
    const day = marginTotals(ctx.snapshot, { start: date, end: date }, missing);
    return { date, netSales: day.netSales, cost: day.cost ?? 0, rate: day.rate };
  });
  const menus = [...now.menus].sort((a, b) => Number(b.costMissing) - Number(a.costMissing) || (a.rate ?? Infinity) - (b.rate ?? Infinity) || a.menuId.localeCompare(b.menuId));
  const model: MarginModel = {
    period, netSales: now.netSales, cost: now.cost, grossProfit: now.grossProfit, rate: now.rate,
    comparison: now.rate !== null && baseRate !== null ? { base, baseRate, delta: { value: round1(now.rate - baseRate), kind: 'pp' } } : null,
    trend, menus, costMissing: now.costMissing,
  };
  return ready('margin', condition, variant, model, missing ? [note('margin', 'missing-cost')] : undefined);
};

/** ‘가격·원가 바꿔 보기’: pure calculator outside the model (SCR-31). Null when the price is 0 or less. */
export function simulateMenuPrice(next: { readonly price: number; readonly unitCost: number }, base?: { readonly price: number; readonly unitCost: number }):
  { readonly profit: number; readonly rate: number; readonly profitDelta?: number; readonly rateDelta?: number } | null {
  const calc = (v: { price: number; unitCost: number }) => (v.price > 0 && v.unitCost >= 0 && Number.isFinite(v.price) && Number.isFinite(v.unitCost) ? { profit: v.price - v.unitCost, rate: round1(((v.price - v.unitCost) / v.price) * 100) } : null);
  const result = calc(next);
  if (!result) return null;
  const before = base ? calc(base) : null;
  return before ? { ...result, profitDelta: result.profit - before.profit, rateDelta: round1(result.rate - before.rate) } : result;
}

/* 세금 */
export const projectTax: Projector<'tax'> = (ctx, condition, variant) => {
  const real = realTaxModel(ctx.snapshot, condition.kind === 'dateRange');
  if (real) return ready('tax', condition, variant, real);
  const t = ctx.snapshot.tables;
  const period = periodOf('tax', condition) ?? { start: MONTH_START, end: TODAY };
  const confirmed = confirmedIn(t, period);
  const allChecked = variant === 'all-checked';
  const items: TaxItemRow[] = confirmed.filter((e) => e.evidence === 'none').map((e) => ({
    refType: 'expense', refId: e.expenseId, date: e.businessDate, category: e.category, categoryKey: categoryKey(e.category), amount: e.amount, memo: e.memo,
    status: allChecked ? 'checked' : (t.taxReview.find((r) => r.refType === 'expense' && r.refId === e.expenseId)?.status ?? 'needs-check'),
    reasonKey: 'data.tax.reason.missingEvidence',
  }));
  const reviewCount = items.filter((i) => i.status === 'needs-check').length;
  const accounting = ctx.snapshot.pos?.money ? selectAccountingPresentation(ctx.snapshot).views.find(v => v.status === 'ready' && v.period.start === period.start && v.period.end === period.end) : undefined;
  const salesTotal = accounting?.status === 'ready' ? accounting.summary.sales.total : salesIn(t, period).net;
  const deductible = sum(confirmed.filter((e) => e.evidence === 'tax-invoice' || e.evidence === 'card').map((e) => e.amount));
  const missingData = variant === 'missing-data';
  const connection = (source: 'sales' | 'expenses' | 'evidence', status: 'connected' | 'partial' | 'missing') => ({ source, sourceKey: `data.tax.source.${source}`, status, statusKey: `data.tax.connection.${status}` });
  const model: TaxModel = {
    payments: selectTaxPayments(ctx.snapshot, { date: TODAY }),
    period: missingData ? null : period,
    connections: [connection('sales', 'connected'), connection('expenses', missingData ? 'missing' : 'connected'), connection('evidence', missingData ? 'missing' : reviewCount > 0 ? 'partial' : 'connected')],
    items, reviewCount,
    estimate: reviewCount === 0 && !missingData ? { amount: Math.max(0, Math.round((salesTotal - deductible) / 11 / 10) * 10), basisDate: period.end, assumptionKey: 'data.tax.assumption' } : null,
    exportPreview: { salesTotal, expenseTotal: sum(confirmed.map((e) => e.amount)), withEvidence: confirmed.filter((e) => e.evidence !== 'none').length, missingEvidence: confirmed.filter((e) => e.evidence === 'none').length,
      cashReceipts: !missingData && ctx.snapshot.pos ? selectCashReceiptTotals(ctx.snapshot.pos, period) : { count: 0, amount: 0 } },
  };
  const notes = allChecked ? [note('tax', 'all-checked')] : missingData ? [note('tax', 'missing-data'), { messageKey: 'data.state.tax.needs-more' }] : undefined;
  return ready('tax', condition, variant, model, notes);
};

/* 정부지원 */
export const projectGrants: Projector<'grants'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const needsCheck = variant === 'needs-check';
  const notices: GrantRow[] = t.grantNotice.filter((n) => n.applyEnd >= LEGACY_GRANT_EVALUATION_NOW).sort((a, b) => a.applyEnd.localeCompare(b.applyEnd) || a.noticeId.localeCompare(b.noticeId)).map((n) => {
    const reviewStatus = t.grantReview.find((r) => r.noticeId === n.noticeId)?.reviewStatus ?? 'before';
    const applyEndDate = dateOf(n.applyEnd);
    return {
      noticeId: n.noticeId, titleKey: n.titleKey, agencyKey: n.agencyKey, regionKey: n.regionKey, applyStart: n.applyStart, applyEnd: n.applyEnd, applyEndDate, applyEndTime: timeOf(n.applyEnd),
      daysLeft: daysBetween(TODAY, applyEndDate), conditionKeys: n.conditionKeys, summaryKey: n.summaryKey, matchStatus: needsCheck ? 'needs-check' : n.matchStatus,
      reviewStatus, isCandidate: n.applyStart <= LEGACY_GRANT_EVALUATION_NOW && reviewStatus === 'before' && !t.grantApplication.some((a) => a.noticeId === n.noticeId),
    };
  });
  return ready('grants', condition, variant, { applications: t.grantApplication.map((a) => ({ ...a, title: { key: t.grantNotice.find((n) => n.noticeId === a.noticeId)?.titleKey ?? 'data.management.grant.digital' } })), inProgressCount: t.grantApplication.filter((a) => ['applied', 'reviewing', 'selected'].includes(a.status)).length, candidateCount: notices.filter((n) => n.isCandidate).length, notices, sourceKey: 'data.source.sample' }, needsCheck ? [note('grants', 'needs-check')] : undefined);
};
