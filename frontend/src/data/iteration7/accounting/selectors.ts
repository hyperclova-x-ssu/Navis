import type { PosCommandMeta } from '../../../contracts/pos';
import type { AccountingDay, MoneyPlan, MoneyRead } from './types';
import { emptyEffects, failure, freezePos, guard, publish } from './shared';
import { sameSource, settlementLineQuantityLeft, settlementRemaining } from './settlement';

export function selectAccountingDay(read: MoneyRead, { date }: { readonly date: string }): AccountingDay {
  return selectAccountingPeriod(read, { start: date, end: date });
}
export function selectAccountingPeriod(read: MoneyRead, { start, end }: { readonly start: string; readonly end: string }): AccountingDay {
  const inPeriod = (date: string) => date >= start && date <= end;
  const rows = read.state.recognitions.filter(r => inPeriod(r.businessDate));
  const corrections = read.state.corrections.filter(c => inPeriod(c.at.slice(0, 10)));
  const byRealMethodSale = { card: 0, easy_pay: 0, cash: 0 }, byMethod = { card: 0, easy_pay: 0, cash: 0 };
  const discountBySource = { direct: 0, coupon: 0, membership: 0 };
  let chargeUsed = 0, receivableCreated = 0, membershipCount = 0, subscriptionDaily = 0, membershipExpiry = 0, customPickup = 0, cost = 0, gross = 0;
  for (const r of rows) {
    if (r.source === 'custom_pickup') customPickup += r.amount;
    else if (r.source === 'subscription_day') subscriptionDaily += r.amount;
    else if (r.source === 'membership_expiry') membershipExpiry += r.amount;
    else if (r.settlementCategory === 'charge') chargeUsed += r.amount;
    else if (r.settlementCategory === 'receivable') receivableCreated += r.amount;
    else if (r.settlementCategory === 'membership_count') membershipCount += r.amount;
    else if (r.settlementCategory === 'card' || r.settlementCategory === 'easy_pay' || r.settlementCategory === 'cash') byRealMethodSale[r.settlementCategory] += r.amount;
    cost += r.cost ?? 0; gross += r.gross ?? 0;
    for (const key of ['direct', 'coupon', 'membership'] as const) discountBySource[key] += r.discountBySource?.[key] ?? 0;
  }
  const total = rows.reduce((n, r) => n + r.amount, 0), discount = Object.values(discountBySource).reduce((n, v) => n + v, 0);
  const refund = -corrections.filter(c => c.kind === 'refund').flatMap(c => c.recognitionEffects).reduce((n, r) => n + r.amount, 0);
  const payments = read.state.payments.filter(p => inPeriod(p.at.slice(0, 10)));
  const byPurpose = { sale: 0, charge_topup: 0, receivable_collection: 0, membership_sale: 0, custom_order: 0 };
  let grossReceived = 0, returned = 0, pendingReceived = 0;
  for (const p of payments) {
    grossReceived += p.amount; byPurpose[p.purpose] += p.amount;
    for (const a of p.splits) byMethod[a.method] += a.amount;
    if (p.purpose === 'sale' && !read.state.recognitions.some(r => ['menu', 'membership_count'].includes(r.source) && r.sourceId === p.sourceRef.id)) {
      pendingReceived += p.amount - read.state.corrections.filter(c => c.settlementId === p.settlementId && c.at.slice(0, 10) <= end).flatMap(c => c.realMethodReturns).reduce((n, a) => n + a.amount, 0);
    }
  }
  for (const c of corrections) {
    const s = read.state.settlements.find(s => s.settlementId === c.settlementId);
    for (const m of c.realMethodReturns) { returned += m.amount; byMethod[m.method] -= m.amount; if (s) byPurpose[s.purpose] -= m.amount; }
  }
  const deposits = { total: grossReceived - returned, byMethod, byPurpose, grossReceived, returned, pendingReceived };
  const quantities = new Map<string, number>();
  for (const r of rows.filter(r => ['menu', 'membership_count'].includes(r.source))) quantities.set(r.sourceId, (quantities.get(r.sourceId) ?? 0) + (r.quantity ?? 0));
  const accountRows = read.state.accountTxns.filter(t => inPeriod(t.at.slice(0, 10)));
  const accountKind = (kind: string) => accountRows.filter(t => t.kind === kind || t.kind === 'reversal' && read.state.accountTxns.find(o => o.txnId === t.originalTxnId)?.kind === kind).reduce((n, t) => n + t.amount, 0);
  const expenses = inPeriod(read.businessDate) ? read.expenses ?? 0 : 0;
  return freezePos({ sales: { total, byRealMethodSale, chargeUsed, receivableCreated, membershipCount, subscriptionDaily, membershipExpiry, customPickup, refund, gross, discount, discountBySource }, deposits,
    settlementActivity: { chargeTopup: accountKind('topup'), chargeUsed: -accountKind('use'), receivableCreated: accountKind('sale'), receivableCollected: -accountKind('collection'),
      membershipSold: byPurpose.membership_sale, membershipCount, subscriptionDaily, membershipExpiry,
      customAdvance: payments.filter(p => p.purpose === 'custom_order' && read.state.settlements.find(s => s.settlementId === p.settlementId)?.sourceSnapshot?.paymentTiming !== 'on_pickup').reduce((n, p) => n + p.amount, 0)
        - corrections.filter(c => read.state.settlements.find(s => s.settlementId === c.settlementId)?.purpose === 'custom_order').flatMap(c => c.realMethodReturns).reduce((n, a) => n + a.amount, 0), customPickup },
    orderCount: [...quantities.values()].filter(n => n > 0).length,
    realPaymentCount: payments.filter(p => p.amount > corrections.filter(c => c.settlementId === p.settlementId && c.kind === 'cancel').flatMap(c => c.realMethodReturns).reduce((n, m) => n + m.amount, 0)).length,
    discountBySource, cost, expenses, profit: total - expenses,
    unknownCostSales: rows.filter(r => r.cost === null).map(r => ({ recognitionId: r.recognitionId, sourceId: r.sourceId, amount: r.amount, cost: null })) });
}
export function selectAccountingDrawer(read: MoneyRead) {
  const drawer = read.drawer ?? { opening: 0, actual: null, memo: '', movements: [] };
  const day = selectAccountingDay(read, { date: read.businessDate });
  const cash = (splits: readonly { readonly method: string; readonly amount: number }[]) => splits.filter(a => a.method === 'cash').reduce((n, a) => n + a.amount, 0);
  const approvedCash = read.state.payments.filter(p => p.at.slice(0, 10) === read.businessDate).reduce((n, p) => n + cash(p.splits), 0);
  const corrections = read.state.corrections.filter(c => c.at.slice(0, 10) === read.businessDate);
  const cashCanceled = corrections.filter(c => c.kind === 'cancel').reduce((n, c) => n + cash(c.realMethodReturns), 0), cashRefunded = corrections.filter(c => c.kind === 'refund').reduce((n, c) => n + cash(c.realMethodReturns), 0);
  const incoming = drawer.movements.filter(m => m.kind === 'in').reduce((n, m) => n + m.amount, 0), outgoing = drawer.movements.filter(m => m.kind === 'out').reduce((n, m) => n + m.amount, 0);
  const cashReturned = cashCanceled + cashRefunded, cashNet = day.deposits.byMethod.cash, expected = drawer.opening + cashNet + incoming - outgoing;
  const pendingCash = read.state.payments.filter(p => p.purpose === 'sale' && p.at.slice(0, 10) === read.businessDate && !read.state.recognitions.some(r => r.sourceId === p.sourceRef.id && r.source !== 'custom_pickup'))
    .reduce((n, p) => n + cash(p.splits) - read.state.corrections.filter(c => c.settlementId === p.settlementId).reduce((n, c) => n + cash(c.realMethodReturns), 0), 0);
  return freezePos({ ...drawer, approvedCash, cashPayments: approvedCash - pendingCash, pendingCash, cashCanceled, cashRefunded, cashReturned, cashNet,
    in: incoming, out: outgoing, expected, difference: drawer.actual === null ? null : drawer.actual - expected });
}
export function selectAccountingClosing(read: MoneyRead) {
  return freezePos({ businessDate: read.businessDate, generation: read.generation, ...selectAccountingDay(read, { date: read.businessDate }), drawer: selectAccountingDrawer(read) });
}
export function selectMoneyReceipt(read: MoneyRead, input: { readonly settlementId?: string; readonly paymentId?: string }) {
  const payment = read.state.payments.find(p => input.paymentId ? p.paymentId === input.paymentId : p.settlementId === input.settlementId);
  const settlement = read.state.settlements.find(s => s.settlementId === (input.settlementId ?? payment?.settlementId));
  if (!settlement) return null;
  const source = read.sources.find(s => sameSource(s.sourceRef, settlement.sourceRef)) ?? settlement.sourceSnapshot;
  const currentPrepared = source?.prepared ?? false;
  const reversalLines = (source?.lines ?? []).map(line => ({ allocationId: line.allocationId, orderLineId: line.orderLineId, menuId: line.menuId, name: line.name,
    quantity: Math.min(settlementLineQuantityLeft(read, settlement, line.allocationId), Math.max(0, line.quantity - read.state.corrections.filter(c => read.state.settlements.some(s => s.settlementId === c.settlementId && sameSource(s.sourceRef, settlement.sourceRef)))
      .flatMap(c => c.quantityReturns ?? []).filter(q => q.allocationId === line.allocationId).reduce((n, q) => n + q.quantity, 0))), prepared: line.prepared ?? currentPrepared })).filter(l => l.quantity > 0);
  return freezePos({ ...settlement, paymentId: payment?.paymentId, payment: payment ?? null, remainingRefundable: settlementRemaining(read, settlement),
    currentPrepared, reversalLines, wholeBillDiscount: source?.wholeBillDiscount ?? false,
    accountEffects: read.state.accountTxns.filter(t => t.settlementId === settlement.settlementId),
    membershipEffects: read.state.uses.filter(u => settlement.allocations.some(a => a.useId === u.useId)),
    recognitionEffects: read.state.recognitions.filter(r => r.settlementId === settlement.settlementId), corrections: read.state.corrections.filter(c => c.settlementId === settlement.settlementId) });
}
/** API-274's receive planner and this effect are committed together by T-270. */
export function planRecognizeCustomPickup(read: MoneyRead, input: { readonly customOrderId: string; readonly meta: PosCommandMeta }): MoneyPlan {
  const payload = { type: 'custom.pickup.recognize', customOrderId: input.customOrderId }, checked = guard(read, input.meta, payload); if (checked) return checked;
  if (read.state.attempt) return failure('APPROVAL_BUSY', 'CONFLICT');
  const source = read.sources.find(s => s.purpose === 'custom_order' && s.sourceRef.id === input.customOrderId);
  if (!source) return failure('NOT_FOUND', 'NOT_FOUND');
  if (source.canSubmit === false) return source.issues?.[0] ?? failure('QUOTE_CHANGED', 'CONFLICT');
  if (read.state.recognitions.some(r => r.source === 'custom_pickup' && r.sourceId === input.customOrderId)) return failure('ALREADY_RECEIVED', 'CONFLICT');
  const settled = read.state.settlements.filter(s => s.purpose === 'custom_order' && sameSource(s.sourceRef, source.sourceRef)).reduce((n, s) => n + settlementRemaining(read, s), 0);
  if (settled !== source.amountDue) return failure('PAYMENT_REQUIRED');
  const recognitionId = `pickup:${input.customOrderId}`;
  return publish(read, { ...emptyEffects(), recognitions: [{ recognitionId, source: 'custom_pickup', sourceId: input.customOrderId, businessDate: read.businessDate, at: read.now,
    amount: source.amountDue, cost: null, settlementCategory: 'custom_pickup', originalRecognitionId: null }] }, { sourceRef: source.sourceRef, settled: true }, input.meta, payload);
}
