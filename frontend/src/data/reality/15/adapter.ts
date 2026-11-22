/**
 * F15 (REAL-PLAN B15) — the `inbox` domain: inquiries, replies and notice drafts over `/api/v1/stores/{storeId}/marketing`.
 * Rows fill the existing `inquiryThread` / `noticeDraft` / `noticeSent` tables (Navis facts and the panels keep reading them);
 * the raw DTOs and the persona NAVER server (네이버 가상 서버) reads sit in `realInbox`. Every card-only operation first records the
 * owner's press at the approval issuer (`notice-reply-approvals`); typed or spoken text never reaches it.
 */
import { APP_CLOCK } from '../../db/app-clock';
import { addDays } from '../../db/time';
import { selectStoreClosures } from '../../iteration7/notices/selectors';
import type { NoticeCommand, NoticeDraft } from '../../iteration7/notices/types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter, type LoadContext, type PortReads, type PortTransport } from '../00';
import { issueCardApproval, type CardIntent } from './card-approval';
import { inquiryThread, noticeDraftRow, noticeHistoryRows, SMS_MINUTE, type AudiencesDto, type ConsultationsDto, type InboxPage, type InquiryDto, type NewsDto, type NoticeDetailDto, type NoticeDto, type Provided, type RealInbox, type ReviewDraftPreviewDto, type ReviewDraftSource, type ReviewInsightsDto, type ReviewStatsUnit, type ReviewsDto, type SmsReservationDto } from './dto';

const marketing = '/marketing';
const inquiries = `${marketing}/inquiries`;
const notices = `${marketing}/notices`;
const approvals = `${marketing}/notice-reply-approvals`;
const itemPath = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;
export const inquiryKey = (id: string) => `inquiry:${id}`;
export const noticeKey = (id: string) => `notice:${id}`;
const SESSION = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN']);
const inboxNotice = (name: string) => `data.real.inbox.${name}`;

type ApprovalOperation = 'inquiry.attest' | 'inquiry.post' | 'inquiry.editReply' | 'inquiry.deleteReply'
  | 'notice.attest' | 'notice.send' | 'notice.deleteDraft' | 'notice.deleteNews';
const DESTRUCTIVE: ReadonlySet<ApprovalOperation> = new Set(['inquiry.deleteReply', 'notice.deleteDraft', 'notice.deleteNews']);

/** Every page of a list, keeping the full-store waiting count the first page carries. */
async function readAll<T>({ reads, signal }: LoadContext, path: string, resource: string): Promise<InboxPage<T> & { readonly complete: boolean }> {
  const page = (cursor?: string) => reads.one<InboxPage<T>>({ resource, path, query: { limit: 100, cursor } }, { signal });
  const first = await page();
  const items = [...first.items];
  let cursor = first.nextCursor;
  for (let index = 1; cursor && index < 20; index++) {
    const next = await page(cursor);
    if (next.sourceRevision !== first.sourceRevision) return { ...first, items, nextCursor: cursor, complete: false };
    items.push(...next.items);
    cursor = next.nextCursor;
  }
  return { ...first, items, nextCursor: cursor, complete: cursor === null };
}

/** The persona NAVER server reads (fake until A6) must never take the record flow down: a failed read shows as unavailable. */
async function provided<T extends object>(signal: AbortSignal, read: () => Promise<T>): Promise<Provided<T>> {
  try { return { status: 'available', ...(await read()) }; }
  catch (error) {
    if (signal.aborted || error instanceof PortError && SESSION.has(error.code)) throw error;
    return { status: 'unavailable' };
  }
}

