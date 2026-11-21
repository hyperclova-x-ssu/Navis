/**
 * GD-1: the guards of the management and legacy handlers (NAVIS_AGENT_GAP_PLAN "Direct app defects").
 * Each guard has a refusal and the allowed neighbour. Tests read the store state (names, phones, dates)
 * instead of fixing seed amounts, because the seed is replaced later (N-4).
 */
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, selectMembers, selectReservations, selectWidget, widgetFacts, readModel, TODAY, type DataCommandResult, type DataSnapshot } from '../widget-data';
import { addDays } from '../db/time';
import type { Reservation } from '../db/types';
import { selectCalendar, selectNextTaxPayment as nextTaxFromOperations } from '../derive/operations';
import { BUSINESS_TIME } from '../derive/reservations';
import { dataBundle } from '../messages';
import { managementHandlers } from './management';
import { BUSINESS_CLOCK, compareTaxDue, digitsOf, hourIsBusinessHour, normalizeName, plainText, sameName, selectNextTaxPayment, slotHasPassed, slotIsLater, slotPhase } from './management-guards';

const fresh = () => createWidgetDataStore();
type Store = ReturnType<typeof fresh>;
function refusal(result: DataCommandResult, reason: string, code = 'CONFLICT') {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  expect(result).toMatchObject({ code, reason, messageKey: `data.management.error.${reason}` });
  return result;
}
function accepted(result: DataCommandResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result;
}
let n = 0;
const key = (prefix: string) => `${prefix}-${++n}`;
const phoneOf = (snapshot: DataSnapshot, memberId: string) => {
  const profile = snapshot.tables.memberProfile.find((p) => p.memberId === memberId)!;
  return snapshot.tables.marketing.mktCustomer.find((c) => c.customerId === profile.customerId)!.phone!;
};
const unusedPhone = (snapshot: DataSnapshot) => {
  const taken = new Set(snapshot.tables.marketing.mktCustomer.map((c) => digitsOf(c.phone ?? '')));
  for (let i = 0; i < 1000; i++) { const p = `0109${String(8000000 + i)}`; if (!taken.has(p)) return p; }
  throw new Error('no free number');
};
const tomorrow = addDays(TODAY, 1);
const book = (store: Store, over: Record<string, unknown> = {}) => store.dispatch({ type: 'booking.create', guest: { name: '테스트손님' }, date: tomorrow, time: '12:00', partySize: 2, tableChoice: 'auto', idempotencyKey: key('bk'), ...over } as never);
const memberIds = (store: Store) => selectMembers(store.getSnapshot(), {}).rows.map((r) => r.memberId);

describe('(1) member phone numbers are unique among live customers', () => {
  it('refuses a create with a number a live member already has, and points at the masked row', () => {
    const store = fresh();
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0001', phone: '01092000001' }));
    const before = store.getSnapshot();
    const result = refusal(store.dispatch({ type: 'members.create', name: '새손님', phone: digitsOf(phoneOf(before, 'M-0001')), idempotencyKey: key('mc') }), 'MEMBER_PHONE_EXISTS');
    expect(result).toMatchObject({ field: 'phone', details: { memberId: 'M-0001' } });
    expect(String((result as { details?: { phone?: string } }).details?.phone)).toMatch(/\*\*\*\*/);
    expect(String((result as { details?: { name?: string } }).details?.name)).toContain('○');
    expect(store.getSnapshot()).toBe(before);
  });
  it('creates with a number nobody has, and the same key replays the original receipt', () => {
    const store = fresh(), phone = unusedPhone(store.getSnapshot()), command = { type: 'members.create', name: '새손님', phone, idempotencyKey: key('mc') } as const;
    const first = accepted(store.dispatch(command));
    // the number is now taken, yet the same request key returns the first receipt instead of a refusal
    const again = accepted(store.dispatch(command));
    expect(again).toMatchObject({ duplicate: true, value: first.value });
    // a distinct key is a new request and is refused
    refusal(store.dispatch({ ...command, idempotencyKey: key('mc') }), 'MEMBER_PHONE_EXISTS');
  });
  it('edit: another member\'s number is refused; an unused number and the member\'s own number are fine', () => {
    const store = fresh();
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0001', phone: '01092000001' }));
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0002', phone: '01092000002' }));
    const snapshot = store.getSnapshot();
    refusal(store.dispatch({ type: 'members.update', memberId: 'M-0002', phone: digitsOf(phoneOf(snapshot, 'M-0001')) }), 'MEMBER_PHONE_EXISTS');
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0002', phone: digitsOf(phoneOf(snapshot, 'M-0002')) }));
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0002', phone: unusedPhone(snapshot) }));
  });
  it('an archived member does not hold the number any more', () => {
    const store = fresh(), phone = '01092000008';
    accepted(store.dispatch({ type: 'members.update', memberId: 'M-0008', phone }));
    accepted(store.dispatch({ type: 'members.delete', memberId: 'M-0008' }));
    expect(memberIds(store)).not.toContain('M-0008');
    accepted(store.dispatch({ type: 'members.create', name: '다시 온 손님', phone, idempotencyKey: key('mc') }));
  });
  it('blocks create and edit against a live number stored in international format', () => {
    const snapshot = fresh().getSnapshot();
    const profile = snapshot.tables.memberProfile.find(row => row.memberId === 'M-0001')!;
    const tables = { ...snapshot.tables, marketing: { ...snapshot.tables.marketing,
      mktCustomer: snapshot.tables.marketing.mktCustomer.map(row => row.customerId === profile.customerId
        ? { ...row, phone: '+82 (10) 9200-0001' } : row),
    } };
    const context = { snapshot: { ...snapshot, tables }, tables, nextId: () => 'new-fixture-id' };
    const create = managementHandlers['members.create'](context,
      { type: 'members.create', name: '새손님', phone: '01092000001', idempotencyKey: key('mc') });
    const update = managementHandlers['members.update'](context,
      { type: 'members.update', memberId: 'M-0002', phone: '01092000001' });
    for (const result of [create, update]) {
      expect(result).toMatchObject({ ok: false, reason: 'MEMBER_PHONE_EXISTS',
        details: { memberId: 'M-0001', phone: '010-****-0001' },
      });
    }
    expect(managementHandlers['members.update'](context,
      { type: 'members.update', memberId: 'M-0001', phone: '01092000001' })).toMatchObject({ ok: true });
  });
});

