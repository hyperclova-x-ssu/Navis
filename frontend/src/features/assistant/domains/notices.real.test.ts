import { expect, it, vi } from 'vitest';
import { readAppClock } from '../../../data/db/app-clock';
import { couponsDomain } from './coupons';
import { readNotice } from '../../../data/reality/15/adapter';
import { createWidgetDataStore, selectWidget } from '../../../data/widget-data';
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

it('proposes the existing SMS commands at night at each widget’s reservation time', async () => {
  const time = vi.spyOn(await import('../../../data/db/app-clock'), 'readAppClock');
  time.mockReturnValue({ ...readAppClock(), local: '2026-11-17T03:00' });
  const reader = vi.spyOn(await import('../../../data/reality/15/adapter'), 'readNotice');
  try {
    const draft: NoticeDto = { ...row, id: 'draft', status: 'draft', result: null };
    const state = snapshot(draft);
    reader.mockResolvedValue({ ...draft, smsPreview: { content: '서비스에서 미리 본 문자', recipientCount: 3, sendAllowed: true } } as Awaited<ReturnType<typeof readNotice>>);
    const route = noticesDomain.routeBeforeHandoff?.('“매장 소식” 공지를 지금 문자로 보내줘', state, 'ko');
    if (!route || !('kind' in route) || route.kind !== 'deferred') throw Error('Missing notice preview');
    const proposal = await route.resolve({ snapshot: state, port: { reads: {} } as NonNullable<Parameters<typeof route.resolve>[0]['port']>, signal: new AbortController().signal });
    expect(proposal).toMatchObject({ kind: 'local-proposal', command: 'notice.send', slots: { sendAt: '2026-11-18T08:00' } });

    const base = createWidgetDataStore().getSnapshot();
    const expiry = selectWidget(base, 'expiry-coupon', condition, 'normal');
    const slots = selectWidget(base, 'slot-coupon', condition, 'normal');
    const status = selectWidget(base, 'coupon-status', condition, 'normal');
    if (expiry.status !== 'ready' || slots.status !== 'ready' || status.status !== 'ready') throw Error('Missing coupon models');
    const real = { ...base, tables: { ...base.tables, realCoupons: { coupons: [], businessDate: '2026-11-17', localAt: '2026-11-17T03:00', status: status.model, expiry: expiry.model, slots: slots.model, naver: null, missing: [] } } };
    const eligibleSlots = slots.model.openSlots.filter(slot => slots.model.recipients.some(person => person.selectable && person.slotIds.includes(slot.slotId)));
    real.tables.realCoupons.slots = { ...slots.model, openSlots: eligibleSlots.slice(0, 1) };
    const slotResult = couponsDomain.routeBeforeHandoff?.('빈 시간 쿠폰 지금 보내줘', real, 'ko');
    expect(slotResult).toMatchObject({ kind: 'local-proposal', command: 'coupon.sendSlot', slots: { sendAt: '2026-11-18T08:00' } });
    expect(couponsDomain.route?.('바스크 치즈케이크 당일 소진 쿠폰 40% 할인해서 문자로 보내줘', real, 'ko'))
      .toMatchObject({ kind: 'local-proposal', command: 'coupon.createExpiry', slots: { expiryNightSms: '2026-11-17T08:00' } });
  } finally {
    reader.mockRestore();
    time.mockRestore();
  }
});

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