function expected(context: CommandContext, key: string): number {
  const revision = context.revision(key);
  if (revision === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return revision;
}
const inboxOf = (context: CommandContext) => context.snapshot.tables.realInbox;
function inquiryOf(context: CommandContext, id: string): InquiryDto {
  const row = inboxOf(context)?.inquiries.find(item => item.id === id);
  if (!row) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND', 'threadId');
  return row;
}
function noticeOf(context: CommandContext, id: string): NoticeDto {
  const row = inboxOf(context)?.notices.find(item => item.id === id);
  if (!row) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND', 'noticeId');
  return row;
}

/**
 * The owner's press. The command only arrives here after the card (or the widget's own confirmation) was pressed, so this is the first and only
 * call that records it. A delete is pressed and then confirmed (the second step); the service refuses a delete with only the first.
 */
async function approved(context: CommandContext, operation: ApprovalOperation, resourceId: string, command: { readonly expectedRevision: number; readonly text?: string }) {
  const approvalId = globalThis.crypto.randomUUID();
  const issue = (stage: 'press' | 'confirm') => context.request({ method: 'POST', path: approvals, body: { approvalId, operation, resourceId, command, stage } });
  await issue('press');
  if (DESTRUCTIVE.has(operation)) await issue('confirm');
  return { ...command, approvalId };
}

/**
 * SMS reservations (PN13) go through the separate owner-card issuer (CARD-AUTH `POST /marketing/approvals`): the generic notice approval
 * cannot grant them. Scheduling takes the press; cancelling takes the press and the second confirmation, both from the owner's buttons.
 */
async function smsApproval(context: CommandContext, key: string, row: NoticeDto, intent: Omit<CardIntent, 'targetRef' | 'expectedRevision'>, confirm: boolean) {
  const card: CardIntent = { ...intent, targetRef: row.id, expectedRevision: row.revision };
  const request = (input: Parameters<typeof context.request>[0]) => context.request(input);
  const press = await issueCardApproval(request, card, key, 'press');
  if (confirm) await issueCardApproval(request, card, key, 'confirm', press.approvalId);
  return press.approvalId;
}
const commandKey = (command: { readonly idempotencyKey?: string }) => command.idempotencyKey || `inbox:${globalThis.crypto.randomUUID()}`;

/** Review draft settings. NAVER does not publish the option names, so the chips stay hidden and these defaults are sent (SCREENS §17.6 #4). */
export const REVIEW_DRAFT_DEFAULTS = { style: '정중하게', length: '짧게' } as const;
/** PN03 NAVER draft or PN14 Navis draft of one visible review: a preview that saves and posts nothing. */
export function reviewDraftPreview(transport: Pick<PortTransport, 'request'>, source: ReviewDraftSource, reviewRef: string, signal?: AbortSignal) {
  return transport.request<ReviewDraftPreviewDto>({
    method: 'POST', path: `${marketing}/reviews/${encodeURIComponent(reviewRef)}/${source === 'navis' ? 'navis-draft-preview' : 'draft-preview'}`,
    body: REVIEW_DRAFT_DEFAULTS, ...(signal ? { signal } : {}),
  });
}
/** Insight's review AI statistics and the official average (GAP-INS). Read on demand by the inbox widget; never part of the record load. */
export function readReviewInsights(reads: PortReads, unit: ReviewStatsUnit, signal?: AbortSignal) {
  return reads.one<ReviewInsightsDto>({ resource: 'review-insights', path: '/insight/review-insights', query: { unit } }, signal ? { signal } : undefined);
}
/** One notice with the service's send facts, including the exact SMS preview for a saved SMS draft. */
export function readNotice(reads: PortReads, noticeId: string, signal?: AbortSignal) {
  return reads.one<NoticeDetailDto>({ resource: 'notice', path: itemPath(notices, noticeId) }, signal ? { signal } : undefined);
}
/** The provider's live status of one SMS reservation, read again on each press. */
export function readSmsReservation(reads: PortReads, noticeId: string, signal?: AbortSignal) {
  return reads.one<SmsReservationDto>({ resource: 'sms-reservation', path: `${itemPath(notices, noticeId)}/sms-reservation` }, signal ? { signal } : undefined);
}

type SaveDraft = Extract<NoticeCommand, { type: 'notice.saveDraft' }>;
function noticeBody(context: CommandContext, command: SaveDraft, existing: NoticeDraft | undefined) {
  const channel = command.channel ?? existing?.channel ?? 'manual';
  const linkedId = command.closureEventId === undefined ? existing?.closureEventId ?? null : command.closureEventId;
  const kept = linkedId !== null && existing?.closureEventId === linkedId;
  const current = linkedId ? selectStoreClosures({ tables: context.snapshot.tables }).find(item => item.eventId === linkedId) : undefined;
  const revision = kept ? existing!.closureRevision : current?.revision;
  if (linkedId && revision == null) throw new PortError(404, 'NOT_FOUND', 'UNKNOWN_CLOSURE', 'closureEventId');
  const closure = linkedId ? { eventId: linkedId, revision } : undefined;
  const audience = command.talkAudience ?? existing?.talkAudience;
  const group = command.recipientGroupId ?? existing?.recipientGroupId;
  if (channel === 'talktalk' && !audience) throw new PortError(400, 'VALIDATION', 'INVALID_AUDIENCE', 'talkAudience');
  if (channel === 'sms' && !group) throw new PortError(400, 'VALIDATION', 'INVALID_GROUP', 'recipientGroupId');
  const hours = command.businessHours ?? existing?.businessHours;
  const pin = command.pin ?? existing?.pin;
  const coupon = command.couponRef ?? existing?.couponRef;
  return {
    title: command.title, text: command.body, channel, startDate: command.startDate, endDate: command.endDate,
    ...(closure ? { closure } : {}),
    ...(channel === 'talktalk' ? { audience, ...(coupon ? { couponRef: coupon } : {}) } : {}),
    ...(channel === 'sms' ? { recipientGroupId: group } : {}),
    ...(channel === 'place-news' && pin ? { pin } : {}),
    ...(channel === 'place-hours' && !closure ? { businessHours: hours } : {}),
  };
}

async function loadInbox(context: LoadContext) {
  const { reads, storeId, signal } = context;
  const day = APP_CLOCK.calendarDate;
  const [inquiryPage, noticePage, reviews, consultations, audiences, news] = await Promise.all([
    readAll<InquiryDto>(context, inquiries, 'inquiries'),
    readAll<NoticeDto>(context, notices, 'notices'),
    provided<ReviewsDto>(signal, () => reads.one({ resource: 'reviews', path: `${marketing}/reviews`, query: { view: 'venue' } }, { signal })),
    provided<ConsultationsDto>(signal, () => reads.one({ resource: 'consultations', path: `${marketing}/talktalk/consultations`, query: { from: addDays(day, -30), to: day } }, { signal })),
    provided<AudiencesDto>(signal, () => reads.one({ resource: 'audiences', path: `${marketing}/talktalk/marketing/audiences` }, { signal })),
    provided<NewsDto>(signal, () => reads.one({ resource: 'place-news', path: `${marketing}/place/news` }, { signal })),
  ]);
  const authorNotification = inquiryPage.items.find(row => row.authorNotification)?.authorNotification
    ?? (reviews.status === 'available' ? reviews.authorNotification ?? null : null);
  const inbox: RealInbox = {
    storeId, asOf: [inquiryPage.asOf, noticePage.asOf].sort().at(-1)!, inquiries: inquiryPage.items, notices: noticePage.items,
    waitingInquiries: inquiryPage.waitingCount, activeNotices: noticePage.waitingCount, reviews, consultations, audiences, news, authorNotification,
  };
  return { inbox, inquiryPage, noticePage };
}

export const inboxAdapter: DomainAdapter = {
  domain: 'inbox',
  sources: ['inbox', 'notice-send', 'inquiries', 'notices', 'calendar'],
  tables: ['inquiryThread', 'noticeDraft', 'noticePreview', 'noticeSent', 'realInbox'],
  clear() { return { realInbox: undefined }; },
  errorKeys: {
    CLOSURE_CHANGED: 'data.notices.error.CLOSURE_CHANGED', NOTICE_OUTSIDE_SEND_WINDOW: 'data.notices.error.NIGHT_RESTRICTED',
    ...Object.fromEntries(['A6_DISABLED', 'CARD_REQUIRED', 'PENDING_OR_USED_APPROVAL', 'APPROVAL_EXPIRED', 'APPROVAL_CONFLICT', 'REPLY_CONTAINS_CONTACT',
      'REPLY_ALREADY_RECORDED', 'DRAFT_REQUIRED', 'MANUAL_ATTESTATION_REQUIRED', 'CHANNEL_MISMATCH', 'REVIEW_REPLY_CHANGED', 'REPLY_NOT_ALLOWED',
      'AUDIENCE_UNAVAILABLE', 'QUOTA_EXHAUSTED', 'NEWS_NOT_PUBLISHED', 'NOTICE_ALREADY_COMPLETED', 'INQUIRY_ALREADY_RECORDED', 'EFFECT_PENDING_RECONCILIATION',
      'PROVIDER_UNAVAILABLE', 'SCHEDULE_UNAVAILABLE', 'INVALID_SOURCE_URL', 'INVALID_TEXT', 'INVALID_AUDIENCE', 'INVALID_GROUP', 'INVALID_HOURS',
      'INVALID_NEWS_PIN', 'DRAFT_UNAVAILABLE', 'REPLY_BODY_MISMATCH', 'UNAVAILABLE', 'SMS_SCHEDULE_REQUIRED', 'SMS_SCHEDULE_TOO_SOON',
      'INVALID_SMS_SCHEDULE', 'SMS_CONTENT_UNSUPPORTED', 'SMS_CONSENT_REQUIRED', 'SMS_NOT_CANCELABLE', 'SMS_RESERVATION_NOT_FOUND'].map(reason => [reason, `data.real.inbox.error.${reason}`])),
  },
  async load(context) {
    const { inbox, inquiryPage, noticePage } = await loadInbox(context);
    const drafts = inbox.notices.filter(row => row.status === 'draft').map(noticeDraftRow);
    const closures = selectStoreClosures({ tables: context.snapshot.tables });
    const done = noticeHistoryRows(inbox.notices.filter(row => row.status === 'done'), closures);
    const reviews = new Map(inbox.reviews.status === 'available' ? inbox.reviews.items.map(row => [row.ref, row]) : []);
    return {
      tables: { inquiryThread: inbox.inquiries.map(row => inquiryThread(row, row.source === 'review' && row.providerRef ? reviews.get(row.providerRef) : undefined)),
        noticeDraft: drafts, noticePreview: [], noticeSent: done, realInbox: inbox },
      revisions: {
        ...Object.fromEntries(inbox.inquiries.map(row => [inquiryKey(row.id), row.revision])),
        ...Object.fromEntries(inbox.notices.map(row => [noticeKey(row.id), row.revision])),
      },
      asOf: inbox.asOf,
      sourceRevision: inquiryPage.sourceRevision + noticePage.sourceRevision,
      complete: inquiryPage.complete && noticePage.complete,
    };
  },
  commands: [
    defineBinding({ type: 'inquiry.create', noticeKey: inboxNotice('inquiryRecorded'), request: ({ kind, title, body, sourceUrl }) => ({
      method: 'POST', path: inquiries, body: { source: 'manual', type: kind, title, text: body, ...(sourceUrl ? { sourceUrl } : {}) },
    }) }),
    defineBinding({ type: 'inquiry.import', noticeKey: inboxNotice('inquiryRecorded'), request: ({ source, providerRef }) => ({
      method: 'POST', path: inquiries, body: { source, providerRef },
    }) }),
    defineBinding({ type: 'inquiry.saveDraft', noticeKey: 'data.notice.replyDraftSaved', request: (command, context) => ({
      method: 'PATCH', path: `${itemPath(inquiries, command.threadId)}/draft`,
      body: { text: command.body, draftSource: 'draftSource' in command ? command.draftSource : 'owner' }, expectedRevision: expected(context, inquiryKey(command.threadId)),
    }) }),
    // The review draft styles and lengths of PN03 are not enumerated by the provider; drafts are written by the owner (or proposed by a Navis card as text).
    defineBinding({ type: 'reply.draft', request: () => { throw new PortError(400, 'VALIDATION', 'DRAFT_UNAVAILABLE', 'threadId'); } }),
    ...(['inquiry.send', 'inquiry.post'] as const).map(type => defineBinding({ type, noticeKey: inboxNotice('replyDone'),
      request: async ({ threadId, body }, context) => {
        const row = inquiryOf(context, threadId);
        if (!row.draft) throw new PortError(409, 'CONFLICT', 'DRAFT_REQUIRED', 'threadId');
        if (body !== undefined && body !== row.draft.text) throw new PortError(400, 'VALIDATION', 'REPLY_BODY_MISMATCH', 'body');
        const manual = row.source === 'manual';
        const operation = manual ? 'inquiry.attest' : 'inquiry.post';
        const action = await approved(context, operation, threadId, { expectedRevision: row.revision });
        return { method: 'POST', path: `${itemPath(inquiries, threadId)}/${manual ? 'attestation' : 'reply'}`, body: action };
      } })),
    defineBinding({ type: 'inquiry.editReply', noticeKey: inboxNotice('replyEdited'), request: async ({ threadId, body }, context) => {
      const row = inquiryOf(context, threadId);
      const action = await approved(context, 'inquiry.editReply', threadId, { expectedRevision: row.revision, text: body });
      return { method: 'PATCH', path: `${itemPath(inquiries, threadId)}/reply`, body: action };
    } }),
    defineBinding({ type: 'inquiry.deleteReply', noticeKey: inboxNotice('replyDeleted'), request: async ({ threadId }, context) => {
      const row = inquiryOf(context, threadId);
      const action = await approved(context, 'inquiry.deleteReply', threadId, { expectedRevision: row.revision });
      return { method: 'DELETE', path: `${itemPath(inquiries, threadId)}/reply`, body: action };
    } }),
    defineBinding({ type: 'notice.saveDraft', noticeKey: 'data.notices.notice.saved', request: (command, context) => {
      const existing = command.noticeId ? context.snapshot.tables.noticeDraft.find(row => row.noticeId === command.noticeId) : undefined;
      if (command.noticeId && !existing) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND', 'noticeId');
      const body = noticeBody(context, command, existing);
      return command.noticeId
        ? { method: 'PATCH', path: `${itemPath(notices, command.noticeId)}/draft`, body, expectedRevision: expected(context, noticeKey(command.noticeId)) }
        : { method: 'POST', path: notices, body };
    } }),
    defineBinding({ type: 'notice.importClosure', noticeKey: 'data.notices.notice.saved', request: (command, context) => {
      const closure = selectStoreClosures({ tables: context.snapshot.tables }).find(item => item.eventId === command.eventId);
      if (!closure) throw new PortError(404, 'NOT_FOUND', 'UNKNOWN_CLOSURE', 'eventId');
      const existing = command.noticeId ? context.snapshot.tables.noticeDraft.find(row => row.noticeId === command.noticeId) : undefined;
      if (command.noticeId && !existing) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND', 'noticeId');
      const channel = existing?.channel ?? 'manual';
      const body = { title: closure.title, text: closure.body || closure.title, channel, startDate: closure.startDate, endDate: closure.endDate,
        closure: { eventId: closure.eventId, revision: closure.revision },
        ...(channel === 'talktalk' && existing?.talkAudience ? { audience: existing.talkAudience } : {}),
        ...(channel === 'sms' && existing?.recipientGroupId ? { recipientGroupId: existing.recipientGroupId } : {}) };
      return command.noticeId
        ? { method: 'PATCH', path: `${itemPath(notices, command.noticeId)}/draft`, body, expectedRevision: expected(context, noticeKey(command.noticeId)) }
        : { method: 'POST', path: notices, body };
    } }),
    defineBinding({ type: 'notice.deleteDraft', noticeKey: 'data.notices.notice.deleted', receiptBase: marketing,
      undoPath: receiptId => `${marketing}/notice-reply-receipts/${encodeURIComponent(receiptId)}/undo`,
      request: async ({ noticeId }, context) => {
        const row = noticeOf(context, noticeId);
        const action = await approved(context, 'notice.deleteDraft', noticeId, { expectedRevision: row.revision });
        return { method: 'DELETE', path: `${itemPath(notices, noticeId)}/draft`, body: action };
      } }),
    defineBinding({ type: 'notice.send', noticeKey: inboxNotice('noticeDone'), request: async (command, context) => {
      const { noticeId, draftRevision, sendAt } = command;
      const row = noticeOf(context, noticeId);
      if (row.channel === 'sms') {
        // PN13 SMS is a reservation only (Seoul minute, at least ten minutes ahead, never at night). Its card is the separate SMS issuer.
        if (sendAt === undefined) throw new PortError(400, 'VALIDATION', 'SMS_SCHEDULE_REQUIRED', 'sendAt');
        if (!SMS_MINUTE.test(sendAt)) throw new PortError(400, 'VALIDATION', 'INVALID_SMS_SCHEDULE', 'sendAt');
        if (draftRevision !== row.revision) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
        const approvalId = await smsApproval(context, commandKey(command), row, { operation: 'sms.schedule', command: { scheduledFor: sendAt } }, false);
        return { method: 'POST', path: `${itemPath(notices, noticeId)}/send`, body: { expectedRevision: draftRevision, approvalId, scheduledFor: sendAt } };
      }
      // Other channels have no scheduled send: a card at night is pressed again when sending is allowed (`내일 8시`).
      if (sendAt !== undefined) throw new PortError(400, 'VALIDATION', 'SCHEDULE_UNAVAILABLE', 'sendAt');
      const manual = row.channel === 'manual';
      const action = await approved(context, manual ? 'notice.attest' : 'notice.send', noticeId, { expectedRevision: draftRevision });
      return { method: 'POST', path: `${itemPath(notices, noticeId)}/${manual ? 'attestation' : 'send'}`, body: action };
    } }),
    // The fixture's D-326 cancel of a scheduled notice. Over HTTP the history row's `sentId` is the notice ID; the owner presses twice.
    defineBinding({ type: 'notice.cancelSchedule', noticeKey: 'data.notices.notice.scheduleCancelled', request: async (command, context) => {
      const row = noticeOf(context, command.sentId);
      if (row.channel !== 'sms' || row.result?.state !== 'scheduled') throw new PortError(409, 'CONFLICT', 'SMS_NOT_CANCELABLE', 'sentId');
      const approvalId = await smsApproval(context, commandKey(command), row, { operation: 'sms.cancel', command: {} }, true);
      return { method: 'POST', path: `${itemPath(notices, row.id)}/cancel-sms`, body: { expectedRevision: row.revision, approvalId } };
    } }),
    defineBinding({ type: 'notice.deleteNews', noticeKey: inboxNotice('newsDeleted'), request: async ({ noticeId }, context) => {
      const row = noticeOf(context, noticeId);
      const action = await approved(context, 'notice.deleteNews', noticeId, { expectedRevision: row.revision });
      return { method: 'DELETE', path: `${itemPath(notices, noticeId)}/place-news`, body: action };
    } }),
  ],
};
