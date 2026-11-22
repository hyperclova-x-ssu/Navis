import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { createWidgetDataStore, selectWidget } from '../../../data/widget-data';
import * as widgetData from '../../../data/widget-data';
import { formatMaskedCustomer } from '../../../data/customer-display';
import { selectMembers } from '../../../data/derive/members';
import { createSessionActions, sessionGateFor } from '../../../app/session-actions';
import * as sessionActionsModule from '../../../app/session-actions';
import { App } from '../../../app/App';
import { selectPosDayTotals } from '../../../pos/domain';
import { quotePaymentBill } from '../../../pos/loyalty';
import { timePolicy } from '../../../ui';
import { storeFactSource } from '../../../features/assistant/snapshot';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { seedToday } from '../../../data/db/generated/today';

const disposals: (() => void)[] = [];
afterEach(async () => { cleanup(); await act(async () => { vi.advanceTimersByTime(500); }); disposals.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); check(); }, { timeout: 5000, interval: 50 });
function setup() {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' }); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data);
  expect(actions.completeOnboarding(null).ok).toBe(true); run.actions.skipWidgetCoaches(); run.actions.switchLayer('orders-payment');
  disposals.push(() => { actions.pos.dispose(); run.dispose(); });
  let seq = 0;
  const add = (qty = 2) => {
    const menu = actions.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return actions.pos.execute({ type: 'cart.add', menuId: menu.menuId, qty, optionIds, meta: { runId: run.getState().runId, idempotencyKey: `test-add:${++seq}` } });
  };
  // Observe the root's real store creation; do not replace any store behavior.
  const stores = vi.spyOn(widgetData, 'createWidgetDataStore');
  const sessions = vi.spyOn(sessionActionsModule, 'createSessionActions');
  expect(add().ok).toBe(true); render(<App run={run} manageLifecycle={false}/>);
  const appData = stores.mock.results.at(-1)!.value as typeof data;
  return { run, data: appData, pos: actions.pos, money: sessions.mock.results.at(-1)!.value.money };
}
const click = (name: string) => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
async function checkout() { await settle(() => expect(screen.getByRole('button', { name: '결제하기' })).toBeInTheDocument()); fireEvent.click(screen.getByRole('button', { name: '결제하기' })); await settle(() => expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument()); }

