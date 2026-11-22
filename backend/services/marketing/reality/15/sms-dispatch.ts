import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { advertisingSmsText, smsMessageType } from '../../sms-text.ts';
import { inStore } from '../../transaction.ts';
import type { Closure, NoticeReplyOptions, Owner, SmsEffect, SmsState, SmsStatus } from './ports.ts';
import { get, publishRecordChange } from './records.ts';
import type { Notice, Row } from './records.ts';
import type { NoticeDraft } from './wire.ts';
import { isAdvertisingHour, NoticeError, seoulMinute, sensBatchSize, smsMaxRecipients, uuid } from './wire.ts';
import { configuredSensSettings, liveAdvertisingText } from './sens-settings.ts';

/**
 * Scheduled owner notice SMS (RV-GAP-B-3/5/6). The card press writes one ledger row in the same transaction as the
 * receipt and calls no provider. At the scheduled minute marketing-worker claims the row through the private routes
 * below; Marketing re-resolves SMS advertising consent and the approved closure revision right before the send and
 * returns the numbers in the claim response only. The worker holds the PN13 credentials and reports each batch.
 */
export const noticeSmsDispatchRoot = '/internal/v1/marketing/notice-sms-dispatch/stores/:storeId';
const staleClaimMs = 2 * 60_000;
const providerId = /^[A-Za-z0-9_-]{1,128}$/;

type BatchState = 'sending' | 'accepted' | 'failed' | 'unknown' | 'not_sent';
type Batch = { batch: number; size: number; state: BatchState; requestId?: string; skipped?: number; delivery?: 'delivered' | 'failed' };
type Dispatch = {
  storeId: string; dispatchId: string; noticeId: string; actorId: string; scheduledAt: Date; scheduledLocal: string;
  content: string; messageType: 'SMS' | 'LMS'; recipientGroupId: string; closure: Closure | null;
  period: { date: string; endDate?: string } | null; state: SmsState | 'dispatching'; reason: string | null;
  batches: Batch[]; recipientCount: number | null; providerLive: boolean;
};
const columns = `store_id AS "storeId", dispatch_id AS "dispatchId", notice_id AS "noticeId", actor_id AS "actorId",
  scheduled_at AS "scheduledAt", scheduled_local AS "scheduledLocal", content, message_type AS "messageType",
  recipient_group_id AS "recipientGroupId", closure, period, state, reason, batches, recipient_count AS "recipientCount",
  provider_live AS "providerLive"`;

/** The exact final text and SENS message type the card previews and the worker sends. */
export function noticeSmsText(draft: Pick<NoticeDraft, 'text'>, content = advertisingSmsText(draft.text)) {
  const kind = smsMessageType(content);
  return { content, contentType: 'AD' as const, type: kind?.type ?? null, bytes: kind?.bytes ?? null };
}

export async function approvedNoticeSmsText(options: NoticeReplyOptions, owner: Owner, draft: Pick<NoticeDraft, 'text'>) {
  if (options.scheduledSms?.mode !== 'live') return noticeSmsText(draft);
  const settings = await options.scheduledSms.settings?.(owner.storeId) ?? null;
  if (!configuredSensSettings(settings)) throw new NoticeError(409, 'SMS_SETTINGS_REQUIRED');
  return noticeSmsText(draft, liveAdvertisingText(draft.text, settings));
}

/** Card preview for an SMS draft: exact final text, message type, current consenting count and send reasons. */
export async function noticeSmsPreview(options: NoticeReplyOptions, owner: Owner, draft: NoticeDraft) {
  const reasons: string[] = [];
  const text = await approvedNoticeSmsText(options, owner, draft).catch(() => {
    reasons.push('SMS_SETTINGS_REQUIRED');
    return noticeSmsText(draft, draft.text);
  });
  if (!options.scheduledSms) reasons.push('A6_DISABLED');
  if (!text.type) reasons.push('SMS_CONTENT_UNSUPPORTED');
  let recipientCount: number | null = null;
  if (options.scheduledSms && draft.recipientGroupId) {
    const recipients = await options.scheduledSms.recipients(owner, draft.recipientGroupId, true).catch(() => undefined);
    recipientCount = recipients === undefined ? null : recipients?.to.length ?? 0;
    if (recipients === undefined) reasons.push('RECIPIENTS_UNAVAILABLE');
    else if (!recipientCount) reasons.push('SMS_CONSENT_REQUIRED');
    else if (recipientCount > smsMaxRecipients) reasons.push('SMS_RECIPIENT_LIMIT');
  }
  return { ...text, recipientCount, maxRecipients: smsMaxRecipients, sendAllowed: !reasons.length, reasons };
}

