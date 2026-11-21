import type { DataCommandResult } from '../../commands/types';
import { deepFreeze } from '../../db/freeze';
import { isIsoDate, isTime, NOW } from '../../db/time';
import { buildNoticeDraft, classifyNoticeContent, noticeFailure as fail, prepareNoticePreview, prepareScheduledNoticePreview, validateNoticeDraft } from '../../commands/notice-guard';
import { selectStoreClosures } from './selectors';
import type { NoticeCommand, NoticeDraft, NoticeHistory, NoticePreview, NoticePreviewView, NoticeSourceTables } from './types';

type Failure = Extract<DataCommandResult, { ok: false }>;
export interface NoticeHandlerContext<T extends NoticeSourceTables> {
  readonly tables: T; readonly snapshot: { readonly revision: number; readonly tables?: T }; readonly now?: string;
  nextId(prefix: string): string;
}
type Result<T> = Failure | { readonly ok: true; readonly tables: T; readonly undoable: boolean; readonly noticeKey?: string; readonly value: unknown };
export { classifyNoticeContent };
export const NOTICE_ONCE_COMMANDS = ['notice.importClosure', 'notice.deleteDraft', 'notice.send'] as const;
export const noticeRequiresKey = (c: NoticeCommand) => c.type === 'notice.importClosure' || c.type === 'notice.deleteDraft' || c.type === 'notice.send' || c.type === 'notice.saveDraft' && !c.noticeId;
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const viewOf = (p: NoticePreview): NoticePreviewView => ({ previewId: p.previewId, draftRevision: p.draftRevision, contentClass: p.contentClass, recipientCount: p.recipientCount, excludedCount: p.excludedCount, renderedBody: p.renderedBody, adMarker: p.adMarker, optOutText: p.optOutText, sendAllowed: p.sendAllowed, reasons: p.reasons });
function handle<T extends NoticeSourceTables>(ctx: NoticeHandlerContext<T>, c: NoticeCommand): Result<T> {
  const t = ctx.tables, now = ctx.now ?? NOW;
  if (c.baseRevision !== undefined && c.baseRevision !== ctx.snapshot.revision) return fail('STALE_REVISION', undefined, 'CONFLICT');
  if (!isIsoDate(now.slice(0, 10)) || !isTime(now.slice(11, 16))) return fail('INVALID_DATE_RANGE', 'now');
  if (noticeRequiresKey(c) && (!('idempotencyKey' in c) || !clean(c.idempotencyKey))) return fail('KEY_REQUIRED', 'idempotencyKey');
  const success = (tables: T, value: unknown, undoable = false, noticeKey?: string): Result<T> => ({ ok: true, tables, value, undoable, ...(noticeKey ? { noticeKey } : {}) });
  if (c.type === 'notice.importClosure') {
    const closure = selectStoreClosures({ tables: t }).find(e => e.eventId === c.eventId);
    if (!closure) return fail('UNKNOWN_CLOSURE', 'eventId', 'NOT_FOUND');
    const existing = c.noticeId ? t.noticeDraft.find(d => d.noticeId === c.noticeId) : null;
    if (c.noticeId && !existing) return fail('NOT_FOUND', 'noticeId', 'NOT_FOUND');
    const draft: NoticeDraft = { noticeId: c.noticeId ?? ctx.nextId('notice'), kind: closure.kind === 'regular' ? 'regular_closure' : 'temporary_closure', title: closure.title, body: closure.body,
      startDate: closure.startDate, endDate: closure.endDate, closureEventId: closure.eventId, closureRevision: closure.revision,
      audience: existing?.audience ?? 'all_contactable', groupIds: existing?.groupIds ?? [], contentClass: classifyNoticeContent(closure.title, closure.body), revision: (existing?.revision ?? 0) + 1 };
    const invalid = validateNoticeDraft(draft, now.slice(0, 10)); if (invalid) return invalid;
    return success({ ...t, noticeDraft: [...t.noticeDraft.filter(d => d.noticeId !== draft.noticeId), draft], noticePreview: t.noticePreview.filter(p => p.draftId !== draft.noticeId) }, { noticeId: draft.noticeId, revision: draft.revision }, true, 'data.notices.notice.saved');
  }
  if (c.type === 'notice.saveDraft') {
    const candidate = buildNoticeDraft(t, c, now.slice(0, 10));
    if (!candidate.ok) return candidate;
    const { existing, draft: normalized } = candidate;
    if (existing && JSON.stringify({ ...existing, groupIds: [...existing.groupIds].sort() }) === JSON.stringify(normalized)) return success(t, { noticeId: existing.noticeId, revision: existing.revision });
    const saved = { ...normalized, noticeId: c.noticeId ?? ctx.nextId('notice'), revision: normalized.revision + 1 };
    return success({ ...t, noticeDraft: [...t.noticeDraft.filter(d => d.noticeId !== saved.noticeId), saved], noticePreview: t.noticePreview.filter(p => p.draftId !== saved.noticeId) }, { noticeId: saved.noticeId, revision: saved.revision }, true, 'data.notices.notice.saved');
  }
  if (c.type === 'notice.deleteDraft') {
    if (!t.noticeDraft.some(draft => draft.noticeId === c.noticeId)) return fail('NOT_FOUND', 'noticeId', 'NOT_FOUND');
    return success({ ...t, noticeDraft: t.noticeDraft.filter(d => d.noticeId !== c.noticeId), noticePreview: t.noticePreview.filter(p => p.draftId !== c.noticeId) },
      { noticeId: c.noticeId }, true, 'data.notices.notice.deleted');
  }
  // D-326: the stored preview is bound to the exact optional schedule time.
  const input = { noticeId: c.noticeId, draftRevision: c.draftRevision };
  const result = c.sendAt === undefined ? prepareNoticePreview({ tables: t }, input, now)
    : prepareScheduledNoticePreview({ tables: t }, input, c.sendAt, now);
  if (!result.ok) return result;
  const { draft, prepared } = result;
  if (c.type === 'notice.preview') {
    const existing = t.noticePreview.find(p => p.draftId === draft.noticeId && p.signature === prepared.signature && p.sendAllowed === prepared.sendAllowed);
    if (existing) return success(t, deepFreeze(viewOf(existing)));
    const preview: NoticePreview = { previewId: ctx.nextId('notice-preview'), draftId: prepared.draftId, draftRevision: prepared.draftRevision, contentClass: prepared.contentClass,
      recipientCount: prepared.recipientCount, excludedCount: prepared.excludedCount, renderedBody: prepared.renderedBody, adMarker: prepared.adMarker,
      optOutText: prepared.optOutText, sendAllowed: prepared.sendAllowed, reasons: prepared.reasons, signature: prepared.signature, eligibleMemberIds: prepared.eligibleMemberIds };
    return success({ ...t, noticePreview: [...t.noticePreview.filter(p => p.draftId !== draft.noticeId), preview] }, deepFreeze(viewOf(preview)));
  }
  const p = t.noticePreview.find(p => p.previewId === c.previewId && p.draftId === draft.noticeId);
  if (!p || p.draftRevision !== draft.revision || p.signature !== prepared.signature) return fail('PREVIEW_STALE', 'previewId', 'CONFLICT');
  if (!prepared.sendAllowed) return fail(prepared.reasons[0]);
  const previous = t.noticeSent.find(s => s.noticeId === draft.noticeId && s.draftRevision === draft.revision);
  const receipt = (row: NoticeHistory) => ({ sentId: row.sentId, status: row.status, recipientCount: row.recipientCount, sentAt: row.sentAt,
    ...(row.status === 'scheduled' ? { sendAt: row.sendAt } : {}) });
  if (previous) return success(t, receipt(previous));
  const timing = c.sendAt === undefined ? { sentAt: now, status: 'sent_example' as const }
    : { sendAt: c.sendAt, sentAt: null, status: 'scheduled' as const };
  const sent: NoticeHistory = deepFreeze({ ...draft, groupIds: [...draft.groupIds], contentClass: prepared.contentClass,
    sentId: ctx.nextId('notice-sent'), draftRevision: draft.revision, recipientCount: prepared.recipientCount, renderedBody: prepared.renderedBody, ...timing,
    closureTitle: prepared.closure?.title ?? null, closureBody: prepared.closure?.body ?? null });
  return success({ ...t, noticeSent: [...t.noticeSent, sent] }, receipt(sent), sent.status === 'scheduled',
    sent.status === 'scheduled' ? 'data.notices.notice.scheduled' : 'data.notices.notice.sent');
}
export const noticeHandlers = { 'notice.saveDraft': handle, 'notice.importClosure': handle, 'notice.deleteDraft': handle, 'notice.preview': handle, 'notice.send': handle };
