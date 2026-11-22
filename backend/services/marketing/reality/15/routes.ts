import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { inStore } from '../../transaction.ts';
import { businessDay, clockOf } from '../19/wire.ts';
import { execute, undoNoticeDeletion } from './commands.ts';
import { createTalkTalkInbox, liveInboxPrefix, liveTalkTalkConversation } from './inbox.ts';
import type { NoticeReplyOptions, Owner } from './ports.ts';
import { ensureRecipientGroup, listRecipientGroups, parseGroupId } from './recipients.ts';
import { byReceipt, dto, get, list } from './records.ts';
import { dispatchStatus, noticeSmsPreview, registerNoticeSmsDispatch } from './sms-dispatch.ts';
import type { Kind, Notice } from './records.ts';
import { createLiveTalkTalk, registerLiveTalkTalkWebhook } from './talktalk-live.ts';
import { authorNotification, choice, date, nightNoticeHint, NoticeError, object, publicReply, redactReviewContact, reference, text, uuid } from './wire.ts';
import type { Operation } from './wire.ts';

const root = '/internal/v1/marketing/stores/:storeId';
const idempotency = /^[A-Za-z0-9_:.~-]{1,160}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();
type Params = { storeId: string; id?: string };
type Request = FastifyRequest<{ Params: Params }>;

export const noticeReplyRoutes = [
  ['GET', '/inquiries'], ['POST', '/inquiries'], ['GET', '/inquiries/:id'],
  ['PATCH', '/inquiries/:id/draft'], ['POST', '/inquiries/:id/attestation'],
  ['POST', '/inquiries/:id/reply'], ['PATCH', '/inquiries/:id/reply'], ['DELETE', '/inquiries/:id/reply'],
  ['GET', '/notices'], ['POST', '/notices'], ['GET', '/notices/:id'],
  ['PATCH', '/notices/:id/draft'], ['POST', '/notices/:id/attestation'], ['DELETE', '/notices/:id/draft'],
  ['POST', '/notices/:id/send'], ['POST', '/notices/:id/cancel-sms'], ['GET', '/notice-reply-receipts/:id'],
  ['POST', '/notice-reply-receipts/:id/undo'],
  ['DELETE', '/notices/:id/place-news'],
  ['GET', '/reviews'], ['GET', '/reviews/:id'], ['GET', '/review-statistics'], ['POST', '/reviews/:id/draft-preview'],
  ['POST', '/reviews/:id/navis-draft-preview'], ['GET', '/notices/:id/sms-reservation'],
  ['GET', '/notice-recipient-groups'], ['POST', '/notice-recipient-groups'],
  ['GET', '/talktalk/consultations'], ['GET', '/talktalk/consultations/:id'], ['GET', '/talktalk/marketing/audiences'],
  ['GET', '/place/news'], ['GET', '/place/hours'],
] as const;

