import manifest from './generated/manifest.json';

const env = import.meta.env;
export const CLOCK_MODE = (env?.VITE_NAVIS_CLOCK || env?.VITE_NAVIS_POS_CLOCK) === 'real' ? 'real' : 'fixed';
const replayInstant = env?.VITE_NAVIS_REPLAY_INSTANT;
export const REPLAY_CLOCK = replayInstant ? parseReplayInstant(replayInstant) : undefined;

function parseReplayInstant(value: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const now = new Date(value);
  const day = new Date(`${match?.[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(+now) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== match[1]) {
    throw new Error('VITE_NAVIS_REPLAY_INSTANT must be a timezone-qualified ISO timestamp');
  }
  return now;
}
export const FIXED_STORE_DATE = manifest.cutoff.businessDate;

const zone = new Intl.DateTimeFormat('en', {
  timeZone: manifest.store.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const cutoff = manifest.store.businessDayStart;
const dayMs = 86_400_000;

/** Wall time stamps have the civil date, even when POS attributes them to the previous business day. */
export function readAppClock() {
  if (CLOCK_MODE === 'fixed' && !REPLAY_CLOCK) {
    const time = manifest.cutoff.localTime.slice(0, 5);
    const local = `${FIXED_STORE_DATE}T${time}`;
    return { businessDate: FIXED_STORE_DATE, calendarDate: FIXED_STORE_DATE, time, local, localSecond: `${FIXED_STORE_DATE}T${manifest.cutoff.localTime}` };
  }
  const { year, month, day, hour, minute, second } = Object.fromEntries(
    zone.formatToParts(REPLAY_CLOCK ?? new Date()).map(({ type, value }) => [type, value]),
  );
  const calendarDate = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}`;
  const businessDate = time < cutoff
    ? new Date(Date.parse(`${calendarDate}T00:00:00Z`) - dayMs).toISOString().slice(0, 10)
    : calendarDate;
  const local = `${calendarDate}T${time}`;
  return { businessDate, calendarDate, time, local, localSecond: `${local}:${second}` };
}

// Selectors, default ranges and fixture projections start from the same reading when the app loads.
export const APP_CLOCK = Object.freeze(readAppClock());
