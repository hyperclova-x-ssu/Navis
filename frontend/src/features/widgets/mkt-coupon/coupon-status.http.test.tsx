import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import type { CouponDto } from '../../../data/reality/14/dto';
import { renderWithKit } from '../../../ui/test-utils';
import { CouponStatusDetail } from './coupon-status';

const sms = vi.hoisted(() => ({ configured: true }));
// Exercise FAKE send and confirmation flows with the setup gate satisfied.
vi.mock('../../../data/reality/14/sms', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/reality/14/sms')>(),
  get smsSenderConfigured() { return sms.configured; },
}));


afterEach(cleanup);

function setup(sourceRevision?: number, approvalsEnabled = typeof sourceRevision === 'number', items: readonly CouponDto[] = [], membership: unknown = { benefits: [{ ref: 'member-1', name: '회원 스탬프' }] }) {
  const backend = fakeBackend(), store = createWidgetDataStore();
  backend.on('GET', '/marketing/coupons', () => ({ items, nextCursor: null, sourceRevision: 1, asOf: '2026-11-22T13:00:00Z', businessDate: '2026-11-22' }));
  backend.on('GET', '/marketing/naver-coupons', () => ({
    sourceRevision, approvalsEnabled,
    placeCoupons: { items: [{ ref: 'place-1', name: '플레이스 첫 방문', displayPeriod: { from: '2026-11-01', to: '2026-12-01' } }], nextCursor: null },
    orderPromotions: { items: [{ ref: 'order-1', name: '주문 스탬프' }], nextCursor: null },
    membership,
  }));
  const port = createRealPort({ store, source: () => 'http', adapters: [couponsAdapter], fetch: backend.fetch });
  store.bindReal(port);
  const host: WidgetHost = {
    layer: 'marketing', openClosing: vi.fn(() => true), resetPreview: vi.fn(), openLinked: vi.fn(),
    openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(),
  };
  renderWithKit(<CouponStatusDetail featureId="coupon-status" condition={{ kind: 'default' }} detailRef={{ featureId: 'coupon-status' }} host={host} />, { store });
  return backend;
}

it('shows the next morning on the ending reminder card after 9 PM before any queue write', async () => {
  const campaign: CouponDto = {
    couponId: 'coupon-1', origin: 'slot', name: '평일 단골 쿠폰', benefitType: 'percent', benefitValue: 10,
    targetRef: null, validHours: null, startsOn: '2026-11-16', endsOn: '2026-11-24',
    status: 'active', daysLeft: 2, endingSoon: true, originRef: {}, basis: null,
    futureIssueCount: null, businessDate: '2026-11-16', createdAt: '2026-11-16T09:00:00Z',
    issued: 1, used: 0, discountSum: 0, reminderTargets: 1,
    canPause: true, canResume: false, canExtend: true, canEnd: true, canNotify: true, codes: [], revision: 1,
  };
  const backend = setup(undefined, false, [campaign]);
  fireEvent.click(await screen.findByRole('button', { name: '끝나기 전 알림 보내기' }));
  fireEvent.click(screen.getByRole('button', { name: '알림 보내기(받는 사람 1명)' }));
  expect(screen.getByText('내일 8시', { exact: true })).toBeVisible();
  expect(backend.callsTo('POST', /notify-ending/)).toHaveLength(0);
});

it('shows the NAVER read ledger with disabled coupon and promotion writes while approvals are pending', async () => {
  const backend = setup(9, false);
  await screen.findByText('플레이스 첫 방문');
  const ledger = within(screen.getByRole('region', { name: '네이버 쿠폰' }));
  expect(ledger.getByText('주문 스탬프')).toBeInTheDocument();
  expect(ledger.getByText('12/1(화)까지')).toBeInTheDocument();
  expect(ledger.getByText('회원 스탬프')).toBeInTheDocument();
  expect(ledger.getByText('준비 중', { exact: true })).toBeInTheDocument();
  const create = ledger.getByRole('button', { name: '네이버 쿠폰 만들기' });
  expect(create).toBeDisabled();
  expect(ledger.getByRole('button', { name: '주문 프로모션 만들기' })).toBeDisabled();
  fireEvent.click(create);
  expect(backend.callsTo('POST', /^\/marketing/)).toEqual([]);
});