describe('(2) tax payments: one obligation once, and one "next due"', () => {
  const unpaidRow = (store: Store) => store.getSnapshot().tables.taxPayment.find((p) => p.status === 'unpaid')!;
  it('refuses the same type (spacing and punctuation ignored), amount and due date; shows the existing row', () => {
    const store = fresh(), row = unpaidRow(store), spaced = plainText(row.type).replace('(', ' ').replace(')', ' ');
    const result = refusal(store.dispatch({ type: 'tax.createPayment', taxType: spaced, amount: row.amount, dueOn: row.dueOn, idempotencyKey: key('tp') }), 'TAX_PAYMENT_EXISTS');
    expect(result).toMatchObject({ field: 'taxType', details: { taxPaymentId: row.taxPaymentId, amount: row.amount, dueOn: row.dueOn } });
  });
  it('a different amount or date is a distinct entry, an overdue date is allowed, and an insisted duplicate is recorded', () => {
    const store = fresh(), row = unpaidRow(store), type = plainText(row.type);
    accepted(store.dispatch({ type: 'tax.createPayment', taxType: type, amount: row.amount + 1, dueOn: row.dueOn, idempotencyKey: key('tp') }));
    accepted(store.dispatch({ type: 'tax.createPayment', taxType: type, amount: row.amount, dueOn: addDays(TODAY, -40), idempotencyKey: key('tp') }));
    const before = store.getSnapshot().tables.taxPayment.length;
    accepted(store.dispatch({ type: 'tax.createPayment', taxType: type, amount: row.amount, dueOn: row.dueOn, idempotencyKey: key('tp'), confirmDuplicate: true }));
    expect(store.getSnapshot().tables.taxPayment.length).toBe(before + 1);
  });
  it('next due = earliest unpaid due date, whatever the table order; the panel selector, the briefing and the fact agree', () => {
    const store = fresh(), type = plainText(unpaidRow(store).type);
    const earlier = addDays(TODAY, -3);
    accepted(store.dispatch({ type: 'tax.createPayment', taxType: `${type} 추가분`, amount: 1_000, dueOn: earlier, idempotencyKey: key('tp') }));
    const snapshot = store.getSnapshot(), next = nextTaxFromOperations(readModelPayments(snapshot));
    expect(next?.dueOn).toBe(earlier);
    const view = selectWidget(snapshot, 'tax', { kind: 'default' }, 'normal');
    const fact = widgetFacts(view).find((f) => f.key === 'tax.payment.next');
    expect(fact).toMatchObject({ value: 1_000, unit: 'KRW', date: earlier });
  });
  it('ties on the due date are broken by amount, then id, regardless of order', () => {
    const rows = [
      { taxPaymentId: 'b', dueOn: '2026-11-10', amount: 500, status: 'unpaid' as const },
      { taxPaymentId: 'a', dueOn: '2026-11-10', amount: 500, status: 'unpaid' as const },
      { taxPaymentId: 'c', dueOn: '2026-11-10', amount: 100, status: 'unpaid' as const },
      { taxPaymentId: 'p', dueOn: '2026-10-01', amount: 1, status: 'paid' as const },
    ];
    expect(selectNextTaxPayment(rows)?.taxPaymentId).toBe('c');
    expect(selectNextTaxPayment([...rows].reverse())?.taxPaymentId).toBe('c');
    expect(selectNextTaxPayment(rows.filter((r) => r.taxPaymentId !== 'c'))?.taxPaymentId).toBe('a');
    expect([...rows].sort(compareTaxDue).map((r) => r.taxPaymentId)).toEqual(['p', 'c', 'a', 'b']);
    expect(selectNextTaxPayment(rows.filter((r) => r.status === 'paid'))).toBeNull();
  });
});
const readModelPayments = (snapshot: DataSnapshot) => { const view = selectWidget(snapshot, 'tax', { kind: 'default' }, 'normal'); if (view.status !== 'ready') throw new Error('tax view'); return view.model.payments; };

