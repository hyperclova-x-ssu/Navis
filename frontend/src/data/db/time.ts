/**
 * Fixed store-local clock for the mockup (DATA_MODEL 10.9, ADR-0003).
 * Pure ISO-date arithmetic: no Date.now(), no device timezone, no Date parsing.
 */
import manifest from './generated/manifest.json';
import { POS_BUSINESS_DATE as TODAY, POS_NOW_TIME as NOW_TIME, POS_NOW as NOW } from '../../pos/clock';

export { TODAY, NOW_TIME, NOW };
export const LEGACY_BOOKING_VIEW_TIME = NOW_TIME;
export const LEGACY_MARKETING_VALIDATION_NOW = NOW;
export const LEGACY_GRANT_EVALUATION_NOW = NOW;
export const MINIMUM_WAGE = 10_320;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const monthDays = (y: number, m: number): number => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  return m >= 1 && m <= 12 && d >= 1 && d <= monthDays(y, m);
}

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** Days since 1970-01-01 (civil-from-days algorithm, proleptic Gregorian). */
export function dayNumber(iso: string): number {
  const match = DATE_RE.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  let y = Number(match[1]);
  const m = Number(match[2]), d = Number(match[3]);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): string {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const addDays = (iso: string, days: number): string => fromDayNumber(dayNumber(iso) + days);
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
/** 1 = Monday … 7 = Sunday (store weeks start on Monday). */
export const weekdayOf = (iso: string): number => ((((dayNumber(iso) + 3) % 7) + 7) % 7) + 1;
export const inRange = (iso: string, start: string, end: string): boolean => iso >= start && iso <= end;
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let n = dayNumber(start), last = dayNumber(end); n <= last; n++) out.push(fromDayNumber(n));
  return out;
}
export const hourOf = (time: string): number => Number(time.slice(0, 2));
export const dateOf = (stamp: string): string => stamp.slice(0, 10);
export const timeOf = (stamp: string): string => stamp.slice(11, 16);

export const TOMORROW = addDays(TODAY, 1);
export const YESTERDAY = addDays(TODAY, -1);
export const WEEK_START = addDays(TODAY, 1 - weekdayOf(TODAY));
export const WEEK_END = addDays(WEEK_START, 6);
export const MONTH_START = `${TODAY.slice(0, 7)}-01`;
export const LAST_MONTH_END = addDays(MONTH_START, -1);
export const LAST_MONTH_START = `${LAST_MONTH_END.slice(0, 7)}-01`;
export const LAST_WEEK_SAME_DAY = manifest.comparison.businessDate;
