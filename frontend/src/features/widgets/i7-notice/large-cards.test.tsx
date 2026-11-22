/**
 * LARGE-CARDS-3 (D-333): the 4-high 공지 발송 card shows more of the notices the data holds — each draft's kind, dates and first words, the scheduled
 * notices, more sent rows — and writes nothing for what the data does not have.
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TODAY, addDays } from '../../../data/db/time';
import { createTranslator } from '../../../i18n/translator';
import { renderWithKit } from '../../../ui/test-utils';
import { NoticePanel, type NoticeDraftInput, type NoticeView } from './widget';
import { dateRangeWithWeekdays } from '../date-range';

afterEach(cleanup);
const format = createTranslator('ko').format;
const draft = (patch: Partial<NoticeDraftInput> & { title: string }): NoticeDraftInput => ({ noticeId: patch.title, revision: 1, kind: 'other', body: '', startDate: '', endDate: '', audience: 'all_contactable', groupIds: [], ...patch });
const sent = (n: number) => Array.from({ length: n }, (_, i) => ({ sentId: `s${i}`, title: `보낸 공지 ${i + 1}`, kind: i % 2 ? 'other' : 'temporary_closure', recipientCount: 100 + i, sentAt: `${addDays(TODAY, -i - 1)}T09:05` }));
const view = (patch: Partial<Extract<NoticeView, { status: 'ready' }>> = {}): NoticeView => ({ status: 'ready', unsentCount: 2, nextClosure: null, closures: [], drafts: [], sent: [], scheduled: [], groups: [], ...patch });
const panel = (v: NoticeView, width: number, height: number) => renderWithKit(<NoticePanel view={v} width={width} height={height} onOpen={() => {}} onRetry={() => {}} />);
const draftRows = () => Array.from(document.querySelectorAll('.i7-notice-drafts .i7-notice-draft'));
const sentRows = () => Array.from(document.querySelectorAll('.i7-notice-history-table tbody tr'));
const text = (el: Element) => (el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

describe('공지 발송 (27) on large cards', () => {
  const drafts = [
    draft({ title: '연말 임시 휴무', kind: 'temporary_closure', body: '12월 31일은 쉬어요. 새해에 만나요.', startDate: `${addDays(TODAY, 40)}`, endDate: `${addDays(TODAY, 41)}` }),
    draft({ title: '저녁 좌석 예약 안내', kind: 'other', body: '오늘 저녁 방문하실 분은 4인석 예약 가능 시간을 매장에 문의해 주세요.' }),
  ];
  it('names each draft\'s kind, dates and first words at 4x4 only, and no dates for a draft that has none', () => {
    panel(view({ drafts }), 4, 4);
    expect(draftRows()).toHaveLength(2);
    expect(text(draftRows()[0]!)).toContain('연말 임시 휴무');
    expect(text(draftRows()[0]!)).toContain(`임시 휴무 · ${dateRangeWithWeekdays({ locale: 'ko', format }, drafts[0]!.startDate, drafts[0]!.endDate)}`);
    expect(text(draftRows()[0]!)).toContain('12월 31일은 쉬어요. 새해에 만나요.');
    expect(text(draftRows()[1]!)).toContain('기타');
    expect(text(draftRows()[1]!)).not.toMatch(/기타 ·/);
    // A draft of kind 기타 has no period of its own (the data layer fills a start date for it): no date is written.
    cleanup(); panel(view({ drafts: [draft({ title: '신메뉴 안내', kind: 'other', startDate: TODAY, endDate: TODAY })] }), 4, 4);
    expect(text(draftRows()[0]!)).not.toMatch(/기타 ·/);
    cleanup(); panel(view({ drafts }), 4, 4);
    cleanup(); panel(view({ drafts }), 4, 2);
    expect(draftRows()).toHaveLength(2);
    expect(document.querySelector('.i7-notice-draft__sub, .i7-notice-draft__body')).toBeNull();
    cleanup(); panel(view({ drafts }), 2, 2);
    expect(document.querySelector('.i7-notice-draft__sub, .i7-notice-draft__body')).toBeNull();
  });
  it('lists the scheduled notices (title, send time, people) at 4x4 and writes no section when none are scheduled', () => {
    const scheduled = [
      { sentId: 'sc1', noticeId: 'n1', title: '연말 임시 휴무', recipientCount: 312, sendAt: `${addDays(TODAY, 1)}T09:00`, cancellable: true },
      { sentId: 'sc2', noticeId: 'n2', title: '신메뉴 안내', recipientCount: 128, sendAt: `${addDays(TODAY, 2)}T10:30`, cancellable: true },
    ];
    panel(view({ drafts, scheduled }), 4, 4);
    const rows = Array.from(document.querySelectorAll('.i7-notice-scheduled .i7-notice-value-row'));
    expect(rows).toHaveLength(2);
    expect(text(rows[0]!)).toContain('연말 임시 휴무');
    expect(text(rows[0]!)).toContain(`${format.dateTime(scheduled[0]!.sendAt, { today: TODAY })} · 312명`);
    expect(text(rows[1]!)).toContain(`${format.dateTime(scheduled[1]!.sendAt, { today: TODAY })} · 128명`);
    cleanup(); panel(view({ drafts, scheduled }), 4, 2);
    expect(document.querySelector('.i7-notice-scheduled')).toBeNull();
    cleanup(); panel(view({ drafts }), 4, 4);
    expect(document.querySelector('.i7-notice-scheduled')).toBeNull();
  });
  it('lists eight sent notices at 4x4, six at 4x3 and three at 4x2, never more than were sent', () => {
    panel(view({ sent: sent(10) }), 4, 4);
    expect(sentRows()).toHaveLength(8);
    cleanup(); panel(view({ sent: sent(10) }), 4, 3);
    expect(sentRows()).toHaveLength(6);
    cleanup(); panel(view({ sent: sent(10) }), 4, 2);
    expect(sentRows()).toHaveLength(3);
    cleanup(); panel(view({ sent: sent(5) }), 4, 4);
    expect(sentRows()).toHaveLength(5);
  });
});
