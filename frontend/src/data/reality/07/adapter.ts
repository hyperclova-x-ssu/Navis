import type { CalendarCategory } from '../../db/management-types';
import type { CalendarEvent, CalendarVisibility } from '../../db/types';
import type { CalendarProjection, Staff, StaffSchedule, StaffScheduleChange } from '../../iteration7/staff/types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter } from '../00';

type Versioned<T> = T & { readonly revision: number };
type EventDto = Versioned<Omit<CalendarEvent, 'title' | 'memo'> & { readonly title: string; readonly memo: string | null }>;
type PreferencesDto = Versioned<{
  readonly sourceVisibility: CalendarVisibility;
  readonly categoryVisibility: Readonly<Record<CalendarCategory, boolean>>;
}>;

const staff = '/staff';
const shifts = '/shifts';
const calendar = '/calendar';
const events = `${calendar}/events`;
const preferences = `${calendar}/preferences`;
const shiftCollectionKey = 'staff:shift-collection';
const preferenceKey = 'staff:calendar-preferences';
const personKey = (id: string) => `staff:person:${id}`;
const shiftKey = (id: string) => `staff:shift:${id}`;
const eventKey = (id: string) => `staff:event:${id}`;
const itemPath = (collection: string, id: string) => `${collection}/${encodeURIComponent(id)}`;
const staffNotice = (name: string) => `data.staff.notice.${name}`;

