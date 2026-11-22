import { APP_CLOCK, CLOCK_MODE, FIXED_STORE_DATE, REPLAY_CLOCK } from './app-clock';
import { addDays, daysBetween, isIsoDate } from './time';

const configuredEnd = import.meta.env?.VITE_NAVIS_FIXTURE_END_DATE;
if ((REPLAY_CLOCK || CLOCK_MODE === 'real') && configuredEnd && !isIsoDate(configuredEnd)) {
  throw new Error('VITE_NAVIS_FIXTURE_END_DATE must be a valid YYYY-MM-DD');
}

if (REPLAY_CLOCK && configuredEnd && configuredEnd !== APP_CLOCK.calendarDate) {
  throw new Error('VITE_NAVIS_FIXTURE_END_DATE conflicts with VITE_NAVIS_REPLAY_INSTANT');
}

export const FIXTURE_END_DATE = REPLAY_CLOCK || CLOCK_MODE === 'real'
  ? configuredEnd && configuredEnd < APP_CLOCK.calendarDate ? configuredEnd : APP_CLOCK.calendarDate
  : FIXED_STORE_DATE;
// The clock is sampled with the rest of the fixture at app load, so every reader sees one cutoff.
export const FIXTURE_AS_OF = CLOCK_MODE === 'real' ? APP_CLOCK.localSecond : undefined;

export function fixtureOccurred(at: string): boolean {
  return !FIXTURE_AS_OF || at <= FIXTURE_AS_OF;
}

const offset = daysBetween(FIXED_STORE_DATE, FIXTURE_END_DATE);

const isoValue = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function rebaseDate(value: string): string {
  const date = isoValue.exec(value)?.[1];
  return date && isIsoDate(date) ? addDays(date, offset) + value.slice(date.length) : value;
}

function rebase(value: unknown): unknown {
  if (typeof value === 'string') return rebaseDate(value);
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [rebaseDate(key), rebase(child)]));
  }
  return value;
}

/** Applies only to generated JSON-shaped fixtures before they reach the store or its projections. */
export function rebaseFixtureDates<T>(fixture: T): T {
  return offset ? rebase(fixture) as T : fixture;
}
