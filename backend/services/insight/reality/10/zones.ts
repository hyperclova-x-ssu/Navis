import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { InsightError } from '../../scope.ts';
import { appendObservationEvent, type WriteContext } from './commands.ts';
import { id, invalid, number, object, revision } from './wire.ts';

type Zone = { zoneId: string; zoneVersionId: string; cameraId: string; zoneSetRevision: number; label: string | null; polygon: Point[] | null };
type Point = { x: number; y: number };
const sources = ['cctv.zones', 'cctv.table-links', 'briefing'];
const activeZones = `SELECT coalesce(z.zone_id, v.zone_version_id) AS "zoneId", v.zone_version_id AS "zoneVersionId",
    v.camera_id AS "cameraId", v.zone_set_revision::float8 AS "zoneSetRevision", z.label, z.polygon
  FROM insight.camera c JOIN insight.table_zone v USING (store_id, camera_id, zone_set_revision)
  LEFT JOIN insight.configured_zone z USING (store_id, camera_id, zone_set_revision, zone_version_id)
  WHERE c.store_id=$1`;

export async function listZones(db: PoolClient, storeId: string, camera: string | null, cursor: string | null, limit: number) {
  const { rows } = await db.query<Zone & { linkRevision: number }>(`SELECT zones.*, coalesce(l.revision, 0) AS "linkRevision"
    FROM (${activeZones}) zones LEFT JOIN insight.zone_table_link l ON l.store_id=$1 AND l.zone_id=zones."zoneId"
    WHERE ($2::uuid IS NULL OR "cameraId"=$2) AND ($3::uuid IS NULL OR "zoneId">$3)
    ORDER BY "zoneId" LIMIT $4`, [storeId, camera, cursor, limit + 1]);
  return rows;
}

export async function listLinks(db: PoolClient, storeId: string, camera: string | null, cursor: string | null, limit: number) {
  const { rows } = await db.query<{ zoneId: string }>(`
    SELECT z."zoneId", z."cameraId", z."zoneVersionId", z."zoneSetRevision", l.table_id AS "tableId", l.revision,
      CASE WHEN p.archived THEN 'archived' ELSE 'active' END AS "tableState"
    FROM (${activeZones}) z JOIN insight.zone_table_link l ON l.store_id=$1 AND l.zone_id=z."zoneId"
      AND l.camera_id=z."cameraId"
    JOIN insight.pos_table_source p USING (store_id, table_id)
    WHERE ($2::uuid IS NULL OR z."cameraId"=$2) AND ($3::uuid IS NULL OR z."zoneId">$3)
    ORDER BY z."zoneId" LIMIT $4`, [storeId, camera, cursor, limit + 1]);
  return rows;
}

