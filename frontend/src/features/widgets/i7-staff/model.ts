import { addIsoDays, addIsoMonths, parseIsoDate, toIsoDate } from '../../../ui';

export type PeriodMode = 'week' | 'month';
/** Day of week (0 = Sunday) of a store-local `YYYY-MM-DD`; read in UTC so the device time zone never matters. */
const weekday = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay();
export function periodFor(value: string, mode: PeriodMode) {
  if (mode === 'week') {
    const startDate = addIsoDays(value, -((weekday(value) + 6) % 7));
    return { startDate, endDate: addIsoDays(startDate, 6) };
  }
  const startDate = toIsoDate({ ...parseIsoDate(value)!, d: 1 });
  return { startDate, endDate: addIsoDays(addIsoMonths(startDate, 1), -1) };
}
/** Weeks move by 7 days; months keep the day of the month, clamped to the shorter month. */
export function shiftPeriod(value: string, mode: PeriodMode, amount: number): string {
  return mode === 'week' ? addIsoDays(value, amount * 7) : addIsoMonths(value, amount);
}
export function daysInPeriod(start: string, end: string): string[] {
  const days: string[] = []; for (let day = start; day <= end; day = addIsoDays(day, 1)) days.push(day); return days;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The store-local business day turns over at 05:00, so a shift that ends before that after starting later runs into the next day. */
const BUSINESS_DAY_STARTS = '05:00';
export const SAME_DAY_ONLY = '근무는 같은 날 안에서만 정할 수 있어요';
export const END_AFTER_START = '퇴근 시각은 출근 시각보다 뒤여야 해요';
export function validateSchedule(kind: 'work' | 'off', start: string, end: string, breakMinutes: number | null): string | null {
  if (kind === 'off') return null;
  if (!TIME.test(start) || !TIME.test(end)) return END_AFTER_START;
  if (end < start && end <= BUSINESS_DAY_STARTS) return SAME_DAY_ONLY;
  if (end <= start) return END_AFTER_START;
  if (breakMinutes === null || !Number.isInteger(breakMinutes) || breakMinutes < 0) return '휴게 시간은 0분 이상 넣어 주세요';
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return breakMinutes >= minutes(end) - minutes(start) ? '휴게 시간은 근무 시간보다 짧아야 해요' : null;
}
