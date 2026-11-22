import { describe, expect, it } from 'vitest';
import { selectCalendar } from '../../derive/operations';
import { selectStaffSchedule } from '../../iteration7/staff/selectors';
import { createWidgetDataStore, readModel } from '../../widget-data';
import { calendarStaffDomain } from '../../../features/assistant/domains/calendar-staff';
import { createRealPort } from '../00';
import { fakeBackend, reply } from '../00/testing';
import { staffCalendarAdapter } from './adapter';

const day = '2026-11-17';
const asOf = `${day}T00:00:00Z`;
const page = <T>(items: readonly T[], sourceRevision = 1, nextCursor: string | null = null) => ({ items, asOf, nextCursor, sourceRevision });
const receipt = (resourceId: string, revision: number) => ({
  resourceId, revision, receiptId: `receipt-${resourceId}-${revision}`, undoUntil: new Date(Date.now() + 60_000).toISOString(),
  affectedSources: ['staff-schedule', 'calendar', 'briefing', 'notice-send'],
});
const shift = { scheduleId: 'shift-1', staffId: 'person-1', date: day, kind: 'work', start: '09:00', end: '15:00', breakMinutes: 30, revision: 8 };
const event = { eventId: 'event-1', date: day, kind: 'event', title: '문 닫는 날', time: null, memo: '안내 준비', categoryId: 'store-operations', storeClosure: { kind: 'temporary', endDate: day }, revision: 3 };
const preferences = {
  sourceVisibility: { reservation: true, pickup: true, shift: true, delivery: true, deadline: true, direct: true },
  categoryVisibility: { 'store-operations': true, 'tax-admin': true, purchasing: true },
  revision: 0,
};
function setup() {
  const backend = fakeBackend();
  backend.on('GET', '/staff', () => page([{ staffId: 'person-1', name: '직원 한 명', archivedAt: null, revision: 4 }]));
  backend.on('GET', '/shifts', () => page([shift], 11));
  backend.on('GET', '/shifts/history', () => page([]));
  backend.on('GET', '/calendar/events', () => page([event]));
  backend.on('GET', '/calendar/preferences', () => preferences);
  backend.on('GET', '/calendar/projections', call => call.query.cursor
    ? page([{ source: 'custom-pickup', sourceId: 'pickup-7', sourceRevision: 2, featureId: 'custom-order', categoryId: 'store-operations', visibility: 'pickup', date: day, endDate: day, time: '13:00', title: '주문 픽업' }])
    : page([{ source: 'purchase-order', sourceId: 'po-5', sourceRevision: 5, featureId: 'suppliers', categoryId: 'purchasing', visibility: 'delivery', date: day, endDate: day, time: '10:00', title: '거래처 입고' }], 1, 'next'));
  const open = () => {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [staffCalendarAdapter] });
    store.bindReal(port);
    return { store, port };
  };
  return { ...open(), open, backend };
}

