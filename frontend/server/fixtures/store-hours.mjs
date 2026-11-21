import manifest from '../../src/data/db/generated/manifest.json' with { type: 'json' };

export const STORE_HOURS = Object.freeze(Object.fromEntries(
  Object.entries(manifest.store.hours).map(([day, hours]) => [day, Object.freeze(hours)]),
));

const range = ([open, close]) => `${open}~${close}`;

/** `평일 08:00~22:00 · 토요일 09:30~21:30 · 일요일 10:00~20:30` (same text as storeHoursSummary('ko')). */
export function storeHoursSummaryKo() {
  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (!weekdays.every(day => range(STORE_HOURS[day]) === range(STORE_HOURS.mon))) throw new Error('Weekday hours differ; extend the summary.');
  return `평일 ${range(STORE_HOURS.mon)} · 토요일 ${range(STORE_HOURS.sat)} · 일요일 ${range(STORE_HOURS.sun)}`;
}

/** The grounding line for message drafts: `영업시간: 평일 08:00~22:00 · …`. */
export const storeHoursGroundingKo = () => `영업시간: ${storeHoursSummaryKo()}`;

/** `일요일에는 10:00~20:30에 열어요.` */
export const sundayHoursSentenceKo = () => `일요일에는 ${range(STORE_HOURS.sun)}에 열어요.`;
