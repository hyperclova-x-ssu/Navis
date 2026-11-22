import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import { dateRangeWithWeekdays } from './date-range';

// T-43 (D-381/D-382): a period reads with the weekday of each end, "11월 16일(월)~22일(일)" (DS G-25 gives the weekday in every date).
const f = (locale: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant') => createTranslator(locale);
describe('dateRangeWithWeekdays', () => {
  it('puts the weekday of both ends in a same-month Korean period', () => {
    expect(dateRangeWithWeekdays(f('ko'), '2026-11-16', '2026-11-22')).toBe('11월 16일(월)~22일(일)');
  });
  it('names both months when the period crosses a month', () => {
    expect(dateRangeWithWeekdays(f('ko'), '2026-11-29', '2026-12-06')).toBe('11월 29일(일)~12월 6일(일)');
  });
  it('reads one day as the short date', () => {
    expect(dateRangeWithWeekdays(f('ko'), '2026-11-22', '2026-11-22')).toBe('11/22(일)');
  });
  it('leaves the other languages on the shared range', () => {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) expect(dateRangeWithWeekdays(f(locale), '2026-11-16', '2026-11-22')).toBe(f(locale).format.dateRange('2026-11-16', '2026-11-22'));
  });
});
