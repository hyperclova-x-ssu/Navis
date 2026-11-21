/**
 * Pure date helpers for the kit DateField calendar (K-C). Store-local `YYYY-MM-DD` strings only: no Date from the device clock,
 * no time zone. Weeks start on Monday, like the 캘린더 and 직원 스케줄표 widgets.
 */
export interface IsoParts { readonly y: number; readonly m: number; readonly d: number }

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** UTC day count since 1970-01-01 of a calendar date. Day arithmetic goes through this so there is no DST or zone drift. */
const toDayNumber = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const fromDayNumber = (n: number): IsoParts => { const x = new Date(n * 86400000); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };

export function parseIsoDate(iso: string | null | undefined): IsoParts | null {
  const match = iso ? ISO.exec(iso.slice(0, 10)) : null;
  if (!match) return null;
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}
export const toIsoDate = ({ y, m, d }: IsoParts): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const addDays = (iso: string, days: number): string => { const p = parseIsoDate(iso)!; return toIsoDate(fromDayNumber(toDayNumber(p.y, p.m, p.d) + days)); };
/** Same day of the month, clamped to the shorter month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  const p = parseIsoDate(iso)!; const index = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(index / 12); const m = (index % 12 + 12) % 12 + 1;
  return toIsoDate({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}
/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (iso: string): number => { const p = parseIsoDate(iso)!; return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; };
export const compareIso = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const clampIso = (iso: string, min?: string, max?: string): string => (min && iso < min ? min : max && iso > max ? max : iso);
export const isDisabledDay = (iso: string, min?: string, max?: string): boolean => (min !== undefined && iso < min) || (max !== undefined && iso > max);

export interface CalendarDay { readonly iso: string; readonly day: number; readonly inMonth: boolean }
/** Six Monday-first weeks that cover the month: the same grid height every month, so the popover never jumps. */
export function monthMatrix(y: number, m: number): readonly (readonly CalendarDay[])[] {
  const first = toIsoDate({ y, m, d: 1 });
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, col) => {
    const iso = addDays(start, week * 7 + col); const p = parseIsoDate(iso)!;
    return { iso, day: p.d, inMonth: p.y === y && p.m === m };
  }));
}
/** The seven ISO dates of the week that holds `iso`, Monday first (used for the weekday header names). */
export const weekHeaderDates = (iso: string): readonly string[] => { const start = addDays(iso, -weekdayIndex(iso)); return Array.from({ length: 7 }, (_, i) => addDays(start, i)); };

/** Time slots `HH:MM` from `min` to `max` (inclusive) every `step` minutes. */
export function timeSlots(step = 30, min = '00:00', max = '23:59'): readonly string[] {
  const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; };
  const out: string[] = []; const safeStep = Math.max(1, Math.floor(step));
  for (let at = toMin(min); at <= toMin(max); at += safeStep) out.push(`${pad(Math.floor(at / 60))}:${pad(at % 60)}`);
  return out;
}
export const isTimeString = (value: string | null | undefined): value is string => !!value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