export async function scheduleDispatch(db: PoolClient, owner: Owner, row: Row, draft: NoticeDraft,
  schedule: { local: string; at: Date }, text: { content: string; type: 'SMS' | 'LMS' }, closure: Closure | undefined,
  period: { date: string; endDate?: string } | undefined, now: Date, providerLive = false) {
  const dispatchId = randomUUID();
  await db.query(`INSERT INTO marketing.notice_sms_dispatch (store_id, dispatch_id, notice_id, actor_id, scheduled_at,
      scheduled_local, content, message_type, recipient_group_id, closure, period, state, created_at, provider_live)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled',$12,$13)`,
  [owner.storeId, dispatchId, row.id, owner.actorId, schedule.at, schedule.local, text.content, text.type,
    draft.recipientGroupId, closure ? JSON.stringify(closure) : null, period ? JSON.stringify(period) : null, now, providerLive]);
  return dispatchId;
}

/** Owner cancellation before the scheduled minute. A claimed dispatch can no longer be canceled. */
export async function cancelDispatch(db: PoolClient, storeId: string, dispatchId: string, now: Date) {
  const { rowCount } = await db.query(`UPDATE marketing.notice_sms_dispatch SET state='canceled', finished_at=$3
    WHERE store_id=$1 AND dispatch_id=$2 AND state='scheduled' AND scheduled_at > $3`, [storeId, dispatchId, now]);
  return rowCount === 1;
}

const statusOf: Record<Dispatch['state'], SmsStatus> = {
  scheduled: 'READY', dispatching: 'PROCESSING', uncertain: 'PROCESSING', sent: 'DONE', canceled: 'CANCELED',
  skipped: 'SKIP', failed: 'FAIL',
};

/** Ledger status in the SENS reservation vocabulary, plus the re-check reason and counts. No provider call. */
export async function dispatchStatus(db: PoolClient, storeId: string, dispatchId: string) {
  const { rows: [row] } = await db.query<Dispatch>(`SELECT ${columns} FROM marketing.notice_sms_dispatch
    WHERE store_id=$1 AND dispatch_id=$2`, [storeId, dispatchId]);
  if (!row) throw new NoticeError(404, 'SMS_RESERVATION_NOT_FOUND');
  const count = (batches: Batch[]) => batches.reduce((sum, batch) => sum + batch.size - (batch.skipped ?? 0), 0);
  return { status: statusOf[row.state], dispatchState: row.state, reason: row.reason, messageType: row.messageType,
    recipientCount: row.recipientCount, acceptedCount: count(row.batches.filter(batch => batch.state === 'accepted')),
    failedCount: count(row.batches.filter(batch => batch.state === 'failed')),
    unknownCount: count(row.batches.filter(batch => batch.state === 'unknown')),
    ...(row.providerLive && {
      skippedCount: row.batches.reduce((sum, batch) => sum + (batch.skipped ?? 0), 0),
      deliveredCount: count(row.batches.filter(batch => batch.delivery === 'delivered')),
      deliveryFailedCount: count(row.batches.filter(batch => batch.delivery === 'failed')),
    }) };
}

async function finish(db: PoolClient, dispatch: Dispatch, state: Exclude<SmsState, 'scheduled' | 'canceled'>,
  reason: string | null, now: Date) {
  await db.query(`UPDATE marketing.notice_sms_dispatch SET state=$3, reason=$4, finished_at=$5
    WHERE store_id=$1 AND dispatch_id=$2`, [dispatch.storeId, dispatch.dispatchId, state, reason, now]);
  const row = await get(db, dispatch.storeId, 'notice', dispatch.noticeId, true);
  const notice = row.data as Notice;
  if (notice.result?.state !== 'scheduled' || !('providerRef' in notice.result) || notice.result.providerRef !== dispatch.dispatchId) {
    return;
  }
  const result: SmsEffect = { state, providerRef: dispatch.dispatchId, scheduledFor: dispatch.scheduledLocal,
    ...(reason && { reason }) };
  row.data = { ...notice, result };
  row.revision++;
  row.updatedAt = now;
  await db.query(`UPDATE marketing.reply_notice_record SET revision=$3, data=$4, updated_at=$5 WHERE store_id=$1 AND id=$2`,
    [dispatch.storeId, row.id, row.revision, row.data, row.updatedAt]);
  await publishRecordChange(db, dispatch.storeId, row, state, undefined, dispatch.period ?? undefined);
}

function settle(batches: Batch[]): { state: 'sent' | 'failed' | 'uncertain' | 'skipped'; reason: string | null } | null {
  if (batches.some(batch => batch.state === 'sending')) return null;
  if (batches.some(batch => batch.state === 'unknown')) return { state: 'uncertain', reason: 'PROVIDER_OUTCOME_UNKNOWN' };
  if (batches.some(batch => batch.state === 'accepted')) {
    return { state: 'sent', reason: batches.some(batch => batch.skipped) ? 'NOT_SENT_TEST_MODE'
      : batches.some(batch => batch.state === 'failed') ? 'PARTIAL_PROVIDER_REJECTION' : null };
  }
  if (batches.every(batch => batch.state === 'not_sent')) return { state: 'skipped', reason: 'NOT_SENT_TEST_MODE' };
  return { state: 'failed', reason: 'PROVIDER_REJECTED' };
}

