import type { DataCommandResult } from './types';
import { deepFreeze } from '../db/freeze';
import { addDays, isIsoDate, isTime, NOW } from '../db/time';
import { selectDraftClosureLink, selectStoreClosures } from '../iteration7/notices/selectors';
import { resolveNoticeRecipients } from '../iteration7/notices/recipients';
import type { ClosureLinkStatus, NoticeCommand, NoticeDraft, NoticePreviewView, NoticeSourceTables } from '../iteration7/notices/types';

type Failure = Extract<DataCommandResult, { ok: false }>;
type UnsavedDraft = Omit<Extract<NoticeCommand, { type: 'notice.saveDraft' }>, 'type' | 'idempotencyKey' | 'baseRevision'>;
type NoticePreviewInput = { readonly noticeId: string; readonly draftRevision: number } | { readonly draft: UnsavedDraft };
type Snapshot = { readonly tables: NoticeSourceTables };
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const fail = (reason: string, field?: string, code: Failure['code'] = 'VALIDATION'): Failure => ({ ok: false, code, reason, field, messageKey: `data.notices.error.${reason}` });
export { fail as noticeFailure };
/** Single deterministic classifier for both preview and commit. */
export const classifyNoticeContent = (title: string, body: string): NoticeDraft['contentClass'] => /쿠폰|할인|홍보|증정|특가|세일|프로모션|coupon|discount|promotion|\d\s*%/iu.test(`${title}\n${body}`) ? 'promotional' : 'informational';
/** A closure link that no longer matches its calendar event. Reason stays PREVIEW_STALE; the message tells the owner to import again. */
const CLOSURE_STALE_REASON = { changed: 'CLOSURE_CHANGED', removed: 'CLOSURE_REMOVED', dates: 'CLOSURE_DATES_DIFFER' } as const;
function closureStale(draft: NoticeDraft, link: Exclude<ClosureLinkStatus, 'none' | 'current'>): Failure {
  return { ...fail('PREVIEW_STALE', 'closureEventId', 'CONFLICT'), messageKey: `data.notices.error.${CLOSURE_STALE_REASON[link]}`,
    details: { noticeId: draft.noticeId, closureEventId: draft.closureEventId, changed: link, reimport: link !== 'removed' } };
}
export function validateNoticeDraft(d: NoticeDraft, today: string): Failure | null {
  if (!d.title.trim()) return fail('TITLE_REQUIRED', 'title');
  if (!d.body.trim()) return fail('BODY_REQUIRED', 'body');
  if (!isIsoDate(d.startDate) || !isIsoDate(d.endDate) || d.startDate > d.endDate) return fail('INVALID_DATE_RANGE', 'endDate');
  // GD-2: a notice about a range that is already over cannot be sent. A range still running today is fine.
  if (d.endDate < today) return fail('PAST_DATE', 'startDate');
  if (!['regular_closure', 'temporary_closure', 'hours_change', 'other'].includes(d.kind)) return fail('INVALID_KIND', 'kind');
  if (!['all_contactable', 'group'].includes(d.audience)) return fail('INVALID_AUDIENCE', 'audience');
  if (!Array.isArray(d.groupIds) || d.groupIds.some(id => !['regular', 'first-visit', 'churn-risk'].includes(id))) return fail('INVALID_GROUP', 'groupIds');
  return null;
}
function prepareNotice(t: NoticeSourceTables, draft: NoticeDraft, now: string) {
  const classified = { ...draft, contentClass: classifyNoticeContent(draft.title, draft.body) };
  const recipients = resolveNoticeRecipients(t, classified);
  const closure = draft.closureEventId ? selectStoreClosures({ tables: t }).find(c => c.eventId === draft.closureEventId) ?? null : null;
  const adMarker = classified.contentClass === 'promotional';
  const time = now.slice(11, 16);
  const reasons: string[] = [];
  if (!recipients.recipientCount) reasons.push('NO_RECIPIENTS');
  // F-278 keeps the night restriction for promotional notices.
  if (adMarker && (time >= '21:00' || time < '08:00')) reasons.push('AD_NIGHT_RESTRICTED');
  const optOutText = adMarker ? '수신 거부 방법이 함께 들어가요(예시)' : '';
  const renderedBody = `${adMarker ? '(광고)\n' : ''}${draft.title}\n${draft.body}${adMarker ? `\n${optOutText}` : ''}`;
  const signature = JSON.stringify({ draft: classified, recipients: recipients.source, closure, date: now.slice(0, 10) });
  return { draftId: draft.noticeId, draftRevision: draft.revision, contentClass: classified.contentClass, eligibleMemberIds: recipients.eligibleMemberIds,
    recipientCount: recipients.recipientCount, excludedCount: recipients.excludedCount, renderedBody, adMarker, optOutText, sendAllowed: reasons.length === 0, reasons, signature, closure };
}

