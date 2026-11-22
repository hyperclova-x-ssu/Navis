import { randomUUID } from 'node:crypto';
import { InsightError } from '../../scope.ts';
import { appendObservationEvent, type WriteContext } from './commands.ts';
import { instant, invalid, number, object, revision } from './wire.ts';
import type { PoolClient } from 'pg';

type Range = [number, number];
type Limits = { revision: number; temperatureRange: Range; humidityRange: Range };
export type Reading = { readingId: string; measuredAt: Date; temperatureC: number; humidityPct: number; source: 'manual' };
const defaults: Limits = { revision: 0, temperatureRange: [18, 25], humidityRange: [40, 60] };
const sources = ['environment.readings', 'environment.summary', 'briefing'];

export async function readLimits(db: PoolClient, storeId: string) {
  const { rows: [limits] } = await db.query<Limits>(`SELECT revision,
    jsonb_build_array(temperature_min, temperature_max) AS "temperatureRange",
    jsonb_build_array(humidity_min, humidity_max) AS "humidityRange"
    FROM insight.environment_limits WHERE store_id=$1`, [storeId]);
  return limits ?? defaults;
}

export async function recordReading({ db, storeId, at }: WriteContext, body: unknown) {
  const input = object(body, ['measuredAt', 'temperatureC', 'humidityPct']);
  const measuredAt = instant(input.measuredAt);
  if (measuredAt > at) invalid();
  const temperatureC = number(input.temperatureC, -50, 80);
  const humidityPct = number(input.humidityPct, 0, 100);
  const readingId = randomUUID();
  await db.query(`INSERT INTO insight.environment_reading (store_id, reading_id, measured_at, temperature_c, humidity_pct)
    VALUES ($1,$2,$3,$4,$5)`, [storeId, readingId, measuredAt, temperatureC, humidityPct]);
  await appendObservationEvent(db, storeId, at, 'insight.environment_reading_recorded.v1', readingId,
    { readingId, measuredAt, revision: 1, source: 'manual' });
  return { resourceId: readingId, revision: 1, affectedSources: sources };
}

function range(raw: unknown, min: number, max: number): Range {
  if (!Array.isArray(raw) || raw.length !== 2) invalid();
  const lower = number(raw[0], min, max);
  return [lower, number(raw[1], lower, max)];
}

export async function updateLimits({ db, storeId, at }: WriteContext, body: unknown) {
  const input = object(body, ['expectedRevision', 'temperatureRange', 'humidityRange']);
  const expected = revision(input.expectedRevision);
  const temperatureRange = range(input.temperatureRange, -50, 80);
  const humidityRange = range(input.humidityRange, 0, 100);
  if ((await readLimits(db, storeId)).revision !== expected) throw new InsightError(409, 'STALE_REVISION');
  const next = expected + 1;
  await db.query(`INSERT INTO insight.environment_limits
    (store_id, revision, temperature_min, temperature_max, humidity_min, humidity_max)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (store_id) DO UPDATE SET revision=EXCLUDED.revision,
      temperature_min=EXCLUDED.temperature_min, temperature_max=EXCLUDED.temperature_max,
      humidity_min=EXCLUDED.humidity_min, humidity_max=EXCLUDED.humidity_max`,
  [storeId, next, ...temperatureRange, ...humidityRange]);
  await appendObservationEvent(db, storeId, at, 'insight.environment_limits_changed.v1', storeId, { revision: next });
  return { resourceId: storeId, revision: next, affectedSources: ['environment.limits', 'environment.summary', 'briefing'] };
}

const readingFields = `reading_id AS "readingId", measured_at AS "measuredAt", temperature_c AS "temperatureC",
  humidity_pct AS "humidityPct", 'manual' AS source`;

export async function readReadings(db: PoolClient, storeId: string, from: Date, to: Date,
  cursor: [Date | null, string | null], limit: number) {
  const { rows } = await db.query<Reading>(`SELECT ${readingFields} FROM insight.environment_reading
    WHERE store_id=$1 AND measured_at >= $2 AND measured_at <= $3
      AND ($4::timestamptz IS NULL OR (measured_at, reading_id) < ($4, $5::uuid))
    ORDER BY measured_at DESC, reading_id DESC LIMIT $6`, [storeId, from, to, ...cursor, limit + 1]);
  return rows;
}

export async function environmentSummary(db: PoolClient, storeId: string, now: Date) {
  const { rows: [reading] } = await db.query<Reading>(`SELECT ${readingFields} FROM insight.environment_reading
    WHERE store_id=$1 AND measured_at <= $2 ORDER BY measured_at DESC, reading_id DESC LIMIT 1`, [storeId, now]);
  const limits = await readLimits(db, storeId);
  const alerts = [];
  if (reading) {
    for (const [metric, bounds] of [['temperatureC', limits.temperatureRange], ['humidityPct', limits.humidityRange]] as const) {
      const value = reading[metric];
      const direction = value < bounds[0] ? 'below' : value > bounds[1] ? 'above' : null;
      if (direction) alerts.push({ metric, direction, value, range: bounds, readingId: reading.readingId });
    }
  }
  return { current: reading ?? null, limits, alerts, asOf: now.toISOString() };
}
