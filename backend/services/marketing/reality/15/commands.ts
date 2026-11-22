import { marketingCards, smsBinding } from './card-bindings.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NaverAdapterError, type AdapterCode } from '../../naver/errors.ts';
import { inStore } from '../../transaction.ts';
import type { Approval, Closure, NoticeReplyOptions, Owner, ProviderResult, SmsEffect } from './ports.ts';
import { talkTalkInboxRecipient } from './inbox.ts';
import { recipientGroup } from './recipients.ts';
import { assertWritable, byKey, byReceipt, complete, get, insert, reject, reserve } from './records.ts';
import type { Inquiry, Kind, Notice, Receipt, Row } from './records.ts';
import { cancelDispatch, noticeSmsText, scheduleDispatch } from './sms-dispatch.ts';
import {
  cardOperations, destructiveOperations, nightNoticeHint, NoticeError, noticeCommand, publicReply, smsMaxRecipients, smsReservationTime,
} from './wire.ts';
import type { CommandInput, NoticeDraft, Operation } from './wire.ts';

type NoticeEffect = ProviderResult | SmsEffect;
type Period = { date: string; endDate?: string };

/**
 * Adapter outcomes that are certain to have changed nothing at the provider (RV-GAP-B-5): local validation before
 * any request, a missing binding, or a documented refusal. Timeouts, `UNKNOWN_OUTCOME` and response-shape
 * violations stay pending because the write may have happened.
 */
const definitiveAdapterCodes = new Set<AdapterCode>(['NOT_CONFIGURED', 'LIVE_NOT_APPROVED', 'LIVE_CONTRACT_MISSING',
  'INVALID_INPUT', 'CONFIRMATION_REQUIRED', 'REJECTED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED']);

export function definitiveRejection(error: unknown) {
  if (error instanceof NoticeError) return error.code;
  if (error instanceof NaverAdapterError && definitiveAdapterCodes.has(error.code)) return 'PROVIDER_' + error.code;
  return null;
}
type Effect = (id: string) => Promise<NoticeEffect>;

function invoke<T>(port: T | undefined): T {
  if (!port) throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
  return port;
}

async function closureFor(options: NoticeReplyOptions, owner: Owner, draft: NoticeDraft): Promise<Closure | undefined> {
  if (!draft.closure) return;
  const current = await invoke(options.readClosure)(owner, draft.closure.eventId);
  if (!current || draft.closure.eventId !== current.eventId || draft.closure.revision !== current.revision) {
    throw new NoticeError(409, 'CLOSURE_CHANGED');
  }
  return current;
}

async function newRow(options: NoticeReplyOptions, owner: Owner, kind: Kind, input: CommandInput, now: Date): Promise<Row> {
  const { source, type, providerRef, title, text, sourceUrl } = input;
  const base = { id: randomUUID(), kind, revision: 1, source: source ?? null, providerRef: providerRef ?? null, updatedAt: now };
  if (kind === 'notice') return { ...base, status: 'draft', data: { ...input.notice!, result: null } };
  let reply: Inquiry['reply'] = null;
  if (source === 'review') {
    const review = await invoke(options.provider?.review)(owner, providerRef!);
    if (review.hasReply && review.reply) reply = { text: review.reply, state: 'saved' };
  }
  if (source === 'talktalk') await invoke(options.provider?.consultation)(owner, providerRef!);
  return { ...base, status: reply ? 'done' : 'waiting', data: {
    type: type!, title: title ?? null, text: text ?? null, sourceUrl: sourceUrl ?? null, draft: null, reply,
  } };
}