describe('(3) CCTV review marks only today\'s business hours', () => {
  const todayHour = (store: Store) => store.getSnapshot().tables.cctvHourly.find((r) => r.businessDate === TODAY && !r.reviewMarked)!.hour;
  it('refuses an older day (the row exists, nobody can see its mark) and an hour outside opening time', () => {
    const store = fresh(), old = store.getSnapshot().tables.cctvHourly.find((r) => r.businessDate !== TODAY)!;
    const result = refusal(store.dispatch({ type: 'cctv.markPeakForReview', date: old.businessDate, hour: old.hour }), 'CCTV_TODAY_ONLY', 'VALIDATION');
    expect(result).toMatchObject({ field: 'date' });
    refusal(store.dispatch({ type: 'cctv.markPeakForReview', date: TODAY, hour: 3 }), 'CCTV_TODAY_ONLY', 'VALIDATION');
    expect(store.getSnapshot().tables.cctvHourly.some((r) => r.reviewMarked)).toBe(false);
  });
  it('marks a visible hour of today, a second mark is a no-op conflict, and undo restores the row', () => {
    const store = fresh(), hour = todayHour(store);
    const marked = accepted(store.dispatch({ type: 'cctv.markPeakForReview', date: TODAY, hour }));
    expect(store.getSnapshot().tables.cctvHourly.find((r) => r.businessDate === TODAY && r.hour === hour)?.reviewMarked).toBe(true);
    expect(store.dispatch({ type: 'cctv.markPeakForReview', date: TODAY, hour })).toMatchObject({ ok: false, code: 'CONFLICT' });
    accepted(store.undo(marked.undoToken!));
    expect(store.getSnapshot().tables.cctvHourly.find((r) => r.businessDate === TODAY && r.hour === hour)?.reviewMarked).toBe(false);
  });
  it('business hours come from the one store-hours table', () => {
    expect(hourIsBusinessHour(TODAY, 10)).toBe(true);
    expect(hourIsBusinessHour(TODAY, 3)).toBe(false);
    expect(hourIsBusinessHour(TODAY, 23)).toBe(false);
  });
});

