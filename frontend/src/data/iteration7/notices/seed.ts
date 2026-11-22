import { seedSupplement } from '../../db/cafe-fixtures';
import type { ClosureCalendarEvent, NoticeTables } from './types';

/** Append this direct closure in shared composition; it is outside today's/week's summary. */
export function createInitialClosure(): ClosureCalendarEvent {
  return { eventId: 'closure-1102', revision: 1, kind: 'event', categoryId: 'store-operations', date: '2026-11-02', time: null,
    title: { raw: '11/02(월) 임시 휴무' }, memo: { raw: '매장 내부 정비로 하루 쉬어요' }, storeClosure: { kind: 'temporary', endDate: '2026-11-02' } };
}
export function createLegacyNoticeSeed(): NoticeTables {
  return { noticeDraft: [{ noticeId: 'notice-closure-1', kind: 'temporary_closure', title: '11/02(월) 임시 휴무', body: '매장 내부 정비로 하루 쉬어요',
    startDate: '2026-11-02', endDate: '2026-11-02', closureEventId: 'closure-1102', closureRevision: 1,
    audience: 'all_contactable', groupIds: [], contentClass: 'informational', revision: 1 }], noticePreview: [], noticeSent: [] };
}

export function createNoticeSeed(): NoticeTables {
  return {
    noticeDraft: seedSupplement.notices.map(row => ({
      ...row, noticeId: row.id, kind: 'other', startDate: row.createdAt.slice(0, 10), endDate: row.createdAt.slice(0, 10),
      closureEventId: null, closureRevision: null, audience: 'all_contactable', groupIds: [], contentClass: 'informational', revision: 1,
    })),
    noticePreview: [], noticeSent: [],
  };
}