export function registerNoticeReplyRoutes(app: FastifyInstance, pool: Pool, options: NoticeReplyOptions) {
  if (!options.gatewayToken || options.scheduledSms && !['fake', 'virtual'].includes(options.scheduledSms.mode) || options.provider && options.provider.mode !== 'fake' && options.provider.mode !== 'virtual') {
    throw new Error('B15 requires a workload token and a fake or virtual provider');
  }
  const token = digest(`Bearer ${options.gatewayToken}`);
  const clock = options.now ?? (() => new Date());
  const liveTalkTalk = createLiveTalkTalk(process.env);
  if (liveTalkTalk) {
    registerLiveTalkTalkWebhook(app, liveTalkTalk.webhookToken, createTalkTalkInbox(pool, liveTalkTalk.storeId, undefined, true));
  }
  const commandOptions = { ...options, liveTalkTalk };
  registerNoticeSmsDispatch(app, pool, options);
  app.register(async routes => {
    routes.setErrorHandler((error, request, reply) => {
      if (error instanceof NoticeError) return reply.code(error.status).send({
        code: error.code, ...(error.receiptId && { receiptId: error.receiptId }),
      });
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ code: 'INVALID_REQUEST' });
      request.log.error('Marketing inquiry or notice request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    function owner(req: Request): Owner {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), token)) throw new NoticeError(401, 'UNAUTHENTICATED');
      const storeId = uuid(req.params.storeId);
      if (req.headers['x-navis-store-id'] !== storeId || req.headers['x-navis-store-role'] !== 'owner') {
        throw new NoticeError(403, 'STORE_FORBIDDEN');
      }
      try { return { storeId, actorId: uuid(req.headers['x-navis-user-id']) }; }
      catch { throw new NoticeError(403, 'STORE_FORBIDDEN'); }
    }

    function route(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
      handler: (scope: Owner, req: Request) => Promise<unknown>) {
      routes.route<{ Params: Params }>({
        method, url: root + path, exposeHeadRoute: false, bodyLimit: 32 * 1024,
        async onRequest(req, reply) {
          reply.header('cache-control', 'no-store');
          owner(req);
        },
        handler: req => handler(owner(req), req),
      });
    }

    function keyFor(req: Request) {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !idempotency.test(key)) throw new NoticeError(400, 'IDEMPOTENCY_KEY_REQUIRED');
      return key;
    }
    function command(method: 'POST' | 'PATCH' | 'DELETE', path: string, kind: Kind, operation: Operation) {
      route(method, path, async (scope, req) => execute(pool, commandOptions, scope, { kind, operation, key: keyFor(req),
        id: req.params.id ? uuid(req.params.id) : null, raw: req.body }));
    }

    for (const [path, kind] of [['/inquiries', 'inquiry'], ['/notices', 'notice']] as const) {
      route('GET', path, async ({ storeId }, req) => {
        const query = object(req.query, ['limit', 'cursor']);
        const rawLimit = query.limit ?? '50';
        if (typeof rawLimit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
          throw new NoticeError(400, 'INVALID_LIMIT');
        }
        const cursor = query.cursor === undefined ? null : uuid(query.cursor);
        return inStore(pool, storeId, db => list(db, storeId, kind, { limit: Number(rawLimit), cursor }, clock()),
          { serialize: true });
      });
      route('GET', path + '/:id', async (scope, req) => {
        const { storeId } = scope;
        const row = await inStore(pool, storeId, db => get(db, storeId, kind, uuid(req.params.id)));
        if (kind !== 'notice') return dto(row);
        const notice = row.data as Notice;
        const { closure, channel } = notice;
        const view = { ...dto(row), nextSendWindow: row.status === 'draft' && (channel === 'sms' || channel === 'talktalk')
          ? nightNoticeHint(clock()) : null, smsEnabled: Boolean(options.scheduledSms),
        // Exact final SMS text (ad prefix, sender line, opt-out), message type and current consenting count for the card.
        ...(channel === 'sms' && row.status === 'draft' && { smsPreview: await noticeSmsPreview(options, scope, notice) }) };
        if (!closure) return { ...view, closureStatus: 'none' };
        if (!options.readClosure) return { ...view, closureStatus: 'unavailable' };
        const current = await options.readClosure(scope, closure.eventId).catch(() => undefined);
        const closureStatus = current === undefined ? 'unavailable'
          : current?.eventId === closure.eventId && current.revision === closure.revision ? 'current' : 'changed';
        return { ...view, closureStatus };
      });
      command('POST', path, kind, `${kind}.create`);
      command('PATCH', path + '/:id/draft', kind, `${kind}.saveDraft`);
      command('POST', path + '/:id/attestation', kind, `${kind}.attest`);
    }
    command('POST', '/inquiries/:id/reply', 'inquiry', 'inquiry.post');
    command('PATCH', '/inquiries/:id/reply', 'inquiry', 'inquiry.editReply');
    command('DELETE', '/inquiries/:id/reply', 'inquiry', 'inquiry.deleteReply');
    command('DELETE', '/notices/:id/draft', 'notice', 'notice.deleteDraft');
    command('POST', '/notices/:id/send', 'notice', 'notice.send');
    command('POST', '/notices/:id/cancel-sms', 'notice', 'notice.cancelSms');
    route('GET', '/notices/:id/sms-reservation', async (scope, req) => inStore(pool, scope.storeId, async db => {
      const row = await get(db, scope.storeId, 'notice', uuid(req.params.id));
      const { channel, result } = row.data as Notice;
      if (channel !== 'sms' || !result || !('providerRef' in result) || !('scheduledFor' in result)) {
        throw new NoticeError(404, 'SMS_RESERVATION_NOT_FOUND');
      }
      // Our dispatch ledger, in the SENS reservation status vocabulary. No provider call and no numbers.
      return { resourceId: row.id, revision: row.revision, scheduledFor: result.scheduledFor,
        ...await dispatchStatus(db, scope.storeId, result.providerRef) };
    }));
    route('GET', '/notice-recipient-groups', async (scope, req) => {
      object(req.query, []);
      const now = clock();
      return inStore(pool, scope.storeId, async db => ({ asOf: now.toISOString(),
        items: await listRecipientGroups(db, scope.storeId, businessDay(now, clockOf(req))) }));
    });
    route('POST', '/notice-recipient-groups', async (scope, req) => {
      const { groupId } = object(req.body, ['groupId']);
      const group = parseGroupId(groupId);
      return inStore(pool, scope.storeId, db => ensureRecipientGroup(db, scope.storeId, group, clock()), { serialize: true });
    });

    command('DELETE', '/notices/:id/place-news', 'notice', 'notice.deleteNews');
    route('GET', '/notice-reply-receipts/:id', async (scope, req) =>
      inStore(pool, scope.storeId, db => byReceipt(db, scope, uuid(req.params.id))));
    route('POST', '/notice-reply-receipts/:id/undo', async (scope, req) => {
      object(req.body ?? {}, []);
      return undoNoticeDeletion(pool, options, scope, uuid(req.params.id), keyFor(req));
    });

    const provider = options.provider;
    function read<T>(port: T | undefined): T {
      if (!port) throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
      return port;
    }
    route('GET', '/reviews', async (scope, req) => {
      const query = object(req.query, ['view', 'product', 'rating', 'hasReply', 'sort']);
      const view = choice(query.view ?? 'venue', ['venue', 'booking'] as const);
      if (view === 'venue' && Object.keys(query).some(key => key !== 'view')) throw new NoticeError(400, 'INVALID_REVIEW_FILTER');
      const result = await read(provider?.reviews)(scope, { view,
        product: query.product === undefined ? undefined : text(query.product, 128),
        rating: query.rating === undefined ? undefined : Number(choice(query.rating, ['1', '2', '3', '4', '5'])) as 1 | 2 | 3 | 4 | 5,
        hasReply: query.hasReply === undefined ? undefined : choice(query.hasReply, ['true', 'false']) === 'true',
        sort: query.sort === undefined ? undefined : choice(query.sort, ['use-date'] as const),
      });
      return { ...result, authorNotification };
    });
    route('GET', '/reviews/:id', async (scope, req) => ({
      ...await read(provider?.review)(scope, reference(req.params.id)), authorNotification,
    }));
    route('GET', '/review-statistics', async (scope, req) => {
      const { unit } = object(req.query, ['unit']);
      return read(provider?.reviewStatistics)(scope, choice(unit ?? 'week', ['day', 'week', 'month'] as const));
    });
    route('POST', '/reviews/:id/draft-preview', async (scope, req) => {
      const { style, length } = object(req.body, ['style', 'length']);
      return { ...await read(provider?.reviewDraft)(scope,
        { ref: reference(req.params.id), style: text(style, 40), length: text(length, 40) }), source: 'naver-ai' };
    });
    route('POST', '/reviews/:id/navis-draft-preview', async (scope, req) => {
      const { style, length } = object(req.body, ['style', 'length']);
      const preferences = { style: text(style, 40), length: text(length, 40) };
      const draft = read(options.navisReviewDraft ?? provider?.navisReviewDraft);
      const review = await read(provider?.review)(scope, reference(req.params.id));
      const reviewText = text(redactReviewContact([...review.text].slice(0, 1000).join('')), 1000);
      const result = await draft(scope, { ...preferences, reviewText, rating: review.stars });
      return { text: publicReply(result.text), source: 'navis' };
    });
    route('GET', '/talktalk/consultations', async (scope, req) => {
      const query = object(req.query, ['from', 'to', 'status', 'cursor']);
      const from = date(query.from);
      const to = date(query.to);
      const duration = +new Date(to) - +new Date(from);
      if (duration < 0 || duration > 31 * 86400000) throw new NoticeError(400, 'INVALID_PERIOD');
      const status = query.status === undefined ? undefined : choice(query.status,
        ['waiting', 'in-progress', 'on-hold', 'completed', 'blocked', 'spam'] as const);
      return read(provider?.consultations)(scope, { from, to, status,
        cursor: query.cursor === undefined ? undefined : text(query.cursor, 200) });
    });
    route('GET', '/talktalk/consultations/:id', async (scope, req) => {
      const ref = reference(req.params.id);
      if (!ref.startsWith(liveInboxPrefix)) return read(provider?.consultation)(scope, ref);
      const { storeId } = scope;
      const inquiryId = uuid(ref.slice(liveInboxPrefix.length));
      const conversation = await inStore(pool, storeId, db => liveTalkTalkConversation(db, storeId, inquiryId, ref));
      if (!conversation) throw new NoticeError(404, 'NOT_FOUND');
      return conversation;
    });
    route('GET', '/talktalk/marketing/audiences', scope => read(provider?.audiences)(scope));
    route('GET', '/place/news', scope => read(provider?.news)(scope));
    route('GET', '/place/hours', scope => read(provider?.hours)(scope));
  });
}
