import { addDays, isIsoDate, TODAY } from '../../db/time';
import { deepFreeze } from '../../db/freeze';
import type { DataText } from '../../db/types';
import type { ClosureCalendarEvent, ClosureLinkStatus, NoticeDraft, NoticeScheduled, NoticeSent, NoticesModel, NoticesQuery, NoticeSourceTables, StoreClosure } from './types';

const raw = (text: DataText | null): string => text && 'raw' in text ? text.raw : '';
export function selectStoreClosures(snapshot: { readonly tables: { readonly calendarEvent: readonly ClosureCalendarEvent[] } }, query?: { readonly start: string; readonly end: string }): readonly StoreClosure[] {
  return deepFreeze(snapshot.tables.calendarEvent.flatMap(e => {
    const closure = e.storeClosure;
    if (!closure || e.kind !== 'event' || e.categoryId !== 'store-operations' || !['regular', 'temporary'].includes(closure.kind) || !isIsoDate(e.date) || !isIsoDate(closure.endDate) || closure.endDate < e.date) return [];
    if (query && (e.date > query.end || closure.endDate < query.start)) return [];
    return [{ eventId: e.eventId, revision: e.revision ?? 0, kind: closure.kind, title: raw(e.title), body: raw(e.memo), startDate: e.date, endDate: closure.endDate }];
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.eventId.localeCompare(b.eventId)));
}
/**
 * Is a draft still the same as the calendar closure it was imported from? `changed` = the closure was edited
 * after the import (its revision moved), `removed` = it is gone, `dates` = the draft's own dates were edited away
 * from the closure. Anything but `current`/`none` means the old preview can no longer be sent.
 */
export function selectDraftClosureLink(snapshot: { readonly tables: { readonly calendarEvent: readonly ClosureCalendarEvent[] } }, draft: Pick<NoticeDraft, 'closureEventId' | 'closureRevision' | 'startDate' | 'endDate'>): ClosureLinkStatus {
  if (!draft.closureEventId) return 'none';
  const closure = selectStoreClosures(snapshot).find(c => c.eventId === draft.closureEventId);
  if (!closure) return 'removed';
  if (closure.revision !== draft.closureRevision) return 'changed';
  return closure.startDate !== draft.startDate || closure.endDate !== draft.endDate ? 'dates' : 'current';
}
export function selectNotices(snapshot: { readonly tables: NoticeSourceTables }, query: NoticesQuery = {}, today = TODAY): NoticesModel {
  const t = snapshot.tables;
  const matches = (row: { readonly startDate: string; readonly endDate: string; readonly audience: string; readonly groupIds: readonly string[] }) =>
    (!query.period || row.startDate <= query.period.end && row.endDate >= query.period.start) &&
    (!query.groupIds?.length || row.audience === 'all_contactable' || query.groupIds.some(id => row.groupIds.includes(id)));
  const closures = selectStoreClosures(snapshot, { start: today, end: addDays(today, 7) });
  // D-326: pending schedules do not count as sent until delivery.
  const sentHistory = t.noticeSent.filter((row): row is NoticeSent => row.status === 'sent_example' || row.status === 'sent');
  const scheduled = t.noticeSent.filter((row): row is NoticeScheduled => row.status === 'scheduled' && matches(row))
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.sentId.localeCompare(b.sentId));
  const upcomingUnsentClosures = closures.filter(c => !t.noticeSent.some(s => s.closureEventId === c.eventId && s.closureRevision === c.revision && s.startDate === c.startDate && s.endDate === c.endDate && s.closureTitle === c.title && s.closureBody === c.body));
  const drafts = t.noticeDraft.filter(matches), sent = sentHistory.filter(matches).sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.sentId.localeCompare(a.sentId));
  const closureLinks = Object.fromEntries(t.noticeDraft.map(draft => [draft.noticeId, selectDraftClosureLink(snapshot, draft)]));
  return deepFreeze({ drafts, sent, scheduled, upcomingUnsentClosures, unsentCount: upcomingUnsentClosures.length + drafts.filter(row => !row.closureEventId && !t.noticeSent.some(message => message.noticeId === row.noticeId && (message.status === 'scheduled' || message.draftRevision === row.revision))).length, sentCount: sent.length, nextClosure: closures[0] ?? null, closureLinks });
}
export function selectShopGuidance<T extends object>(snapshot: { readonly tables: { readonly calendarEvent: readonly ClosureCalendarEvent[] } }, manual: T = {} as T): T & { readonly closures: readonly StoreClosure[] } {
  return deepFreeze({ ...manual, closures: selectStoreClosures(snapshot) });
}