describe('(4) bookings: no past slot, no look-alike, request and key cleared together', () => {
  it('refuses a slot before the business clock (a past day and an earlier time today); the boundary itself is allowed', () => {
    const store = fresh();
    expect(refusal(book(store, { date: addDays(TODAY, -1), time: '19:00' }), 'BOOKING_PAST', 'VALIDATION')).toMatchObject({ field: 'date' });
    expect(refusal(book(store, { date: TODAY, time: '10:00' }), 'BOOKING_PAST', 'VALIDATION')).toMatchObject({ field: 'time' });
    accepted(book(store, { date: TODAY, time: BUSINESS_CLOCK.time, guest: { name: '지금손님' } }));
    accepted(book(store, { date: TODAY, time: '18:00', guest: { name: '저녁손님' } }));
  });
  it('asks before a second booking for the same person, slot and party; a different party or time is fine; the flag insists', () => {
    const store = fresh();
    const first = accepted(book(store, { guest: { name: '김서연' } }));
    const result = refusal(book(store, { guest: { name: ' 김 서연 ' } }), 'BOOKING_DUPLICATE');
    expect(result).toMatchObject({ details: { reservationId: (first.value as { reservationId: string }).reservationId } });
    accepted(book(store, { guest: { name: '김서연' }, partySize: 3 }));
    accepted(book(store, { guest: { name: '김서연' }, time: '13:00' }));
    accepted(book(store, { guest: { name: '김서연' }, confirmDuplicate: true }));
  });
  it('a typed name matches a masked guest name, and two different numbers are two people', () => {
    const store = fresh();
    const created = accepted(book(store, { guest: { name: '김서연' } }));
    const { reservationId } = created.value as { reservationId: string };
    expect(selectReservations(store.getSnapshot(), { date: tomorrow }).rows.find(row => row.reservationId === reservationId)?.name).toEqual({ raw: '김○연' });
    refusal(book(store, { guest: { name: '김하연' } }), 'BOOKING_DUPLICATE');
    const first = accepted(book(store, { guest: { name: '이도윤', phone: '01011112222' } }));
    expect(first.ok).toBe(true);
    accepted(book(store, { guest: { name: '이도윤', phone: '01033334444' } }));
  });
  it('the same key returns the first receipt, never a second booking or a refusal', () => {
    const store = fresh(), command = { type: 'booking.create', guest: { name: '재시도손님' }, date: tomorrow, time: '09:00', partySize: 2, tableChoice: 'auto', idempotencyKey: key('bk') } as const;
    const first = accepted(store.dispatch(command));
    expect(accepted(store.dispatch(command))).toMatchObject({ duplicate: true, value: first.value });
  });
  it('editing a past row keeps working when the slot stays; moving it to a past slot is refused', () => {
    const seed = fresh().getSnapshot().tables.reservation;
    const past = { ...seed.find(row => row.kind === 'visit' && row.status === 'completed')!, status: 'confirmed' as const };
    const store = createWidgetDataStore({ reservation: seed.map(row => row.reservationId === past.reservationId ? past : row) });
    accepted(store.dispatch({ type: 'booking.update', reservationId: past.reservationId, patch: { request: '창가 자리' } }));
    refusal(store.dispatch({ type: 'booking.update', reservationId: past.reservationId, patch: { date: addDays(TODAY, -2) } }), 'BOOKING_PAST', 'VALIDATION');
    const future = accepted(book(store, { guest: { name: '옮길손님' } }));
    accepted(store.dispatch({ type: 'booking.update', reservationId: (future.value as { reservationId: string }).reservationId, patch: { time: '15:00' } }));
  });
  it('clearing the request clears the seeded request key too; rewriting it replaces both', () => {
    const store = fresh(), seeded = store.getSnapshot().tables.reservation.find((r): r is Reservation => r.kind !== 'pickup' && !!r.requestKey && r.status === 'confirmed')!;
    const rowOf = () => selectReservations(store.getSnapshot(), { date: seeded.date }).rows.find((r) => r.reservationId === seeded.reservationId)!;
    expect(rowOf().requestKey).toBeTruthy();
    accepted(store.dispatch({ type: 'booking.update', reservationId: seeded.reservationId, patch: { request: '' } }));
    expect(rowOf()).toMatchObject({ requestKey: null, request: null });
    accepted(store.dispatch({ type: 'booking.update', reservationId: seeded.reservationId, patch: { request: '유모차 자리' } }));
    expect(rowOf()).toMatchObject({ requestKey: null, request: { raw: '유모차 자리' } });
    // a booking edit that does not mention the request keeps what was there
    accepted(store.dispatch({ type: 'booking.update', reservationId: seeded.reservationId, patch: { partySize: seeded.partySize + 1 } }));
    expect(rowOf().request).toEqual({ raw: '유모차 자리' });
  });
  it('the allocation warning is part of the saved row, so the form can show it before confirm', () => {
    const store = fresh();
    const over = accepted(book(store, { guest: { name: '단체손님' }, partySize: 40 }));
    const row = selectReservations(store.getSnapshot(), { date: tomorrow }).rows.find((r) => r.reservationId === (over.value as { reservationId: string }).reservationId)!;
    expect(row).toMatchObject({ status: 'needs-check', allocationWarning: 'SEAT_LIMIT' });
  });
});

