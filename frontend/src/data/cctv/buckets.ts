import {seedCatalog} from '../db/generated/catalog';
import {NOW_TIME} from '../db/time';
import {HOURLY_DWELL} from './dwell';
import {TABLE_COUNT} from './snapshot';

/** `end` is null for the last, still running bucket ("until now"); the screen words it. */
export interface Bucket { readonly start: string; readonly end: string | null; readonly value: number }

export const NOW_MINUTE = Number(NOW_TIME.slice(0, 2)) * 60 + Number(NOW_TIME.slice(3, 5));
export const OPEN_MINUTE = HOURLY_DWELL[0] ? HOURLY_DWELL[0].hour * 60 : NOW_MINUTE;

const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// The sample camera covers three tables. The POS seed lists the whole café's tables.
const CAMERA_SHARE = TABLE_COUNT / seedCatalog.tables.length;
export const BUCKET_VALUES_15M: readonly number[] = Object.freeze(HOURLY_DWELL.flatMap(row =>
  Array.from({length: Math.ceil(row.hours * 4)}, () => row.avgGuests * CAMERA_SHARE)
));

function build(values: readonly number[], size: number): readonly Bucket[] {
  return Object.freeze(values.map((value, i) => {
    const s = OPEN_MINUTE + i * size, e = Math.min(s + size, NOW_MINUTE);
    return Object.freeze({start: fmt(s), end: e === NOW_MINUTE ? null : fmt(e), value});
  }));
}

export const CCTV_BUCKETS_15M: readonly Bucket[] = build(BUCKET_VALUES_15M, 15);

const CENTERS_15M = BUCKET_VALUES_15M.map((_, i) => {
  const start = OPEN_MINUTE + i * 15;
  return (start + Math.min(start + 15, NOW_MINUTE)) / 2;
});

/** Linear interpolation between 15-minute centres, held flat before the first / after the last centre. */
export function interpolateAt(minute: number): number {
  if (!CENTERS_15M.length) return 0;
  if (minute <= CENTERS_15M[0]) return BUCKET_VALUES_15M[0];
  const last = CENTERS_15M.length - 1;
  if (minute >= CENTERS_15M[last]) return BUCKET_VALUES_15M[last];
  let k = 0;
  while (CENTERS_15M[k + 1] < minute) k++;
  const f = (minute - CENTERS_15M[k]) / (CENTERS_15M[k + 1] - CENTERS_15M[k]);
  return BUCKET_VALUES_15M[k] + (BUCKET_VALUES_15M[k + 1] - BUCKET_VALUES_15M[k]) * f;
}

const COUNT_5M = Math.ceil((NOW_MINUTE - OPEN_MINUTE) / 5);

/** Interpolate at each five-minute bucket's centre, then round to one decimal. */
export const BUCKET_VALUES_5M: readonly number[] = Object.freeze(Array.from({length: COUNT_5M}, (_, i) => {
  const start = OPEN_MINUTE + i * 5;
  const centre = (start + Math.min(start + 5, NOW_MINUTE)) / 2;
  return Math.round(interpolateAt(centre) * 10) / 10;
}));
export const CCTV_BUCKETS: readonly Bucket[] = build(BUCKET_VALUES_5M, 5);

/** Wording is the screen's job (message keys `cctv.change.*`); this is only direction and people count. */
export type Change = {readonly direction: 'up' | 'down' | 'flat'; readonly count: number} | null;

/** Moving comparison (D-63): diff = round(now) − round(value exactly 5 minutes ago), people not percent. No earlier value → null (hide the line). */
export function bucketChange(now: number, before: number | null | undefined): Change {
  if (before == null || !Number.isFinite(before) || !Number.isFinite(now)) return null;
  const diff = Math.round(now) - Math.round(before);
  if (diff === 0) return {direction: 'flat', count: 0};
  return diff > 0 ? {direction: 'up', count: diff} : {direction: 'down', count: -diff};
}

/** Value of the series exactly 5 minutes before `minute` (before opening → null). */
export function valueFiveMinutesBefore(minute: number): number | null {
  return minute - 5 < OPEN_MINUTE ? null : interpolateAt(minute - 5);
}

/** The current headcount compared with the camera estimate five minutes before the demo clock. */
export function changeFor(now: number, minute: number = NOW_MINUTE): Change {
  return bucketChange(now, valueFiveMinutesBefore(minute));
}
