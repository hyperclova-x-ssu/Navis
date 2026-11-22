import type { Translator } from '../../i18n';

/**
 * A period with the weekday of each end (T-43): `11월 16일(월)~22일(일)`, across months `11월 29일(일)~12월 6일(일)`, one day `11/22(일)`.
 * Korean only; the other languages keep the shared range. Dates are store-local `YYYY-MM-DD`.
 */
export function dateRangeWithWeekdays(t: Pick<Translator, 'locale' | 'format'>, startIso: string, endIso: string): string {
  if (t.locale !== 'ko') return t.format.dateRange(startIso, endIso);
  if (startIso === endIso) return t.format.date(startIso, 'short');
  const [, sm, sd] = startIso.split('-').map(Number), [, em, ed] = endIso.split('-').map(Number);
  const start = `${sm}월 ${sd}일(${t.format.weekday(startIso, 'short')})`;
  const end = `${sm === em ? '' : `${em}월 `}${ed}일(${t.format.weekday(endIso, 'short')})`;
  return `${start}~${end}`;
}
