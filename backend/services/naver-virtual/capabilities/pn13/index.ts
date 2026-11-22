import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaCapability, PersonaContext } from '../../app.ts';
import type { SensProduct, SmsReservation } from '../../../../packages/naver/contracts/pn13/index.ts';
import { cancelReservation, messages, requests, reservation, sensMigration, sensReservationMigration, store, type Data, type RequestRow } from './database.ts';
import { isoDate, mailAcceptance, mailDraft, mailListItem, mailRequest, mailResult } from './mail.ts';
import { kst, localDate, phoneAcceptance, phoneDraft, phoneProducts, phoneResult, type PhoneProduct } from './messages.ts';

type Route = { Params: { serviceId: string; messageId?: string; requestId?: string; mailId?: string; reserveId?: string } };
type ErrorStatus = 400 | 401 | 403 | 404 | 500;

const errors: Record<ErrorStatus, [string, string, string]> = {
  400: ['Bad Request', 'InvalidParameter', 'The request contains an invalid parameter.'],
  401: ['Unauthorized', 'Unauthorized', 'Unauthorized'],
  403: ['Forbidden', 'Forbidden', "Do not have access to this 'serviceId'"],
  404: ['Not Found', 'NotFound', 'Not Found'],
  500: ['Internal Server Error', 'InternalError', 'Internal Server Error'],
};

function error(reply: FastifyReply, product: SensProduct, status: ErrorStatus) {
  const [label, errorCode, message] = errors[status];
  return reply.code(status).send(product === 'mail'
    ? { error: { errorCode, message: status === 404 ? 'The requested resource was not found.' : message } }
    : { status, error: label, message });
}

function authorize(request: FastifyRequest<Route>, context: PersonaContext): 401 | 403 | undefined {
  const access = context.providerCredential(request, 'accessKey');
  const key = context.providerCredential(request, 'secretKey');
  const timestamp = request.headers['x-ncp-apigw-timestamp'];
  const signature = request.headers['x-ncp-apigw-signature-v2'];
  if (!access || !key || request.headers['x-ncp-iam-access-key'] !== access
    || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)
    || Math.abs(context.now().getTime() - Number(timestamp)) > 300_000
    || typeof signature !== 'string') return 401;

  // SENS uses the NCP API Gateway signature over method, raw target, timestamp and access key.
  // https://api.ncloud-docs.com/docs/sens-overview
  // https://api.ncloud-docs.com/docs/common-ncpapi
  const expected = createHmac('sha256', key).update(`${request.method} ${request.url}\n${timestamp}\n${access}`).digest('base64');
  if (Buffer.byteLength(signature) !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return 401;
  if (request.params.serviceId !== context.providerCredential(request, 'serviceId')) return 403;
}

function query(request: FastifyRequest) {
  return new URLSearchParams(request.url.split('?')[1]);
}

function number(value: string | null, fallback: number, min: number, max: number) {
  if (value === null) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  return n >= min && n <= max ? n : undefined;
}

function phoneFilters(q: URLSearchParams, product: PhoneProduct) {
  const requestId = q.get('requestId') ?? undefined;
  const messageId = q.get('messageId') ?? undefined;
  const completionTime = q.has('completeStartTime') || q.has('completeEndTime');
  const requestTime = q.has('requestStartTime') || q.has('requestEndTime');
  if ((!requestId && !completionTime && !requestTime) || completionTime && requestTime) return undefined;
  if (product !== 'sms' && !requestId && !q.get('plusFriendId')) return undefined;
  const from = completionTime ? localDate(q.get('completeStartTime')) : localDate(q.get('requestStartTime'));
  const to = completionTime ? localDate(q.get('completeEndTime')) : localDate(q.get('requestEndTime'));
  const maxDays = completionTime ? 1 : product === 'sms' ? 30 : 31;
  if ((completionTime || requestTime) && (!from || !to || to < from || to.getTime() - from.getTime() > maxDays * 86400_000)) return undefined;
  const defaultSize = requestId ? (product === 'sms' ? 1000 : 100) : 20;
  const pageSize = number(q.get('pageSize'), defaultSize, 1, 100);
  const token = q.get('nextToken');
  const pageIndex = token === null ? 0
    : /^[A-Za-z0-9_-]{1,20}$/.test(token) ? number(Buffer.from(token, 'base64url').toString('utf8'), 0, 1, 1_000_000) : undefined;
  if (pageSize === undefined || pageIndex === undefined) return undefined;
  return { requestId, messageId, completionTime, from, to, pageSize, pageIndex };
}