describe('(5) one business clock (15:45) and one boundary', () => {
  it('the reservation clock is the POS scenario clock', () => {
    expect(BUSINESS_TIME).toBe('15:45');
    expect(BUSINESS_CLOCK).toEqual({ date: TODAY, time: '15:45' });
  });
  it('a slot at exactly 15:45 is "now": not past, not later; 15:44 is past; 15:46 is later', () => {
    expect([slotPhase(TODAY, '15:44'), slotPhase(TODAY, '15:45'), slotPhase(TODAY, '15:46')]).toEqual(['past', 'now', 'future']);
    expect([slotHasPassed(TODAY, '15:45'), slotIsLater(TODAY, '15:45')]).toEqual([false, false]);
    expect([slotPhase(addDays(TODAY, -1), '23:59'), slotPhase(tomorrow, '00:00')]).toEqual(['past', 'future']);
  });
  it('completion and no-show use the same boundary: 15:45 is not yet time', () => {
    const store = fresh();
    const now = accepted(book(store, { date: TODAY, time: '15:45', guest: { name: '지금손님' } }));
    expect(store.dispatch({ type: 'booking.markCompleted', reservationId: (now.value as { reservationId: string }).reservationId })).toMatchObject({ ok: false, reason: 'NOT_YET_TIME' });
    const row = selectReservations(store.getSnapshot(), { date: TODAY }).rows.find((r) => r.reservationId === (now.value as { reservationId: string }).reservationId)!;
    expect([row.canMarkCompleted, row.canMarkNoShow]).toEqual([false, false]);
  });
  it('the calendar\'s "upcoming" keeps an entry at 15:45 and drops one at 15:44', () => {
    const store = fresh();
    accepted(store.dispatch({ type: 'calendar.addEvent', title: '직전 일정', date: TODAY, time: '15:44', dateIntent: 'historical' }));
    accepted(store.dispatch({ type: 'calendar.addEvent', title: '정각 일정', date: TODAY, time: '15:45' }));
    const upcoming = selectCalendar(store.getSnapshot(), { date: TODAY }).upcoming.map((e) => plainText(e.title));
    expect(upcoming).toContain('정각 일정');
    expect(upcoming).not.toContain('직전 일정');
  });
});