type Check = { skip: string } | { from: string; to: string[] };

/** Consent, closure and daytime window just before sending. Unavailable sources throw so the row stays scheduled. */
async function recheck(options: NoticeReplyOptions, dispatch: Dispatch, now: Date): Promise<Check> {
  if (!isAdvertisingHour(seoulMinute(now))) return { skip: 'NOTICE_OUTSIDE_SEND_WINDOW' };
  const owner = { storeId: dispatch.storeId, actorId: dispatch.actorId };
  if (dispatch.closure) {
    if (!options.readClosure) throw new NoticeError(503, 'CLOSURE_UNAVAILABLE');
    const current = await options.readClosure(owner, dispatch.closure.eventId);
    if (!current || current.eventId !== dispatch.closure.eventId || current.revision !== dispatch.closure.revision) {
      return { skip: 'CLOSURE_CHANGED' };
    }
  }
  if (!options.scheduledSms) throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
  if (dispatch.providerLive !== (options.scheduledSms.mode === 'live')) return { skip: 'SMS_PROVIDER_CHANGED' };
  const recipients = await options.scheduledSms.recipients(owner, dispatch.recipientGroupId, true);
  if (!recipients?.to.length) return { skip: 'SMS_CONSENT_REQUIRED' };
  const to = [...new Set(recipients.to)];
  if (to.length > smsMaxRecipients) return { skip: 'SMS_RECIPIENT_LIMIT' };
  return { from: recipients.from, to };
}

