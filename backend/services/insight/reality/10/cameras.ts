import type { PoolClient } from 'pg';

type Camera = { cameraId: string; zoneSetRevision: number; lastObservedAt: Date | null;
  measurementStatus: 'ok' | 'partial' | 'none'; deviceStatus: 'registered' | 'unavailable' };
type Bucket = { cameraId: string; bucketStart: Date; bucketMinutes: number; zoneSetRevision: number; observedUntil: Date;
  status: 'ok' | 'partial' | 'none'; avgInStore: number | null; maxInStore: number | null;
  entries: { zoneVersionId: string; zoneId: string; occupiedSeconds: number; finishedSessions: number;
    finishedSecondsSum: number; toClearEvents: number }[] };

export async function listCameras(db: PoolClient, storeId: string, now: Date, cursor: string | null, limit: number) {
  const { rows } = await db.query<Camera>(`
    SELECT c.camera_id AS "cameraId", c.zone_set_revision::float8 AS "zoneSetRevision", p.observed_until AS "lastObservedAt",
      CASE WHEN p.observed_until >= $2::timestamptz - interval '15 minutes' THEN p.status ELSE 'none' END AS "measurementStatus",
      CASE WHEN EXISTS (SELECT 1 FROM insight.cctv_device d WHERE d.store_id=c.store_id AND d.camera_id=c.camera_id
        AND d.revoked_at IS NULL AND d.expires_at>$2) THEN 'registered' ELSE 'unavailable' END AS "deviceStatus"
    FROM insight.camera c LEFT JOIN LATERAL (
      SELECT observed_until, status FROM insight.people_count_bucket
      WHERE store_id=c.store_id AND camera_id=c.camera_id AND zone_set_revision=c.zone_set_revision AND observed_until<=$2
      ORDER BY bucket_start DESC LIMIT 1
    ) p ON true WHERE c.store_id=$1 AND ($3::uuid IS NULL OR c.camera_id>$3)
    ORDER BY c.camera_id LIMIT $4`, [storeId, now, cursor, limit + 1]);
  return rows;
}

export async function listBuckets(db: PoolClient, storeId: string, cameraId: string | null, from: Date, to: Date,
  cursor: [Date | null, string | null], limit: number) {
  const { rows } = await db.query<Bucket>(`
    SELECT p.camera_id AS "cameraId", p.bucket_start AS "bucketStart", p.bucket_minutes AS "bucketMinutes",
      p.zone_set_revision::float8 AS "zoneSetRevision", p.observed_until AS "observedUntil", p.status,
      p.avg_in_store AS "avgInStore", p.max_in_store AS "maxInStore", coalesce((SELECT jsonb_agg(jsonb_build_object(
        'zoneVersionId', b.zone_version_id, 'zoneId', coalesce(z.zone_id, b.zone_version_id), 'occupiedSeconds', b.occupied_seconds,
        'finishedSessions', b.finished_sessions, 'finishedSecondsSum', b.finished_seconds_sum, 'toClearEvents', b.to_clear_events
      ) ORDER BY b.zone_version_id) FROM insight.table_occupancy_bucket b
      LEFT JOIN insight.configured_zone z USING (store_id, camera_id, zone_set_revision, zone_version_id)
      WHERE (b.store_id,b.camera_id,b.bucket_start,b.bucket_minutes)=(p.store_id,p.camera_id,p.bucket_start,p.bucket_minutes)
    ), '[]'::jsonb) AS entries
    FROM insight.people_count_bucket p WHERE p.store_id=$1 AND ($2::uuid IS NULL OR p.camera_id=$2)
      AND p.bucket_start >= $3 AND p.bucket_start < $4
      AND ($5::timestamptz IS NULL OR (p.bucket_start, p.camera_id) < ($5, $6::uuid))
    ORDER BY p.bucket_start DESC, p.camera_id DESC LIMIT $7`, [storeId, cameraId, from, to, ...cursor, limit + 1]);
  return rows;
}