function polygon(value: unknown): Point[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 32) invalid();
  const points = value.map(entry => {
    const p = object(entry, ['x', 'y']);
    return { x: number(p.x, 0, 1), y: number(p.y, 0, 1) };
  });
  if (new Set(points.map(({ x, y }) => `${x},${y}`)).size !== points.length) invalid();
  const area = points.reduce((sum, p, index) => {
    const next = points[(index + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0);
  if (Math.abs(area) < 1e-8) invalid();
  return points;
}

export async function setZones({ db, storeId, at }: WriteContext, camera: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'zones', 'confirmed']);
  const expected = revision(input.expectedRevision);
  if (!Array.isArray(input.zones) || input.zones.length > 256
      || (input.confirmed !== undefined && typeof input.confirmed !== 'boolean')) invalid();
  const { rows: [current] } = await db.query<{ revision: number }>(`
    SELECT zone_set_revision::float8 AS revision FROM insight.camera WHERE store_id=$1 AND camera_id=$2 FOR UPDATE`, [storeId, camera]);
  if (!current) throw new InsightError(404, 'CAMERA_NOT_FOUND');
  if (current.revision !== expected) throw new InsightError(409, 'STALE_REVISION');
  const { rows: prior } = await db.query<Zone>(`SELECT * FROM (${activeZones}) zones WHERE "cameraId"=$2`, [storeId, camera]);
  const known = new Set(prior.map(zone => zone.zoneId));
  const zones = input.zones.map(raw => {
    const zone = object(raw, ['zoneId', 'label', 'polygon']);
    if (typeof zone.label !== 'string') invalid();
    const label = zone.label.trim().normalize('NFC');
    if (!label || [...label].length > 40 || /[\p{Cc}\p{Cf}]/u.test(label)) invalid();
    const zoneId = zone.zoneId === undefined ? randomUUID() : id(zone.zoneId);
    if (zone.zoneId !== undefined && !known.has(zoneId)) throw new InsightError(404, 'ZONE_NOT_FOUND');
    return { zoneId, zoneVersionId: randomUUID(), label, polygon: polygon(zone.polygon) };
  });
  const kept = new Set(zones.map(zone => zone.zoneId));
  if (kept.size !== zones.length) invalid();
  const removed = [...known].filter(zone => !kept.has(zone));
  if (removed.length && input.confirmed !== true) throw new InsightError(400, 'CONFIRMATION_REQUIRED');
  await db.query(`UPDATE insight.zone_table_link SET table_id=NULL, revision=revision+1
    WHERE store_id=$1 AND zone_id=ANY($2::uuid[]) AND table_id IS NOT NULL`, [storeId, removed]);
  const next = expected + 1;
  await db.query(`UPDATE insight.camera SET zone_set_revision=$3 WHERE store_id=$1 AND camera_id=$2`, [storeId, camera, next]);
  await db.query(`WITH zones AS (
    SELECT * FROM jsonb_to_recordset($4::jsonb) AS z("zoneId" uuid, "zoneVersionId" uuid, label text, polygon jsonb)
  ), versions AS (
    INSERT INTO insight.table_zone (store_id, camera_id, zone_set_revision, zone_version_id)
    SELECT $1,$2,$3,"zoneVersionId" FROM zones RETURNING zone_version_id
  ) INSERT INTO insight.configured_zone (store_id, camera_id, zone_set_revision, zone_version_id, zone_id, label, polygon)
    SELECT $1,$2,$3,z."zoneVersionId",z."zoneId",z.label,z.polygon FROM zones z JOIN versions v ON v.zone_version_id=z."zoneVersionId"`,
  [storeId, camera, next, JSON.stringify(zones)]);
  await appendObservationEvent(db, storeId, at, 'insight.zone_changed.v1', camera, { cameraId: camera, zoneSetRevision: next });
  return { resourceId: camera, revision: next, affectedSources: ['cctv.cameras', ...sources] };
}

export async function setLink({ db, storeId, at }: WriteContext, zone: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'tableId', 'confirmed']);
  const expected = revision(input.expectedRevision);
  const table = input.tableId === null ? null : id(input.tableId);
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') invalid();
  if (table === null && input.confirmed !== true) throw new InsightError(400, 'CONFIRMATION_REQUIRED');
  const { rows: [current] } = await db.query<{ cameraId: string; revision: number; tableId: string | null }>(`
    SELECT z."cameraId", coalesce(l.revision, 0) AS revision, l.table_id AS "tableId"
    FROM (${activeZones}) z LEFT JOIN insight.zone_table_link l ON l.store_id=$1 AND l.zone_id=z."zoneId"
    WHERE z."zoneId"=$2`, [storeId, zone]);
  if (!current) throw new InsightError(404, 'ZONE_NOT_FOUND');
  if (current.revision !== expected) throw new InsightError(409, 'STALE_REVISION');
  if (table) {
    const active = await db.query(`SELECT 1 FROM insight.pos_table_source WHERE store_id=$1 AND table_id=$2 AND NOT archived FOR SHARE`,
      [storeId, table]);
    if (!active.rowCount) throw new InsightError(409, 'TABLE_UNAVAILABLE');
    const conflict = await db.query(`SELECT 1 FROM insight.zone_table_link WHERE store_id=$1 AND table_id=$2 AND zone_id<>$3`,
      [storeId, table, zone]);
    if (conflict.rowCount || (current.tableId && current.tableId !== table)) throw new InsightError(409, 'LINK_IN_USE');
  }
  if (current.tableId === table) return { resourceId: zone, revision: expected, affectedSources: [] };
  const next = expected + 1;
  await db.query(`INSERT INTO insight.zone_table_link (store_id, camera_id, zone_id, table_id, revision)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (store_id, zone_id) DO UPDATE SET table_id=EXCLUDED.table_id, revision=EXCLUDED.revision`,
  [storeId, current.cameraId, zone, table, next]);
  await appendObservationEvent(db, storeId, at, 'insight.zone_changed.v1', zone, { zoneId: zone, tableId: table, revision: next });
  return { resourceId: zone, revision: next, affectedSources: [...sources, 'pos.tables'] };
}
