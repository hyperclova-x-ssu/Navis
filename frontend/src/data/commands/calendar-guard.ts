/**
 * GD-2 calendar guard: what a direct calendar write must not do silently. Both rules belong to the handler, so the
 * calendar widget and the chatbot get the same refusal.
 *  - A newly assigned past date or elapsed time is refused without explicit historical intent.
 *  - An event or to-do with the same title on the same day is refused unless the command says `confirmDuplicate: true`
 *    (the owner was asked and chose to add another).
 * Both are typed refusals with `details`, so the widget can offer the "yes, I mean it" button.
 */
import type { DataTables, DataText } from '../db/types';
import { isIsoDate, isTime, NOW_TIME, TODAY } from '../db/time';
import { sourcedRows } from '../messages/sourced';
import { writtenRows } from '../messages/written';
import type { HandlerResult } from './handlers';

export interface CalendarWrite {
  readonly type: 'calendar.addEvent' | 'calendar.addTodo' | 'calendar.updateEvent';
  readonly eventId?: string;
  readonly title?: string;
  readonly date?: string;
  readonly time?: string | null;
  readonly dateIntent?: 'historical';
  readonly confirmDuplicate?: boolean;
}

/** Same title however it is spaced or cased: "위생 점검" and "위생점검" are one event. */
const normalize = (title: string): string => title.normalize('NFC').toLowerCase().replace(/[\s·.,!?~\-_()[\]]+/g, '');
const koreanOf = (key: string): string => {
  const row = (sourcedRows as Readonly<Record<string, readonly string[]>>)[key] ?? (writtenRows as Readonly<Record<string, readonly string[]>>)[key];
  return row?.[0] ?? '';
};
/** Owner text as typed; a built-in title through its Korean message (this layer runs no translator). */
const titleOf = (text: DataText | null): string => !text ? '' : 'raw' in text ? text.raw : koreanOf(text.key);
const failure = (code: 'VALIDATION' | 'CONFLICT', reason: string, field: string, details: Readonly<Record<string, unknown>>): HandlerResult =>
  ({ ok: false, code, reason, field, messageKey: `data.calendar.error.${reason}`, details });

/** `null` when the write may go ahead. Malformed input is left to the handler's own validation. */
export function guardCalendarWrite(t: Pick<DataTables, 'calendarEvent'>, c: CalendarWrite, today: string = TODAY): HandlerResult | null {
  const current = c.type === 'calendar.updateEvent' ? t.calendarEvent.find(e => e.eventId === c.eventId) : undefined;
  if (c.type === 'calendar.updateEvent' && !current) return null;
  const date = c.date ?? current?.date ?? today;
  if (!isIsoDate(date)) return null;
  const dateChanged = c.type !== 'calendar.updateEvent' || date !== current!.date;
  if (dateChanged && date < today && c.dateIntent !== 'historical') return failure('VALIDATION', 'CALENDAR_PAST_DATE', 'date', { date, today });
  const title = typeof c.title === 'string' ? c.title.trim() : current ? titleOf(current.title) : '';
  const titleChanged = c.type !== 'calendar.updateEvent' || (c.title !== undefined && normalize(title) !== normalize(titleOf(current!.title)));
  if (title && (dateChanged || titleChanged) && c.confirmDuplicate !== true) {
    const kind = c.type === 'calendar.addTodo' ? 'todo' : current?.kind ?? 'event';
    const twin = t.calendarEvent.find(e => e.eventId !== c.eventId && e.kind === kind && e.date === date && normalize(titleOf(e.title)) === normalize(title));
    if (twin) return failure('CONFLICT', 'CALENDAR_DUPLICATE', 'title', { eventId: twin.eventId, title: titleOf(twin.title), date: twin.date, time: twin.time });
  }
  const time = c.time === undefined ? current?.time : c.time;
  const timeChanged = c.time !== undefined && time !== current?.time;
  if ((dateChanged || timeChanged) && date === today && isTime(time) && time < NOW_TIME && c.dateIntent !== 'historical') {
    return failure('VALIDATION', 'CALENDAR_PAST_DATE', 'date', { date, today, time });
  }
  return null;
}