describe('staff and calendar HTTP port', () => {
  it('reads roster, shifts, closures and all pages of read-only projections through the existing selectors', async () => {
    const { store, port, backend } = setup();
    expect(await port.load('staff')).toMatchObject({ status: 'ready', complete: true });
    const snapshot = store.getSnapshot();
    expect(selectStaffSchedule(snapshot, { startDate: day, endDate: day }).rows).toEqual([shift]);
    const calendar = selectCalendar(snapshot, { date: day });
    expect(calendar.todayEntries).toEqual([
      expect.objectContaining({ sourceId: 'po-5', editable: false, title: { raw: '거래처 입고' }, ref: expect.objectContaining({ featureId: 'suppliers', itemId: 'po-5' }) }),
      expect.objectContaining({ sourceId: 'event-1', editable: true, memo: { raw: '안내 준비' } }),
    ]);
    expect(calendar.pickupEntries).toEqual([expect.objectContaining({ sourceId: 'pickup-7', editable: false, ref: expect.objectContaining({ featureId: 'custom-order', itemId: 'pickup-7' }) })]);
    expect(calendar.staffEntries).toEqual([expect.objectContaining({ sourceId: 'shift-1', editable: false })]);
    expect(backend.callsTo('GET', '/calendar/projections')).toHaveLength(2);
  });

  it('writes a shift once, edits with its revision and re-reads both widgets in a new session', async () => {
    const { store, port, open, backend } = setup();
    let rows = [shift];
    backend.on('GET', '/shifts', () => page(rows, 11));
    backend.on('POST', '/shifts', call => {
      expect(call.body).toEqual({ staffId: 'person-1', date: day, kind: 'work', start: '17:00', end: '19:00', breakMinutes: 0 });
      expect(call.headers.get('idempotency-key')).toBe('create-shift');
      rows = [...rows, { ...shift, scheduleId: 'shift-2', start: '17:00', end: '19:00', breakMinutes: 0, revision: 1 }];
      return receipt('shift-2', 1);
    });
    backend.on('PATCH', '/shifts/shift-2', call => {
      expect(call.body).toMatchObject({ end: '20:00', expectedRevision: 1 });
      rows = rows.map(row => row.scheduleId === 'shift-2' ? { ...row, end: '20:00', revision: 2 } : row);
      return receipt('shift-2', 2);
    });
    await port.load('staff');
    const create = { type: 'staff.saveSchedule', staffId: 'person-1', date: day, kind: 'work', start: '17:00', end: '19:00', breakMinutes: 0, idempotencyKey: 'create-shift' } as const;
    expect((await Promise.all([store.execute(create), store.execute(create)])).every(result => result.ok)).toBe(true);
    expect(backend.callsTo('POST', '/shifts')).toHaveLength(1);
    expect(await store.execute({ ...create, scheduleId: 'shift-2', end: '20:00', idempotencyKey: undefined })).toMatchObject({ ok: true });
    const reopened = open();
    await reopened.port.load('staff');
    expect(reopened.store.getSnapshot().tables.staffSchedule.find(row => row.scheduleId === 'shift-2')).toMatchObject({ end: '20:00', revision: 2 });
    expect(selectCalendar(reopened.store.getSnapshot(), { date: day }).staffEntries.some(row => row.sourceId === 'shift-2')).toBe(true);
  });

  it('uses the server clock for live panels and Navis even with no calendar connection', async () => {
    const { store, port, backend } = setup();
    const date = '2026-11-22';
    store.hydrate({ integration: { calendar: false, phone: false, pos: false, channels: false } });
    backend.on('GET', '/shifts', () => ({ ...page([{ ...shift, date }]), asOf: '2026-11-21T15:30:00Z' }));
    backend.on('GET', '/calendar/events', () => page([{ ...event, date, storeClosure: null }]));
    await port.load('staff');
    const snapshot = store.getSnapshot();
    expect(readModel(snapshot, 'calendar').today).toBe(date);
    expect(readModel(snapshot, 'staff-schedule').period).toEqual({ start: date, end: date });
    expect(selectStaffSchedule(snapshot, { startDate: date, endDate: date }).today.workingCount).toBe(1);
    expect(calendarStaffDomain.projectWidget?.(snapshot, 'calendar', { kind: 'default' }, 'ko')).toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ key: 'calendar.entries.count', value: 2, date })]),
    });
  });

  it('keeps the calendar event, preference revision and undo on the same command path', async () => {
    const { store, port, backend } = setup();
    let events = [event];
    backend.on('GET', '/calendar/events', () => page(events));
    backend.on('POST', '/calendar/events', call => {
      expect(call.body).toMatchObject({ kind: 'event', title: '추가 휴무', storeClosure: { kind: 'temporary', endDate: day } });
      events = [...events, { ...event, eventId: 'event-2', title: '추가 휴무', revision: 1 }];
      return receipt('event-2', 1);
    });
    backend.on('PATCH', '/calendar/events/event-2', call => {
      expect(call.body).toEqual({ memo: '안내 수정', expectedRevision: 1 });
      events = events.map(row => row.eventId === 'event-2' ? { ...row, memo: '안내 수정', revision: 2 } : row);
      return receipt('event-2', 2);
    });
    backend.on('POST', '/calendar/receipts/receipt-event-2-2/undo', () => {
      events = events.map(row => row.eventId === 'event-2' ? { ...row, memo: '안내 준비', revision: 3 } : row);
      return receipt('event-2', 3);
    });
    backend.on('PATCH', '/calendar/preferences', call => {
      expect(call.body).toEqual({ source: 'reservation', visible: false, expectedRevision: 0 });
      backend.on('GET', '/calendar/preferences', () => ({ ...preferences, sourceVisibility: { ...preferences.sourceVisibility, reservation: false }, revision: 1 }));
      return receipt('calendar-preferences', 1);
    });
    await port.load('staff');
    expect(await store.execute({ type: 'calendar.addEvent', title: '추가 휴무', date: day, storeClosure: { kind: 'temporary', endDate: day } })).toMatchObject({ ok: true, value: { resourceId: 'event-2' } });
    const result = await store.execute({ type: 'calendar.updateEvent', eventId: 'event-2', memo: '안내 수정' });
    expect(result).toMatchObject({ ok: true, undoToken: 'real-undo:receipt-event-2-2' });
    if (!result.ok || !result.undoToken) throw new Error('Expected an undoable receipt');
    expect(await port.undo(result.undoToken)).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.calendarEvent.find(row => row.eventId === 'event-2')?.memo).toEqual({ raw: '안내 준비' });
    expect(await store.execute({ type: 'calendar.setSourceVisible', source: 'reservation', visible: false })).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.calendarSettings.reservation).toBe(false);
  });

  it('requires a loaded resource revision and never retries a stale write silently', async () => {
    const { store, port, backend } = setup();
    await port.load('staff');
    backend.on('DELETE', '/staff/person-1', call => {
      expect(call.body).toEqual({ expectedRevision: 4, expectedScheduleRevision: 11, cascadeSchedules: true, confirmed: true });
      return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' });
    });
    expect(await store.execute({ type: 'staff.delete', staffId: 'person-1', cascadeSchedules: true, idempotencyKey: 'delete-staff' })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(backend.callsTo('DELETE', '/staff/person-1')).toHaveLength(1);
    expect(backend.callsTo('GET', '/staff')).toHaveLength(2);
    expect(await store.execute({ type: 'calendar.deleteEvent', eventId: 'pickup-7' })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(backend.callsTo('DELETE', '/calendar/events/pickup-7')).toHaveLength(0);
  });
});
