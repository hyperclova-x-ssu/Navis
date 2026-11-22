import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type {
  WorksEvent, WorksEventEnvelope, WorksEventInput, WorksListResult, WorksTime,
} from '../../../../packages/naver/contracts/pn11/index.ts';
import { bearerToken } from './oauth.ts';

type Context = Parameters<PersonaCapability['register']>[1];
type EventRow = { event_id: string; payload: WorksEventInput; created_at: Date; updated_at: Date };
type Params = { userId: string; calendarId: string; eventId?: string };
const path = '/v1.0/users/:userId/calendars/:calendarId/events';
const columns = 'event_id, payload, created_at, updated_at';
const zone = 'Asia/Seoul';
const calendarId = 'fixture-team';
const ownerId = 'fixture-owner';
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function worksError(reply: FastifyReply, status: 400 | 401 | 403 | 404 | 409) {
  const errors = {
    400: { code: 'INVALID_PARAMETER', description: 'Invalid parameter.' },
    401: { code: 'UNAUTHORIZED', description: 'Unauthorized.' },
    403: { code: 'FORBIDDEN', description: 'Forbidden.' },
    404: { code: 'NOT_FOUND', description: 'Not found.' },
    409: { code: 'CONFLICT', description: 'Conflict.' },
  };
  return reply.code(status).send(errors[status]);
}

function inScope(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply, context: Context, mode: 'read' | 'write') {
  const token = bearerToken(request);
  const readToken = context.providerCredential(request, 'readToken');
  const writeToken = context.providerCredential(request, 'writeToken');
  if (!token || (token !== readToken && token !== writeToken)) {
    worksError(reply, 401);
    return false;
  }
  if (request.params.userId !== ownerId || request.params.calendarId !== calendarId ||
      (mode === 'write' && token !== writeToken)) {
    worksError(reply, 403);
    return false;
  }
  return true;
}

function exactDate(value: string) {
  if (!dayPattern.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function instant(value: unknown): value is WorksTime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.date === 'string' && Object.keys(obj).length === 1) return exactDate(obj.date);
  if (typeof obj.dateTime !== 'string' || !timePattern.test(obj.dateTime) || obj.timeZone !== zone ||
      Object.keys(obj).length !== 2) return false;
  const date = new Date(obj.dateTime + 'Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 19) === obj.dateTime;
}

function range(start: WorksTime, end: WorksTime | undefined) {
  if ('date' in start) {
    const startsAt = new Date(start.date + 'T00:00:00+09:00');
    const endsAt = end && 'date' in end ? new Date(end.date + 'T00:00:00+09:00') : new Date(+startsAt + 86_400_000);
    return end && !('date' in end) || endsAt <= startsAt ? undefined : { startsAt, endsAt };
  }
  const startsAt = new Date(start.dateTime + '+09:00');
  const endsAt = end && 'dateTime' in end ? new Date(end.dateTime + '+09:00') : startsAt;
  return end && !('dateTime' in end) || endsAt < startsAt ? undefined : { startsAt, endsAt };
}

function parseEvent(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const { eventComponents, sendNotification, ...extra } = body as Record<string, unknown>;
  if (Object.keys(extra).length || (sendNotification !== undefined && typeof sendNotification !== 'boolean') ||
      !Array.isArray(eventComponents) || eventComponents.length !== 1) return;
  const event = eventComponents[0] as Record<string, unknown> | undefined;
  if (!event || typeof event !== 'object' || Array.isArray(event)) return;
  const { eventId, summary, description, start, end, ...unknown } = event;
  if (Object.keys(unknown).length || typeof summary !== 'string' || summary.length > 200 ||
      (description !== undefined && (typeof description !== 'string' || description.length > 5000)) ||
      (eventId !== undefined && (typeof eventId !== 'string' || !eventId || eventId.length > 255)) ||
      !instant(start) || (end !== undefined && !instant(end))) return;
  const period = range(start, end);
  if (!period) return;
  const payload: WorksEventInput = { summary, start, ...(end && { end }),
    ...(description !== undefined && { description }) };
  return { ...period, payload, eventId };
}

function workTime(now: Date): WorksEvent['createdTime'] {
  return { dateTime: new Date(+now + 9 * 3_600_000).toISOString().slice(0, 19), timeZone: zone };
}

function envelope(row: EventRow): WorksEventEnvelope {
  return { eventComponents: [{ ...row.payload, eventId: row.event_id,
    createdTime: workTime(row.created_at), updatedTime: workTime(row.updated_at),
  }], organizerCalendarId: calendarId };
}

function queryInstant(value: string | undefined) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !exactDate(value.slice(0, 10))) return;
  const date = new Date(value);
  if (Number.isFinite(+date)) return date;
}

