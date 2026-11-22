import { expect, it } from 'vitest';
import { classifyWidgetHandoff, widgetHandoffRef } from './widget-handoff';
import { createWidgetDataStore } from '../../data/widget-data';
import type { NoticeDto } from '../../data/reality/15/dto';

it.each([
  ['네이버 카페에 글 올려줘', 'community', 'cafe'],
  ['블로그와 카페 검색 결과 보여줘', 'local-trends', 'keywords'],
  ['공지 문자 예약 발송해줘', 'notice-send', 'compose'],
  ['예약한 문자 취소해줘', 'notice-send', 'scheduled'],
  ['네이버 리뷰 답글 초안 만들어줘', 'ai-response', 'review'],
  ['네이버 캘린더에 일정 추가해줘', 'calendar', 'day', false],
  ['WORKS에서 일정 지워줘', 'staff-schedule', 'works', false],
  ['플레이스 새소식에 글 올려줘', 'notice-send', 'compose'],
  ['홍보 영상을 플레이스 새소식에 올려줘', 'promo-video', 'create'],
  ['스마트플레이스 메뉴를 올려줘', 'menu', 'list'],
  ['스마트스토어 온라인 재고 바꿔줘', 'inventory-booking', 'products'],
  ['거래처에 발주 문자 보내줘', 'suppliers', 'orders', false],
  ['플레이스 쿠폰 지워줘', 'coupon-status', 'naver'],
])('keeps %s in the widget confirmation flow', (text, featureId, view, expandAction = true) => {
  const handoff = classifyWidgetHandoff(text)!;
  expect(handoff).toMatchObject({ featureId });
  const ref = widgetHandoffRef(handoff);
  expect(ref).toMatchObject({ featureId, view });
  expect(ref?.focus).toBe(expandAction ? 'action' : undefined);
  expect(widgetHandoffRef({ ...handoff, draft: { confirmed: true } })).toBeUndefined();
});

it.each([
  '스마트스토어 온라인 재고 몇 개 있어?',
  '홍보 영상 만들 때 플레이스 쿠폰이 있어?',
  '예약 문자 보내지 마',
  '예약 취소 안내 공지 초안 써줘',
  '다음 문장을 읽어줘. “네이버 카페에 글 올려줘”',
])('does not suggest a widget action for %s', text => {
  expect(classifyWidgetHandoff(text)).toBeUndefined();
});

const reservation = (id: string, title: string): NoticeDto => ({
  id, title, revision: 1, status: 'done', channel: 'sms', text: '', closure: null,
  audience: null, recipientGroupId: null, couponRef: null, startDate: null, endDate: null, businessHours: null, pin: null,
  updatedAt: '2026-11-17T06:45:00Z', result: { state: 'scheduled', scheduledFor: '2026-11-18T00:00:00Z' },
});

function snapshotWithReservations(notices: NoticeDto[]) {
  const unavailable = { status: 'unavailable' as const };
  return createWidgetDataStore({ realInbox: {
    storeId: 'store', asOf: '2026-11-17T06:45:00Z', inquiries: [], notices,
    waitingInquiries: 0, activeNotices: 0, reviews: unavailable, consultations: unavailable, audiences: unavailable,
    news: unavailable, authorNotification: null,
  } }).getSnapshot();
}

it('opens the named SMS reservation on the scheduled tab without a command or prefill', () => {
  const target = reservation('sms-reservation', '매장 정비');
  const snapshot = snapshotWithReservations([
    target, reservation('other-reservation', '새 메뉴'), { ...target, id: 'place-notice', channel: 'place-news' },
    { ...target, id: 'unsent-draft', status: 'draft', result: null },
  ]);
  for (const text of ['예약한 문자 “매장 정비” 취소해줘', '매장 정비 문자 예약 상태 보여줘']) {
    const handoff = classifyWidgetHandoff(text, snapshot)!;
    expect(handoff).toEqual({ featureId: 'notice-send', step: 'sms-status', itemId: target.id });
    expect(widgetHandoffRef(handoff)).toEqual({ featureId: 'notice-send', view: 'scheduled', focus: 'action', itemId: target.id });
  }
});

it('opens the SMS reservation list when a title is ambiguous or the owner asks for the list', () => {
  const target = reservation('sms-1', '매장 정비');
  const single = snapshotWithReservations([target]);
  const ambiguous = snapshotWithReservations([target, reservation('sms-2', target.title)]);
  for (const [text, snapshot] of [
    ['예약한 문자 매장 정비 상태 보여줘', ambiguous],
    ['예약한 문자 “매장 정비” 목록 보여줘', single],
    ['예약한 문자 “다음 매장 정비” 취소해줘', single],
  ] as const) {
    const handoff = classifyWidgetHandoff(text, snapshot)!;
    expect(handoff).toEqual({ featureId: 'notice-send', step: 'sms-status' });
    expect(widgetHandoffRef(handoff)).toEqual({ featureId: 'notice-send', view: 'scheduled', focus: 'action' });
  }
});

it('opens one message thread\'s reply pane at the draft step with the thread and the action focus, and nothing else', () => {
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'message-draft', itemId: 'th-2' })).toEqual({ featureId: 'ai-response', view: 'message', focus: 'action', itemId: 'th-2' });
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'message-draft' })).toEqual({ featureId: 'ai-response', view: 'message', focus: 'action' });
  // The step carries no command or draft, and an item id must be a short string.
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'message-draft', itemId: 'th-2', command: 'inquiry.send' })).toBeUndefined();
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'message-draft', itemId: 'th-2', draft: { body: 'x' } })).toBeUndefined();
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'message-draft', itemId: 'x'.repeat(201) })).toBeUndefined();
  expect(widgetHandoffRef({ featureId: 'community', step: 'message-draft', itemId: 'th-2' })).toBeUndefined();
});

// D-404: the W21 test-SMS flow is retired. Nothing opens a "test-sms" step any more; a reply request reaches the item's reply pane by its command.
it('has no test-SMS destination and never classifies a test-text request as a widget handoff', () => {
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'test-sms' as never })).toBeUndefined();
  for (const text of ['시험 문자 보내줘', '테스트 문자 보내줘', 'test sms 보내줘']) expect(classifyWidgetHandoff(text)?.step, text).not.toBe('test-sms');
  // The review-draft step stays: it opens the review tab for the named review.
  expect(widgetHandoffRef({ featureId: 'ai-response', step: 'review-draft', itemId: 'review-1' })).toMatchObject({ featureId: 'ai-response', view: 'review', itemId: 'review-1', focus: 'action' });
});
