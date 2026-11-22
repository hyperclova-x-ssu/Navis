import { createTranslator } from '../../i18n';
import { isIsoDate, isTime, NOW } from '../db/time';
import type { DataSnapshot, DataTables, InquiryThread, PartnershipOffer, ReplyDraft } from '../db/types';
import { dataBundle } from '../messages';
import type { HandlerResult } from './handlers';
import type { DataCommand, DataErrorCode } from './types';

export type InquiryDraftCommand = Extract<DataCommand, { type: 'reply.draft' | 'inquiry.saveDraft' }>;
export type InquiryReplyCommand = Extract<DataCommand, { type: 'inquiry.send' | 'inquiry.post' }>;
export type CommunityResponseCommand = Extract<DataCommand, { type: 'community.accept' | 'community.decline' | 'community.sendInterest' }>;
type Rejected = Extract<HandlerResult, { ok: false }>;

const copy = createTranslator<string>('ko', dataBundle);
const reject = (code: DataErrorCode, messageKey: string, field?: string): Rejected =>
  ({ ok: false, code, messageKey, ...(field ? { field } : {}) });
const notFound = (field: string) => reject('NOT_FOUND', 'data.error.notFound', field);
const alreadyDone = () => reject('CONFLICT', 'data.error.alreadyDone');
const wrongType = () => reject('VALIDATION', 'data.error.wrongInquiryType', 'threadId');
const text = (key: string) => copy.has(key) ? copy.t(key) : '';
const validBody = (body: unknown): body is string => typeof body === 'string' && body.length <= 1000 && Boolean(body.trim());
const unsafePromise = /(?:환불|보상|결제\s*취소).{0,12}(?:해\s*드|가능|약속|처리하겠|진행하겠|해\s*주)/u;

export const inquirySourceText = (thread: InquiryThread): string => thread.bodyRaw ?? text(thread.bodyKey);
export const inquiryDraftRevision = (thread: InquiryThread): number => thread.replyDraft?.revision ?? 1;
export function storedInquiryReply(thread: InquiryThread): string | undefined {
  return thread.replyDraft?.body ?? (thread.draftKey ? text(thread.draftKey) || undefined : undefined);
}

function draftText(thread: InquiryThread, sourceText: string) {
  // The legacy parking and review fixtures have specific approved lines.
  if (thread.bodyKey === 'data.inquiry.body.parking') {
    return { body: text('data.inquiry.fake.parking'), grounding: [text('data.storeInfo.parking')] };
  }
  if (thread.bodyKey === 'data.inquiry.body.review') {
    return { body: text('data.inquiry.fake.review'), grounding: [] };
  }
  if (/일요일/u.test(sourceText) && /영업|열|문/u.test(sourceText) && !/임시|시험기간|더 일찍|더 늦게/u.test(sourceText)) {
    return { body: text('data.inquiry.draft.hours'), grounding: [text('data.storeInfo.hours')] };
  }
  return { body: text('data.inquiry.fake.acknowledge'), grounding: [] };
}

function readyThread(tables: DataTables, threadId: string): { ok: true; thread: InquiryThread } | Rejected {
  const thread = tables.inquiryThread.find(row => row.threadId === threadId);
  if (!thread) return notFound('threadId');
  if (thread.type !== 'message' && !(thread.type === 'review' && thread.isPublic)) return wrongType();
  if (thread.status === 'done') return alreadyDone();
  if (!tables.integration.channels) return reject('PREVIEW_FAILURE', 'data.error.replyDisconnected');
  return { ok: true, thread };
}

export function planInquiryDraft(tables: DataTables, command: InquiryDraftCommand):
  { ok: true; thread: InquiryThread; draft: ReplyDraft } | Rejected {
  const checked = readyThread(tables, command.threadId);
  if (!checked.ok) return checked;
  const { thread } = checked;
  const revision = inquiryDraftRevision(thread);
  const sourceText = inquirySourceText(thread);
  if (!sourceText) return reject('VALIDATION', 'data.error.replySourceMissing', 'threadId');
  if (command.type === 'reply.draft') {
    if (thread.needsPersonReason) return reject('VALIDATION', 'data.error.replyNeedsPerson', 'threadId');
    return { ok: true, thread, draft: { ...draftText(thread, sourceText), sourceText, revision: revision + 1, origin: 'generated' } };
  }
  if (command.revision !== revision) return reject('CONFLICT', 'data.management.error.STALE_REVISION', 'revision');
  if (!validBody(command.body) || unsafePromise.test(command.body)) return reject('VALIDATION', 'data.error.replyInvalidBody', 'body');
  const grounding = thread.replyDraft?.grounding ?? thread.groundKeys.map(text).filter(Boolean);
  return { ok: true, thread, draft: { body: command.body, sourceText, grounding, revision: revision + 1, origin: 'edited' } };
}

export function checkInquiryReply(tables: DataTables, command: InquiryReplyCommand):
  { ok: true; thread: InquiryThread } | Rejected {
  const checked = readyThread(tables, command.threadId);
  if (!checked.ok) return checked;
  const { thread } = checked;
  if (thread.type !== (command.type === 'inquiry.post' ? 'review' : 'message')) return wrongType();
  if (command.previewVariant === 'send-failure') return reject('PREVIEW_FAILURE', 'data.error.sendFailed');
  // The widget completion path already validated its server draft. Navis can only send the saved body.
  if (command.body !== undefined && (!validBody(command.body) || command.body !== storedInquiryReply(thread)
    || unsafePromise.test(command.body) || thread.needsPersonReason !== null)) {
    return reject('VALIDATION', 'data.error.replyInvalidBody', 'body');
  }
  return checked;
}

export function communityDeadlineOpen(snapshot: DataSnapshot, offer: PartnershipOffer): boolean {
  const now = `${snapshot.pos?.businessDate ?? NOW.slice(0, 10)}${NOW.slice(10)}`;
  const cutoff = offer.respondBy.slice(0, 16);
  return cutoff[10] === 'T' && isIsoDate(cutoff.slice(0, 10)) && isTime(cutoff.slice(11)) && cutoff >= now;
}

export function checkCommunityResponse(snapshot: DataSnapshot, command: CommunityResponseCommand):
  { ok: true; offer: PartnershipOffer } | Rejected {
  const offer = snapshot.tables.partnershipOffer.find(row => row.offerId === command.offerId);
  if (!offer) return notFound('offerId');
  const interest = command.type === 'community.sendInterest';
  if (snapshot.tables.realLocal) {
    const row = snapshot.tables.realLocal.offers.find(item => item.id === command.offerId);
    if (!row?.canRespond) return reject('CONFLICT', 'data.real.local.closed', 'offerId');
    if (interest && row.interested) return alreadyDone();
    return { ok: true, offer };
  }
  if (offer.visibility !== (interest ? 'public' : 'direct')) {
    return reject('VALIDATION', interest ? 'data.error.publicOnly' : 'data.error.directOnly', 'offerId');
  }
  if (offer.status === 'expired' || offer.status === 'pending' && !communityDeadlineOpen(snapshot, offer)) {
    return reject('CONFLICT', 'data.error.offerExpired', 'offerId');
  }
  if (offer.status !== 'pending' || interest && snapshot.tables.offerInterest.some(row => row.offerId === offer.offerId)) return alreadyDone();
  return { ok: true, offer };
}
