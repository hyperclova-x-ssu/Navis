import manifest from '../data/db/generated/manifest.json';
import { readAppClock } from '../data/db/app-clock';
import { STORE_HOURS, STORE_WEEKDAYS } from '../data/store-hours';

/**
 * D-327 (2026-11-21): the arrival briefing opens by itself at most once per business day, so a reload,
 * data reset, example state or business-type change in the middle of work never brings it back.
 * A business day runs from the store's opening time minus 2 hours on that weekday until the next
 * day's opening minus 2 hours, measured in the store's local time.
 */
export const BRIEFING_LEAD_MINUTES = 120;

/** The two Storage methods this rule needs; anything else about the storage is not trusted. */
export type BriefingDayStorage = Pick<Storage, 'getItem' | 'setItem'>;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const dayKey = (utcMidnightMs: number): string => new Date(utcMidnightMs).toISOString().slice(0, 10);
/** Minutes (on the wall-clock axis) at which the business day of the calendar day starting at `utcMidnightMs` begins. */
function businessDayStart(utcMidnightMs: number): number {
  const weekday = STORE_WEEKDAYS[(new Date(utcMidnightMs).getUTCDay() + 6) % 7]; // getUTCDay: 0 = Sunday
  const [hour, minute] = STORE_HOURS[weekday][0].split(':').map(Number);
  return utcMidnightMs / MINUTE_MS + hour * 60 + minute - BRIEFING_LEAD_MINUTES;
}

/**
 * Business day (`YYYY-MM-DD`, the calendar date of its opening) that a local `YYYY-MM-DDTHH:mm` time belongs to,
 * or null when the text is not a valid local date-time.
 */
export function briefingBusinessDay(local: string): string | null {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const midnight = Date.UTC(year, month - 1, day);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || new Date(midnight).getUTCDate() !== day) return null;
  const at = midnight / MINUTE_MS + hour * 60 + minute;
  // The next calendar day's start is checked first so an opening before 02:00 (start before midnight) still works.
  for (const offset of [1, 0]) if (at >= businessDayStart(midnight + offset * DAY_MS)) return dayKey(midnight + offset * DAY_MS);
  return dayKey(midnight - DAY_MS);
}

/** Browser storage key of the last business day the briefing opened by itself, one per store. */
export const briefingDayStorageKey = (storeId: string = manifest.store.storeId): string => `navis.briefing.lastShownDay.${storeId}`;

/** `window.localStorage`, or null when the browser denies even touching it (private mode, blocked cookies). */
export function browserBriefingStorage(win: Pick<Window, 'localStorage'>): BriefingDayStorage | null {
  try { return win.localStorage ?? null; } catch { return null; }
}

export interface BriefingDayOptions {
  /** Where the last shown business day is remembered. Absent or unusable: once per run only. */
  readonly briefingStorage?: BriefingDayStorage | null;
  /** The run's store ID. The standalone app defaults to its seed store. */
  readonly storeId?: string;
  /** The run's clock as local `YYYY-MM-DDTHH:mm`. Defaults to the shared app clock. */
  readonly businessNow?: () => string;
  /** REAL-PLAN F12: the service's view of the arrival day (HTTP builds only). Absent: the local rule alone, exactly as before. */
  readonly briefingServer?: () => BriefingServerDay | null | undefined;
}

/**
 * What the service says about the arrival: `arrivalDay` replaces the local weekday rule when it has authoritative weekly opening times (null keeps the local rule),
 * `acknowledgedDay` is the business day the owner explicitly confirmed. `undefined` from the source means not known yet (the card waits); `null` means no usable answer.
 */
export interface BriefingServerDay { readonly arrivalDay: string | null; readonly acknowledgedDay: string | null }

export interface BriefingDayGate {
  /**
   * Asks to open the briefing now. True means it may open (and its business day has been recorded);
   * false means this run already decided, or the day's briefing was already shown, so it must stay closed.
   */
  readonly claim: (runId: string) => boolean;
  /** True while this run already got its answer for the current business day (no storage read needed). */
  readonly settled: (runId: string) => boolean;
}

export function createBriefingDayGate(options: BriefingDayOptions = {}): BriefingDayGate {
  const clock = options.businessNow ?? (() => readAppClock().local);
  const key = briefingDayStorageKey(options.storeId);
  let decided: { readonly runId: string; readonly day: string | null } | null = null;
  let cached: { readonly text: string; readonly day: string | null } | null = null;
  const localDay = (): string | null => {
    const text = clock();
    if (cached?.text !== text) cached = { text, day: briefingBusinessDay(text) };
    return cached.day;
  };
  const server = () => options.briefingServer?.();
  const today = (): string | null => server()?.arrivalDay ?? localDay();
  const read = (): string | null => {
    try {
      const value = options.briefingStorage?.getItem(key);
      return typeof value === 'string' && DAY_KEY.test(value) ? value : null;
    } catch { return null; }
  };
  const write = (day: string): void => { try { options.briefingStorage?.setItem(key, day); } catch { /* once per run is the fallback */ } };
  // The decision is remembered per run and business day, so the storage is read only when the card is about to open.
  // An unreadable business clock (day null) stores nothing and decides once per run.
  return {
    settled: runId => decided?.runId === runId && decided.day === today(),
    claim: runId => {
      // The service's answer is still on its way: decide nothing and ask again on the next tick.
      if (options.briefingServer && server() === undefined) return false;
      const day = today();
      if (decided?.runId === runId && decided.day === day) return false;
      const shown = day !== null && (read() === day || server()?.acknowledgedDay === day);
      decided = { runId, day };
      if (day !== null && !shown) write(day);
      return !shown;
    },
  };
}