// Check both the committed money and the final dialog transition: a paid bill alone
// does not prove that the checkout read this attempt's completion result.
it('member + coupon -> three shares -> mixed first share -> close/resume -> one atomic recognition', async () => {
  const { run, data, pos, money } = setup();
  const before = selectMembers(data.getSnapshot(), {});
  const selected = before.rows.find(row => row.grade === 'frequent' && row.recentVisits === 3
    && row.lastVisit !== POS_BUSINESS_DATE && row.phone && typeof row.name === 'string')!;
  await checkout();
  click('회원 찾기'); fireEvent.change(screen.getByRole('textbox', { name: '연락처 끝 4자리' }), { target: { value: selected.phone.slice(-4) } });
  const label = formatMaskedCustomer(typeof selected.name === 'string' ? selected.name : null, selected.memberId, selected.memberCode);
  fireEvent.click(screen.getByRole('button', { name: `${label} · ${selected.phone} · 자주 방문` }));
  click('할인'); click('오후 한산시간 디저트 1,000원 할인');
  expect(quotePaymentBill(pos.read()).payable).toBe(5000);
  click('나눠 내기'); fireEvent.change(screen.getByRole('spinbutton', { name: '인원 수' }), { target: { value: '3' } }); click('나누기');
  expect(quotePaymentBill(pos.read()).parts.map(p => p.amount)).toEqual([1666, 1666, 1668]);
  click('복합 결제');
  fireEvent.change(screen.getByRole('spinbutton', { name: '현금' }), { target: { value: '500' } });
  fireEvent.click(screen.getByRole('button', { name: '카드 남은 금액 넣기' }));
  click('결제하기'); click('승인 중이에요');
  expect(money.approval()?.status).toBe('pending');
  await settle(() => expect(run.getState().pos.payments.length).toBe(154));
  expect(screen.getByRole('heading', { name: '몫을 냈어요' })).toBeInTheDocument();
  await settle(() => expect(screen.queryByRole('heading', { name: '몫을 냈어요' })).not.toBeInTheDocument());
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ revenue: seedToday.rollup.net, pendingReceived: 1666 });
  expect(selectMembers(data.getSnapshot(), {}).gradeCounts).toEqual(before.gradeCounts);
  click('닫기'); await settle(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const partialBillId = run.getState().pos.cart.lock;
  expect(partialBillId).not.toBeNull();
  await checkout(); click('간편결제'); await settle(() => expect(run.getState().pos.payments.length).toBe(155));
  expect(screen.getByRole('heading', { name: '몫을 냈어요' })).toBeInTheDocument();
  await settle(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '카드' })).toBeInTheDocument());
  click('카드'); await settle(() => expect(selectPosDayTotals(run.getState().pos).revenue).toBe(836220));
  expect(run.getState().pos.bills.find(bill=>bill.billId===partialBillId)?.status).toBe('paid');
  expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '결제했어요 · 주문 #154' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '몫을 냈어요' })).not.toBeInTheDocument();
  await settle(() => expect(screen.queryByRole('dialog', { name: '결제' })).not.toBeInTheDocument());
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ paymentCount: 156, pendingReceived: 0, byMethod: { card: 559884, easy_pay: 218936, cash: 57400 }, methodCounts: { card: 105, easy_pay: 40, cash: 11 } });
  expect(run.getState().pos.orders.at(-1)?.orderNo).toBe(154);
  expect(run.getState().pos.cart.lines).toHaveLength(0);
  const members = selectMembers(data.getSnapshot(), {}), member = members.rows.find(r => r.memberId === selected.memberId)!;
  expect(members.gradeCounts).toMatchObject({ regular: before.gradeCounts.regular + 1, frequent: before.gradeCounts.frequent - 1 });
  expect(member).toMatchObject({ recentVisits: 4, lastVisit: POS_BUSINESS_DATE, grade: 'regular', lastPayment: { amount: 1668 } });
  const coupons = selectWidget(data.getSnapshot(), 'coupon-status', { kind:'default' }, 'normal');
  expect(coupons.status === 'ready' && coupons.model).toMatchObject({ monthUsed: 366, runningUsed: 224 });
  expect(storeFactSource(data).readSource?.('pos').find(f=>f.key==='pos.discount.coupon')?.value).toBe(20000);
}, 60000);

it('discount bounds and zero settlement preserve payment/method counts', async () => {
  const { run, pos } = setup(); await checkout(); click('할인');
  fireEvent.change(screen.getByRole('spinbutton', { name: '직접 할인' }), { target: { value: '10000' } }); click('할인 넣기');
  expect(quotePaymentBill(pos.read()).discount).toBe(0);
  fireEvent.click(screen.getByRole('radio', { name: '%' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: '직접 할인' }), { target: { value: '100' } }); click('할인 넣기');
  expect(quotePaymentBill(pos.read())).toMatchObject({ payable: 0, discount: 6000 });
  click('0원으로 주문하기');
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 153, methodCounts: { card: 103, easy_pay: 39, cash: 11 } });
  await settle(() => expect(run.getState().pos.orders.at(-1)?.orderNo).toBe(154));
});

it('closing an unpaid split clears its draft; cancelling a paid share unlocks without recognizing sales', async () => {
  const { run, pos } = setup(); await checkout(); click('나눠 내기'); click('나누기');
  click('닫기'); await settle(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(quotePaymentBill(pos.read()).parts).toHaveLength(0);
  await checkout(); click('나눠 내기'); click('나누기'); click('카드');
  await settle(() => expect(run.getState().pos.payments.length).toBe(154));
  await settle(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '결제 취소하기' })).toBeInTheDocument());
  click('결제 취소하기');
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  await settle(() => expect(run.getState().pos.cart.lock).toBeNull());
  expect(run.getState().pos.orders).toHaveLength(153);
  expect(run.getState().pos.payments.at(-1)?.status).toBe('canceled');
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ revenue: seedToday.rollup.net, pendingReceived: 0 });
}, 60000);