export function registerWorks(app: FastifyInstance, context: Context) {
  // https://developers.worksmobile.com/kr/docs/calendar-event-user-list
  app.get<{ Params: Params; Querystring: Record<string, string> }>(path, {
    config: { personaOperation: 'pn11.works.list' },
  }, async (request, reply) => {
    if (!inScope(request, reply, context, 'read')) return;
    const { fromDateTime, untilDateTime, ...unknown } = request.query;
    const start = queryInstant(fromDateTime);
    const end = queryInstant(untilDateTime);
    if (Object.keys(unknown).length || !start || !end || end <= start || +end - +start > 31 * 86_400_000) {
      return worksError(reply, 400);
    }
    const { rows } = await context.transaction(request, async (client) => client.query<EventRow>(`
      SELECT ${columns} FROM naver_virtual.pn11_works
      WHERE account_id = $1 AND starts_at < $3 AND ends_at >= $2 AND deleted_at IS NULL
      ORDER BY starts_at, event_id
    `, [context.accountId(request), start, end]));
    const result: WorksListResult = { events: rows.map(envelope) };
    return result;
  });

  // https://developers.worksmobile.com/kr/docs/calendar-event-user-create
  app.post<{ Params: Params }>(path, { config: { personaOperation: 'pn11.works.create' } }, async (request, reply) => {
    if (!inScope(request, reply, context, 'write')) return;
    const body = parseEvent(request.body);
    if (!body) return worksError(reply, 400);
    const id = body.eventId ?? randomUUID();
    const account = context.accountId(request);
    const current = await context.transaction(request, async (client) => {
      const created = await client.query<EventRow>(`
        INSERT INTO naver_virtual.pn11_works (account_id, event_id, payload, starts_at, ends_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT DO NOTHING RETURNING ${columns}
      `, [account, id, body.payload, body.startsAt, body.endsAt, context.now()]);
      if (created.rows[0]) return created.rows[0];
      const replay = await client.query<EventRow>(`
        SELECT ${columns} FROM naver_virtual.pn11_works WHERE account_id = $1 AND event_id = $2
          AND payload = $3::jsonb AND deleted_at IS NULL
      `, [account, id, body.payload]);
      return replay.rows[0];
    });
    return current ? reply.code(201).send(envelope(current)) : worksError(reply, 409);
  });

  // https://developers.worksmobile.com/kr/docs/calendar-event-user-get
  app.get<{ Params: Required<Params> }>(path + '/:eventId', {
    config: { personaOperation: 'pn11.works.read' },
  }, async (request, reply) => {
    if (!inScope(request, reply, context, 'read')) return;
    const { rows } = await context.transaction(request, async (client) => client.query<EventRow>(`
      SELECT ${columns} FROM naver_virtual.pn11_works
      WHERE account_id = $1 AND event_id = $2 AND deleted_at IS NULL
    `, [context.accountId(request), request.params.eventId]));
    return rows[0] ? envelope(rows[0]) : worksError(reply, 404);
  });

  // https://developers.worksmobile.com/kr/docs/calendar-event-user-update-put
  app.put<{ Params: Required<Params> }>(path + '/:eventId', {
    config: { personaOperation: 'pn11.works.update' },
  }, async (request, reply) => {
    if (!inScope(request, reply, context, 'write')) return;
    const body = parseEvent(request.body);
    if (!body || (body.eventId && body.eventId !== request.params.eventId)) return worksError(reply, 400);
    const { rows } = await context.transaction(request, async (client) => client.query<EventRow>(`
      UPDATE naver_virtual.pn11_works
      SET payload = $3, starts_at = $4, ends_at = $5,
        updated_at = CASE WHEN payload IS DISTINCT FROM $3::jsonb THEN $6 ELSE updated_at END
      WHERE account_id = $1 AND event_id = $2 AND deleted_at IS NULL
      RETURNING ${columns}
    `, [context.accountId(request), request.params.eventId, body.payload, body.startsAt, body.endsAt, context.now()]));
    return rows[0] ? envelope(rows[0]) : worksError(reply, 404);
  });

  // https://developers.worksmobile.com/kr/docs/calendar-event-user-delete
  app.delete<{ Params: Required<Params>; Querystring: Record<string, string> }>(path + '/:eventId', {
    config: { personaOperation: 'pn11.works.delete' },
  }, async (request, reply) => {
    if (!inScope(request, reply, context, 'write')) return;
    const { sendNotification, ...unknown } = request.query;
    if (Object.keys(unknown).length || (sendNotification !== undefined && !['', 'true', 'false'].includes(sendNotification))) {
      return worksError(reply, 400);
    }
    const result = await context.transaction(request, async (client) => client.query(`
      UPDATE naver_virtual.pn11_works SET deleted_at = COALESCE(deleted_at, $3)
      WHERE account_id = $1 AND event_id = $2
    `, [context.accountId(request), request.params.eventId, context.now()]));
    return result.rowCount ? reply.code(204).send() : worksError(reply, 404);
  });
}
