import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { InsightError, inStore, isDate, requireOwner, type StoreParams } from '../../scope.ts';
import { execute, type Receipt, type WriteContext } from './commands.ts';
import { environmentSummary, readLimits, readReadings, recordReading, updateLimits } from './environment.ts';
import { listZones, listLinks, setLink, setZones } from './zones.ts';
import { id, instant, invalid, object, pageQuery, period } from './wire.ts';
import { listBuckets, listCameras } from './cameras.ts';
import { listReviews, markReview, undoReview } from './reviews.ts';

const root = '/internal/v1/insight/stores/:storeId/insight';
const undoPath = '/receipts/:id/undo';
type Request = FastifyRequest<{ Params: StoreParams & { id?: string } }>;

async function sourceRevision(db: PoolClient, storeId: string) {
  const { rows: [source] } = await db.query<{ revision: number }>(
    'SELECT last_seq::float8 AS revision FROM insight.outbox_scope WHERE scope_key=$1', [storeId]);
  return source?.revision ?? 0;
}

function page<T>(rows: T[], limit: number, key: (row: T) => string) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? key(items[limit - 1]) : null };
}
const optionalId = (value: unknown) => value === undefined ? null : id(value);

function timedCursor(value: unknown): [Date | null, string | null] {
  if (value === undefined) return [null, null];
  if (typeof value !== 'string') invalid();
  const parts = value.split('|');
  if (parts.length !== 2) invalid();
  return [instant(parts[0]), id(parts[1])];
}

function commandKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new InsightError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return value;
}

export async function undoObservationReceipt(ctx: WriteContext, receiptId: string, body: unknown, query: unknown, key: string) {
  const { rowCount } = await ctx.db.query(
    'SELECT 1 FROM insight.observation_command WHERE store_id=$1 AND actor_id=$2 AND receipt_id=$3',
    [ctx.storeId, ctx.actorId, receiptId]);
  if (!rowCount) return undefined;
  object(query, []);
  return execute(ctx, commandKey(key), ['POST', undoPath, receiptId, body], () => undoReview(ctx, receiptId, body));
}

export function registerB10Routes(app: FastifyInstance, pool: Pool, gatewayToken: string, now = () => new Date(),
  { registerUndo = true } = {}) {
  async function auth(req: Request, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    try { requireOwner(req, gatewayToken); } catch (error) {
      if (!(error instanceof InsightError)) throw error;
      return reply.code(error.status).send({ code: error.code });
    }
  }

  function route(method: 'GET' | 'POST' | 'PATCH', path: string, handler: (ctx: WriteContext, req: Request) => Promise<unknown>) {
    app.route<{ Params: Request['params'] }>({
      method, url: root + path, onRequest: auth, exposeHeadRoute: false, bodyLimit: 128 * 1024,
      async handler(req, reply) {
        const scope = requireOwner(req, gatewayToken);
        try {
          const result = await inStore(pool, scope.storeId, db => handler({ ...scope, db, at: now() }, req), method === 'GET');
          if (method === 'POST') reply.code(201);
          return result;
        } catch (error) {
          if (!(error instanceof InsightError)) throw error;
          return reply.code(error.status).send({ code: error.code });
        }
      },
    });
  }

  function list(path: string, filters: string[], read: (ctx: WriteContext, options: ReturnType<typeof pageQuery>, req: Request) => Promise<object>) {
    route('GET', path, async (ctx, req) => ({
      ...await read(ctx, pageQuery(req.query, filters), req),
      asOf: ctx.at.toISOString(), sourceRevision: await sourceRevision(ctx.db, ctx.storeId),
    }));
  }

  list('/cameras', [], async ({ db, storeId, at }, { limit, cursor }) =>
    page(await listCameras(db, storeId, at, optionalId(cursor), limit), limit, row => row.cameraId));

  list('/zones', ['cameraId'], async ({ db, storeId }, { limit, cursor, input }) =>
    page(await listZones(db, storeId, optionalId(input.cameraId), optionalId(cursor), limit), limit, row => row.zoneId));

  list('/table-links', ['cameraId'], async ({ db, storeId }, { limit, cursor, input }, req) => {
    const camera = optionalId(input.cameraId);
    const after = optionalId(cursor);
    if (req.headers['x-navis-pos-tables-enabled'] !== '1') return { items: [], nextCursor: null };
    return page(await listLinks(db, storeId, camera, after, limit), limit, row => row.zoneId);
  });

  list('/cctv-buckets', ['cameraId', 'from', 'to'], async ({ db, storeId, at }, { limit, cursor, input }) => {
    const { from, to } = period(input, at);
    return page(await listBuckets(db, storeId, optionalId(input.cameraId), from, to, timedCursor(cursor), limit), limit,
      row => `${row.bucketStart.toISOString()}|${row.cameraId}`);
  });

  list('/environment-readings', ['from', 'to'], async ({ db, storeId, at }, { limit, cursor, input }) => {
    const { from, to } = period(input, at);
    return page(await readReadings(db, storeId, from, to, timedCursor(cursor), limit), limit,
      row => `${row.measuredAt.toISOString()}|${row.readingId}`);
  });
  route('GET', '/environment-limits', ({ db, storeId }, req) => {
    object(req.query, []);
    return readLimits(db, storeId);
  });
  route('GET', '/environment-summary', async ({ db, storeId, at }, req) => {
    object(req.query, []);
    return { ...await environmentSummary(db, storeId, at), sourceRevision: await sourceRevision(db, storeId) };
  });
  route('GET', '/cctv-reviews', async ({ db, storeId, at }, req) => {
    const { date } = object(req.query, ['date']);
    if (!isDate(date)) invalid();
    return { items: await listReviews(db, storeId, date), nextCursor: null, asOf: at.toISOString(),
      sourceRevision: await sourceRevision(db, storeId) };
  });

  function write(method: 'POST' | 'PATCH', path: string, apply: (ctx: WriteContext, req: Request) => Promise<Omit<Receipt, 'receiptId'>>) {
    route(method, path, async (ctx, req) => {
      object(req.query, []);
      const key = commandKey(req.headers['idempotency-key']);
      return execute(ctx, key, [method, path, req.params.id, req.body], () => apply(ctx, req));
    });
  }
  write('POST', '/environment-readings', (ctx, req) => recordReading(ctx, req.body));
  write('PATCH', '/environment-limits', (ctx, req) => updateLimits(ctx, req.body));
  write('PATCH', '/cameras/:id/zones', (ctx, req) => setZones(ctx, id(req.params.id), req.body));
  write('PATCH', '/zones/:id/table-link', (ctx, req) => {
    if (req.headers['x-navis-pos-tables-enabled'] !== '1') throw new InsightError(409, 'TABLE_LINK_DISABLED');
    return setLink(ctx, id(req.params.id), req.body);
  });
  write('POST', '/cctv-reviews', (ctx, req) => {
    const timezone = req.headers['x-navis-store-timezone'] ?? 'Asia/Seoul';
    const dayStart = req.headers['x-navis-business-day-start'] ?? '00:00';
    if (typeof timezone !== 'string' || typeof dayStart !== 'string'
        || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(dayStart)) invalid();
    return markReview(ctx, req.body, { timezone, dayStart });
  });
  if (registerUndo) write('POST', undoPath, (ctx, req) => undoReview(ctx, id(req.params.id), req.body));
}