async function changeInquiry(db: PoolClient, options: NoticeReplyOptions, owner: Owner, row: Row, operation: Operation,
  input: CommandInput): Promise<{ effect?: Effect; apply: (result?: NoticeEffect) => Receipt['state'] }> {
  const data = row.data as Inquiry;
  if (operation === 'inquiry.saveDraft') {
    const text = data.type === 'review' ? publicReply(input.text) : input.text!;
    if (row.status === 'done') throw new NoticeError(409, 'REPLY_ALREADY_RECORDED');
    data.draft = { text, source: input.draftSource! };
    row.status = 'draft_ready';
    return { apply: () => 'saved' };
  }

  const ref = row.providerRef;
  const edit = operation === 'inquiry.editReply';
  const remove = operation === 'inquiry.deleteReply';
  if (edit || remove) {
    if (row.source !== 'review' || !ref) throw new NoticeError(409, 'CHANNEL_MISMATCH');
  } else {
    if (row.status === 'done') throw new NoticeError(409, 'REPLY_ALREADY_RECORDED');
    if (!data.draft) throw new NoticeError(409, 'DRAFT_REQUIRED');
  }
  const text = remove ? '' : edit ? input.text! : data.draft!.text;
  const apply = (result?: NoticeEffect): Receipt['state'] => {
    if (result && result.state !== 'saved' && result.state !== 'accepted') throw new Error('Unexpected SMS result for inquiry');
    const state = result?.state ?? 'recorded';
    row.status = remove ? 'waiting' : 'done';
    data.reply = remove ? null : { text, state };
    data.draft = null;
    return remove ? 'deleted' : state;
  };
  if (operation === 'inquiry.attest') return { apply };
  let effect: Effect;
  if (row.source === 'review' && ref) {
    if (!remove) publicReply(text);
    const review = await invoke(options.provider?.review)(owner, ref);
    if (review.hasReply !== (edit || remove)) throw new NoticeError(409, 'REVIEW_REPLY_CHANGED');
    const write = invoke(options.provider?.reviewReply);
    effect = effectId => write(owner, { effectId, ref, text, operation: remove ? 'delete' : edit ? 'edit' : 'create' });
  } else if (row.source === 'talktalk' && ref) {
    const recipient = await talkTalkInboxRecipient(db, owner.storeId, row.id);
    if (recipient?.live) {
      if (options.liveTalkTalk?.storeId !== owner.storeId) throw new NoticeError(409, 'UNAVAILABLE');
      const live = options.liveTalkTalk;
      return { effect: () => live.sendReply(recipient.user, text), apply };
    }
    const user = recipient?.user;
    if (!user) {
      const consultation = await invoke(options.provider?.consultation)(owner, ref);
      if (consultation.status === 'blocked' || consultation.status === 'spam') throw new NoticeError(409, 'REPLY_NOT_ALLOWED');
    }
    const write = invoke(options.provider?.talkTalkReply);
    effect = effectId => write(owner, { effectId, ref, text, ...(user && { user }) });
  } else {
    throw new NoticeError(409, 'MANUAL_ATTESTATION_REQUIRED');
  }
  return { effect, apply };
}

