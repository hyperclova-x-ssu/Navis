import type { CctvHourly, DataSnapshot } from '../../db/types';
import manifest from '../../db/generated/manifest.json';
import { addDays } from '../../db/time';
import { staffLocalTimestamp } from '../../iteration7/staff/clock';
import { staffCountAt } from '../../iteration7/staff/selectors';
import type { CameraDto, RealInsight } from './dto';

export function observationBusinessDate(timestamp: string) {
  const { date, time } = staffLocalTimestamp(timestamp);
  return time < manifest.store.businessDayStart ? addDays(date, -1) : date;
}

export function insightHours(insight: RealInsight, snapshot: DataSnapshot, cameraId?: string) {
  const byHour = new Map<number, { hour: number; max: number | null; partial: boolean; reviewMarked: boolean; staff: number | null }>();
  const reviewed = new Set(insight.reviews.map(review => review.hour));
  for (const bucket of insight.buckets) {
    if (cameraId && bucket.cameraId !== cameraId) continue;
    const { date, time } = staffLocalTimestamp(bucket.bucketStart);
    if (observationBusinessDate(bucket.bucketStart) !== insight.date) continue;
    const hour = Number(time.slice(0, 2));
    const row = byHour.get(hour) ?? { hour, max: null, partial: false, reviewMarked: reviewed.has(hour),
      staff: snapshot.tables.staffCalendarAsOf ? staffCountAt(snapshot.tables, date, hour) : null };
    if (bucket.maxInStore !== null && bucket.observedUntil > bucket.bucketStart) row.max = Math.max(row.max ?? 0, bucket.maxInStore);
    row.partial ||= bucket.status !== 'ok';
    byHour.set(hour, row);
  }
  return [...byHour.values()].sort((a, b) => a.hour - b.hour);
}

/**
 * The measured hours in the shape the original CCTV screens read (`cctvHourly`, PARITY-FIX-MGMT / D-355): one row per business date and hour,
 * `entries` is the highest in-store count a camera observed in that hour (the service measures no visits; the widget says so in its note),
 * `partial` when any bucket of the hour was not fully measured and `none` when no bucket carried a number. Hours without a bucket have no row.
 */
export function insightHourlyRows(insight: Pick<RealInsight, 'date' | 'buckets' | 'reviews'>): CctvHourly[] {
  const reviewed = new Set(insight.reviews.map(review => review.hour));
  const byHour = new Map<string, { businessDate: string; hour: number; max: number | null; partial: boolean }>();
  for (const bucket of insight.buckets) {
    const { time } = staffLocalTimestamp(bucket.bucketStart);
    const businessDate = observationBusinessDate(bucket.bucketStart);
    const hour = Number(time.slice(0, 2));
    const key = `${businessDate}:${hour}`;
    const row = byHour.get(key) ?? { businessDate, hour, max: null, partial: false };
    if (bucket.maxInStore !== null && bucket.observedUntil > bucket.bucketStart) row.max = Math.max(row.max ?? 0, bucket.maxInStore);
    row.partial ||= bucket.status !== 'ok';
    byHour.set(key, row);
  }
  return [...byHour.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.hour - b.hour).map(row => ({
    businessDate: row.businessDate, hour: row.hour, entries: row.max,
    status: row.max === null ? 'none' : row.partial ? 'partial' : 'ok',
    reviewMarked: row.businessDate === insight.date && reviewed.has(row.hour),
  }));
}

export const insightPeak =(hours: ReturnType<typeof insightHours>) => hours.reduce<(typeof hours)[number] | undefined>(
  (best, row) => row.max !== null && (!best || row.max > (best.max ?? -1)) ? row : best, undefined,
);

export function cameraMeasurement(camera: CameraDto) {
  return camera.deviceStatus === 'unavailable' ? '카메라 사용 불가'
    : camera.measurementStatus === 'none' ? '미측정' : camera.measurementStatus === 'partial' ? '일부 측정' : '측정됨';
}