it('holds NAVER deletion until the extra owner press and uses the approval and source revision on DELETE', async () => {
  const backend = setup(9);
  backend.on('POST', '/marketing/naver-coupon-approvals', () => ({ approvalId: 'approval-1' }));
  backend.on('DELETE', '/marketing/naver-coupons/place/place-1', () => ({ receiptId: 'delete-1', state: 'applied', changed: true }));
  const remove = await screen.findByRole('button', { name: '쿠폰 지우기' });
  fireEvent.click(remove);
  expect(backend.callsTo('POST', '/marketing/naver-coupon-approvals')).toHaveLength(0);
  const review = within(screen.getByRole('region', { name: '플레이스 첫 방문을 지울까요?' }));
  fireEvent.click(review.getByRole('button', { name: '지울 쿠폰 확인하기' }));
  const second = await review.findByRole('button', { name: '쿠폰 지우기' });
  expect(backend.callsTo('DELETE', /naver-coupons/)).toHaveLength(0);
  fireEvent.click(second);
  await waitFor(() => expect(backend.callsTo('DELETE', /naver-coupons/)).toHaveLength(1));
  const approvals = backend.callsTo('POST', '/marketing/naver-coupon-approvals').map(call => call.body);
  expect(approvals).toEqual([
    { stage: 'press', operation: 'place.delete', targetRef: 'place-1', expectedRevision: 9, command: { confirmed: true } },
    { stage: 'confirm', operation: 'place.delete', targetRef: 'place-1', expectedRevision: 9, command: { confirmed: true }, approvalId: 'approval-1' },
  ]);
  const effect = backend.callsTo('DELETE', '/marketing/naver-coupons/place/place-1')[0];
  expect(effect.body).toEqual({ confirmed: true, expectedRevision: 9, approvalId: 'approval-1' });
  expect(effect.headers.get('idempotency-key')).toBeTruthy();
  // T-28: the result line says what happened to the coupon, not that NAVER "reflected" it.
  expect(await screen.findByText('쿠폰을 지웠어요')).toBeInTheDocument();
  expect(screen.queryByText(/반영했어요|반영 완료/)).not.toBeInTheDocument();
});

it('checks a pending NAVER application with the original key and never treats 202 as a completed effect', async () => {
  const backend = setup(12);
  backend.on('POST', '/marketing/naver-coupon-approvals', () => ({ approvalId: 'approval-12' }));
  let submits = 0;
  backend.on('POST', '/marketing/naver-coupons/place', () => ++submits === 1
    ? reply(202, { receiptId: 'place-12', changed: false, state: 'pending' })
    : { receiptId: 'place-12', changed: true, state: 'applied' });
  fireEvent.click(await screen.findByRole('button', { name: '네이버 쿠폰 만들기' }));
  fireEvent.change(screen.getByLabelText('쿠폰 이름'), { target: { value: '첫 방문 할인' } });
  fireEvent.click(screen.getByRole('radio', { name: '마케팅 메시지를 받는 손님' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: '금액 할인' }), { target: { value: '500' } });
  fireEvent.click(screen.getByRole('button', { name: '만들 내용 확인하기' }));
  expect(backend.callsTo('POST', /^\/marketing/)).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '확인하고 실행하기' }));
  const check = await screen.findByRole('button', { name: '결과 확인하기' });
  expect(screen.queryByText('쿠폰을 만들었어요')).not.toBeInTheDocument();
  fireEvent.click(check);
  await screen.findByText('쿠폰을 만들었어요');
  expect(screen.queryByText(/반영했어요|반영 완료/)).not.toBeInTheDocument(); // T-28 (P4/R3): no claim about what NAVER shows outside
  const calls = backend.callsTo('POST', '/marketing/naver-coupons/place');
  expect(calls).toHaveLength(2);
  expect(calls[0].body).toEqual({ type: 'place', name: '첫 방문 할인', audience: 'marketing-message',
    benefit: { type: 'amount', value: 500 }, approvalId: 'approval-12', expectedRevision: 12 });
  expect(calls[1].body).toEqual(calls[0].body);
  expect(calls[1].headers.get('idempotency-key')).toBe(calls[0].headers.get('idempotency-key'));
  expect(backend.callsTo('POST', '/marketing/naver-coupon-approvals')).toHaveLength(1);
});

