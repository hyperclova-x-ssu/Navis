import { addDays } from '../../db/time';
import { businessDate } from './shared';
import type { CustomAccountingModel, CustomCalendarEvent, CustomOrder, CustomOrderPaymentView, CustomOrderQuery, CustomOrderRead, CustomOrdersModel, PickupReservation } from './types';

export function customPaymentView(read: CustomOrderRead, order: CustomOrder): CustomOrderPaymentView {
  const settlements = read.money.settlements.filter(s => s.purpose === 'custom_order' && s.sourceRef.id === order.customOrderId);
  const ids = new Set(settlements.map(s => s.settlementId));
  const corrections = read.money.corrections.filter(c => ids.has(c.settlementId));
  const amountSettled = settlements.reduce((sum, s) => sum + s.amount, 0);
  const amountReturned = corrections.reduce((sum, c) => sum + c.amount, 0);
  return { status: corrections.some(c => c.kind === 'refund') ? 'refunded' : corrections.length ? 'canceled' : amountSettled ? 'paid' : 'unpaid', amountSettled, amountReturned,
    realDeposits: read.money.payments.filter(p => ids.has(p.settlementId)).reduce((sum, p) => sum + p.amount, 0) - corrections.flatMap(c=>c.realMethodReturns).reduce((n,m)=>n+m.amount,0),
    chargeApplied: Math.max(0,-(read.accounting?.accountTxns.filter(t=>!!t.settlementId&&ids.has(t.settlementId)&&t.account==='charge').reduce((n,t)=>n+t.amount,0)??0)),
    receivableAmount: read.accounting?.accountTxns.filter(t=>!!t.settlementId&&ids.has(t.settlementId)&&t.account==='receivable').reduce((n,t)=>n+t.amount,0)??0 };
}
export const customPickup = (read: CustomOrderRead, order: CustomOrder): PickupReservation | null => read.tables.reservation.find((r): r is PickupReservation => r.kind === 'pickup' && r.customOrderId === order.customOrderId && r.reservationId === order.pickupReservationId) ?? null;

export function selectCustomOrders(read: CustomOrderRead, query: CustomOrderQuery = {}): CustomOrdersModel {
  const today = businessDate(read), tomorrow = addDays(today, 1);
  const all = read.tables.customOrder.map(order => {
    const pickup = customPickup(read, order);
    return { ...order, pickup, confirmedPickupAt: pickup ? `${pickup.date}T${pickup.time}` : null, payment: customPaymentView(read, order) };
  });
  const active = all.filter(o => o.stage !== 'canceled' && o.stage !== 'received_by_customer');
  const upcoming = active.filter(o => o.pickup?.status === 'confirmed');
  const summary = { inProgress: active.length, approvalPending: active.filter(o => o.stage === 'approval_pending' && o.customerDecision === 'pending').length,
    todayPickup: upcoming.filter(o => o.pickup!.date === today).length, tomorrowPickup: upcoming.filter(o => o.pickup!.date === tomorrow).length,
    todayNotComplete: upcoming.filter(o => o.pickup!.date === today && o.stage !== 'production_complete').length };
  const text = query.query?.trim().toLocaleLowerCase();
  const orders = all.filter(o => {
    const date = (o.confirmedPickupAt ?? o.desiredPickupAt).slice(0, 10);
    return (!query.stage || o.stage === query.stage) && (!query.start || date >= query.start) && (!query.end || date <= query.end)
      && (!text || [o.customOrderId, o.productLabel, o.guest?.name, o.guest?.phone, o.memberId, o.request].join(' ').toLocaleLowerCase().includes(text));
  });
  return { templates: read.tables.customTemplate.filter(t => t.archivedAt === null), orders, summary };
}

export function selectCustomCalendar(read: CustomOrderRead): readonly CustomCalendarEvent[] {
  return selectCustomOrders(read).orders.flatMap(order => {
    if (order.stage === 'canceled' || order.stage === 'received_by_customer' || order.pickup?.status !== 'confirmed') return [];
    const base = { customOrderId: order.customOrderId, reservationId: order.pickup.reservationId, source: 'pickup' as const, category: 'store-operations' as const, readonly: true as const,
      title: order.productLabel, detailRef: { featureId: 'custom-order' as const, customOrderId: order.customOrderId } };
    return [{ ...base, eventId: `custom-pickup:${order.customOrderId}`, kind: 'pickup' as const, date: order.pickup.date, time: order.pickup.time },
      ...(order.productionAt ? [{ ...base, eventId: `custom-production:${order.customOrderId}`, kind: 'production' as const, title: `내부 제작 · ${order.productLabel}`, date: order.productionAt.slice(0, 10), time: order.productionAt.slice(11) }] : [])];
  });
}

export function selectCustomAccounting(read: CustomOrderRead, query: { readonly date?: string } = {}): CustomAccountingModel {
  const date = query.date ?? businessDate(read), methodDeposits = { card: 0, easy_pay: 0, cash: 0 };
  const settlementById = new Map(read.money.settlements.map(s => [s.settlementId, s]));
  let advanceDeposits = 0, refund = 0;
  for (const payment of read.money.payments) {
    const settlement = settlementById.get(payment.settlementId);
    if (!settlement || !payment.at.startsWith(date)) continue;
    for (const split of payment.splits) methodDeposits[split.method] += split.amount;
    if (settlement.paymentTiming === 'advance') advanceDeposits += payment.amount;
  }
  for (const correction of read.money.corrections) {
    const settlement = settlementById.get(correction.settlementId);
    if (!settlement || !correction.at.startsWith(date)) continue;
    for (const split of correction.realMethodReturns) methodDeposits[split.method] -= split.amount;
    if (settlement.paymentTiming === 'advance') advanceDeposits -= correction.realMethodReturns.reduce((n,s)=>n+s.amount,0);
    if (correction.kind === 'refund') refund += correction.amount;
  }
  const recognitions = read.money.recognitions.filter(r => r.source === 'custom_pickup' && r.businessDate === date);
  const orders = new Map(read.tables.customOrder.map(o => [o.customOrderId, o]));
  return { customPickup: recognitions.reduce((sum, r) => sum + r.amount, 0), realDeposits: methodDeposits.card + methodDeposits.easy_pay + methodDeposits.cash, advanceDeposits, methodDeposits, refund,
    rows: recognitions.map(r => ({ customOrderId: r.sourceId, productLabel: orders.get(r.sourceId)?.productLabel ?? '', amount: r.amount, cost: null, recognitionId: r.recognitionId })) };
}
