import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { readSales } from '../../sales.ts';
import { inStore, InsightError, isDate, requireOwner, type StoreParams } from '../../scope.ts';
import { listCameras } from '../10/cameras.ts';
import { environmentSummary } from '../10/environment.ts';
import { businessDay, object } from '../11/commands.ts';
import { briefingFacts } from '../11/records.ts';
import { acknowledge, readAck } from './ack.ts';
import { arrivalDay, dayPeriod, readSources, type BriefingContext, type Readers } from './briefing.ts';

const prefix = '/internal/v1/insight/stores/:storeId';
export const briefingRoutes = [
  ['GET', '/insight/briefings'],
  ['POST', '/insight/briefings/:businessDay/ack'],
] as const;

export type BriefingOptions = {
  gatewayToken: string;
  now?: () => Date;
  readers?: Readers;
  readOpenings?: (ctx: BriefingContext) => Promise<readonly string[] | undefined>;
};

export function registerBriefing(app: FastifyInstance, pool: Pool, {
  gatewayToken, now = () => new Date(), readers, readOpenings,
}: BriefingOptions) {
  function context(req: FastifyRequest<{ Params: StoreParams }>): BriefingContext {
    const owner = requireOwner(req, gatewayToken);
    const at = now();
    const tz = req.headers['x-navis-store-timezone'];
    const start = req.headers['x-navis-business-day-start'];
    if (typeof tz !== 'string' || typeof start !== 'string') throw new InsightError(503, 'STORE_CLOCK_UNAVAILABLE');
    return { ...owner, now: at, timezone: tz, businessDayStart: start, businessDay: businessDay(at, tz, start) };
  }

  const sources: Readers = {
    sales: async ctx => {
      const { days, hours } = await readSales(pool, ctx.storeId, ctx.businessDay, ctx.businessDay);
      return { period: dayPeriod(ctx), data: { projectedNetSales: days[0]?.netSales ?? 0, hours } };
    },
    environment: ctx => inStore(pool, ctx.storeId, async db => {
      const { asOf, ...data } = await environmentSummary(db, ctx.storeId, ctx.now);
      return { period: null, asOf, data };
    }, true),
    cctv: ctx => inStore(pool, ctx.storeId, async db => {
      const rows = await listCameras(db, ctx.storeId, ctx.now, null, 100);
      const cameras = rows.slice(0, 100);
      const current = cameras.filter(camera => camera.deviceStatus === 'registered' && camera.measurementStatus !== 'none');
      const { rows: measurements } = await db.query<{
        cameraId: string; observedUntil: Date; bucketStart: Date; bucketMinutes: number;
        avgInStore: number | null; maxInStore: number | null;
      }>(`
        SELECT c.id AS "cameraId", p.observed_until AS "observedUntil", p.bucket_start AS "bucketStart",
          p.bucket_minutes AS "bucketMinutes", p.avg_in_store AS "avgInStore", p.max_in_store AS "maxInStore"
        FROM unnest($2::uuid[], $3::bigint[]) AS c(id, revision)
        JOIN LATERAL (
          SELECT observed_until, bucket_start, bucket_minutes, avg_in_store, max_in_store
          FROM insight.people_count_bucket
          WHERE store_id=$1 AND camera_id=c.id AND zone_set_revision=c.revision AND observed_until BETWEEN $4 AND $5
          ORDER BY bucket_start DESC LIMIT 1
        ) p ON true`, [ctx.storeId, current.map(camera => camera.cameraId), current.map(camera => camera.zoneSetRevision),
        new Date(ctx.now.getTime() - 15 * 60_000), ctx.now]);
      const byCamera = new Map(measurements.map(({ cameraId, ...measurement }) => [cameraId, measurement]));
      const data = cameras.map(camera => ({ ...camera, currentMeasurement: byCamera.get(camera.cameraId) ?? null }));
      return { period: null, asOf: ctx.now.toISOString(), partial: rows.length > 100, data };
    }, true),
    manualsGrants: ctx => inStore(pool, ctx.storeId, async db => {
      const { businessDay, asOf, sourceRevision, ...data } = await briefingFacts({ ...ctx, db });
      return { period: { from: businessDay, to: businessDay }, asOf, sourceRevision, data };
    }, true),
    ...readers,
  };

  app.get<{ Params: StoreParams }>(prefix + briefingRoutes[0][1], async req => {
    const ctx = context(req);
    object(req.query, []);
    const [acknowledgement, projections, openings] = await Promise.all([
      inStore(pool, ctx.storeId, db => readAck(db, ctx.storeId, ctx.businessDay), true),
      readSources(ctx, sources),
      readOpenings?.(ctx).catch(() => undefined),
    ]);
    return { businessDay: ctx.businessDay, arrivalDay: arrivalDay(ctx, openings), asOf: ctx.now.toISOString(),
      acknowledgement, sources: projections };
  });

  app.post<{ Params: StoreParams & { businessDay: string } }>(prefix + briefingRoutes[1][1], {
    bodyLimit: 1_024,
    onRequest: async req => { requireOwner(req, gatewayToken); },
  }, async req => {
    const ctx = context(req);
    const { businessDay: day } = req.params;
    object(req.query, []);
    object(req.body === undefined ? {} : req.body, []);
    if (!isDate(day)) throw new InsightError(400, 'INVALID_BUSINESS_DAY');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
      throw new InsightError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    return acknowledge(pool, ctx, day, key);
  });
}
