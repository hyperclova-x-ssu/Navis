import manifest from './generated/manifest.json';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isIsoDate, isTime, NOW, TODAY, TOMORROW, WEEK_END, WEEK_START, weekdayOf, dateRange, hourOf, MONTH_START } from './time';

describe('fixed store-local clock (no device time)', () => {
  it('has the documented fixed now', () => {
    expect(TODAY).toBe(manifest.cutoff.businessDate);
    expect(NOW).toBe(`${manifest.cutoff.businessDate}T${manifest.cutoff.localTime.slice(0, 5)}`);
    expect(TOMORROW).toBe('2026-11-18');
    expect(WEEK_START).toBe('2026-11-16');
    expect(WEEK_END).toBe('2026-11-22');
    expect(MONTH_START).toBe('2026-11-01');
  });
  it('does pure ISO date arithmetic across month and year ends', () => {
    expect(addDays('2026-10-26', 6)).toBe('2026-11-01');
    expect(addDays('2026-10-01', -4)).toBe('2026-09-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-26', '2026-10-30')).toBe(4);
    expect(dateRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
  it('knows weekdays with Monday = 1', () => {
    expect(weekdayOf('2026-10-26')).toBe(1);
    expect(weekdayOf('2026-10-27')).toBe(2);
    expect(weekdayOf('2026-10-31')).toBe(6);
    expect(weekdayOf('2026-11-01')).toBe(7);
  });
  it('validates dates and times strictly', () => {
    expect(isIsoDate('2026-10-26')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-10-2026')).toBe(false);
    expect(isTime('09:00')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(isTime('9:00')).toBe(false);
    expect(hourOf('17:30')).toBe(17);
  });
});
