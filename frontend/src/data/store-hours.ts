import manifest from './db/generated/manifest.json';

export const STORE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type StoreWeekday = typeof STORE_WEEKDAYS[number];
/** `[open, close]` as 24-hour `HH:MM` on the same business day. */
export type StoreHoursRange = readonly [open: string, close: string];

export const STORE_HOURS: Readonly<Record<StoreWeekday, StoreHoursRange>> = Object.freeze(
  Object.fromEntries(STORE_WEEKDAYS.map(day => [day, Object.freeze(manifest.store.hours[day])])) as Record<StoreWeekday, StoreHoursRange>,
);

export type StoreHoursLocale = 'ko' | 'en' | 'zh-Hans' | 'zh-Hant';

const SEPARATOR = ' · ';
const DASH: Record<StoreHoursLocale, string> = { ko: '~', en: '–', 'zh-Hans': '–', 'zh-Hant': '–' };
const GROUP_LABEL: Record<StoreHoursLocale, Record<'weekdays' | 'sat' | 'sun', string>> = {
  ko: { weekdays: '평일', sat: '토요일', sun: '일요일' },
  en: { weekdays: 'Weekdays', sat: 'Saturday', sun: 'Sunday' },
  'zh-Hans': { weekdays: '平日', sat: '周六', sun: '周日' },
  'zh-Hant': { weekdays: '平日', sat: '週六', sun: '週日' },
};
const LABEL_PREFIX: Record<StoreHoursLocale, string> = { ko: '영업시간: ', en: 'Hours: ', 'zh-Hans': '营业时间：', 'zh-Hant': '營業時間：' };

const rangeText = (range: StoreHoursRange, locale: StoreHoursLocale): string => `${range[0]}${DASH[locale]}${range[1]}`;
const same = (a: StoreHoursRange, b: StoreHoursRange): boolean => a[0] === b[0] && a[1] === b[1];

/** Opening hours of one weekday, e.g. `10:00–20:30`. */
export function storeHoursOn(weekday: StoreWeekday, locale: StoreHoursLocale = 'ko'): string {
  return rangeText(STORE_HOURS[weekday], locale);
}

/** Open and close time of one weekday, for sentences that name the two times separately. */
export function storeOpenClose(weekday: StoreWeekday): { readonly open: string; readonly close: string } {
  return { open: STORE_HOURS[weekday][0], close: STORE_HOURS[weekday][1] };
}

/**
 * All week in three groups, e.g. `평일 08:00~22:00 · 토요일 09:30~21:30 · 일요일 10:00~20:30`.
 * Monday–Friday collapse into "weekdays" only while the five days share one range (checked here,
 * so editing the table to give one weekday its own hours is shown as such, not hidden).
 */
export function storeHoursSummary(locale: StoreHoursLocale = 'ko'): string {
  const weekdays = STORE_WEEKDAYS.slice(0, 5);
  const label = GROUP_LABEL[locale];
  const parts: string[] = [];
  if (weekdays.every((day) => same(STORE_HOURS[day], STORE_HOURS.mon))) parts.push(`${label.weekdays} ${rangeText(STORE_HOURS.mon, locale)}`);
  else for (const day of weekdays) parts.push(`${GROUP_LABEL[locale].weekdays} ${day} ${rangeText(STORE_HOURS[day], locale)}`);
  parts.push(`${label.sat} ${rangeText(STORE_HOURS.sat, locale)}`, `${label.sun} ${rangeText(STORE_HOURS.sun, locale)}`);
  return parts.join(SEPARATOR);
}

/** The grounding line used for message drafts, e.g. `영업시간: 평일 08:00~22:00 · 토요일 …`. */
export function storeHoursGrounding(locale: StoreHoursLocale = 'ko'): string {
  return `${LABEL_PREFIX[locale]}${storeHoursSummary(locale)}`;
}
