import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../catalog';
import { createWidgetDataStore, TODAY, selectStaffSchedule } from '../data/widget-data';
import { addDays, NOW } from '../data/db/time';
import { cafeMemberId } from '../data/db/cafe-identity';
import { seedCatalog } from '../data/db/generated/catalog';
import { seedToday } from '../data/db/generated/today';
import { seedSupplement } from '../data/db/generated/supplement';
import { createCustomOrderSeed } from '../data/iteration7/custom-orders';
import { WidgetDataProvider } from '../data/react';
import { I18nProvider } from '../i18n';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { UiProvider, timePolicy } from '../ui';
import { BriefingOverlay } from '../screens/briefing';
import { beginDashboard } from './test-session';
import { renderWithKit } from '../ui/test-utils';
import { DetailStack } from '../features/widgets/mgmt-supply/testing';
import { widgetModules } from '../features/widgets/registry';
import { attachCustomApprovalScheduler, M2RunHost, useM2WidgetBindings } from './pos-host';
import { createSessionActions, type SessionActions, SessionActionsProvider, sessionGateFor } from './session-actions';
import { PosProvider } from '../pos/react';
import { closureForQuestion } from '../features/widgets/mkt-local/ai-response';
import { selectShopGuidance } from '../data/iteration7/notices';
import { CctvLinks } from '../features/widgets/mgmt-customers/cctv-detail';
import { TableMap } from '../screens/order/tables/TableMap';
import { createTableLayout } from '../layout/table-layout';
import { useMemberMoney } from '../features/widgets/i7-credit/context';
import { useAccountingPresentation } from '../features/widgets/mgmt-money/ledger';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
import { LoyaltyCheckout } from '../screens/order/loyalty/Checkout';

const activePass = seedSupplement.activePasses[0];
const chargeMemberId = cafeMemberId(activePass.memberId);
const receivableMemberId = cafeMemberId(seedSupplement.balances.find(row => row.receivableBalance > 5_000)!.memberId);
const chargeBalance = seedSupplement.balances.reduce((sum, row) => sum + row.chargeBalance, 0);
const sale = seedToday.rollup;
const americano = seedCatalog.menu.find(row => row.menuId === 'm-americano')!;
const hotRegular = americano.groups.flatMap(group => group.options.filter(option => ['HOT', '레귤러'].includes(option.name)).map(option => option.optionId));
// The café seed approves CO-001 for payment at pickup; the order still waiting for its first quote is the one these flows quote.
const orderToQuote = createCustomOrderSeed().tables.customOrder.find(order => order.quoteRevision === 0)!;
const customOrderId = orderToQuote.customOrderId;
const quotedAmount = 45_600;

function approveCustom(session: SessionActions) {
  const quote = session.custom.dispatch({ type: 'customOrder.quote', customOrderId, quoteAmount: quotedAmount, proposedPickupAt: `${TODAY}T17:00`, idempotencyKey: 'quote' });
  expect(quote).toMatchObject({ ok: true, value: { quoteRevision: 1 } });
  expect(session.custom.dispatch({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'approve' })).toMatchObject({ ok: true });
}

function payCustom(session: SessionActions, runId: string) {
  const quote = session.custom.quoteSettlement({ customOrderId, allocations: [{ kind: 'method', method: 'card', amount: quotedAmount }] });
  expect(session.custom.beginApproval({ quote, idempotencyKey: 'pay-fixture' })).toMatchObject({ ok: true });
  expect(session.custom.finishApproval({ runId, attemptId: session.custom.approval()!.attemptId, outcome: 'approved' })).toMatchObject({ ok: true });
  session.custom.dismissApproval();
}

