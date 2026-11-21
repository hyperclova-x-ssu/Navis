import { describe, expect, it } from 'vitest';
import { addDays, TOMORROW, YESTERDAY } from '../db/time';
import { createWidgetDataStore, TODAY } from '../widget-data';
import { guardCalendarWrite } from './calendar-guard';

const tables = () => createWidgetDataStore().getSnapshot().tables;
const owned = (title: string, date: string, extra: object = {}) => ({ eventId: `own-${date}-${title}`, kind: 'event' as const, title: { raw: title }, date, time: null, memo: null, ...extra });

describe('GD-2 calendar guard (handler-level rules, no widget)', () => {
  it('refuses a past date with the typed shape and lets today and later through', () => {
    const t = tables();
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: YESTERDAY })).toEqual({ ok: false, code: 'VALIDATION', reason: 'CALENDAR_PAST_DATE', field: 'date', messageKey: 'data.calendar.error.CALENDAR_PAST_DATE', details: { date: YESTERDAY, today: TODAY } });
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: TODAY })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: TOMORROW })).toBeNull();
  });
  it('lets an explicitly historical record through and treats a to-do the same way', () => {
    const t = tables();
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: YESTERDAY, dateIntent: 'historical' })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.addTodo', title: '세금 서류', date: YESTERDAY })).toMatchObject({ reason: 'CALENDAR_PAST_DATE' });
    expect(guardCalendarWrite(t, { type: 'calendar.addTodo', title: '세금 서류' })).toBeNull();
  });
  it('asks before a same-title event on the same day, however it is spaced', () => {
    const t = { calendarEvent: [...tables().calendarEvent, owned('거래처 미팅', addDays(TODAY, 2))] };
    for (const title of ['거래처 미팅', ' 거래처  미팅 ', '거래처미팅']) {
      expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title, date: addDays(TODAY, 2) })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'CALENDAR_DUPLICATE', field: 'title', messageKey: 'data.calendar.error.CALENDAR_DUPLICATE', details: { eventId: `own-${addDays(TODAY, 2)}-거래처 미팅`, date: addDays(TODAY, 2) } });
    }
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: addDays(TODAY, 2), confirmDuplicate: true })).toBeNull();
  });
  it('matches a localized title through its Korean text (위생 점검 today at 14:00)', () => {
    const event = { ...owned('위생 점검', TODAY), eventId: 'ev-hygiene', title: { key: 'data.calendar.hygiene' }, time: '14:00' };
    const t = { calendarEvent: [...tables().calendarEvent, event] };
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '위생점검', date: TODAY })).toMatchObject({ reason: 'CALENDAR_DUPLICATE', details: { eventId: 'ev-hygiene', time: '14:00' } });
  });
  it('lets a different title, a different day and a to-do with the same words through', () => {
    const t = { calendarEvent: [...tables().calendarEvent, owned('거래처 미팅', addDays(TODAY, 2))] };
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 점심', date: addDays(TODAY, 2) })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '거래처 미팅', date: addDays(TODAY, 3) })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.addTodo', title: '거래처 미팅', date: addDays(TODAY, 2) })).toBeNull();
  });
  it('on edit: refuses moving into the past or onto a twin, but not an unchanged past event or an unchanged twin', () => {
    const past = owned('지난 미팅', '2026-10-20'), twin = owned('같은 제목', addDays(TODAY, 2)), other = owned('같은 제목', addDays(TODAY, 3));
    const t = { calendarEvent: [...tables().calendarEvent, past, twin, other] };
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: other.eventId, date: YESTERDAY })).toMatchObject({ reason: 'CALENDAR_PAST_DATE' });
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: other.eventId, date: YESTERDAY, dateIntent: 'historical' })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: other.eventId, date: addDays(TODAY, 2) })).toMatchObject({ reason: 'CALENDAR_DUPLICATE', details: { eventId: twin.eventId } });
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: past.eventId, title: '지난 미팅', date: '2026-10-20' })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: twin.eventId, title: '같은 제목', date: addDays(TODAY, 2) })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: twin.eventId, title: '새 제목', date: addDays(TODAY, 2) })).toBeNull();
  });
  it('leaves malformed input and unknown ids to the handler', () => {
    const t = tables();
    expect(guardCalendarWrite(t, { type: 'calendar.addEvent', title: '일정', date: '2026-02-30' })).toBeNull();
    expect(guardCalendarWrite(t, { type: 'calendar.updateEvent', eventId: 'missing', date: '2026-10-01' })).toBeNull();
  });
});

describe('N10 elapsed calendar slots', () => {
  it('requires historical intent for a new elapsed time today', () => {
    const store = createWidgetDataStore();
    const command = { type: 'calendar.addEvent', title: '거래처 미팅', date: TODAY, time: '10:00' } as const;
    const before = store.getSnapshot();
    expect(store.dispatch(command)).toMatchObject({ ok: false, reason: 'CALENDAR_PAST_DATE' });
    expect(store.getSnapshot()).toBe(before);
    expect(store.dispatch({ ...command, dateIntent: 'historical' })).toMatchObject({ ok: true });
    expect(store.dispatch({ ...command, title: '지금 일정', time: '15:45' })).toMatchObject({ ok: true });
  });

  it('checks duplicate and elapsed intent independently while allowing a memo on a past entry', () => {
    const past = owned('지난 미팅', TODAY, { time: '10:00' });
    const store = createWidgetDataStore({ calendarEvent: [past] });
    const command = { type: 'calendar.addEvent', title: '지난미팅', date: TODAY, time: '10:00' } as const;
    expect(store.dispatch(command)).toMatchObject({ ok: false, reason: 'CALENDAR_DUPLICATE' });
    expect(store.dispatch({ ...command, confirmDuplicate: true })).toMatchObject({ ok: false, reason: 'CALENDAR_PAST_DATE' });
    expect(store.dispatch({ ...command, confirmDuplicate: true, dateIntent: 'historical' })).toMatchObject({ ok: true });
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId: past.eventId, memo: '확인' })).toMatchObject({ ok: true });
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId: past.eventId, time: '11:00' })).toMatchObject({ ok: false, reason: 'CALENDAR_PAST_DATE' });
  });
});
