import { describe, expect, it } from 'vitest';
import { buildNaverCalendarEvent, parseWorksWindow, worksShiftEvent } from './naver.ts';
import type { CalendarEvent, Shift } from './wire.ts';

const event: CalendarEvent = {
  eventId: '9f8fe2ae-1563-4e1b-963c-18b74e96bc7a', kind: 'event',
  title: '회의\r\nATTENDEE:mailto:invalid', memo: null, date: '2027-01-05',
  time: '10:00', categoryId: 'store-operations', storeClosure: null, revision: 2,
};
const storeId = '96f91c6e-4024-4a33-b44c-a857f540f531';

describe('PN11 calendar mapping', () => {
  it('exports one safe VEVENT with a stable UID across source revisions', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    const first = buildNaverCalendarEvent(event, storeId, now, 'Asia/Seoul');
    const second = buildNaverCalendarEvent({ ...event, revision: 3 }, storeId, now, 'Asia/Seoul');
    expect(first.icalUid).toBe(second.icalUid);
    expect(first.ical.match(/^BEGIN:VEVENT\r?$/gm)).toHaveLength(1);
    expect(first.ical).toContain('DTSTART:20270105T010000Z');
    expect(first.ical).not.toMatch(/^ATTENDEE:/m);
    expect(() => buildNaverCalendarEvent({ ...event, kind: 'todo' }, storeId, now, 'Asia/Seoul')).toThrow();
  });

  it('accepts a 31-day WORKS window and rejects longer, invalid, and reversed windows', () => {
    const fromDateTime = '2027-01-01T00:00:00+09:00';
    const last = '2027-02-01T00:00:00+09:00';
    expect(parseWorksWindow({ fromDateTime, untilDateTime: last })).toEqual([fromDateTime, last]);
    for (const untilDateTime of ['2027-02-02T00:00:00+09:00', '2027-01-32T00:00:00+09:00', fromDateTime]) {
      expect(() => parseWorksWindow({ fromDateTime, untilDateTime })).toThrow();
    }
  });

  it('uses the same WORKS event ID across shift revisions and exclusive all-day ends', () => {
    const shift: Shift = { scheduleId: event.eventId, staffId: storeId, kind: 'off', date: event.date,
      start: null, end: null, breakMinutes: 0, revision: 1 };
    const mapped = worksShiftEvent(storeId, 'team', shift, '직원');
    expect(mapped.end).toEqual({ date: '2027-01-06' });
    expect(worksShiftEvent(storeId, 'team', { ...shift, revision: 2, kind: 'work', start: '09:00', end: '17:00' }, '직원').eventId)
      .toBe(mapped.eventId);
  });
});
