import { expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/widget-data';
import type { NoticeDto, RealInbox } from '../../../data/reality/15/dto';
import { noticeDraftRow, noticeHistoryRows } from '../../../data/reality/15/dto';
import { noticesDomain } from './notices';

const row: NoticeDto = {
  id: 'reserved', revision: 2, status: 'done', title: '매장 소식', text: '안내 문구', channel: 'sms',
  closure: null, audience: null, recipientGroupId: 'consenting-group', couponRef: null, startDate: '2026-11-17',
  endDate: '2026-11-18', businessHours: null, pin: null, updatedAt: '2026-11-17T06:45:00Z',
  result: { state: 'scheduled', scheduledFor: '2026-11-18T08:00' },
};

function snapshot(...notices: NoticeDto[]) {
  const inbox: RealInbox = { storeId: 'store', notices, inquiries: [], authorNotification: null, waitingInquiries: 0, activeNotices: 0, asOf: row.updatedAt,
    reviews: { status: 'unavailable' }, consultations: { status: 'unavailable' }, audiences: { status: 'unavailable' }, news: { status: 'unavailable' } };
  return createWidgetDataStore({ realInbox: inbox, noticeDraft: notices.filter(item => item.status === 'draft').map(noticeDraftRow),
    noticeSent: noticeHistoryRows(notices.filter(item => item.status === 'done')) }).getSnapshot();
}

const condition = { kind: 'default' } as const;

it('shows the stored reservation and cancellation separately from sent notices', () => {
  const canceled: NoticeDto = { ...row, id: 'canceled', title: '취소한 소식', result: { state: 'canceled', scheduledFor: '2026-11-18T10:00' } };
  const result = noticesDomain.projectWidget?.(snapshot(row, canceled), 'notice-send', condition, 'ko');
  expect(result).toMatchObject({ facts: expect.arrayContaining([
    expect.objectContaining({ key: 'notice.sent.count', value: 0 }),
    expect.objectContaining({ key: 'notice.sms.scheduled.count', value: 1 }),
    expect.objectContaining({ key: 'notice.sms.0.status', value: 'scheduled', display: '예약했어요' }),
    expect.objectContaining({ key: 'notice.sms.1.status', value: 'canceled', display: '예약을 취소했어요' }),
  ]) });
});

it('opens the saved SMS draft through a read-only handoff when an exact time is requested', () => {
  const draft: NoticeDto = { ...row, id: 'draft', status: 'draft', result: null };
  const state = snapshot(draft);
  expect(noticesDomain.route?.('“매장 소식” 공지를 내일 오전 9시에 문자 예약 발송해줘', state, 'ko')).toMatchObject({
    kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'notice-send', step: 'sms-schedule', itemId: 'draft' },
  });
});

it('keeps an SMS draft with a changed closure from becoming a reservation handoff', () => {
  const draft: NoticeDto = { ...row, id: 'draft', status: 'draft', result: null, closure: { eventId: 'removed', revision: 1 } };
  expect(noticesDomain.route?.('“매장 소식” 공지를 내일 오전 9시에 문자 예약 발송해줘', snapshot(draft), 'ko')).toMatchObject({
    kind: 'clarification', field: 'closureEventId',
  });
});
