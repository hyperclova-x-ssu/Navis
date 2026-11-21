import type { Pool } from 'pg';
import { transact } from '../../packages/streams/transaction.ts';
import { fingerprint, hash, InsightError, inStore, isUuid, setStore } from './scope.ts';

const bucketMinutes = 5;
const bucketMs = bucketMinutes * 60_000;
const integer = (minimum = 0, maximum = 2_147_483_647) => ({ type: 'integer', minimum, maximum });
const nullableNumber = (type: 'number' | 'integer') => ({ type: [type, 'null'], minimum: 0, maximum: 2_147_483_647 });
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' };
const utc = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' };
const fields = {
  zone_version_id: uuid, occupied_seconds: integer(0, 300), finished_sessions: integer(),
  finished_seconds_sum: integer(0, Number.MAX_SAFE_INTEGER), to_clear_events: integer(),
};
const properties = {
  schema_version: { const: 1 }, camera_id: uuid, zone_set_revision: integer(0, Number.MAX_SAFE_INTEGER),
  bucket_start: utc, bucket_minutes: { const: bucketMinutes }, observed_until: utc,
  status: { enum: ['ok', 'partial', 'none'] }, avg_in_store: nullableNumber('number'), max_in_store: nullableNumber('integer'),
  entries: { type: 'array', maxItems: 256, items: { type: 'object', additionalProperties: false, required: Object.keys(fields), properties: fields } },
};
export const aggregateSchema = { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };

type Zone = {
  zone_version_id: string;
  occupied_seconds: number;
  finished_sessions: number;
  finished_seconds_sum: number;
  to_clear_events: number;
};
export type Aggregate = {
  schema_version: 1; camera_id: string; zone_set_revision: number; bucket_minutes: 5;
  bucket_start: string; observed_until: string; status: 'ok' | 'partial' | 'none';
  avg_in_store: number | null; max_in_store: number | null; entries: Zone[];
};

function canonicalUtc(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new InsightError(400, 'INVALID_REQUEST');
  const iso = new Date(time).toISOString();
  if (value.slice(0, 19) !== iso.slice(0, 19)) throw new InsightError(400, 'INVALID_REQUEST');
  return iso;
}

export function registerCamera(pool: Pool, config: {
  storeId: string; cameraId: string; zoneRevision: number; zoneIds: string[];
  deviceId: string; token: string; expiresAt: Date;
}) {
  const { storeId, cameraId, zoneRevision, zoneIds, deviceId, token, expiresAt } = config;
  if (![storeId, cameraId, deviceId, ...zoneIds].every(isUuid) || !Number.isSafeInteger(zoneRevision) || zoneRevision < 0
      || new Set(zoneIds).size !== zoneIds.length || token.length < 32 || !Number.isFinite(expiresAt.getTime())) {
    throw new Error('Invalid CCTV camera registration');
  }
  return inStore(pool, storeId, async db => {
    await db.query(`
      INSERT INTO insight.camera (store_id, camera_id, zone_set_revision) VALUES ($1,$2,$3)
      ON CONFLICT (store_id, camera_id) DO UPDATE SET zone_set_revision=EXCLUDED.zone_set_revision
      WHERE camera.zone_set_revision <= EXCLUDED.zone_set_revision`, [storeId, cameraId, zoneRevision]);
    await db.query(`
      INSERT INTO insight.table_zone (store_id, camera_id, zone_set_revision, zone_version_id)
      SELECT $1, $2, $3, unnest($4::uuid[]) ON CONFLICT DO NOTHING`, [storeId, cameraId, zoneRevision, zoneIds]);
    await db.query(`
      INSERT INTO insight.cctv_device (store_id, camera_id, device_id, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (store_id, device_id) DO NOTHING`, [storeId, cameraId, deviceId, hash(token), expiresAt]);
  });
}