export function buildNoticeDraft(tables: NoticeSourceTables, input: UnsavedDraft, today: string) {
  const existing = input.noticeId ? tables.noticeDraft.find(draft => draft.noticeId === input.noticeId) : null;
  if (input.noticeId && !existing) return fail('NOT_FOUND', 'noticeId', 'NOT_FOUND');
  const closureEventId = input.closureEventId === undefined ? existing?.closureEventId ?? null : input.closureEventId;
  const closure = closureEventId ? selectStoreClosures({ tables }).find(event => event.eventId === closureEventId) : null;
  if (closureEventId && !closure) return fail('UNKNOWN_CLOSURE', 'closureEventId', 'NOT_FOUND');
  const title = clean(input.title), body = clean(input.body);
  const draft: NoticeDraft = {
    noticeId: input.noticeId ?? '', kind: input.kind, title, body, startDate: input.startDate, endDate: input.endDate,
    closureEventId,
    // Only import refreshes the revision on an existing link.
    closureRevision: existing && existing.closureEventId === closureEventId ? existing.closureRevision : closure?.revision ?? null,
    audience: input.audience, groupIds: input.groupIds, contentClass: classifyNoticeContent(title, body), revision: existing?.revision ?? 0,
  };
  const invalid = validateNoticeDraft(draft, today);
  if (invalid) return invalid;
  return { ok: true, existing, draft: { ...draft, groupIds: [...new Set(draft.groupIds)].sort() } } as const;
}

export function prepareNoticePreview(snapshot: Snapshot, input: NoticePreviewInput, now: string) {
  const today = now.slice(0, 10);
  if (!isIsoDate(today) || !isTime(now.slice(11, 16))) return fail('INVALID_DATE_RANGE', 'now');
  let draft: NoticeDraft;
  if ('draft' in input) {
    const candidate = buildNoticeDraft(snapshot.tables, input.draft, today);
    if (!candidate.ok) return candidate;
    draft = candidate.draft;
    if ((draft.audience === 'group') !== (draft.groupIds.length > 0)) return fail('INVALID_GROUP', 'groupIds');
  } else {
    const saved = snapshot.tables.noticeDraft.find(row => row.noticeId === input.noticeId);
    if (!saved) return fail('NOT_FOUND', 'noticeId', 'NOT_FOUND');
    if (saved.revision !== input.draftRevision) return fail('PREVIEW_STALE', 'draftRevision', 'CONFLICT');
    const invalid = validateNoticeDraft(saved, today);
    if (invalid) return invalid;
    draft = saved;
  }
  const closureLink = selectDraftClosureLink(snapshot, draft);
  if (closureLink !== 'none' && closureLink !== 'current') return closureStale(draft, closureLink);
  return { ok: true, draft, closureLink, prepared: prepareNotice(snapshot.tables, draft, now) } as const;
}

// D-326: one local-time guard shared by scheduled previews and commits.
const atNight = (time: string) => time < '08:00' || time >= '21:00';
const localTimestamp = (stamp: unknown): stamp is string => typeof stamp === 'string'
  && stamp.length === 16 && stamp[10] === 'T' && isIsoDate(stamp.slice(0, 10)) && isTime(stamp.slice(11));

export function nextNoticeMorning(now = NOW): string | undefined {
  return localTimestamp(now) && atNight(now.slice(11)) ? `${addDays(now.slice(0, 10), 1)}T08:00` : undefined;
}

export function prepareScheduledNoticePreview(snapshot: Snapshot, input: NoticePreviewInput, sendAt: string, now = NOW) {
  if (!localTimestamp(sendAt) || !localTimestamp(now) || sendAt <= now) return fail('SCHEDULE_IN_FUTURE', 'sendAt');
  if (atNight(sendAt.slice(11))) return fail('SCHEDULE_NIGHT_RESTRICTED', 'sendAt');
  const result = prepareNoticePreview(snapshot, input, sendAt);
  if (!result.ok) return result;
  return { ...result, prepared: { ...result.prepared, signature: JSON.stringify([result.prepared.signature, sendAt]) } } as const;
}
// End D-326.

/** Public read projection. Never issues a preview ID or exposes eligible member IDs. */
export function previewNotice(snapshot: Snapshot, input: NoticePreviewInput, now = NOW):
  Failure | { readonly ok: true; readonly preview: Omit<NoticePreviewView, 'previewId'>; readonly closureLink: ClosureLinkStatus } {
  const result = prepareNoticePreview(snapshot, input, now);
  if (!result.ok) return result;
  const { draftRevision, contentClass, recipientCount, excludedCount, renderedBody, adMarker, optOutText, sendAllowed, reasons } = result.prepared;
  return deepFreeze({ ok: true, closureLink: result.closureLink,
    preview: { draftRevision, contentClass, recipientCount, excludedCount, renderedBody, adMarker, optOutText, sendAllowed, reasons } });
}