/** Private marketing-worker routes. Registered only when a distinct worker credential is configured. */
export function registerNoticeSmsDispatch(app: FastifyInstance, pool: Pool, options: NoticeReplyOptions) {
  if (!options.smsWorkerToken) return;
  if (options.smsWorkerToken === options.gatewayToken) throw new Error('The SMS worker credential must be distinct');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${options.smsWorkerToken}`);
  const clock = options.now ?? (() => new Date());
  app.register(async routes => {
    type Params = { storeId: string; dispatchId?: string };
    routes.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
    });
    routes.setErrorHandler((error, req, reply) => {
      if (error instanceof NoticeError) return reply.code(error.status).send({ code: error.code });
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ code: 'INVALID_REQUEST' });
      req.log.error('Notice SMS dispatch request failed');
      return reply.code(503).send({ code: 'UNAVAILABLE' });
    });
    const read = (storeId: string, dispatchId: string, lock = false) => async (db: PoolClient) => {
      const { rows: [row] } = await db.query<Dispatch>(`SELECT ${columns} FROM marketing.notice_sms_dispatch
        WHERE store_id=$1 AND dispatch_id=$2${lock ? ' FOR UPDATE' : ''}`, [storeId, dispatchId]);
      return row;
    };

    routes.get<{ Params: Params }>(noticeSmsDispatchRoot, async req => {
      const storeId = uuid(req.params.storeId);
      const now = clock();
      return inStore(pool, storeId, async db => {
        const { rows } = await db.query<Dispatch>(`SELECT ${columns} FROM marketing.notice_sms_dispatch WHERE store_id=$1 AND
          ((state='scheduled' AND scheduled_at <= $2) OR (state='dispatching' AND claimed_at < $3) OR
            (provider_live AND state='sent' AND finished_at > $2 - interval '7 days' AND EXISTS
              (SELECT 1 FROM jsonb_array_elements(batches) AS b WHERE b->>'state'='accepted' AND NOT (b ? 'delivery'))))
          ORDER BY CASE WHEN state='sent' THEN 1 ELSE 0 END, scheduled_at, dispatch_id LIMIT 20`,
        [storeId, now, new Date(+now - staleClaimMs)]);
        return rows.map(row => ({ dispatchId: row.dispatchId, state: row.state,
          pendingBatches: row.batches.filter(batch => batch.state === 'sending').map(batch => batch.batch),
          ...(row.state === 'sent' && { acceptedBatches: row.batches.filter(batch => batch.state === 'accepted' && !batch.delivery)
            .map(batch => ({ batch: batch.batch, providerId: batch.requestId, size: batch.size - (batch.skipped ?? 0) })) }) }));
      });
    });

    routes.post<{ Params: Params }>(noticeSmsDispatchRoot + '/:dispatchId/claim', async req => {
      const storeId = uuid(req.params.storeId);
      const dispatchId = uuid(req.params.dispatchId);
      const due = await inStore(pool, storeId, read(storeId, dispatchId));
      if (!due || due.state !== 'scheduled' || due.scheduledAt > clock()) return null;
      // Network re-checks run outside the store lock; the state change below is a compare-and-set.
      const check = await recheck(options, due, clock());
      return inStore(pool, storeId, async db => {
        const now = clock();
        const row = await read(storeId, dispatchId, true)(db);
        if (!row || row.state !== 'scheduled' || row.scheduledAt > now) return null;
        if ('skip' in check) {
          await finish(db, row, 'skipped', check.skip, now);
          return null;
        }
        const batches: Batch[] = [];
        for (let index = 0; index * sensBatchSize < check.to.length; index++) {
          batches.push({ batch: index, size: check.to.slice(index * sensBatchSize, (index + 1) * sensBatchSize).length, state: 'sending' });
        }
        await db.query(`UPDATE marketing.notice_sms_dispatch SET state='dispatching', claimed_at=$3, recipient_count=$4, batches=$5
          WHERE store_id=$1 AND dispatch_id=$2`, [storeId, dispatchId, now, check.to.length, JSON.stringify(batches)]);
        return { dispatchId, type: row.messageType, contentType: 'AD', content: row.content, from: check.from,
          ...(row.providerLive && { providerLive: true }),
          batches: batches.map(batch => ({ batch: batch.batch,
            to: check.to.slice(batch.batch * sensBatchSize, (batch.batch + 1) * sensBatchSize) })) };
      }, { serialize: true });
    });

    routes.post<{ Params: Params; Body: unknown }>(noticeSmsDispatchRoot + '/:dispatchId/result', { bodyLimit: 1024 },
      async (req, reply) => {
        const storeId = uuid(req.params.storeId);
        const dispatchId = uuid(req.params.dispatchId);
        const body = req.body as { batch?: unknown; state?: unknown; providerId?: unknown; skipped?: unknown } | null;
        const state = body?.state;
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['batch', 'state', 'providerId', 'skipped'].includes(key))
          || typeof body.batch !== 'number' || !Number.isInteger(body.batch) || body.batch < 0
          || (state !== 'accepted' && state !== 'failed' && state !== 'unknown' && state !== 'not_sent'
            && state !== 'delivered' && state !== 'delivery_failed')
          || (body.skipped !== undefined && (typeof body.skipped !== 'number' || !Number.isInteger(body.skipped) || body.skipped < 0))
          || (state === 'accepted') !== (typeof body.providerId === 'string' && providerId.test(body.providerId))) {
          throw new NoticeError(400, 'INVALID_SMS_RESULT');
        }
        await inStore(pool, storeId, async db => {
          const row = await read(storeId, dispatchId, true)(db);
          if (!row) return;
          const batch = row.batches.find(entry => entry.batch === body.batch);
          if (!batch) return;
          if (state === 'delivered' || state === 'delivery_failed') {
            if (!row.providerLive || row.state !== 'sent' || batch.state !== 'accepted' || batch.delivery) return;
            batch.delivery = state === 'delivered' ? 'delivered' : 'failed';
            await db.query('UPDATE marketing.notice_sms_dispatch SET batches=$3 WHERE store_id=$1 AND dispatch_id=$2',
              [storeId, dispatchId, JSON.stringify(row.batches)]);
            return;
          }
          if (row.state !== 'dispatching' || batch.state !== 'sending') return;
          if (body.skipped !== undefined) {
            const skipped = body.skipped as number;
            if (!row.providerLive || skipped > batch.size || (state === 'not_sent') !== (skipped === batch.size)) {
              throw new NoticeError(400, 'INVALID_SMS_RESULT');
            }
            batch.skipped = skipped;
          } else if (state === 'not_sent') throw new NoticeError(400, 'INVALID_SMS_RESULT');
          batch.state = state;
          if (state === 'accepted') batch.requestId = body.providerId as string;
          await db.query(`UPDATE marketing.notice_sms_dispatch SET batches=$3 WHERE store_id=$1 AND dispatch_id=$2`,
            [storeId, dispatchId, JSON.stringify(row.batches)]);
          const settled = settle(row.batches);
          if (settled) await finish(db, row, settled.state, settled.reason, clock());
        }, { serialize: true });
        return reply.code(204).send();
      });

    routes.post<{ Params: Params; Body: { memberId?: unknown } }>(noticeSmsDispatchRoot + '/coupon-recipient',
      { bodyLimit: 1024 }, async req => {
        const storeId = uuid(req.params.storeId);
        const memberId = uuid(req.body?.memberId);
        const reader = options.scheduledSms?.mode === 'live' && options.scheduledSms.couponRecipient;
        if (!reader) throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
        return { phone: await reader(storeId, memberId) };
      });
  });
}
