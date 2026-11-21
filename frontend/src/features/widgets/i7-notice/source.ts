import type { NoticeDraft, NoticesModel, StoreClosure } from '../../../data/iteration7/notices';
import type { CustomerGroupId } from '../../../data/marketing/types';
import type { NoticeDraftInput, NoticeView } from './widget';

export function noticeDraftInput(draft: NoticeDraft): NoticeDraftInput {
  return { noticeId: draft.noticeId, revision: draft.revision, kind: draft.kind, title: draft.title, body: draft.body, startDate: draft.startDate, endDate: draft.endDate, ...(draft.closureEventId ? { closureEventId: draft.closureEventId } : {}), audience: draft.audience, groupIds: [...draft.groupIds] };
}
/** Picker receives all calendar closures; panel count receives only current unsent closures. */
export function noticeView(model: NoticesModel, closures: readonly StoreClosure[], groups: readonly { groupId: CustomerGroupId; name: string }[]): NoticeView {
  return { status: 'ready', unsentCount: model.unsentCount, nextClosure: model.nextClosure, closures, groups, drafts: model.drafts.map(draft => ({ ...noticeDraftInput(draft), closureLink: model.closureLinks[draft.noticeId] ?? 'none' })), sent: model.sent };
}

import type { DataCommandResult } from '../../../data/commands/types';
import type { NoticeCommand, NoticePreviewView } from '../../../data/iteration7/notices';
import type { NoticePort } from './widget';

type DispatchNotice = (command: NoticeCommand) => DataCommandResult;
const savedValue = (value: unknown): value is { noticeId: string; revision: number } => typeof value === 'object' && value !== null && 'noticeId' in value && typeof value.noticeId === 'string' && 'revision' in value && typeof value.revision === 'number';
const previewValue = (value: unknown): value is NoticePreviewView => typeof value === 'object' && value !== null && 'previewId' in value && typeof value.previewId === 'string' && 'draftRevision' in value && typeof value.draftRevision === 'number' && 'recipientCount' in value && typeof value.recipientCount === 'number' && 'sendAllowed' in value && typeof value.sendAllowed === 'boolean' && 'renderedBody' in value && typeof value.renderedBody === 'string' && 'contentClass' in value && (value.contentClass === 'informational' || value.contentClass === 'promotional') && 'reasons' in value && Array.isArray(value.reasons) && value.reasons.every(item => typeof item === 'string') && 'excludedCount' in value && typeof value.excludedCount === 'number' && 'adMarker' in value && typeof value.adMarker === 'boolean' && 'optOutText' in value && typeof value.optOutText === 'string';
/** getDraft must read the latest shared snapshot after dispatch, not a render-time copy. */
export function createNoticePort(dispatch: DispatchNotice, getDraft: (id: string) => NoticeDraft | undefined, retry: () => void, key: () => string): NoticePort {
  return {
    retry,
    async importClosure(eventId, noticeId) {
      const result = dispatch({ type: 'notice.importClosure', eventId, ...(noticeId ? { noticeId } : {}), idempotencyKey: key() });
      if (!result.ok) return result;
      if (!savedValue(result.value)) return { ok: false };
      const draft = getDraft(result.value.noticeId);
      return draft ? { ok: true, draft: noticeDraftInput(draft) } : { ok: false };
    },
    async saveDraft(draft) {
      const result = dispatch({ type: 'notice.saveDraft', ...(draft.noticeId ? { noticeId: draft.noticeId } : { idempotencyKey: key() }), kind: draft.kind, title: draft.title, body: draft.body, startDate: draft.startDate, endDate: draft.endDate, ...(draft.closureEventId ? { closureEventId: draft.closureEventId } : {}), audience: draft.audience, groupIds: draft.groupIds });
      return result.ok ? savedValue(result.value) ? { ok: true, ...result.value } : { ok: false } : result;
    },
    async deleteDraft(noticeId) { return dispatch({ type: 'notice.deleteDraft', noticeId, idempotencyKey: key() }); },
    async preview(noticeId, draftRevision) {
      const result = dispatch({ type: 'notice.preview', noticeId, draftRevision });
      return result.ok ? previewValue(result.value) ? { ok: true, preview: result.value } : { ok: false } : result;
    },
    async send(noticeId, draftRevision, previewId) {
      const result = dispatch({ type: 'notice.send', noticeId, draftRevision, previewId, idempotencyKey: key() });
      if (!result.ok) return result;
      const value = result.value;
      return typeof value === 'object' && value !== null && 'sentId' in value && typeof value.sentId === 'string' && 'status' in value && value.status === 'sent_example' && 'recipientCount' in value && typeof value.recipientCount === 'number' && 'sentAt' in value && typeof value.sentAt === 'string' ? { ok: true } : { ok: false };
    },
  };
}