function MemberMoneyEntry() {
  const binding = useMemberMoney(), accounting = useAccountingPresentation();
  const today = accounting?.views.find(view => view.period.start === TODAY && view.period.end === TODAY);
  const context = (button: HTMLButtonElement) => ({ detailRef: { featureId: 'members' as const, itemId: chargeMemberId }, selectedId: chargeMemberId, returnFocusRef: { current: button } });
  return <>
    <p>{binding?.view.status === 'ready' ? `충전금 ${binding.view.model.chargeBalance}` : '회원 자금 연결 없음'}</p>
    <p>{accounting?.views.find(view => view.status === 'ready' && view.period.start === TODAY && view.period.end === TODAY)?.status === 'ready' ? '회계 연결됨' : '회계 연결 없음'}</p>
    {today?.status === 'ready' && <p>매출 {today.summary.sales.total} 입금 {today.summary.deposits.total} 시재 {today.drawer?.expected}</p>}
    <button onClick={event => binding?.port.openSettlement({ purpose: 'charge_topup', memberId: chargeMemberId, amount: 50_000 }, context(event.currentTarget))}>회원 충전 열기</button>
    <button onClick={event => binding?.port.openSettlement({ purpose: 'receivable_collection', memberId: receivableMemberId, amount: 5_000 }, context(event.currentTarget))}>부분 수금 열기</button>
    <button onClick={event => binding?.port.openAccounts(chargeMemberId, context(event.currentTarget))}>회원 계정 열기</button>
    <button onClick={event => {
      const pass = binding?.memberships.find(row => row.memberId === chargeMemberId && row.kind === 'count' && row.status === 'active');
      if (pass) binding?.port.openMembershipUse(pass.memberId, pass.membershipId, context(event.currentTarget));
    }}>회원권 POS 열기</button>
    <button onClick={event => {
      const transaction = binding?.view.status === 'ready' ? binding.view.model.transactions.find(row => row.memberId === chargeMemberId && row.kind === 'topup') : undefined;
      if (transaction) binding?.port.openOriginalTransaction(transaction, context(event.currentTarget));
    }}>충전 원거래 열기</button>
  </>;
}

it('hosts member funding and original receipts on the same subscribed money source with return focus', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store), scheduled: (() => void)[] = [];
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run} scheduler={{ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} }}><MemberMoneyEntry /></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  expect(screen.getByText(`충전금 ${chargeBalance}`)).toBeInTheDocument();
  expect(screen.getByText('회계 연결됨')).toBeInTheDocument();
  expect(screen.getByText(`매출 ${sale.net} 입금 ${sale.net} 시재 ${sale.expectedDrawer}`)).toBeInTheDocument();
  const boards = run.getState().boards, opener = screen.getByRole('button', { name: '회원 충전 열기' });
  fireEvent.click(opener);
  expect(screen.getByRole('dialog', { name: '충전금 충전' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  act(() => { scheduled[0](); scheduled[0](); });
  expect(screen.getByText('충전했어요')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
  await act(async () => {});
  expect(opener).toHaveFocus();
  expect(screen.getByText(`충전금 ${chargeBalance + 50_000}`)).toBeInTheDocument();
  expect(screen.getByText(`매출 ${sale.net} 입금 ${sale.net + 50_000} 시재 ${sale.expectedDrawer}`)).toBeInTheDocument();
  expect(run.getState().boards).toBe(boards);
  expect(run.getState().layer).toBe('management');
  fireEvent.click(screen.getByRole('button', { name: '충전 원거래 열기' }));
  expect(screen.getByRole('dialog', { name: '영수증' })).toBeInTheDocument();
  // K-E 10: a live charge belongs to no order, so the receipt has no order number and never prints the internal settlement id
  expect(screen.queryByText('정산 거래번호')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: '영수증' })).not.toHaveTextContent(/settlement:|funding:/);
  fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
  fireEvent.click(screen.getByRole('button', { name: '부분 수금 열기' }));
  fireEvent.click(screen.getByRole('button', { name: '현금' }));
  act(() => scheduled.at(-1)!());
  expect(screen.getByText('외상을 수금했어요')).toBeInTheDocument();
  expect(screen.getByText(`매출 ${sale.net} 입금 ${sale.net + 55_000} 시재 ${sale.expectedDrawer + 5_000}`)).toBeInTheDocument();
  session.pos.dispose(); run.dispose();
});