// FIX-PKG-C T-15 (W28-R6): an ending coupon nobody can be reminded about must not sit next to "곧 끝나는 쿠폰이 없어요".
const endingCoupon = (over: Partial<CouponDto>): CouponDto => ({
  couponId: 'coupon-9', origin: 'slot', name: '곧 끝나는 쿠폰', benefitType: 'percent', benefitValue: 10,
  targetRef: null, validHours: null, startsOn: '2026-11-16', endsOn: '2026-11-24',
  status: 'active', daysLeft: 2, endingSoon: true, originRef: {}, basis: null,
  futureIssueCount: null, businessDate: '2026-11-22', createdAt: '2026-11-16T09:00:00Z',
  issued: 5, used: 1, discountSum: 0, reminderTargets: 0,
  canPause: true, canResume: false, canExtend: true, canEnd: true, canNotify: false, codes: [], revision: 1, ...over,
});

it('says why no reminder can go out instead of "no coupon is ending" while a coupon is ending (no reminder targets)', async () => {
  setup(undefined, false, [endingCoupon({})]);
  expect(await screen.findByText('곧 끝나는 쿠폰 1개')).toBeInTheDocument();
  expect(screen.queryByText('곧 끝나는 쿠폰이 없어요')).not.toBeInTheDocument();
  expect(screen.getByText('알림을 보낼 수 있는 손님이 없어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '끝나기 전 알림 보내기' })).not.toBeInTheDocument();
});

it('keeps "곧 끝나는 쿠폰이 없어요" when nothing is ending', async () => {
  setup(undefined, false, [endingCoupon({ endsOn: '2026-12-20', daysLeft: 28, endingSoon: false })]);
  expect(await screen.findByText('곧 끝나는 쿠폰이 없어요')).toBeInTheDocument();
  expect(screen.queryByText(/곧 끝나는 쿠폰 \d+장/)).not.toBeInTheDocument();
});

// T-52 (D-381/D-382, W28-F10): the membership coupon block says there is no linked membership product and where membership coupons are changed; it has no write button.
it('says there is no linked membership product and that membership coupons are changed on the partner side', async () => {
  setup(9, false, [], { benefits: [] });
  await screen.findByText('플레이스 첫 방문');
  const ledger = within(screen.getByRole('region', { name: '네이버 쿠폰' }));
  expect(ledger.getByText('연결된 멤버십 상품이 없어요')).toBeInTheDocument();
  expect(ledger.getByText('멤버십 쿠폰은 멤버십 제휴사 화면에서 바꿔요')).toBeInTheDocument();
});
it('keeps the membership guidance line when a membership product is listed', async () => {
  setup(9, false);
  await screen.findByText('플레이스 첫 방문');
  const ledger = within(screen.getByRole('region', { name: '네이버 쿠폰' }));
  expect(ledger.getByText('회원 스탬프')).toBeInTheDocument();
  expect(ledger.queryByText('연결된 멤버십 상품이 없어요')).toBeNull();
  expect(ledger.getByText('멤버십 쿠폰은 멤버십 제휴사 화면에서 바꿔요')).toBeInTheDocument();
});
