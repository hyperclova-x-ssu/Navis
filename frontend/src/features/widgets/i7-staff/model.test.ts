import { describe, expect, it } from 'vitest';
import { daysInPeriod, periodFor, shiftPeriod, validateSchedule } from './model';

describe('staff schedule period and validation', () => {
  it('starts weeks on Monday and handles month boundaries', () => {
    expect(periodFor('2026-11-01', 'week')).toEqual({ startDate: '2026-10-26', endDate: '2026-11-01' });
    expect(periodFor('2026-11-17', 'week')).toEqual({ startDate: '2026-11-16', endDate: '2026-11-22' });
    expect(periodFor('2028-02-15', 'month')).toEqual({ startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(periodFor('2026-12-31', 'month')).toEqual({ startDate: '2026-12-01', endDate: '2026-12-31' });
    expect(shiftPeriod('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(shiftPeriod('2026-11-17', 'week', -1)).toBe('2026-11-10');
    expect(shiftPeriod('2026-12-15', 'month', 1)).toBe('2027-01-15');
  });
  it('lists every day of a period, across a month end, without drifting', () => {
    expect(daysInPeriod('2026-11-28', '2026-12-02')).toEqual(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(daysInPeriod('2026-11-01', '2026-11-30')).toHaveLength(30);
  });
  it('rejects invalid work time and break but accepts off days', () => {
    expect(validateSchedule('work', '18:00', '14:00', 0)).toBe('퇴근 시각은 출근 시각보다 뒤여야 해요');
    expect(validateSchedule('work', '14:00', '14:00', 0)).toBe('퇴근 시각은 출근 시각보다 뒤여야 해요');
    expect(validateSchedule('work', '14:00', '18:00', 240)).toBe('휴게 시간은 근무 시간보다 짧아야 해요');
    expect(validateSchedule('work', '14:00', '18:00', -1)).toBe('휴게 시간은 0분 이상 넣어 주세요');
    expect(validateSchedule('off', '', '', 0)).toBeNull();
  });
  it('refuses a shift that runs past midnight with the same-day wording, in the small hours before the business day turns over', () => {
    const sameDay = '근무는 같은 날 안에서만 정할 수 있어요';
    expect(validateSchedule('work', '22:00', '02:00', 0)).toBe(sameDay);
    expect(validateSchedule('work', '18:00', '00:00', 0)).toBe(sameDay);
    expect(validateSchedule('work', '17:00', '05:00', 30)).toBe(sameDay);
    // Ending later than it starts, even at the very end of the day, is a normal shift.
    expect(validateSchedule('work', '17:00', '22:00', 30)).toBeNull();
    expect(validateSchedule('work', '18:00', '23:59', 0)).toBeNull();
    // Starting after it ends in the daytime is a typo, not an overnight shift.
    expect(validateSchedule('work', '18:00', '14:00', 0)).not.toBe(sameDay);
    // A day off is never checked.
    expect(validateSchedule('off', '22:00', '02:00', null)).toBeNull();
  });
});
