import type { DataSnapshot, DataTables, DailySales, MenuDaily } from '../db/types';
import type { ClosingScenario, PaymentMethod, SalesSnapshot } from '../db/management-types';
import { hourOf, NOW_TIME, timeOf, TODAY, weekdayOf } from '../db/time';
import { memoSelector, requireDate } from './common';
import { selectM2DayTotals, selectMoneyRead } from '../pos/projection';
import { STORE_WEEKDAYS, storeOpenClose } from '../store-hours';
import { allocatePosAmount } from '../../pos/domain/money';

export interface PaymentQuery { readonly date: string; readonly method?: PaymentMethod; readonly onlyMixed?: boolean; readonly scenario: ClosingScenario; readonly sort?: { readonly field: 'time' | 'amount' | 'method' | 'status'; readonly direction: 'asc' | 'desc' } }
export const selectPayments = memoSelector((q: PaymentQuery) => JSON.stringify(q), (s, q) => {
  requireDate(q.date);
  const all = q.scenario === 'empty' ? [] : s.tables.payment.filter((p) => p.businessDate === q.date);
  const totals = paymentTotals(s, { date: q.date, scenario: q.scenario });
  const rows = all.filter(p => (!q.method || (p.methodSplits ? p.methodSplits.some(s => s.method === q.method) : p.method === q.method)) && (!q.onlyMixed || (p.methodSplits?.length ?? 1) > 1)).map((p) => {
    const lines = s.tables.paymentLine.filter((l) => l.paymentId === p.paymentId);
    const net = p.status === 'canceled' ? 0 : p.kind === 'refund' ? -p.refundAmount : p.gross - p.discount;
    return { ...p, net, visibleAmount: q.method && p.methodSplits ? p.methodSplits.filter(s => s.method === q.method).reduce((n, s) => n + s.amount, 0) : net, lines,
      summary: { key: p.kind === 'cancel' ? 'data.management.cancelSummary' : p.kind === 'refund' ? 'data.management.refundLines' : 'data.management.paymentLines', params: { count: lines.reduce((n, l) => n + l.qty, 0) } } };
  });
  const sort = q.sort ?? { field: 'time', direction: 'desc' };
  rows.sort((a, b) => {
    const field = sort.field === 'amount' ? 'net' : sort.field === 'status' ? 'kind' : sort.field;
    const av = a[field], bv = b[field];
    const diff = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return diff * (sort.direction === 'asc' ? 1 : -1) || (sort.field === 'time' ? ((a.seq ?? 0) - (b.seq ?? 0)) * (sort.direction === 'asc' ? 1 : -1) : 0) || a.paymentId.localeCompare(b.paymentId);
  });
  return { rows, totals };
});
/** API-243 public normal-ledger read; the existing closing query keeps its explicit scenario. */
export const selectPosPayments = (s: DataSnapshot, q: Omit<PaymentQuery, 'scenario'> & { readonly scenario?: ClosingScenario }) => selectPayments(s, { ...q, scenario: q.scenario ?? 'normal' });

/** Group the signed sales facts used by the day total into local hours. */
export function selectHourlySales(snapshot: DataSnapshot, { date, includeElapsedStoreHours }: {
  readonly date: string;
  readonly includeElapsedStoreHours?: boolean;
}) {
  const entries = snapshot.pos?.money
    ? selectMoneyRead(snapshot).state.recognitions.filter(row => row.businessDate === date)
      .map(row => ({ time: timeOf(row.at), amount: row.amount }))
    : selectPayments(snapshot, { date, scenario: 'normal' }).rows
      .map(row => ({ time: row.time, amount: row.net }));
  const totals = new Map<number, number>();
  for (const { time, amount } of entries) {
    if (amount === 0) continue;
    const hour = hourOf(time);
    totals.set(hour, (totals.get(hour) ?? 0) + amount);
  }
  if (totals.size === 0) return [];

  const hours = [...totals.keys()];
  if (includeElapsedStoreHours && date === TODAY) {
    const { open } = storeOpenClose(STORE_WEEKDAYS[weekdayOf(date) - 1]!);
    hours.push(hourOf(open), hourOf(NOW_TIME));
  }
  const first = Math.min(...hours), last = Math.max(...hours);
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const hour = first + index;
    return { hour, amount: totals.get(hour) ?? 0 };
  });
}