async function changeNotice(db: PoolClient, options: NoticeReplyOptions, owner: Owner, row: Row, operation: Operation,
  input: CommandInput, closure: Closure | undefined, period: Period | undefined) {
  const draft = row.data as Notice;
  if (operation === 'notice.deleteNews') {
    const ref = draft.result && 'providerRef' in draft.result ? draft.result.providerRef : undefined;
    if (row.status !== 'done' || draft.channel !== 'place-news' || !ref) throw new NoticeError(409, 'NEWS_NOT_PUBLISHED');
    const remove = invoke(options.provider?.deleteNews);
    return {
      effect: (effectId: string) => remove(owner, { effectId, ref }),
      apply(): Receipt['state'] { row.status = 'deleted'; return 'deleted'; },
    };
  }
  if (operation === 'notice.cancelSms') {
    const result = draft.result;
    if (draft.channel !== 'sms' || result?.state !== 'scheduled' || !('providerRef' in result) || !result.providerRef) {
      throw new NoticeError(409, 'SMS_NOT_CANCELABLE');
    }
    // DB-only: the ledger row is still ours until the worker claims it at the scheduled minute.
    if (!await cancelDispatch(db, owner.storeId, result.providerRef, row.updatedAt)) throw new NoticeError(409, 'SMS_NOT_CANCELABLE');
    return {
      effect: undefined,
      apply(): Receipt['state'] {
        row.data = { ...draft, result: { ...result, state: 'canceled' } as SmsEffect };
        return 'canceled';
      },
    };
  }
  if (input.scheduledFor && draft.channel !== 'sms') throw new NoticeError(400, 'INVALID_SMS_SCHEDULE');
  if (row.status !== 'draft') throw new NoticeError(409, 'NOTICE_ALREADY_COMPLETED');
  if (operation === 'notice.attest' && draft.channel === 'sms') throw new NoticeError(409, 'A6_DISABLED');
  let effect: Effect | undefined;
  let scheduled: SmsEffect | undefined;
  if (operation === 'notice.send') {
    if (draft.channel === 'sms') {
      if (!options.scheduledSms) throw new NoticeError(409, 'A6_DISABLED');
      if (!input.scheduledFor) throw new NoticeError(409, 'SMS_SCHEDULE_REQUIRED');
      // Owner-written notice copy is advertising: `(광고)`, sender line, body and free opt-out (RV-GAP-B-2).
      const text = noticeSmsText(draft);
      if (!text.type) throw new NoticeError(400, 'SMS_CONTENT_UNSUPPORTED');
      const schedule = smsReservationTime(input.scheduledFor, row.updatedAt, true);
      const recipients = await options.scheduledSms.recipients(owner, draft.recipientGroupId!, true);
      if (!recipients?.to.length) throw new NoticeError(409, 'SMS_CONSENT_REQUIRED');
      if (new Set(recipients.to).size > smsMaxRecipients) throw new NoticeError(409, 'SMS_RECIPIENT_LIMIT');
      // The ledger row commits with the receipt; no provider call happens at the press (RV-GAP-B-3/5/6).
      const dispatchId = await scheduleDispatch(db, owner, row, draft, schedule, { content: text.content, type: text.type },
        closure, period, row.updatedAt);
      scheduled = { state: 'scheduled', providerRef: dispatchId, scheduledFor: schedule.local };
    }
    if (draft.channel === 'manual') throw new NoticeError(409, 'MANUAL_ATTESTATION_REQUIRED');
    if (draft.channel === 'talktalk') {
      if (nightNoticeHint(row.updatedAt)) throw new NoticeError(409, 'NOTICE_OUTSIDE_SEND_WINDOW');
      const audience = draft.audience!;
      const audiences = await invoke(options.provider?.audiences)(owner);
      const target = audiences.items.find(item => item.audience === audience);
      if (!target) {
        throw new NoticeError(409, 'AUDIENCE_UNAVAILABLE');
      }
      if (audiences.quota?.assigned === 0) throw new NoticeError(409, 'NO_ASSIGNED_ALLOWANCE');
      const send = invoke(options.provider?.campaign);
      effect = effectId => send(owner, { effectId, audience, title: draft.title, body: draft.text, couponRef: draft.couponRef });
    }
    if (draft.channel === 'place-news') {
      const publish = invoke(options.provider?.publishNews);
      if (draft.pin) {
        const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(row.updatedAt);
        if (draft.pin.from !== day) throw new NoticeError(409, 'NEWS_PIN_MUST_START_TODAY');
        const news = await invoke(options.provider?.news)(owner);
        const activePins = news.items.filter(item => item.pin && item.pin.from <= day && item.pin.to >= day);
        if (activePins.length >= 5 || activePins.some(item => item.pin?.order === draft.pin?.order)) {
          throw new NoticeError(409, 'NEWS_PIN_LIMIT');
        }
      }
      effect = effectId => publish(owner, { effectId, title: draft.title, text: draft.text, pin: draft.pin });
    }
    if (draft.channel === 'place-hours' && closure) {
      if (+new Date(closure.endDate) - +new Date(closure.date) >= 31 * 86400000) {
        throw new NoticeError(409, 'HOLIDAY_HOURS_LIMIT');
      }
      const publish = invoke(options.provider?.publishClosure);
      effect = effectId => publish(owner, { effectId, closure });
    }
    if (draft.channel === 'place-hours' && draft.businessHours) {
      const publish = invoke(options.provider?.publishBusinessHours);
      const businessHours = draft.businessHours;
      effect = effectId => publish(owner, { effectId, businessHours });
    }
    if (!effect && !scheduled) throw new NoticeError(409, 'UNSUPPORTED_NOTICE_CHANNEL');
  }
  return {
    effect,
    apply(value?: NoticeEffect): Receipt['state'] {
      const result = value ?? scheduled;
      if (operation === 'notice.saveDraft') {
        row.data = { ...input.notice!, result: null };
        return 'saved';
      }
      if (operation === 'notice.deleteDraft') {
        row.status = 'deleted';
        return 'deleted';
      }
      row.status = 'done';
      row.data = { ...draft, result: result ?? { state: 'recorded' } };
      return result?.state ?? 'recorded';
    },
  };
}

export function commandFingerprint(operation: Operation, resourceId: string | null, input: CommandInput) {
  const command = { ...input };
  delete command.approvalId;
  return createHash('sha256').update(JSON.stringify({ operation, resourceId, command })).digest('hex');
}

