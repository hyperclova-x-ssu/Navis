/** Test-only helper for the 예약 window: the café sample (D-313) has one approved pickup (CO-001, tomorrow 10:30) and none today. */
import { selectCustomOrders } from '../../../data/iteration7/custom-orders';
import { createWidgetDataStore, selectReservations, TODAY } from '../../../data/widget-data';
import type { Reservation } from '../../../data/db/types';
import type { CustomOrderPort } from '../i7-custom/port';

/** Approves the first custom order that has no pickup yet with a pickup today, so the window's pickup table has a row. Returns that order. */
export function addTodayPickup(port: CustomOrderPort, time = '18:30') {
  const order = selectCustomOrders(port.read()).orders.find(row => !row.pickup)!;
  const quote = port.dispatch({ type: 'customOrder.quote', customOrderId: order.customOrderId, quoteAmount: 45000, proposedPickupAt: `${TODAY}T${time}`, idempotencyKey: 'booking-fixture-quote' });
  const decision = port.dispatch({ type: 'customOrder.recordDecision', customOrderId: order.customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'booking-fixture-decision' });
  if (!quote.ok || !decision.ok) throw new Error('the pickup fixture could not be built');
  return selectCustomOrders(port.read()).orders.find(row => row.customOrderId === order.customOrderId)!;
}

/** The 13:49 booking is in the sample as completed; set back to confirmed it is a confirmed booking whose time has passed (15:45). */
export function pastConfirmedBooking() {
  const rows = createWidgetDataStore().getSnapshot().tables.reservation;
  const past = rows.find((r): r is Reservation => r.kind !== 'pickup' && r.status === 'completed')!;
  const store = createWidgetDataStore({ reservation: rows.map(r => r === past ? { ...past, status: 'confirmed' as const } : r) });
  return { store, id: past.reservationId, row: selectReservations(store.getSnapshot(), { date: TODAY }).rows.find(r => r.reservationId === past.reservationId)! };
}