describe('(6) menu, stock, supplier, order and expense inputs', () => {
  const menuName = (store: Store) => plainText(store.getSnapshot().tables.menuItem.find((m) => m.kind === 'menu' && !m.deletedAt)!.name, store.getSnapshot().tables.menuItem.find((m) => m.kind === 'menu' && !m.deletedAt)!.nameKey);
  it('a menu name is unique after normalization: create and rename are refused; a new name and the own name are fine', () => {
    const store = fresh(), name = menuName(store);
    expect(refusal(store.dispatch({ type: 'menu.create', name: ` ${name.split('').join(' ')} `, category: 'drink', price: 4000, idempotencyKey: key('m') }), 'NAME_EXISTS')).toMatchObject({ field: 'name' });
    const other = store.getSnapshot().tables.menuItem.filter((m) => m.kind === 'menu' && !m.deletedAt)[1];
    refusal(store.dispatch({ type: 'menu.update', menuId: other.menuId, patch: { name } }), 'NAME_EXISTS');
    accepted(store.dispatch({ type: 'menu.update', menuId: other.menuId, patch: { name: plainText(other.name, other.nameKey).toUpperCase() } }));
    accepted(store.dispatch({ type: 'menu.create', name: '새 시그니처', category: 'drink', price: 4000, idempotencyKey: key('m') }));
  });
  it('an ingredient name is unique; number and unit errors say which field', () => {
    const store = fresh(), items = store.getSnapshot().tables.inventoryItem.filter((i) => i.kind === 'ingredient' && !i.deletedAt);
    const name = plainText(items[0].name, items[0].nameKey);
    refusal(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name, unit: 'L', stock: 3, threshold: 1, idempotencyKey: key('it') }), 'NAME_EXISTS');
    expect(refusal(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name: '귀리우유', unit: 'L', stock: -1, threshold: 1, idempotencyKey: key('it') }), 'NUMBER_INVALID', 'VALIDATION')).toMatchObject({ field: 'stock' });
    expect(refusal(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name: '귀리우유', unit: 'pcs', stock: 1, threshold: 0.5, idempotencyKey: key('it') }), 'UNIT_PRECISION', 'VALIDATION')).toMatchObject({ field: 'threshold' });
    refusal(store.dispatch({ type: 'inventory.updateItem', itemId: items[1].itemId, name }), 'NAME_EXISTS');
    expect(refusal(store.dispatch({ type: 'inventory.updateItem', itemId: items[1].itemId, stock: -2 }), 'NUMBER_INVALID', 'VALIDATION')).toMatchObject({ field: 'stock' });
    accepted(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name: '귀리우유', unit: 'L', stock: 3, threshold: 1, idempotencyKey: key('it') }));
  });
  it('a supplier name is unique on create and rename', () => {
    const store = fresh(), suppliers = store.getSnapshot().tables.supplier.filter((s) => !s.deletedAt), name = plainText(suppliers[0].name, suppliers[0].nameKey);
    refusal(store.dispatch({ type: 'suppliers.createSupplier', name, contact: '박사장', phone: '01011112222', idempotencyKey: key('sup') }), 'NAME_EXISTS');
    refusal(store.dispatch({ type: 'suppliers.updateSupplier', supplierId: suppliers[1].supplierId, patch: { name } }), 'NAME_EXISTS');
    accepted(store.dispatch({ type: 'suppliers.createSupplier', name: '새 거래처', contact: '박사장', phone: '01011112222', idempotencyKey: key('sup') }));
  });
  const purchaseOf = (store: Store) => store.getSnapshot().tables.purchaseItem.find((p) => store.getSnapshot().tables.inventoryItem.some((i) => i.itemId === p.itemId && !i.deletedAt))!;
  it('an order due date must be on or after the business date; today is fine; changing a due date follows the same rule', () => {
    const store = fresh(), p = purchaseOf(store);
    expect(refusal(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: p.purchaseItemId, qty: p.minimumQty, dueDate: addDays(TODAY, -1), idempotencyKey: key('po') }), 'DUE_DATE_PAST', 'VALIDATION')).toMatchObject({ field: 'dueDate' });
    const order = accepted(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: p.purchaseItemId, qty: p.minimumQty, dueDate: TODAY, idempotencyKey: key('po') }));
    const poId = (order.value as { poId: string }).poId;
    expect(refusal(store.dispatch({ type: 'suppliers.changeDueDate', poId, date: addDays(TODAY, -1) }), 'DUE_DATE_PAST', 'VALIDATION')).toMatchObject({ field: 'date' });
    accepted(store.dispatch({ type: 'suppliers.changeDueDate', poId, date: addDays(TODAY, 2) }));
  });
  it('minimum and step errors are separate, with the limit in the details', () => {
    const store = fresh(), p = purchaseOf(store);
    expect(refusal(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: p.purchaseItemId, qty: p.minimumQty / 2, idempotencyKey: key('po') }), 'ORDER_QTY_MIN', 'VALIDATION')).toMatchObject({ details: { minimum: p.minimumQty } });
    expect(refusal(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: p.purchaseItemId, qty: p.minimumQty + p.orderStep / 2, idempotencyKey: key('po') }), 'ORDER_QTY_STEP', 'VALIDATION')).toMatchObject({ details: { step: p.orderStep } });
  });
  it('asks before an order that looks like one already open; the flag insists', () => {
    const store = fresh(), p = purchaseOf(store), order = { type: 'suppliers.createOrder', purchaseItemId: p.purchaseItemId, qty: p.minimumQty, dueDate: addDays(TODAY, 3) } as const;
    accepted(store.dispatch({ ...order, idempotencyKey: key('po') }));
    refusal(store.dispatch({ ...order, idempotencyKey: key('po') }), 'LIKELY_DUPLICATE_ORDER');
    accepted(store.dispatch({ ...order, dueDate: addDays(TODAY, 4), idempotencyKey: key('po') }));
    accepted(store.dispatch({ ...order, idempotencyKey: key('po'), confirmDuplicate: true }));
  });
  it('a purchase price of 0 is allowed (free samples are a product choice); the wrong field is named', () => {
    const store = fresh(), supplier = store.getSnapshot().tables.supplier.find((s) => !s.deletedAt)!;
    const item = accepted(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name: '무료 샘플 원두', unit: 'kg', stock: 1, threshold: 0, idempotencyKey: key('it') }));
    const itemId = (item.value as { itemId: string }).itemId;
    expect(refusal(store.dispatch({ type: 'suppliers.createPurchaseItem', itemId, supplierId: supplier.supplierId, minimumQty: 1, orderStep: 0, unitPrice: 0, leadDays: 1, idempotencyKey: key('pi') }), 'PURCHASE_INVALID', 'VALIDATION')).toMatchObject({ field: 'orderStep' });
    accepted(store.dispatch({ type: 'suppliers.createPurchaseItem', itemId, supplierId: supplier.supplierId, minimumQty: 1, orderStep: 1, unitPrice: 0, leadDays: 1, idempotencyKey: key('pi') }));
  });
  it('expenses: a historical date stays allowed, a future date is not an expense, a look-alike asks first', () => {
    const store = fresh(), expense = { type: 'ledger.recordExpense', category: 'supplies', amount: 31_700 } as const;
    accepted(store.dispatch({ ...expense, date: addDays(TODAY, -20) }));
    expect(refusal(store.dispatch({ ...expense, date: addDays(TODAY, 1) }), 'EXPENSE_DATE_FUTURE', 'VALIDATION')).toMatchObject({ field: 'date' });
    accepted(store.dispatch({ ...expense, date: TODAY }));
    expect(refusal(store.dispatch({ ...expense, date: TODAY }), 'LIKELY_DUPLICATE_EXPENSE')).toMatchObject({ field: 'amount' });
    accepted(store.dispatch({ ...expense, date: TODAY, memo: '다른 영수증' }));
    accepted(store.dispatch({ ...expense, date: TODAY, confirmDuplicate: true }));
  });
  it('a second monthly rent in the same month asks first, a different month does not', () => {
    const store = fresh();
    const rent = { type: 'ledger.recordExpense', category: 'rent', amount: 630_000 } as const;
    accepted(store.dispatch({ ...rent, date: addDays(TODAY, -1) }));
    refusal(store.dispatch({ ...rent, date: TODAY }), 'LIKELY_DUPLICATE_EXPENSE');
    const rentMonths = new Set(store.getSnapshot().tables.expense.filter((e) => e.category === 'rent').map((e) => e.businessDate.slice(0, 7)));
    const freeDay = Array.from({ length: 36 }, (_, i) => addDays(TODAY, -30 * (i + 1))).find((d) => !rentMonths.has(d.slice(0, 7)))!;
    accepted(store.dispatch({ ...rent, date: freeDay }));
  });
});

