import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withCustomerStore } from '../../claims.ts';
import { isUuid } from '../../pos-client.ts';
import { choice, date, idempotencyKey, invalid, missing, object, ScheduleError, uuid } from '../07/wire.ts';
import { fingerprint, previousCommand, runLocalCommand } from './commands.ts';
import { listPickups } from './projection.ts';
import { listNaver, naverVisit, providerRead, runProviderCommand } from './provider.ts';
import { bookLock, bookingRevision, listCandidates, listChanges, publicVisit,
  readLocalVisit, readLocalVisits, type Context } from './records.ts';
import { BookingUnavailable, day, listInput, naverPrefix, reservationRef, stableUuid, visitList, type BookingNaver,
  type OwnerScope, type ReadTables } from './wire.ts';

type Request = FastifyRequest<{ Params: { storeId: string; id?: string } }>;
type Options = { gatewayToken: string; now?: () => Date; readTables: ReadTables; naver?: BookingNaver };
const root = '/internal/v1/customer/stores/:storeId';
const excel = { url: 'https://new.smartplace.naver.com/', instructionsUrl: 'https://help.naver.com/service/30026/contents/20635?lang=ko',
  maxRows: 5_000, masked: true } as const;
const digest = (input: string) => createHash('sha256').update(input).digest();

function page<T>(rows: readonly T[], limit: number, key: (row: T) => string, at: Date, sourceRevision: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? key(items[limit - 1]) : null, asOf: at.toISOString(), sourceRevision };
}

function scopedPage(query: unknown, fields: readonly string[] = []) {
  const { input, ...bounds } = listInput(query, fields);
  return { input, ...bounds, cursor: input.cursor === undefined ? null : uuid(input.cursor, 'cursor') };
}

const sortBy = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;