export async function execute(pool: Pool, options: NoticeReplyOptions, owner: Owner, request: {
  operation: Operation; kind: Kind; id: string | null; key: string; raw: unknown;
}) {
  const { operation, kind, id, key, raw } = request;
  const clock = options.now ?? (() => new Date());
  const input = noticeCommand(operation, raw);
  const fingerprint = commandFingerprint(operation, id, input);
  const isSms = operation === 'notice.cancelSms' || operation === 'notice.send' && input.scheduledFor !== undefined;
  if (cardOperations.has(operation) && !isSms && !options.verifyApproval) throw new NoticeError(403, 'CARD_REQUIRED');

  const prepared = await inStore(pool, owner.storeId, async db => {
    const previous = await byKey(db, owner, key, fingerprint);
    if (previous) {
      if (!previous.receipt) throw new NoticeError(409, 'EFFECT_PENDING_RECONCILIATION', previous.receiptId);
      if (previous.receipt.state === 'rejected') {
        throw new NoticeError(409, previous.receipt.reason ?? 'PROVIDER_REJECTED', previous.receiptId);
      }
      return { receipt: previous.receipt };
    }
    const now = clock();
    const row = id ? await get(db, owner.storeId, kind, id) : await newRow(options, owner, kind, input, now);
    if (id && row.revision !== input.expectedRevision) throw new NoticeError(409, 'STALE_REVISION');
    if (id) await assertWritable(db, owner.storeId, row.id, input.approvalId);
    if (input.notice?.channel === 'sms' && !await recipientGroup(db, owner.storeId, input.notice.recipientGroupId!)) {
      throw new NoticeError(409, 'UNKNOWN_RECIPIENT_GROUP');
    }
    const baseRevision = row.revision;
    if (cardOperations.has(operation)) {
      const approval: Approval = { ...owner, approvalId: input.approvalId!, operation, resourceId: row.id,
        revision: row.revision, fingerprint, secondConfirmation: destructiveOperations.has(operation) };
      const allowed = isSms
        ? await marketingCards.consume(db, smsBinding(approval), approval.approvalId, now)
        : await options.verifyApproval!(approval, db);
      if (!allowed) throw new NoticeError(403, 'CARD_REQUIRED');
    }
    const draft = kind === 'notice' ? input.notice ?? row.data as NoticeDraft : undefined;
    const closure = draft && !destructiveOperations.has(operation) ? await closureFor(options, owner, draft) : undefined;
    const period = closure ? { date: closure.date, ...(closure.endDate !== closure.date && { endDate: closure.endDate }) }
      : draft?.startDate ? { date: draft.startDate, ...(draft.endDate && draft.endDate !== draft.startDate && { endDate: draft.endDate }) }
        : input.scheduledFor ? { date: input.scheduledFor.slice(0, 10) } : undefined;
    row.updatedAt = now;
    const change = !id ? { apply: (): Receipt['state'] => 'saved', effect: undefined }
      : kind === 'inquiry' ? await changeInquiry(db, options, owner, row, operation, input)
      : await changeNotice(db, options, owner, row, operation, input, closure, period);
    if (!id) await insert(db, owner.storeId, row);
    const receiptId = await reserve(db, owner, row, key, fingerprint, input.approvalId);
    if (id) row.revision++;
    if (change.effect) return { row, receiptId, period, baseRevision, effect: change.effect, apply: change.apply };
    const undoUntil = operation === 'notice.deleteDraft' ? new Date(now.getTime() + 6000).toISOString() : undefined;
    const receipt = await complete(db, owner, row, receiptId, change.apply(), period, undoUntil);
    return { receipt };
  }, { serialize: true });

  if ('receipt' in prepared) return prepared.receipt!;
  let result: NoticeEffect;
  try {
    result = await prepared.effect(prepared.receiptId);
  } catch (error) {
    const reason = definitiveRejection(error);
    if (reason) {
      // Known to have changed nothing: finish the attempt as rejected so the record is not locked (RV-GAP-B-5).
      await inStore(pool, owner.storeId, db => reject(db, owner, prepared.row, prepared.receiptId, prepared.baseRevision, reason),
        { serialize: true });
      throw new NoticeError(409, reason, prepared.receiptId);
    }
    // Unknown outcome: the reservation survives a timeout or crash. An unverified request is never sent a second time.
    throw new NoticeError(409, 'EFFECT_PENDING_RECONCILIATION', prepared.receiptId);
  }
  prepared.row.updatedAt = clock();
  return inStore(pool, owner.storeId, db => complete(db, owner, prepared.row, prepared.receiptId,
    prepared.apply(result), prepared.period), { serialize: true });
}

export function undoNoticeDeletion(pool: Pool, options: NoticeReplyOptions, owner: Owner, receiptId: string, key: string) {
  const fingerprint = createHash('sha256').update(`notice.undoDelete:${receiptId}`).digest('hex');
  return inStore(pool, owner.storeId, async db => {
    const prior = await byKey(db, owner, key, fingerprint);
    if (prior?.receipt) return prior.receipt;
    const original = await byReceipt(db, owner, receiptId);
    if (!('undoUntil' in original) || !original.undoUntil) throw new NoticeError(409, 'UNDO_UNAVAILABLE');
    const now = options.now?.() ?? new Date();
    if (now >= new Date(original.undoUntil)) throw new NoticeError(409, 'UNDO_EXPIRED');
    const row = await get(db, owner.storeId, 'notice', original.resourceId, true);
    if (row.status !== 'deleted' || row.revision !== original.revision) throw new NoticeError(409, 'STALE_REVISION');
    await assertWritable(db, owner.storeId, row.id);
    const undoReceipt = await reserve(db, owner, row, key, fingerprint);
    row.revision++;
    row.status = 'draft';
    row.updatedAt = now;
    return complete(db, owner, row, undoReceipt, 'saved');
  }, { serialize: true });
}