function page<T>(rows: T[], pageNo: number, pageSize: number) {
  return { items: rows.slice(pageNo * pageSize, (pageNo + 1) * pageSize), totalElements: rows.length,
    totalPages: Math.ceil(rows.length / pageSize), pageNo, pageSize };
}

function mailFilters(q: URLSearchParams, allowedSort: string[]) {
  const pageNo = number(q.get('pageNo'), 0, 0, 1_000_000);
  const pageSize = number(q.get('pageSize'), 10, 1, 1000);
  const [field, direction = 'asc', extra] = (q.get('sort') ?? 'createDateTime,desc').split(',');
  if (pageNo === undefined || pageSize === undefined || !allowedSort.includes(field)
    || !['asc', 'desc'].includes(direction) || extra !== undefined) return undefined;
  return {
    pageNo, pageSize,
    matches(view: Data) {
      const statuses = q.getAll('status');
      return (!statuses.length || statuses.includes(String(view.status)))
        && (!q.has('title') || String(view.title).includes(q.get('title')!));
    },
    sort(a: Data, b: Data) {
      const left = a[field];
      const right = b[field];
      const order = typeof left === 'number' && typeof right === 'number' ? left - right
        : String(left ?? '').localeCompare(String(right ?? ''));
      return order * (direction === 'desc' ? -1 : 1);
    },
  };
}