it('retains the selected member pass until real POS menu context exists and returns to that member', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' }); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  expect(session.completeOnboarding(null).ok).toBe(true);
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run}><MemberMoneyEntry /></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  const money = session.money.read().state;
  act(() => { expect(run.actions.openDetailRef({ featureId: 'members', itemId: chargeMemberId }, 'dashboard')).toBe(true); });
  fireEvent.click(screen.getByRole('button', { name: '회원 계정 열기' }));
  expect(run.getState().overlay).toMatchObject({ type: 'detail', stack: [{ featureId: 'members', itemId: chargeMemberId }, { featureId: 'credit-receivable', itemId: chargeMemberId }] });
  act(() => { run.actions.detailBack(); });
  fireEvent.click(screen.getByRole('button', { name: '회원권 POS 열기' }));
  expect(run.getState().layer).toBe('management');
  act(() => { run.actions.finishOverlayExit(run.getState().exitPendingToken!); });
  expect(run.getState().layer).toBe('orders-payment');
  expect(screen.getByRole('button', { name: '선택한 회원권 적용하기' })).toBeDisabled();
  expect(session.money.read().state).toBe(money);
  act(() => { expect(session.pos.execute({ type: 'cart.add', menuId: 'm-americano', optionIds: hotRegular, qty: 1, meta: { runId: run.getState().runId, idempotencyKey: 'pass-context' } }).ok).toBe(true); });
  fireEvent.click(screen.getByRole('button', { name: '선택한 회원권 적용하기' }));
  const read = session.pos.read(), bill = quotePaymentBill(read, getPaymentBillId(read));
  expect(bill.memberId).toBe(chargeMemberId);
  expect(bill.discounts).toContainEqual(expect.objectContaining({ source: 'membership' }));
  expect(session.money.read().state).toBe(money);
  fireEvent.click(screen.getByRole('button', { name: '회원목록으로 돌아가기' }));
  expect(run.getState().layer).toBe('management');
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'members', stack: [{ featureId: 'members', itemId: chargeMemberId }] });
  session.pos.dispose(); run.dispose();
});

it('shows separate canonical sales and actual deposits in the closing briefing', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  const topUp = 5_000;
  const quote = session.money.quoteSettlement({ target: { purpose: 'charge_topup', memberId: chargeMemberId, amount: topUp }, allocations: [{ kind: 'method', method: 'card', amount: topUp }] });
  expect(session.money.beginApproval({ quote, idempotencyKey: 'briefing-topup' })).toMatchObject({ ok: true });
  const attempt = session.money.approval()!;
  expect(session.money.finishApproval({ runId: attempt.runId, attemptId: attempt.attemptId, outcome: 'approved' })).toMatchObject({ ok: true });
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run}><DetailStack root={{ featureId: 'briefing' }} modules={widgetModules}/></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  fireEvent.click(screen.getByRole('tab', { name: '퇴근' }));
  expect(screen.getByRole('region', { name: '오늘 매출' }).querySelector('.ui-pos-money')?.textContent).toBe(`${sale.net.toLocaleString('ko-KR')}원`);
  expect(screen.getByRole('region', { name: '실제 입금' }).querySelector('.ui-pos-money')?.textContent).toBe(`${(sale.net + topUp).toLocaleString('ko-KR')}원`);
  expect(screen.getByRole('table', { name: '수단별 실제 입금' })).toBeInTheDocument();
  session.pos.dispose(); run.dispose();
});

it('composes a mixed member sale through the existing checkout and commits its quote once', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store), scheduled: (() => void)[] = [], completed = vi.fn();
  run.actions.setOnboardingAnswer({ businessType: 'cafe' }); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  expect(session.completeOnboarding(null).ok).toBe(true);
  expect(session.pos.execute({ type: 'cart.add', menuId: 'm-americano', optionIds: hotRegular, meta: { runId: run.getState().runId, idempotencyKey: 'mixed-menu' } }).ok).toBe(true);
  const billId = getPaymentBillId(session.pos.read());
  expect(session.pos.execute({ type: 'bill.member', billId, memberId: chargeMemberId, meta: { runId: run.getState().runId, idempotencyKey: 'mixed-member' } }).ok).toBe(true);
  const before = session.money.read().state;
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run} scheduler={{ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} }}><LoyaltyCheckout open billId={billId} summary="아메리카노 1잔" returnFocusRef={{ current: null }} onClose={() => {}} onComplete={completed}/></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  fireEvent.change(screen.getByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '1000' } });
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  expect(session.money.approval()?.status).toBe('pending');
  expect(session.money.read().state.settlements).toBe(before.settlements);
  act(() => { scheduled[0](); scheduled[0](); });
  expect(session.money.approval()?.status).toBe('succeeded');
  expect(session.money.read().state.settlements).toHaveLength(before.settlements.length + 1);
  const latest = session.money.read().state.settlements.at(-1)!;
  expect(latest.allocations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'charge', amount: 1000 }), expect.objectContaining({ kind: 'method', method: 'card', amount: americano.price - 1000 })]));
  expect(run.getState().pos.orders.at(-1)?.orderNo).toBe(seedToday.pos.orders.at(-1)!.orderNo + 1);
  expect(run.getState().pos.cart.lines).toHaveLength(0);
  session.pos.dispose(); run.dispose();
});

