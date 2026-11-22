import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApprovalError } from '../../../../packages/approvals/index.ts';
import { createObjectStorage } from '../../../../packages/object-storage/index.ts';
import { NaverError } from '../../../account/naver/wire.ts';
import { createCalendarNaverCommands, type NaverCalendarOptions } from './naver.ts';
import { withCustomerStore } from '../../claims.ts';
import { isUuid } from '../../pos-client.ts';
import { execute, getEntity, type Command } from './commands.ts';
import { archiveCalendarExport, calendarExport, type CalendarExportStorage } from './exports.ts';
import { listProjections, projectionCursor } from './projection.ts';
import { listEvents, listShifts, listStaff, lockCalendarStaff, publicRow, readPreferences, sourceRevision, staffHistory, type Scope } from './records.ts';
import { idempotencyKey, invalid, listing, object, period, ScheduleError, uuid } from './wire.ts';

const root = '/internal/v1/customer/stores/:storeId';
const digest = (value: string) => createHash('sha256').update(value).digest();
type Request = FastifyRequest<{ Params: { storeId: string; id?: string } }>;
type ScopedRequest = Scope & { now: () => Date; timezone: string; actorId: string };
type Handler = (ctx: ScopedRequest, req: Request, reply: FastifyReply) => Promise<unknown>;
type Transaction = <T>(run: (db: Scope['db']) => Promise<T>) => Promise<T>;
type RequestScope = Omit<ScopedRequest, 'db'> & { transaction: Transaction };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const paginationFields = ['limit', 'cursor', 'startDate', 'endDate'];
const cursor = (input: Record<string, unknown>) => input.cursor === undefined ? null : uuid(input.cursor, 'cursor');
const staffFilter = (input: Record<string, unknown>) => input.staffId === undefined ? null : uuid(input.staffId, 'staffId');

function page<T>(rows: readonly T[], limit: number, key: (row: T) => string, asOf: Date, sourceRevision: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? key(items[limit - 1]) : null, asOf: asOf.toISOString(), sourceRevision };
}

