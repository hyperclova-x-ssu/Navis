import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createObjectStorage, type ObjectStorage } from '../../packages/object-storage/index.ts';
import { transact } from '../../packages/streams/transaction.ts';
import { fingerprint, hash, InsightError, inStore, isUuid, requireOwner, setStore, type StoreParams } from './scope.ts';
import { appendObservationEvent } from './reality/10/commands.ts';

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
      ) FOR SHARE OF c`, [storeId, cameraId, zoneRevision, zoneIds]);
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
    await appendObservationEvent(db, storeId, now, 'insight.cctv_bucket_recorded.v1', cameraId,
      { cameraId, bucketStart: start, zoneSetRevision: zoneRevision, status });
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

export const cctvSampleTypes = {
  'store-sample.mp4': 'video/mp4', 'store-sample-detections.json': 'application/json',
  'cafe17.mp4': 'video/mp4', 'cafe17-detections.json': 'application/json',
} as const;
type SampleAsset = keyof typeof cctvSampleTypes;
type SampleRow = { object_key: string; sha256: string; bytes: number; content_type: string };

function cctvSampleRange(header: string, size: number) {
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(size - 1, last) : size - 1;
  return start <= end ? { start, end } : null;
}

export function registerCctvSampleMedia(routes: FastifyInstance, pool: Pool, gatewayToken: string,
  storage?: ObjectStorage | null) {
  const objects = storage === undefined && process.env.NAVIS_OBJECT_STORAGE_MEDIA_ENABLED === '1'
    ? createObjectStorage() : storage;
  routes.get<{ Params: StoreParams & { asset: string } }>(
    '/internal/v1/insight/stores/:storeId/insight/cctv-samples/:asset', async (req, reply) => {
      const { storeId } = requireOwner(req, gatewayToken);
      const { asset } = req.params;
      if (!Object.hasOwn(cctvSampleTypes, asset)) throw new InsightError(404, 'NOT_FOUND');
      if (!objects) throw new InsightError(404, 'CCTV_SAMPLE_BUNDLED');
      const row = await inStore(pool, storeId, async db => (await db.query<SampleRow>(`
        SELECT object_key, sha256, bytes, content_type FROM insight.cctv_sample_media
        WHERE store_id = $1 AND asset = $2`, [storeId, asset])).rows[0], true);
      if (!row) throw new InsightError(404, 'NOT_FOUND');
      const etag = `"${row.sha256}"`;
      const cache = () => reply.header('cache-control', 'private, max-age=86400')
        .header('etag', etag).header('vary', 'Authorization');
      if (req.headers['if-none-match']?.split(',').some(value => {
        const match = value.trim();
        return match === '*' || match.replace(/^W\//, '') === etag;
      })) return cache().code(304).send();

      const range = req.headers.range ? cctvSampleRange(req.headers.range, row.bytes) : undefined;
      if (range === null) return reply.code(416).header('content-range', `bytes */${row.bytes}`).send();
      let object;
      try {
        object = range ? await objects.getRange?.(row.object_key, `bytes=${range.start}-${range.end}`)
          : await objects.get(row.object_key);
      } catch {
        throw new InsightError(503, 'SERVICE_UNAVAILABLE');
      }
      const length = range ? range.end - range.start + 1 : row.bytes;
      const contentRange = range && `bytes ${range.start}-${range.end}/${row.bytes}`;
      if (!object || object.contentLength !== length || object.contentType !== row.content_type
          || (contentRange && object.contentRange !== contentRange)) {
        object?.body.destroy();
        throw new InsightError(503, 'SERVICE_UNAVAILABLE');
      }
      cache().type(row.content_type).header('accept-ranges', 'bytes').header('content-length', length)
        .header('x-content-type-options', 'nosniff');
      if (contentRange) reply.code(206).header('content-range', contentRange);
      return reply.send(object.body);
    });
}

/** Seed only the repository's approved example files. Live camera footage stays on the device. */
export async function seedCctvSampleMedia(pool: Pool, storage: ObjectStorage, storeId: string, asset: SampleAsset, bytes: Buffer) {
  if (!isUuid(storeId) || !Object.hasOwn(cctvSampleTypes, asset) || !bytes.length || bytes.length > 32 * 1024 * 1024) {
    throw new Error('Invalid CCTV sample');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `stores/${storeId}/insight/cctv-samples/${sha256}/${asset}`;
  const mime = cctvSampleTypes[asset];
  await storage.put(key, bytes, mime);
  await inStore(pool, storeId, db => db.query(`
    INSERT INTO insight.cctv_sample_media (store_id, asset, content_type, object_key, sha256, bytes)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (store_id, asset) DO UPDATE SET
      object_key = EXCLUDED.object_key, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, updated_at = clock_timestamp()
    WHERE cctv_sample_media.sha256 <> EXCLUDED.sha256`, [storeId, asset, mime, key, sha256, bytes.length]));
}