export const paymentTotals = memoSelector((q: { readonly date: string; readonly scenario: ClosingScenario }) => `${q.date}:${q.scenario}`, (s, q): SalesSnapshot => {
  requireDate(q.date);
  const total = { gross: 0, discount: 0, refund: 0, net: 0, paymentCount: 0, refundCount: 0, byMethod: { card: 0, easy_pay: 0, cash: 0 }, methodCounts: { card: 0, easy_pay: 0, cash: 0 } };
  if (q.scenario === 'empty') return total;
  if (s.pos && s.pos.businessDate === q.date) {
    const t = selectM2DayTotals(s.pos);
    return { gross: t.gross, discount: t.discount, refund: t.refund, net: t.revenue, paymentCount: t.paymentCount, refundCount: t.refundCount, byMethod: t.byMethod, methodCounts: t.methodCounts };
  }
  for (const p of s.tables.payment.filter((p) => p.businessDate === q.date)) {
    total.gross += p.gross; total.discount += p.discount; total.refund += p.refundAmount;
    if (p.kind === 'payment' && p.status !== 'canceled') { total.paymentCount++; total.methodCounts[p.method]++; } else if (p.kind === 'refund') total.refundCount++;
    if (p.methodSplits) for (const split of p.methodSplits) total.byMethod[split.method] += split.amount;
    else total.byMethod[p.method] += p.gross - p.discount - p.refundAmount;
  }
  total.net = total.gross - total.discount - total.refund;
  return total;
});
/** Compatibility rows are read adapters of Payment/PaymentLine; historical rows stay immutable. */
export function paymentDailyAdapters(t: DataTables, date = TODAY): { dailySales: readonly DailySales[]; menuDaily: readonly MenuDaily[] } {
  const s: DataSnapshot = { revision: 0, seq: 0, tables: t };
  const totals = paymentTotals(s, { date, scenario: 'normal' });
  const menus: MenuDaily[] = [];
  for (const menuId of new Set(t.paymentLine.map((l) => l.menuId))) {
    const lines = t.paymentLine.filter((l) => l.menuId === menuId && t.payment.some((p) => p.paymentId === l.paymentId && p.kind !== 'refund' && p.businessDate === date));
    const qty = lines.reduce((n, l) => n + l.qty, 0);
    let netSales = lines.reduce((n, l) => n + (l.grossAmount ?? l.qty * l.unitPriceAtSale), 0);
    for (const p of t.payment.filter((p) => p.businessDate === date)) {
      const own = t.paymentLine.filter((l) => l.paymentId === p.paymentId && l.menuId === menuId);
      if (!own.length) continue;
      if (p.kind === 'refund') netSales -= own.reduce((n, l) => n + (l.refundAmount ?? l.qty * l.unitPriceAtSale), 0);
      else if (p.discount && p.kind === 'cancel') netSales -= own.reduce((n, l) => n + (l.discountAmount ?? 0), 0);
      else if (p.discount) {
        const all = t.paymentLine.filter(l => l.paymentId === p.paymentId);
        const allocation = allocatePosAmount(p.discount, all.map(l => ({ id: l.paymentLineId, amount: l.grossAmount ?? l.qty * l.unitPriceAtSale })));
        netSales -= own.reduce((n, l) => n + (l.discountAmount ?? allocation[l.paymentLineId]), 0);
      }
    }
    const cost = lines.some((l) => l.unitCostAtSale === null) ? null : lines.reduce((n, l) => n + l.qty * (l.unitCostAtSale ?? 0), 0);
    menus.push({ businessDate: date, menuId, qty, netSales, unitCost: cost === null || qty === 0 ? null : cost / qty });
  }
  return {
    dailySales: [...t.dailySales.filter((d) => d.businessDate !== date), { businessDate: date, gross: totals.gross, discount: totals.discount, refund: totals.refund, card: totals.byMethod.card, cash: totals.byMethod.cash, easyPay: totals.byMethod.easy_pay }],
    menuDaily: [...t.menuDaily.filter((d) => d.businessDate !== date), ...menus],
  };
}
export const selectClosing = memoSelector((q: { readonly date: string; readonly scenario: ClosingScenario }) => `${q.date}:${q.scenario}`, (s, q) => {
  requireDate(q.date);
  const current = s.tables.dayClosing.filter((c) => c.businessDate === q.date && c.scenario === q.scenario).at(-1);
  const expenses = s.tables.expense.filter((e) => e.businessDate === q.date && e.status === 'confirmed').reduce((n, e) => n + e.amount, 0);
  const salesSnapshot = current?.salesSnapshot ?? paymentTotals(s, q);
  return { ...current, generation: current?.generation ?? 0, status: current?.status ?? 'open', closingId: current?.closingId ?? null, closedAt: current?.closedAt ?? null, canUndo: current?.status === 'closed', salesSnapshot, expenses, netProfit: salesSnapshot.net - expenses, profitRate: salesSnapshot.net ? Math.round((salesSnapshot.net - expenses) / salesSnapshot.net * 1_000) / 10 : null };
});