export function registerCalendarStaffRoutes(app: FastifyInstance, pool: Pool, gatewayToken: string, {
  now = () => new Date(), naver, objectStorage = createObjectStorage(),
}: { now?: () => Date; naver?: NaverCalendarOptions; objectStorage?: CalendarExportStorage } = {}) {
  const expected = digest(gatewayToken);
  async function authorize(req: Request, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(expected, digest(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const store = req.headers['x-navis-store-id'];
    const actor = req.headers['x-navis-user-id'];
    if (!isUuid(req.params.storeId)) return reply.code(400).send(invalid('storeId').toJSON());
    if (!isUuid(store) || store.toLowerCase() !== req.params.storeId.toLowerCase() || !isUuid(actor)
      || req.headers['x-navis-store-role'] !== 'owner') return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
  }

  function register(method: Method, path: string, handler: (ctx: RequestScope, req: Request, reply: FastifyReply) => Promise<unknown>) {
    app.route<{ Params: Request['params'] }>({
      method, url: root + path, exposeHeadRoute: false, onRequest: authorize, bodyLimit: 32 * 1024,
      async handler(req, reply) {
        const storeId = req.params.storeId.toLowerCase();
        const actorId = (req.headers['x-navis-user-id'] as string).toLowerCase();
        const clock = req.headers['x-navis-store-timezone'];
        const timezone = typeof clock === 'string' ? clock : 'Asia/Seoul';
        try {
          return await handler({ storeId, actorId, timezone, now,
            transaction: run => withCustomerStore(pool, storeId, run) }, req, reply);
        } catch (error) {
          if (error instanceof NaverError || error instanceof ApprovalError) return reply.code(error.status).send({ code: error.code });
          if (!(error instanceof ScheduleError)) throw error;
          return reply.code(error.status).send(error.toJSON());
        }
      },
    });
  }

  function route(method: Method, path: string, handler: Handler) {
    register(method, path, ({ transaction, ...scope }, req, reply) => transaction(async db => {
      const ctx = { ...scope, db };
      if (method === 'GET') await lockCalendarStaff(ctx, true);
      return handler(ctx, req, reply);
    }));
  }

  function write(method: 'POST' | 'PATCH' | 'DELETE', path: string, command: Omit<Command, 'id'>) {
    route(method, path, async (ctx, req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !idempotencyKey.test(key)) throw invalid('Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED');
      const result = await execute(ctx, key, { ...command, id: req.params.id }, req.body);
      if (command.operation === 'create') reply.code(201);
      return result;
    });
  }

  route('GET', '/staff', async (ctx, req) => {
    const input = object(req.query, ['limit', 'cursor']);
    const { limit } = listing(input);
    const rows = await listStaff(ctx, { limit, cursor: cursor(input) });
    return page(rows, limit, row => row.staffId, now(), await sourceRevision(ctx, 'staff'));
  });
  route('GET', '/shifts', async (ctx, req) => {
    const input = object(req.query, [...paginationFields, 'staffId']);
    const options = listing(input);
    const rows = await listShifts(ctx, { ...options, cursor: cursor(input) }, staffFilter(input));
    return page(rows.map(row => publicRow(row)), options.limit, row => row.scheduleId, now(), await sourceRevision(ctx, 'shifts'));
  });
  route('GET', '/shifts/history', async (ctx, req) => {
    const input = object(req.query, [...paginationFields, 'staffId']);
    const options = listing(input);
    const rows = await staffHistory(ctx, { ...options, cursor: cursor(input) }, staffFilter(input));
    // A name change appends to the same history as a shift change.
    const revision = await sourceRevision(ctx, 'staff') + await sourceRevision(ctx, 'shifts');
    return page(rows, options.limit, row => row.changeId, now(), revision);
  });
  route('GET', '/calendar/events', async (ctx, req) => {
    const input = object(req.query, [...paginationFields, 'closuresOnly']);
    if (input.closuresOnly !== undefined && input.closuresOnly !== 'true' && input.closuresOnly !== 'false') throw invalid('closuresOnly');
    const options = listing(input);
    const rows = await listEvents(ctx, { ...options, cursor: cursor(input) }, input.closuresOnly === 'true');
    return page(rows.map(row => publicRow(row)), options.limit, row => row.eventId, now(), await sourceRevision(ctx, 'calendar'));
  });
  route('GET', '/calendar/projections', async (ctx, req) => {
    const input = object(req.query, paginationFields);
    const options = listing(input);
    const rows = await listProjections(ctx, { ...options, cursor: projectionCursor(input.cursor) });
    return page(rows, options.limit, row => `${row.source}:${row.sourceId}`, now(), await sourceRevision(ctx, 'projections'));
  });
  route('GET', '/calendar/preferences', ctx => readPreferences(ctx));
  register('GET', '/calendar/exports', async ({ transaction, ...scope }, req, reply) => {
    const { start, end } = period(object(req.query, ['startDate', 'endDate']));
    if (start === null || end === null) throw invalid('startDate', 'INVALID_DATE_RANGE');
    const body = await transaction(async db => {
      const ctx = { ...scope, db };
      await lockCalendarStaff(ctx, true);
      return calendarExport(ctx, start, end, now(), ctx.timezone);
    });
    const content = objectStorage ? await archiveCalendarExport(objectStorage, scope.storeId, start, end, body) : body;
    if (content === undefined) return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE', reason: 'CALENDAR_EXPORT_STORAGE_UNAVAILABLE' });
    reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', 'attachment; filename="navis-calendar.ics"');
    return content;
  });

  for (const [type, path, domain, field] of [
    ['staff', '/staff', 'staff', 'staffId'], ['shifts', '/shifts', 'staff', 'scheduleId'], ['calendar', '/calendar/events', 'calendar', 'eventId'],
  ] as const) {
    route('GET', `${path}/:id`, async (ctx, req) => publicRow((await getEntity(ctx, type, uuid(req.params.id, field), field)).row));
    write('POST', path, { type, domain, operation: 'create' });
    write('PATCH', `${path}/:id`, { type, domain, operation: 'update' });
    write('DELETE', `${path}/:id`, { type, domain, operation: 'delete' });
  }
  if (naver) {
    const pn11 = createCalendarNaverCommands(naver);
    register('POST', '/approvals', (ctx, req) => pn11.approve(ctx, req.body));
    register('POST', '/calendar/naver-approvals', (ctx, req) => {
      const { resourceId, expectedStaffRevision, stage, operation, expectedRevision, approvalId } = object(req.body,
        ['resourceId', 'expectedStaffRevision', 'stage', 'operation', 'expectedRevision', 'approvalId']);
      return pn11.approve(ctx, { stage, operation, expectedRevision, approvalId, targetRef: resourceId,
        command: expectedStaffRevision === undefined ? {} : { expectedStaffRevision } });
    });
    const calendarPath = '/calendar/events/:id/naver';
    route('GET', calendarPath, (ctx, req) => pn11.readCalendarReceipt(ctx, uuid(req.params.id, 'eventId')));
    register('GET', '/shifts/naver-works', (ctx, req) => pn11.list(ctx, req.query));
    for (const [method, path, operation, field] of [
      ['POST', calendarPath, 'calendar.add', 'eventId'],
      ['POST', '/shifts/:id/naver-works', 'works.create', 'scheduleId'],
      ['PATCH', '/shifts/:id/naver-works', 'works.update', 'scheduleId'],
      ['DELETE', '/shifts/:id/naver-works', 'works.delete', 'scheduleId'],
    ] as const) {
      register(method, path, (ctx, req) => {
        return pn11.write(ctx, operation, uuid(req.params.id, field), req.body, req.headers['idempotency-key']);
      });
    }
  }

  write('POST', '/shifts/handoff', { type: 'handoff', domain: 'staff', operation: 'handoff' });
  write('PATCH', '/calendar/preferences', { type: 'preferences', domain: 'calendar', operation: 'preferences' });
  write('POST', '/calendar/receipts/:id/undo', { type: 'undo', domain: 'calendar', operation: 'undo' });
  write('POST', '/staff/receipts/:id/undo', { type: 'undo', domain: 'staff', operation: 'undo' });
}