afterEach(cleanup);

it('registers the member-money controlled module in the real eager registry', () => {
  const credit = widgetModules.find(module => module.id === 'credit-receivable');
  expect(credit?.Panel).toBeTypeOf('function');
  expect(credit?.Detail).toBeTypeOf('function');
});

it('answers closure dates from the same calendar guidance, including the end date', () => {
  const store = createWidgetDataStore();
  const start = addDays(TODAY, 2), endDate = addDays(TODAY, 3);
  expect(store.dispatch({ type: 'calendar.addEvent', title: '예시 휴무', date: start, storeClosure: { kind: 'temporary', endDate } })).toMatchObject({ ok: true });
  const closures = selectShopGuidance(store.getSnapshot()).closures;
  const short = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`;
  expect(closureForQuestion(`${short(endDate)}에 문 여나요?`, closures)).toMatchObject({ date: endDate, closure: { kind: 'temporary' } });
  expect(closureForQuestion(`${short(addDays(endDate, 1))}에도 문 여나요?`, closures)).toBeNull();
  expect(closureForQuestion(`2025-${endDate.slice(5)} 문 여나요?`, closures)).toBeNull();
  expect(closureForQuestion(`${short(endDate)} 문 여나요?`, [])).toBeNull();
});

it('schedules one custom approval and leaves no money effect after disposal', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light' });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  approveCustom(session);
  const scheduled: (() => void)[] = [], cancel = vi.fn();
  const stop = attachCustomApprovalScheduler(session.custom, { schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel });
  const quote = session.custom.quoteSettlement({ customOrderId, allocations: [{ kind: 'method', method: 'card', amount: quotedAmount }] });
  expect(session.custom.beginApproval({ quote, idempotencyKey: 'pay' }).ok).toBe(true);
  expect(scheduled).toHaveLength(1);
  const before = store.getSnapshot();
  stop(); scheduled[0]();
  expect(store.getSnapshot()).toBe(before);
  const resume = attachCustomApprovalScheduler(session.custom, { schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel });
  scheduled[1](); scheduled[1]();
  expect(store.getSnapshot().pos?.customPayments).toHaveLength(1);
  expect(session.custom.approval()?.status).toBe('succeeded');
  resume(); session.pos.dispose(); run.dispose();
});

function CustomPaymentEntry() {
  const binding = useM2WidgetBindings();
  return <><button onClick={event => binding?.customPort.openSettlement({ purpose: 'custom_order', customOrderId }, { selectedId: customOrderId, returnFocusRef: { current: event.currentTarget } })}>공용 결제 열기</button><button onClick={event => binding?.customPort.openReversal({ customOrderId, cancelOrder: true }, { selectedId: customOrderId, returnFocusRef: { current: event.currentTarget } })}>결제 취소 열기</button></>;
}
it('hosts custom payment above the management view and preserves the board and focus', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  approveCustom(session);
  const scheduled: (() => void)[] = [];
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run} scheduler={{ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} }}><CustomPaymentEntry /></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  const boards = run.getState().boards;
  const opener = screen.getByRole('button', { name: '공용 결제 열기' });
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  fireEvent.click(screen.getByRole('button', { name: '승인 중이에요' }));
  expect(session.money.approval()?.status).toBe('pending');
  act(() => scheduled[0]());
  expect(screen.getByText('결제를 완료했어요')).toBeInTheDocument();
  expect(store.getSnapshot().pos?.customPayments).toHaveLength(1);
  expect(run.getState().layer).toBe('management');
  expect(run.getState().boards).toBe(boards);
  fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
  await act(async () => {});
  expect(opener).toHaveFocus();
  session.pos.dispose(); run.dispose();
});

it('restores focus to the selected custom row when payment disables its trigger', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store), scheduled: (() => void)[] = [];
  approveCustom(session);
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run} scheduler={{ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} }}><DetailStack root={{ featureId: 'custom-order', itemId: customOrderId }} modules={widgetModules}/></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  fireEvent.click(screen.getByRole('button', { name: '결제 받기' }));
  fireEvent.click(screen.getByRole('button', { name: '카드' }));
  act(() => scheduled[0]());
  fireEvent.click(screen.getAllByRole('button', { name: '닫기' }).at(-1)!);
  await act(async () => {});
  expect(document.getElementById(`custom-${customOrderId}`)).toHaveFocus();
  expect(screen.getByRole('button', { name: '결제 받기' })).toBeDisabled();
  session.pos.dispose(); run.dispose();
});

it('runs paid cancellation once through the common reversal host without a stock write', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store), scheduled: (() => void)[] = [];
  approveCustom(session);
  payCustom(session, run.getState().runId);
  const before = store.getSnapshot().tables.inventoryStock;
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run} scheduler={{ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel: () => {} }}><CustomPaymentEntry /></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  fireEvent.click(screen.getByRole('button', { name: '결제 취소 열기' }));
  fireEvent.click(screen.getByRole('button', { name: '취소 확정하기' }));
  expect(store.getSnapshot().pos?.customCorrections).toHaveLength(0);
  act(() => { scheduled[0](); scheduled[0](); });
  expect(store.getSnapshot().pos?.customCorrections).toHaveLength(1);
  expect(store.getSnapshot().tables.customOrder.find(order => order.customOrderId === customOrderId)?.stage).toBe('canceled');
  expect(store.getSnapshot().tables.reservation.find(row => row.reservationId === `PICKUP-${customOrderId}`)?.status).toBe('canceled');
  expect(store.getSnapshot().tables.inventoryStock).toEqual(before);
  session.pos.dispose(); run.dispose();
});

function LinkedTableSurfaces() {
  const binding = useM2WidgetBindings();
  return <><CctvLinks {...binding?.cctv}/><TableMap linkedTables={binding?.cctv.linkedTables} onEdit={() => {}} onPick={() => {}}/></>;
}
it('feeds anonymous observations without a mounted CCTV widget and shares the link across both surfaces', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' }); run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' }); run.actions.saveOnboardingTables(createTableLayout());
  expect(session.completeOnboarding(null).ok).toBe(true);
  renderWithKit(<SessionActionsProvider value={session}><PosProvider value={session.pos}><M2RunHost run={run}><LinkedTableSurfaces/></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'T1' } });
  expect(run.getState().shopSettings.cctvPosLinks).toEqual([{ zoneId: 't1', tableId: 'T1' }]);
  expect(store.getSnapshot().tables.shopSettings.cctvPosLinks).toEqual([{ zoneId: 't1', tableId: 'T1' }]);
  expect(run.getState().linkedOccupancy.observations).toContainEqual(expect.objectContaining({ zoneId: 't1', state: 'occupied' }));
  expect(screen.getAllByText('사람 있음')).toHaveLength(2);
  act(() => run.actions.observeLinkedOccupancy({ zoneId: 't1', state: 'cups_left', observedAt: NOW, elapsedNow: 0 }));
  expect(screen.getAllByText('치울 테이블')).toHaveLength(2);
  act(() => run.actions.observeLinkedOccupancy({ zoneId: 't1', state: 'empty', observedAt: NOW, elapsedNow: 0 }));
  expect(screen.queryByText('치울 테이블')).toBeNull();
  session.pos.dispose(); run.dispose();
});
it('arrival briefing shares the session fullscreen preference without changing the board', async () => {
  let now = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  act(() => { beginDashboard(run, 'cafe'); run.actions.visualSettled(); }); advance(400);
  act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); advance(200);
  act(() => run.actions.skipWidgetCoaches()); advance(200);
  act(() => { run.actions.clearNotice(); run.actions.finishEditing(); }); advance(1200);
  const boards = run.getState().boards;
  render(<I18nProvider locale="ko"><WidgetDataProvider store={createWidgetDataStore()}><UiProvider screenPreset={screenPresets.A} reducedMotion><BriefingOverlay run={run} /></UiProvider></WidgetDataProvider></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: '자세히 보기 전체 화면으로 보기' }));
  expect(run.getState().detailDialogFullscreen).toBe(true);
  expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--fullscreen');
  expect(run.getState().boards).toBe(boards);
  fireEvent.click(screen.getByRole('button', { name: '자세히 보기 원래 크기로 보기' }));
  expect(run.getState().detailDialogFullscreen).toBe(false);
  run.dispose();
});

it('arrival briefing displays the shared staff summary', () => {
  let now = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  act(() => { beginDashboard(run, 'cafe'); run.actions.visualSettled(); }); advance(400);
  act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); advance(200);
  act(() => run.actions.skipWidgetCoaches()); advance(200);
  act(() => { run.actions.clearNotice(); run.actions.finishEditing(); }); advance(1200);
  const store = createWidgetDataStore();
  render(<I18nProvider locale="ko"><WidgetDataProvider store={store}><UiProvider screenPreset={screenPresets.A} reducedMotion><BriefingOverlay run={run} /></UiProvider></WidgetDataProvider></I18nProvider>);
  const today = selectStaffSchedule(store.getSnapshot(), { startDate: TODAY, endDate: TODAY }).today;
  expect(today).toMatchObject({ workingCount: 5, nextHandoffAt: '17:00' });
  expect(screen.getByText(`오늘 근무 ${today.workingCount}명 · ${today.nextHandoffAt} 교대`)).toBeInTheDocument();
  act(() => {
    const result = store.dispatch({ type: 'staff.create', name: '한지민', idempotencyKey: 'staff' });
    if (!result.ok) throw new Error(result.messageKey);
    const staffId = (result.value as { staffId: string }).staffId;
    expect(store.dispatch({ type: 'staff.saveSchedule', staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 0, idempotencyKey: 'shift' })).toMatchObject({ ok: true });
    expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: today.nextHandoffAt!, toTime: '17:15', idempotencyKey: 'handoff' })).toMatchObject({ ok: true });
  });
  expect(screen.getByText(`오늘 근무 ${today.workingCount + 1}명 · 17:15 교대`)).toBeInTheDocument();
  run.dispose();
});

it('the root eager registry mounts the staff widget', () => {
  const staff = widgetModules.find(module => module.id === 'staff-schedule');
  expect(staff?.Panel).toBeTypeOf('function');
  expect(staff?.Detail).toBeTypeOf('function');
  expect(widgetModules.map(module => module.id).sort()).toEqual(getRegistry('A').map(item => item.id).sort());
});

it('calendar detail shows read-only staff rows and opens their source', () => {
  const onLinked = vi.fn();
  renderWithKit(<DetailStack root={{ featureId: 'calendar' }} events={{ onLinked }} />);
  const staff = seedSupplement.staff[0];
  const shift = seedSupplement.shifts.find(row => row.staffId === staff.staffId && row.date === TODAY)!;
  const row = screen.getByRole('button', { name: new RegExp(`${staff.name}.*직원 스케줄표`) });
  fireEvent.click(row);
  expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'staff-schedule', itemId: shift.shiftId }));
});

it('calendar creates an inclusive store closure through the existing direct-event form', async () => {
  const store = createWidgetDataStore();
  renderWithKit(<DetailStack root={{ featureId: 'calendar', view: 'add' }} />, { store });
  fireEvent.change(screen.getByRole('textbox', { name: '일정 제목' }), { target: { value: '연휴 휴무' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '매장 휴무' }));
  const endDate = addDays(TODAY, 2);
  fireEvent.click(screen.getByRole('button', { name: /^휴무 종료일 / }));
  const picker = await screen.findByRole('dialog', { name: '날짜 고르기' });
  const endLabel = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' }).format(new Date(endDate));
  fireEvent.click(within(picker).getByRole('button', { name: endLabel }));
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  expect(store.getSnapshot().tables.calendarEvent).toContainEqual(expect.objectContaining({
    title: { raw: '연휴 휴무' }, date: TODAY, storeClosure: { kind: 'temporary', endDate },
  }));
});

it('calendar exposes the canonical pickup separately from visitor and staff counts', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light' });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const session = createSessionActions(run, store);
  approveCustom(session);
  const onLinked = vi.fn();
  const product = orderToQuote.productLabel;
  renderWithKit(<DetailStack root={{ featureId: 'calendar' }} events={{ onLinked }} />, { store });
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`${product}.*주문제작`) }));
  expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'custom-order', itemId: customOrderId }));
  session.pos.dispose(); run.dispose();
});
