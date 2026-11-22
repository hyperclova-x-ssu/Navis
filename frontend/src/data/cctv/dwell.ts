import { seedSupplement } from '../db/cafe-fixtures';
import { NOW_TIME } from '../db/time';

/** D-313 takes dwell and visit counts from the cafe sample, with separate source order counts. */
export interface DwellRow { readonly hour: number; readonly label: string; readonly avgGuests: number; readonly orders: number; readonly visits?: number; readonly provenance?: 'sample'; readonly hours: number; readonly minutes: number }

export function dwellMinutes(avgGuests: number, orders: number, hours: number): number {
  if (orders <= 0 || hours <= 0) return 0;
  return Math.round(avgGuests / (orders / hours) * 60);
}

const cutoffHour = Number(NOW_TIME.slice(0, 2));
const cutoffMinute = Number(NOW_TIME.slice(3, 5));
export const HOURLY_DWELL: readonly DwellRow[] = Object.freeze(seedSupplement.cctv.map(row => {
  const hours = row.hour === cutoffHour ? cutoffMinute / 60 : 1;
  return Object.freeze({
    hour: row.hour, label: `${row.hour}시`, visits: row.entries, orders: row.orderCount, hours, minutes: row.dwellMinutes,
    avgGuests: hours > 0 ? row.entries * row.dwellMinutes / (hours * 60) : 0,
    provenance: row.provenance,
  });
}));
const visits = HOURLY_DWELL.reduce((total, row) => total + (row.visits ?? 0), 0);
export const TODAY_AVG_DWELL_MIN = visits > 0
  ? Math.round(HOURLY_DWELL.reduce((total, row) => total + (row.visits ?? 0) * row.minutes, 0) / visits) : 0;

/** Whole minutes and leftover seconds; the screen turns this into localized text (no Korean here). */
export function splitSeconds(seconds: number): {readonly minutes: number; readonly seconds: number} {
  const s = Math.max(0, Math.round(seconds));
  return {minutes: Math.floor(s / 60), seconds: s % 60};
}