export async function ingestAggregate(pool: Pool, token: string, body: Aggregate, now: Date) {
  return transact(pool, async db => {
    const tokenHash = hash(token);
    await db.query("SELECT set_config('app.cctv_token_hash', $1, true)", [tokenHash]);
    const { rows: [device] } = await db.query<{ store_id: string; camera_id: string }>(`
      SELECT store_id, camera_id FROM insight.cctv_device
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > $2`, [tokenHash, now]);
    if (!device) throw new InsightError(401, 'UNAUTHENTICATED');
    const { store_id: storeId, camera_id: cameraId } = device;
    if (body.camera_id !== cameraId) throw new InsightError(403, 'CAMERA_FORBIDDEN');
    await setStore(db, storeId);

    const { status, avg_in_store: avg, max_in_store: max, zone_set_revision: zoneRevision } = body;
    const start = canonicalUtc(body.bucket_start);
    const observed = canonicalUtc(body.observed_until);
    const startTime = Date.parse(start);
    const endTime = startTime + bucketMs;
    const observedTime = Date.parse(observed);
    const entries = body.entries.toSorted((a, b) => a.zone_version_id.localeCompare(b.zone_version_id));
    const zoneIds = entries.map(zone => zone.zone_version_id);
    if (startTime % bucketMs !== 0 || endTime > now.getTime() || observedTime < startTime || observedTime > endTime
        || (status === 'ok' && observedTime !== endTime)
        || (status === 'none' ? avg !== null || max !== null || entries.length > 0 : avg === null || max === null || avg > max)
        || new Set(zoneIds).size !== zoneIds.length
        || entries.some(entry => entry.occupied_seconds > (observedTime - startTime) / 1000
          || (entry.finished_sessions === 0 && entry.finished_seconds_sum !== 0))) {
      throw new InsightError(400, 'INVALID_REQUEST');
    }
    const key = fingerprint({ ...body, bucket_start: start, observed_until: observed, entries });
    const identity = [storeId, cameraId, start, bucketMinutes] as const;
    const current = async () => {
      const { rows: [existing] } = await db.query<{ fingerprint: string }>(`
        SELECT fingerprint FROM insight.people_count_bucket
        WHERE (store_id, camera_id, bucket_start, bucket_minutes)=($1,$2,$3,$4)`, [...identity]);
      if (!existing) return false;
      if (existing.fingerprint !== key) throw new InsightError(409, 'IDEMPOTENCY_MISMATCH');
      return true;
    };
    if (await current()) return true;
    const authorized = await db.query(`
      SELECT 1 FROM insight.camera c
      WHERE c.store_id=$1 AND c.camera_id=$2 AND c.zone_set_revision=$3 AND NOT EXISTS (
        SELECT zone FROM unnest($4::uuid[]) AS zone
        EXCEPT
        SELECT zone_version_id FROM insight.table_zone z
        WHERE z.store_id=c.store_id AND z.camera_id=c.camera_id AND z.zone_set_revision=c.zone_set_revision
      )`, [storeId, cameraId, zoneRevision, zoneIds]);
    if (!authorized.rowCount) throw new InsightError(409, 'ZONE_VERSION_MISMATCH');

    const inserted = await db.query(`
      INSERT INTO insight.people_count_bucket
        (store_id,camera_id,bucket_start,bucket_minutes,zone_set_revision,observed_until,status,avg_in_store,max_in_store,fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [...identity, zoneRevision, observed, status, avg, max, key]);
    if (!inserted.rowCount) return current();
    if (entries.length) await db.query(`
      INSERT INTO insight.table_occupancy_bucket
        (store_id,camera_id,bucket_start,bucket_minutes,zone_set_revision,zone_version_id,occupied_seconds,finished_sessions,finished_seconds_sum,to_clear_events)
      SELECT $1,$2,$3,$4,$5,zone_version_id,occupied_seconds,finished_sessions,finished_seconds_sum,to_clear_events
      FROM jsonb_to_recordset($6::jsonb) AS zone(
        zone_version_id uuid, occupied_seconds int, finished_sessions int, finished_seconds_sum bigint, to_clear_events int
      )`, [...identity, zoneRevision, JSON.stringify(entries)]);
    return false;
  });
}

export function readCctv(pool: Pool, storeId: string) {
  return inStore(pool, storeId, async db => {
    const { rows } = await db.query(`
      SELECT p.camera_id, p.bucket_start, p.bucket_minutes, p.zone_set_revision, p.observed_until,
        p.status, p.avg_in_store, p.max_in_store,
        coalesce((SELECT jsonb_agg(jsonb_build_object(
          'zone_version_id', z.zone_version_id, 'occupied_seconds', z.occupied_seconds, 'finished_sessions', z.finished_sessions,
          'finished_seconds_sum', z.finished_seconds_sum, 'to_clear_events', z.to_clear_events) ORDER BY z.zone_version_id)
          FROM insight.table_occupancy_bucket z
          WHERE (z.store_id,z.camera_id,z.bucket_start,z.bucket_minutes) = (p.store_id,p.camera_id,p.bucket_start,p.bucket_minutes)
        ), '[]'::jsonb) AS entries
      FROM insight.people_count_bucket p WHERE p.store_id=$1
      ORDER BY p.bucket_start DESC, p.camera_id LIMIT 24`, [storeId]);
    return { buckets: rows };
  }, true);
}