describe('(7) manuals: duplicate title asks, checklist only on checklist manuals', () => {
  const manualBy = (store: Store, test: (m: DataSnapshot['tables']['manual'][number]) => boolean) => store.getSnapshot().tables.manual.find(test)!;
  const create = (title: string, extra: Record<string, unknown> = {}) => ({ type: 'manuals.create', section: 'handover', title, category: 'cleaning', steps: ['첫 단계'], idempotencyKey: key('mn'), ...extra }) as never;
  it('asks before a second manual with the same title; another title is fine; the flag insists', () => {
    const store = fresh(), existing = plainText(store.getSnapshot().tables.manual[0].title);
    expect(refusal(store.dispatch(create(` ${existing} `)), 'MANUAL_TITLE_EXISTS')).toMatchObject({ field: 'title', details: { manualId: store.getSnapshot().tables.manual[0].manualId } });
    accepted(store.dispatch(create('완전히 새로운 매뉴얼')));
    accepted(store.dispatch(create(existing, { confirmDuplicate: true })));
  });
  it('a step can be checked only on an opening/closing handover manual', () => {
    const store = fresh();
    const training = manualBy(store, (m) => m.category === 'new-staff' && m.section === 'handover'), info = manualBy(store, (m) => m.section === 'store-info'), opening = manualBy(store, (m) => m.category === 'opening' && m.section !== 'store-info');
    expect(refusal(store.dispatch({ type: 'manuals.toggleStep', manualId: training.manualId, stepNo: 1 }), 'NOT_CHECKLIST')).toMatchObject({ field: 'manualId' });
    refusal(store.dispatch({ type: 'manuals.toggleStep', manualId: info.manualId, stepNo: 1 }), 'NOT_CHECKLIST');
    expect(store.getSnapshot().tables.checklistLog.some((l) => l.manualId === training.manualId)).toBe(false);
    accepted(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1 }));
  });
  it('the requested state is kept: "checked" twice stays checked, "unchecked" on an unchecked step changes nothing', () => {
    const store = fresh(), opening = manualBy(store, (m) => m.category === 'opening' && m.section !== 'store-info');
    const logged = () => store.getSnapshot().tables.checklistLog.filter((l) => l.manualId === opening.manualId && l.stepNo === 1 && l.date === TODAY).length;
    const before = logged();
    accepted(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1, checked: false }));
    accepted(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1, checked: true }));
    accepted(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1, checked: true }));
    expect(logged()).toBe(1);
    expect(before === 0 || before === 1).toBe(true);
    accepted(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo: 1, checked: false }));
    expect(logged()).toBe(0);
  });
  // N14 manual lifecycle and grant commands.
  it('creates a private draft with the owner memo and publishes only the saved edits', () => {
    const store = fresh();
    const before = store.getSnapshot();
    const memo = '공급받은 원두는 입고 날짜를 적어요';
    const creation = accepted(store.dispatch({ type: 'manuals.createDraftFromMemo', memo }));
    const { draftId } = creation.value as { draftId: string };
    const drafted = store.getSnapshot();
    expect(drafted.tables.manual).toEqual(before.tables.manual);
    expect(drafted.tables.manualDraft.find(d => d.draftId === draftId)).toMatchObject({
      status: 'draft', steps: [{ raw: memo }],
    });
    const publication = accepted(store.dispatch({ type: 'manuals.saveDraft', draftId, title: '원두 입고', steps: ['라벨에 입고 날짜를 적어요'] }));
    const { manualId } = publication.value as { manualId: string };
    expect(store.getSnapshot().tables.manual.find(m => m.manualId === manualId)).toMatchObject({ title: { raw: '원두 입고' }, isPublished: true });
    expect(store.getSnapshot().tables.manualStep.find(s => s.manualId === manualId)?.body).toEqual({ raw: '라벨에 입고 날짜를 적어요' });
    expect(store.dispatch({ type: 'manuals.saveDraft', draftId })).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('discards only an active draft without publishing a manual', () => {
    const store = fresh();
    const before = store.getSnapshot();
    const creation = accepted(store.dispatch({ type: 'manuals.createDraftFromMemo', memo: '당일 입고 수량을 기록해요' }));
    const { draftId } = creation.value as { draftId: string };
    accepted(store.dispatch({ type: 'manuals.discardDraft', draftId }));
    expect(store.getSnapshot().tables.manualDraft).toEqual(before.tables.manualDraft);
    expect(store.getSnapshot().tables.manual).toEqual(before.tables.manual);
    expect(store.dispatch({ type: 'manuals.saveDraft', draftId })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
  it('keeps an equivalent grant result memo and status at the same revision', () => {
    const store = fresh();
    const noticeId = store.getSnapshot().tables.grantNotice[0].noticeId;
    const record = accepted(store.dispatch({ type: 'grants.apply', noticeId, idempotencyKey: key('grant') }));
    const { applicationId } = record.value as { applicationId: string };
    const before = store.getSnapshot();
    const result = accepted(store.dispatch({ type: 'grants.updateApplication', applicationId, status: 'applied', resultMemo: '  ' }));
    expect(result.revision).toBe(before.revision);
    expect(store.getSnapshot()).toBe(before);
  });
  // End N14.
});

describe('(8) Navis facts follow the record and the business date', () => {
  const facts = (store: Store, id: 'inventory-booking' | 'voice-booking' | 'ledger') => { const view = selectWidget(store.getSnapshot(), id, { kind: 'default' }, 'normal'); return { view, list: widgetFacts(view) }; };
  it('stock, threshold and use carry the resolved name of a created and of a renamed ingredient', () => {
    const store = fresh();
    accepted(store.dispatch({ type: 'inventory.createItem', sku: key('SKU'), name: '귀리우유', unit: 'L', stock: 4, threshold: 2, idempotencyKey: key('it') }));
    const renamed = store.getSnapshot().tables.inventoryItem.filter((i) => i.kind === 'ingredient' && !i.deletedAt)[1];
    accepted(store.dispatch({ type: 'inventory.updateItem', itemId: renamed.itemId, name: '이름 바꾼 재료' }));
    const { list } = facts(store, 'inventory-booking');
    for (const name of ['귀리우유', '이름 바꾼 재료']) for (const key of ['inventory.stock', 'inventory.threshold', 'inventory.usedToday']) {
      expect(list.find((f) => f.key === key && f.labelText && 'raw' in f.labelText && f.labelText.raw === name), `${key} ${name}`).toBeTruthy();
    }
  });
  it('tomorrow\'s pickup date is the business date + 1, for any business date', () => {
    const store = fresh(), { view } = facts(store, 'voice-booking');
    if (view.status !== 'ready') throw new Error('voice-booking view');
    const at = (date: string) => widgetFacts({ ...view, model: { ...view.model, date } } as typeof view);
    expect(at(TODAY).find((f) => f.key === 'pickup.tomorrow.count')?.date).toBe(addDays(TODAY, 1));
    expect(at('2026-12-31').find((f) => f.key === 'pickup.tomorrow.count')?.date).toBe('2027-01-01');
    expect(at('2026-12-31').find((f) => f.key === 'pickup.today.count')?.date).toBe('2026-12-31');
  });
  it('the ledger remainder keeps the 순이익 label', () => {
    expect(dataBundle.ko['data.fact.ledger.remaining']).toBe('순이익');
  });
});

describe('name helpers', () => {
  it('normalizes width, spacing, punctuation and case; masks match by their visible letters', () => {
    expect(normalizeName(' Ｃａｆｅ  Latte ')).toBe('cafelatte');
    expect(normalizeName('원천세(10월분)')).toBe(normalizeName('원천세 10월분'));
    expect(sameName('윤○○', '윤서연')).toBe(true);
    expect(sameName('윤○○', '김서연')).toBe(false);
    expect(sameName('', '')).toBe(false);
    expect(readModel).toBeTypeOf('function');
  });
});