export function registerBookingRoutes(app: FastifyInstance, pool: Pool, { gatewayToken, readTables, naver, now = () => new Date() }: Options) {
  const credential = digest(gatewayToken);
  async function authorize(req: Request, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(credential, digest(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const storeId = req.headers['x-navis-store-id'];
    const actorId = req.headers['x-navis-user-id'];
    if (!isUuid(req.params.storeId)) return reply.code(400).send(invalid('storeId').toJSON());
    if (storeId !== req.params.storeId || !isUuid(actorId) || req.headers['x-navis-store-role'] !== 'owner') {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  }

  function route(method: 'GET' | 'POST' | 'PATCH', path: string, handler: (scope: OwnerScope, req: Request, reply: FastifyReply) => Promise<unknown>) {
    app.route<{ Params: Request['params'] }>({
      method, url: root + path, onRequest: authorize, exposeHeadRoute: false, bodyLimit: 32 * 1024,
      async handler(req, reply) {
        const scope = { storeId: req.params.storeId, actorId: req.headers['x-navis-user-id'] as string };
        try {
          return await handler(scope, req, reply);
        } catch (error) {
          if (error instanceof ScheduleError) return reply.code(error.status).send(error.toJSON());
          if (error instanceof BookingUnavailable) return reply.code(503).send({ code: 'UNAVAILABLE', reason: error.reason });
          throw error;
        }
      },
    });
  }

  const transaction = <T>(scope: OwnerScope, run: (ctx: Context) => Promise<T>) =>
    withCustomerStore(pool, scope.storeId, async db => run({ ...scope, db, at: now() }));

  function write(method: 'POST' | 'PATCH', path: string, action: 'create' | 'update' | 'transition' | 'undo') {
    route(method, path, async (scope, req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !idempotencyKey.test(key)) throw invalid('Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED');
      const id = action === 'create' ? null : action === 'undo' ? uuid(req.params.id, 'receiptId') : reservationRef(req.params.id);
      if (id?.startsWith(naverPrefix) && (action === 'update' || action === 'transition')) {
        if (!naver) throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
        return runProviderCommand({ ...scope, pool, naver, action, id, key, raw: req.body, now });
      }
      const saved = await transaction(scope, ctx => previousCommand(ctx, key, fingerprint(action, id, req.body)));
      const body = req.body as { type?: string; patch?: Record<string, unknown> } | undefined;
      const needsTableMap = action === 'create' || action === 'undo' || body?.type === 'booking.confirm'
        || (action === 'update' && ['date', 'time', 'partySize', 'tableChoice'].some(field => Object.hasOwn(body?.patch ?? {}, field)));
      const tableMap = !saved?.receipt && needsTableMap
        ? await readTables(scope.storeId, scope.actorId).catch(() => null) : null;
      const snapshot: ReadTables = async () => {
        if (tableMap) return tableMap;
        throw new BookingUnavailable('BOOKING_TABLES_UNAVAILABLE');
      };
      const result = saved?.receipt ?? await transaction(scope, ctx => runLocalCommand(ctx, snapshot, { action, id, raw: req.body, key }));
      if (action === 'create') reply.code(201);
      return result;
    });
  }

  route('GET', '/reservations', async (scope, req) => {
    const filters = visitList(req.query);
    const [provider, local] = await Promise.all([
      listNaver(naver, scope, filters),
      transaction(scope, async ctx => {
        await bookLock(ctx, true);
        return { rows: filters.source === 'naver' ? [] : await readLocalVisits(ctx, filters), revision: await bookingRevision(ctx) };
      }),
    ]);
    if (filters.source === 'naver' && provider.status === 'unavailable') throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
    const rows = [...local.rows, ...provider.items].sort((a, b) => sortBy(a.reservationId, b.reservationId));
    const result = page(rows, filters.limit, row => row.reservationId, now(), local.revision);
    // The workload hook rewrites only the parsed Authorization header. The
    // original wire header identifies direct gateway reads after authorization.
    const direct = req.raw.rawHeaders.some((name, i, headers) => i % 2 === 0 && name.toLowerCase() === 'authorization' &&
      timingSafeEqual(credential, digest(headers[i + 1]?.match(/^Bearer ([^\s,]+)$/i)?.[1] ?? '')));
    const items = direct ? result.items : result.items.map(({ reservationId, date, time, status, partySize, revision }) =>
      ({ reservationId, date, time, status, partySize, revision }));
    return { ...result, items, sourceStatus: { naver: provider.status } };
  });
  route('GET', '/reservations/export-source', async (_scope, req) => {
    object(req.query, []);
    return excel;
  });
  route('GET', '/reservations/:id', async (scope, req) => {
    object(req.query, []);
    const id = reservationRef(req.params.id);
    if (id.startsWith(naverPrefix)) {
      const booking = await providerRead(naver, service => service.booking(scope, id.slice(naverPrefix.length)));
      if (!booking) throw missing('reservationId');
      const row = naverVisit(booking);
      if (row.reservationId !== id) throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
      return row;
    }
    const row = await transaction(scope, ctx => readLocalVisit(ctx, id));
    if (!row) throw missing('reservationId');
    const { memberName, ...visit } = row;
    return publicVisit(visit, memberName);
  });
  route('GET', '/reservation-changes', (scope, req) => transaction(scope, async ctx => {
    const options = scopedPage(req.query, ['reservationId']);
    const filter = options.input.reservationId === undefined ? null : reservationRef(options.input.reservationId);
    await bookLock(ctx, true);
    return page(await listChanges(ctx, options, filter), options.limit, row => row.changeId, ctx.at, await bookingRevision(ctx));
  }));
  route('GET', '/reservation-suggestions', (scope, req) => transaction(scope, async ctx => {
    const options = scopedPage(req.query, ['status']);
    const status = options.input.status === undefined ? null : choice(options.input.status, ['pending', 'proposed', 'accepted', 'declined'], 'status');
    await bookLock(ctx, true);
    return page(await listCandidates(ctx, options, status), options.limit, row => row.suggestionId, ctx.at, await bookingRevision(ctx));
  }));
  route('GET', '/reservation-pickups', (scope, req) => transaction(scope, async ctx => {
    const options = scopedPage(req.query);
    return page(await listPickups(ctx, options), options.limit, row => row.customOrderId, ctx.at, await bookingRevision(ctx));
  }));
  route('GET', '/booking-products', async (scope, req) => {
    const { limit, cursor, start, end } = scopedPage(req.query);
    if (start || end) throw invalid('date');
    const items = (await providerRead(naver, service => service.bookingProducts(scope))).map(({ name }) => ({ name }));
    const key = (item: typeof items[number]) => stableUuid(scope.storeId, 'booking-product', item.name);
    const sorted = [...new Map(items.map(item => [key(item), item])).entries()].sort(([a], [b]) => sortBy(a, b));
    return page(sorted.filter(([id]) => !cursor || id > cursor).map(([, item]) => item), limit, key, now(), 0);
  });
  route('GET', '/call-records', async (scope, req) => {
    const { input, limit, start, end } = listInput(req.query);
    const cursor = input.cursor === undefined ? null : date(input.cursor, 'cursor');
    const at = now();
    const until = end ?? day(at);
    const since = start ?? day(new Date(Date.parse(until + 'T00:00:00+09:00') - 6 * 86_400_000));
    if (until < since || Date.parse(until) - Date.parse(since) > 31 * 86_400_000) throw invalid('endDate', 'INVALID_DATE_RANGE');
    const source = await providerRead(naver, service => service.smartCallSummary(scope, since, until));
    const rows = source.daily.filter(row => !cursor || row.date > cursor).sort((a, b) => sortBy(a.date, b.date));
    return { ...page(rows, limit, row => row.date, at, 0), period: source.period, channels: source.channels };
  });
  write('POST', '/reservations', 'create');
  write('PATCH', '/reservations/:id', 'update');
  write('POST', '/reservations/:id/transitions', 'transition');
  write('POST', '/booking/receipts/:id/undo', 'undo');
}

export { upsertBookingCandidate } from './records.ts';
export type { BookingNaver, ReadTables } from './wire.ts';