function expected(context: CommandContext, key: string): number {
  const revision = context.revision(key);
  if (revision === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return revision;
}

export const staffCalendarAdapter: DomainAdapter = {
  domain: 'staff',
  sources: ['staff', 'staff-schedule', 'calendar', 'purchase', 'suppliers', 'booking', 'voice-booking', 'custom', 'custom-order',
    'local', 'community', 'inbox', 'notice-send', 'tax', 'manuals', 'grants', 'pos.tax', 'pos.tax-payments'],
  tables: ['staff', 'staffSchedule', 'staffScheduleChange', 'calendarEvent', 'calendarProjection', 'calendarSettings',
    'categoryVisibility', 'staffCalendarAsOf', 'staffShiftRevision'],
  errorKeys: {
    CALENDAR_PAST_DATE: 'data.calendar.error.CALENDAR_PAST_DATE',
    CALENDAR_DUPLICATE: 'data.calendar.error.CALENDAR_DUPLICATE',
    STAFF_SHIFT_OVERLAP: 'data.staff.error.STAFF_SHIFT_OVERLAP',
    NAME_REQUIRED: 'data.staff.error.NAME_REQUIRED',
    INVALID_SHIFT: 'data.staff.error.INVALID_SHIFT',
    BREAK_TOO_LONG: 'data.staff.error.BREAK_TOO_LONG',
  },
  async load({ reads, signal }) {
    const [people, schedules, history, saved, projections, settings] = await Promise.all([
      reads.all<Versioned<Staff>>({ resource: 'staff', path: staff }, { signal }),
      reads.all<Versioned<StaffSchedule>>({ resource: 'staff-shifts', path: shifts }, { signal }),
      reads.all<StaffScheduleChange>({ resource: 'staff-shift-history', path: `${shifts}/history` }, { signal }),
      reads.all<EventDto>({ resource: 'calendar-events', path: events }, { signal }),
      reads.all<CalendarProjection>({ resource: 'calendar-projections', path: `${calendar}/projections` }, { signal }),
      reads.one<PreferencesDto>({ resource: 'calendar-preferences', path: preferences }, { signal }),
    ]);
    return {
      tables: {
        staff: people.items, staffSchedule: schedules.items,
        staffScheduleChange: [...history.items].sort((a, b) => a.at.localeCompare(b.at) || a.changeId.localeCompare(b.changeId)),
        calendarEvent: saved.items.map(({ title, memo, ...row }) => ({ ...row, title: { raw: title }, memo: memo ? { raw: memo } : null })),
        calendarProjection: projections.items, calendarSettings: settings.sourceVisibility, categoryVisibility: settings.categoryVisibility,
        staffCalendarAsOf: schedules.asOf, staffShiftRevision: schedules.sourceRevision,
      },
      revisions: {
        ...Object.fromEntries(people.items.map(row => [personKey(row.staffId), row.revision])),
        ...Object.fromEntries(schedules.items.map(row => [shiftKey(row.scheduleId), row.revision])),
        ...Object.fromEntries(saved.items.map(row => [eventKey(row.eventId), row.revision])),
        [shiftCollectionKey]: schedules.sourceRevision,
        [preferenceKey]: settings.revision,
      },
      asOf: schedules.asOf,
      sourceRevision: schedules.sourceRevision,
      complete: [people, schedules, history, saved, projections].every(result => result.complete),
    };
  },
  commands: [
    defineBinding({ type: 'staff.create', receiptBase: staff, noticeKey: staffNotice('created'), request: ({ name }) => ({
      method: 'POST', path: staff, body: { name },
    }) }),
    defineBinding({ type: 'staff.update', receiptBase: staff, noticeKey: staffNotice('changed'), request: ({ staffId, name }, context) => ({
      method: 'PATCH', path: itemPath(staff, staffId), body: { name }, expectedRevision: expected(context, personKey(staffId)),
    }) }),
    defineBinding({ type: 'staff.delete', receiptBase: staff, noticeKey: staffNotice('deleted'), request: ({ staffId, cascadeSchedules }, context) => ({
      method: 'DELETE', path: itemPath(staff, staffId),
      body: { cascadeSchedules, confirmed: true, expectedScheduleRevision: expected(context, shiftCollectionKey) },
      expectedRevision: expected(context, personKey(staffId)),
    }) }),
    defineBinding({ type: 'staff.saveSchedule', receiptBase: staff, noticeKey: staffNotice('scheduleSaved'),
      request: ({ scheduleId, staffId, date, kind, start, end, breakMinutes }, context) => {
        const body = { staffId, date, kind, start, end, breakMinutes };
        return scheduleId
          ? { method: 'PATCH', path: itemPath(shifts, scheduleId), body, expectedRevision: expected(context, shiftKey(scheduleId)) }
          : { method: 'POST', path: shifts, body };
      },
    }),
    defineBinding({ type: 'staff.deleteSchedule', receiptBase: staff, noticeKey: staffNotice('deleted'), request: ({ scheduleId }, context) => ({
      method: 'DELETE', path: itemPath(shifts, scheduleId), body: { confirmed: true }, expectedRevision: expected(context, shiftKey(scheduleId)),
    }) }),
    defineBinding({ type: 'staff.moveHandoff', receiptBase: staff, noticeKey: staffNotice('changed'), request: ({ date, fromTime, toTime }, context) => ({
      method: 'POST', path: `${shifts}/handoff`, body: { date, fromTime, toTime }, expectedRevision: expected(context, shiftCollectionKey),
    }) }),
    defineBinding({ type: 'calendar.addEvent', receiptBase: calendar, noticeKey: 'data.notice.calendarAdded',
      request: ({ title, date, time, memo, categoryId, storeClosure, dateIntent, confirmDuplicate }) => ({
        method: 'POST', path: events, body: { kind: 'event', title, date, time, memo, categoryId, storeClosure, dateIntent, confirmDuplicate },
      }),
    }),
    defineBinding({ type: 'calendar.addTodo', receiptBase: calendar, noticeKey: 'data.notice.calendarAdded',
      request: ({ title, date, memo, dateIntent, confirmDuplicate }) => ({
        method: 'POST', path: events, body: { kind: 'todo', title, date, memo, dateIntent, confirmDuplicate },
      }),
    }),
    defineBinding({ type: 'calendar.updateEvent', receiptBase: calendar, noticeKey: 'data.notice.calendarUpdated',
      request: ({ eventId, title, date, time, memo, categoryId, storeClosure, dateIntent, confirmDuplicate }, context) => ({
        method: 'PATCH', path: itemPath(events, eventId), body: { title, date, time, memo, categoryId, storeClosure, dateIntent, confirmDuplicate },
        expectedRevision: expected(context, eventKey(eventId)),
      }),
    }),
    defineBinding({ type: 'calendar.deleteEvent', receiptBase: calendar, noticeKey: 'data.notice.calendarDeleted', request: ({ eventId }, context) => ({
      method: 'DELETE', path: itemPath(events, eventId), body: { confirmed: true }, expectedRevision: expected(context, eventKey(eventId)),
    }) }),
    defineBinding({ type: 'calendar.setSourceVisible', receiptBase: calendar, request: ({ source, visible }, context) => ({
      method: 'PATCH', path: preferences, body: { source, visible }, expectedRevision: expected(context, preferenceKey),
    }) }),
    defineBinding({ type: 'calendar.setCategoryVisible', receiptBase: calendar, request: ({ categoryId, visible }, context) => ({
      method: 'PATCH', path: preferences, body: { categoryId, visible }, expectedRevision: expected(context, preferenceKey),
    }) }),
  ],
};