export const personaCapability: PersonaCapability = {
  id: 'pn13',
  migrations: [sensMigration, sensReservationMigration],
  async seed(client, { accountId, previousGeneration }) {
    // Requests exist only when a synthetic adapter has sent one in this generation.
    // Foundation skips this hook during retries of the same generation.
    if (previousGeneration) await client.query('DELETE FROM naver_virtual.sens_requests WHERE account_id = $1', [accountId]);
  },
  register(app, context) {
    const scope = (request: FastifyRequest<Route>, product: SensProduct): [string, SensProduct, string] =>
      [context.accountId(request), product, request.params.serviceId];
    const options = (product: SensProduct, action: string) => ({
      config: { personaOperation: `pn13.${product}.${action}` },
      bodyLimit: product === 'mail' ? 12_000_000 : 1_000_000,
      async onRequest(request: FastifyRequest<Route>, reply: FastifyReply) {
        const status = authorize(request, context);
        if (status) return error(reply, product, status);
      },
      errorHandler(failure: { statusCode?: number }, request: FastifyRequest, reply: FastifyReply) {
        if (failure.statusCode && failure.statusCode < 500) return error(reply, product, 400);
        request.log.error({ operation: request.routeOptions.config.personaOperation }, 'SENS fixture unavailable');
        return error(reply, product, 500);
      },
    });

    for (const product of phoneProducts) {
      const path = `/${product}/v2/services/:serviceId/messages`;
      // https://api.ncloud-docs.com/docs/sens-sms-send
      // https://api.ncloud-docs.com/docs/sens-alimtalk-send
      // https://api.ncloud-docs.com/docs/sens-brandmessage-send
      app.post<Route>(path, options(product, 'send'), async (request, reply) => {
        const credential = (name: string) => context.providerCredential(request, name);
        const now = context.now();
        const draft = phoneDraft(product, request.body, credential, now);
        if (!draft) return error(reply, product, 400);
        const prefix = product === 'sms' ? draft.scheduledAt ? 'RSSA' : 'RSLA' : product === 'alimtalk' ? 'RBAA' : 'RBBA';
        const row: RequestRow = { request_id: `${prefix}-${randomUUID()}`, accepted_at: now,
          scheduled_at: draft.scheduledAt, payload: draft.payload };
        const requestScope = scope(request, product);
        // Private durable replay for scheduled and immediate SMS (Navis attempt key); the official body is unchanged.
        if (product === 'sms' && request.headers['idempotency-key'] !== undefined) {
          const fingerprint = createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
          const { ref } = await context.effect(request, fingerprint, async client => {
            await store(client, requestScope, row, draft.messages);
            return row.request_id;
          });
          const [accepted] = await context.transaction(request, client => requests(client, requestScope, ref));
          return reply.code(202).send(phoneAcceptance(product, accepted, draft));
        }
        await context.transaction(request, client => store(client, requestScope, row, draft.messages));
        return reply.code(202).send(phoneAcceptance(product, row, draft));
      });
      // https://api.ncloud-docs.com/docs/sens-sms-list
      // https://api.ncloud-docs.com/docs/sens-alimtalk-list
      // https://api.ncloud-docs.com/docs/sens-brandmessage-list
      app.get<Route>(path, options(product, 'list'), async (request, reply) => {
        const q = query(request);
        const filter = phoneFilters(q, product);
        if (!filter) return error(reply, product, 400);
        const now = context.now();
        const rows = await context.transaction(request, client => messages(client, scope(request, product), filter));
        const fields = product === 'sms' ? ['type', 'contentType', 'countryCode', 'status', 'from', 'to', 'statusName']
          : ['plusFriendId', 'requestStatusName', 'messageStatusName', 'templateCode', 'to'];
        const matches = rows.map(row => phoneResult(product, row, now))
          .filter(row => (!filter.completionTime || row.completeTime !== undefined)
            && fields.every(field => !q.has(field) || q.get(field) === row[field]));
        const current = page(matches, filter.pageIndex, filter.pageSize);
        const hasMore = filter.pageIndex + 1 < current.totalPages;
        return {
          ...(product === 'alimtalk' && filter.requestId && { requestId: filter.requestId }),
          statusCode: '202', statusName: 'success', messages: current.items,
          pageSize: current.pageSize, pageIndex: current.pageNo, itemCount: current.items.length, hasMore,
          ...(hasMore && { nextToken: Buffer.from(String(filter.pageIndex + 1)).toString('base64url') }),
        };
      });
      // https://api.ncloud-docs.com/docs/sens-sms-get
      // https://api.ncloud-docs.com/docs/sens-alimtalk-get
      // https://api.ncloud-docs.com/docs/sens-brandmessage-get
      app.get<Route>(`${path}/:messageId`, options(product, 'get'), async (request, reply) => {
        const [row] = await context.transaction(request, client => messages(client, scope(request, product), {
          messageId: request.params.messageId,
        }));
        if (!row) return error(reply, product, 404);
        const result = phoneResult(product, row, context.now(), true);
        return product === 'sms' ? {
          statusCode: '200', statusName: result.status === 'READY' ? 'reserved' : 'success', messages: [result],
        } : result;
      });
    }

    const reservePath = '/sms/v2/services/:serviceId/reservations/:reserveId';
    app.get<Route>(reservePath + '/reserve-status', options('sms', 'reservation-status'), async (request, reply) => {
      const reserveId = request.params.reserveId!;
      const row = await context.transaction(request, client => reservation(client, scope(request, 'sms'), reserveId));
      if (!row) return error(reply, 'sms', 404);
      const reserveStatus = row.canceled_at ? 'CANCELED' : row.scheduled_at > context.now() ? 'READY' : 'DONE';
      return { reserveId, reserveTimeZone: 'Asia/Seoul', reserveTime: kst(row.scheduled_at).slice(0, 19) + '+09:00',
        reserveStatus } satisfies SmsReservation;
    });
    app.delete<Route>(reservePath, options('sms', 'reservation-delete'), async (request, reply) => {
      const canceled = await context.transaction(request, client =>
        cancelReservation(client, scope(request, 'sms'), request.params.reserveId!, context.now()));
      return canceled ? reply.code(204).send() : error(reply, 'sms', 404);
    });

    const mailPath = '/mail/v2/services/:serviceId/requests';
    const mailScope = (request: FastifyRequest<Route>) => scope(request, 'mail');
    // https://api.ncloud-docs.com/docs/sens-mail-request-create
    app.post<Route>(mailPath, options('mail', 'send'), async (request, reply) => {
      const now = context.now();
      const draft = mailDraft(request.body, context.providerCredential(request, 'sender'), now);
      if (!draft) return error(reply, 'mail', 400);
      const row: RequestRow = { request_id: `${kst(now).slice(0, 10).replaceAll('-', '')}-R-${randomUUID()}`,
        accepted_at: now, scheduled_at: draft.scheduledAt, payload: draft.payload };
      await context.transaction(request, client => store(client, mailScope(request), row, draft.messages));
      return reply.code(202).send(mailAcceptance(row, draft.messages.length));
    });

    // https://api.ncloud-docs.com/docs/sens-mail-request-list
    app.get<Route>(mailPath, options('mail', 'list'), async (request, reply) => {
      const q = query(request);
      const filter = mailFilters(q, ['createDateTime', 'recipientCount', 'reservationDateTime', 'sendDateTime', 'status']);
      const from = isoDate(q.get('fromDateTime'));
      const to = isoDate(q.get('toDateTime'));
      if (!filter || !from || !to || to < from) return error(reply, 'mail', 400);
      const now = context.now();
      const requestId = q.get('requestId') ?? undefined;
      const [rows, mailRows] = await context.transaction(request, async client => [
        await requests(client, mailScope(request), requestId, from, to),
        await messages(client, mailScope(request), { requestId, from, to }),
      ] as const);
      const byRequest = Map.groupBy(mailRows, row => row.request_id);
      const matched = rows.flatMap(row => {
        const group = byRequest.get(row.request_id) ?? [];
        const view = mailListItem(row, group, now);
        const metadata = ['senderAddress', 'dispatchType', 'templateNo'];
        if (metadata.some(field => q.has(field) && q.get(field) !== String(view[field as keyof typeof view]))) return [];
        if (!group.some(mail => (!q.has('mailId') || q.get('mailId') === mail.message_id)
          && (!q.has('title') || String(mail.message.title).includes(q.get('title')!))
          && containsAddress(mail.message.recipients, q.get('recipientAddress')))) return [];
        const statuses = q.getAll('status');
        return statuses.length && !statuses.includes(view.status) ? [] : [view];
      }).sort(filter.sort);
      const { items, ...counts } = page(matched, filter.pageNo, filter.pageSize);
      return { requests: items, ...counts };
    });

    // https://api.ncloud-docs.com/docs/sens-mail-request-get
    app.get<Route>(`${mailPath}/:requestId`, options('mail', 'request'), async (request, reply) => {
      const { requestId } = request.params;
      const rows = await context.transaction(request, client => messages(client, mailScope(request), { requestId }));
      if (!rows.length) return error(reply, 'mail', 404);
      const view = mailRequest(rows[0], rows, context.now());
      if (view.status === 'READY' || view.status === 'RESERVED') reply.header('retry-after', '3');
      return view;
    });

    // https://api.ncloud-docs.com/docs/sens-mail-list
    app.get<Route>(`${mailPath}/:requestId/mails`, options('mail', 'mails'), async (request, reply) => {
      const q = query(request);
      const filter = mailFilters(q, ['createDateTime', 'mailId', 'status']);
      if (!filter) return error(reply, 'mail', 400);
      const { requestId } = request.params;
      const rows = await context.transaction(request, client => messages(client, mailScope(request), { requestId }));
      if (!rows.length) return error(reply, 'mail', 404);
      const now = context.now();
      const matched = rows.filter(row => (!q.has('mailId') || q.get('mailId') === row.message_id)
        && containsAddress(row.message.recipients, q.get('recipientAddress')))
        .map(row => mailResult(row, now, false)).filter(filter.matches).sort(filter.sort);
      const { items, ...counts } = page(matched, filter.pageNo, filter.pageSize);
      return { mails: items, ...counts };
    });

    // https://api.ncloud-docs.com/docs/sens-mail-get
    app.get<Route>(`${mailPath}/:requestId/mails/:mailId`, options('mail', 'get'), async (request, reply) => {
      const { requestId, mailId } = request.params;
      const [row] = await context.transaction(request, client => messages(client, mailScope(request), {
        requestId, messageId: mailId,
      }));
      return row ? mailResult(row, context.now(), true) : error(reply, 'mail', 404);
    });
  },
};

function containsAddress(recipients: unknown, address: string | null) {
  return address === null || (recipients as { address: string }[]).some(recipient => recipient.address === address);
}
