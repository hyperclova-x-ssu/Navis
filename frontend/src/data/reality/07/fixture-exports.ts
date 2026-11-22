import type { WidgetDataStore } from '../../db/store';
import { addDays } from '../../db/time';
import { PortError } from '../00';
import { worksWindow, type CalendarPushReceipt, type ExportCard, type WorksListItem, type WorksPushReceipt, type WorksTime } from './naver';

function createFixtureExports(store: WidgetDataStore) {
  const calendar = new Map<string, CalendarPushReceipt>();
  const works = new Map<string, WorksListItem>();
  const readCalendar = (id: string) => calendar.get(id) ?? null;
  const listWorks = (start: string) => {
    const [, end] = worksWindow(start);
    return [...works.values()].filter(item => {
      const date = 'date' in item.start ? item.start.date : item.start.dateTime.slice(0, 10);
      return date >= start && date < end.slice(0, 10);
    });
  };
  function submit(card: ExportCard): CalendarPushReceipt | WorksPushReceipt {
    const { resourceId, operation, expectedRevision } = card;
    const tables = store.getSnapshot().tables;
    const receipt = { resourceId, receiptId: card.attemptKey, revision: expectedRevision, sentAt: new Date().toISOString() };
    if (operation === 'calendar.add') {
      const event = tables.calendarEvent.find(row => row.eventId === resourceId && row.kind === 'event');
      if (!event || (event.revision ?? 0) !== expectedRevision) throw stale();
      const result: CalendarPushReceipt = { ...receipt, eventId: resourceId, processType: calendar.has(resourceId) ? 'modify' : 'create', affectedSources: ['calendar'] };
      calendar.set(resourceId, result);
      return result;
    }
    const shift = tables.staffSchedule.find(row => row.scheduleId === resourceId);
    const staff = tables.staff.find(row => row.staffId === shift?.staffId);
    if (!shift || (shift.revision ?? 0) !== expectedRevision ||
        (operation !== 'works.delete' && (!staff || (staff.revision ?? 0) !== card.expectedStaffRevision))) throw stale();
    const eventId = `example-works-${resourceId}`;
    const kind = operation === 'works.create' ? 'create' : operation === 'works.update' ? 'update' : 'delete';
    const stamp = (time: string): WorksTime => ({ dateTime: `${shift.date}T${time}:00`, timeZone: 'Asia/Seoul' });
    if (kind === 'delete') works.delete(resourceId);
    else works.set(resourceId, {
      scheduleId: resourceId, eventId, summary: `${staff?.name ?? ''} ${shift.kind === 'off' ? '휴무' : '근무'}`,
      start: shift.start ? stamp(shift.start) : { date: shift.date }, end: shift.end ? stamp(shift.end) : { date: addDays(shift.date, 1) },
      sentAt: receipt.sentAt, revision: receipt.revision,
    });
    return { ...receipt, scheduleId: resourceId, eventId, operation: kind, affectedSources: ['staff-schedule'] };
  }
  return { readCalendar, listWorks, submit };
}

const stale = () => new PortError(409, 'CONFLICT', 'STALE_REVISION');
const fixtures = new WeakMap<WidgetDataStore, ReturnType<typeof createFixtureExports>>();

/** Store-local examples use the same confirmation cards and hold only their own simulated receipts. */
export function fixtureExports(store: WidgetDataStore) {
  const existing = fixtures.get(store);
  if (existing) return existing;
  const created = createFixtureExports(store);
  fixtures.set(store, created);
  return created;
}
