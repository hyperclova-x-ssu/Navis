import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, fireEvent, getConfig, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { createTableLayout } from '../../../layout/table-layout';
import { createRunStore } from '../../../state';
import { createWidgetDataStore } from '../../../data/widget-data';
import { WidgetDataProvider } from '../../../data/react';
import { createSessionActions, sessionGateFor } from '../../../app/session-actions';
import { App } from '../../../app/App';
import { useState } from 'react';
import type { ReversalReceiptEntry } from '../ReversalReceipt';
import { PosReceiptHost } from '../../../app/pos-host';
import { PosAlertHost } from '../../../app/pos-host';
import { PosProvider } from '../../../pos/react';
import { I18nProvider } from '../../../i18n';
import { VisitPrompt } from '../tables/VisitPrompt';
import { selectOrderSummary } from '../../../pos/status';
import { timePolicy, UiProvider } from '../../../ui';
import { setup as setupBase } from '../../../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../../../pos/loyalty';
import { orderStatusRuntime } from '../../../pos/runtime';
import { OrderScreen } from '../index';

function setupPaymentRun(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}


import { POS_BUSINESS_DATE } from '../../../pos/clock';

function stageAlertOrders(actions: ReturnType<typeof createSessionActions>) {
  const read = actions.pos.read();
  const [slow, missing] = read.pos.orders.slice(-2);
  const nextPos = { ...read.pos, revision: read.posRevision + 1, orders: read.pos.orders.map(order => {
    if (order === missing) return { ...order, orderedAt: `${POS_BUSINESS_DATE}T15:18`, completedAt: null, preparation: 'accepted' as const };
    if (order === slow) return { ...order, orderedAt: `${POS_BUSINESS_DATE}T15:30`, completedAt: null,
      preparedAt: `${POS_BUSINESS_DATE}T15:31`, preparation: 'preparing' as const };
    return order;
  }) };
  expect(actions.commit({ nextPos, nextUi: read.posUi,
    result: { ok: true, status: 'applied', value: null, posRevision: nextPos.revision, dataRevision: read.dataRevision + 1 } }, read).ok).toBe(true);
  return { missing, slow };
}

const defaultAsyncWrapper = getConfig().asyncWrapper;
afterEach(() => { cleanup(); configure({ asyncWrapper: defaultAsyncWrapper }); vi.useRealTimers(); });

// Each receipt entry must retain its own approved method amounts and payment ID.
it('lists all three paid shares and every mixed method, and opens the selected payment receipt', async () => {
  const h = setupPaymentRun();
  h.add('m-americano', 2);
  const billId = getPaymentBillId(h.pos.read());
  expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0002', meta: h.meta() }).ok).toBe(true);
  expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: h.pos.read().data.loyalty!.coupons.find(c => c.status === 'active')!.couponId }, meta: h.meta() }).ok).toBe(true);
  expect(h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 3, meta: h.meta() }).ok).toBe(true);
  const methodAmounts = [
    [{ method: 'card' as const, amount: 1166 }, { method: 'cash' as const, amount: 500 }],
    [{ method: 'easy_pay' as const, amount: 1666 }],
    [{ method: 'card' as const, amount: 1668 }],
  ];
  for (const [index, splits] of methodAmounts.entries()) {
    const quote = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, partId: quote.parts[index].partId, quoteRevision: quote.revision, splits, meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  }
  const payments = h.pos.read().pos.payments.filter(payment => payment.billId === billId);
  const order = h.pos.read().pos.orders.at(-1)!;
  orderStatusRuntime(h.pos).openPos({ tab: 'status', orderId: order.orderId });
  function Host() { const [entry,setEntry]=useState<ReversalReceiptEntry|null>(null); return <><OrderScreen run={h.run} onOpenReceipt={setEntry}/><PosReceiptHost entry={entry} onClose={()=>setEntry(null)}/></>; }
  render(<I18nProvider locale="ko"><WidgetDataProvider store={h.data}><PosProvider value={h.pos}><UiProvider screenPreset={screenPresets.A} reducedMotion><Host/></UiProvider></PosProvider></WidgetDataProvider></I18nProvider>);
  const detail = screen.getByRole('region', { name: `#${order.orderNo} · 접수` });
  for (const [index, payment] of payments.entries()) {
    const group = detail.querySelector<HTMLElement>(`[data-payment-id="${payment.paymentId}"]`);
    expect(group).not.toBeNull();
    const rows = group!.querySelectorAll('[data-payment-method]');
    expect([...rows].map(row => ({ method: row.getAttribute('data-payment-method'), amount: Number(row.querySelector('.ui-pos-money')!.textContent!.replace(/[^\d]/g, '')) }))).toEqual(methodAmounts[index]);
    expect(within(group!).getByRole('button', { name: '영수증 보기' })).toBeInTheDocument();
    expect(within(group!).getByRole('button', { name: '결제 취소하기' })).toBeInTheDocument();
  }
  fireEvent.click(within(detail.querySelector<HTMLElement>(`[data-payment-id="${payments[1].paymentId}"]`)!).getByRole('button', { name: '영수증 보기' }));
  const receipt = await screen.findByRole('dialog', { name: '영수증 보기' });
  expect(within(receipt).getByText(payments[1].transactionNo)).toBeInTheDocument();
  expect(within(receipt).queryByText(payments[0].transactionNo)).not.toBeInTheDocument();
});

// A lost alert deferral, visibility override or status commit breaks this public root flow.
it('the missing-order alert waits for a modal, opens hidden status, completes and undoes once without re-alerting', async () => {
  vi.useFakeTimers();
  // React Testing Library's default microtask drain detects Jest timers only.
  configure({ asyncWrapper: async callback => { let result; await act(async () => { result = await callback(); }); return result; } });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data);
  expect(actions.completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  expect(actions.pos.execute({ type: 'pos.setPreferences', showStatus: false, meta: { runId: run.getState().runId, idempotencyKey: 'hide' } }).ok).toBe(true);
  const { missing, slow } = stageAlertOrders(actions);
  expect(selectOrderSummary(actions.pos.read()).missingIds).toEqual([missing.orderId]);
  run.actions.openSettings();
  render(<App run={run} manageLifecycle={false}/>);
  const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); check(); }, { timeout: 5000, interval: 50 });
  expect(screen.queryByRole('button', { name: '주문 보기' })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('dialog', { name: '설정' })).getByRole('button', { name: '닫기' }));
  await settle(() => expect(screen.queryByRole('dialog', { name: '설정' })).not.toBeInTheDocument());
  await settle(() => expect(run.getState().posUi.orderAlert).toMatchObject({ visible: true, notifiedIds: [missing.orderId] }));
  expect(screen.getByRole('button', { name: '주문 보기' })).toBeInTheDocument();
  // Vitest omits imported CSS. Reproduce the real portal host's pass-through surface;
  // userEvent must reject a pointer action unless the alert explicitly accepts it.
  const viewOrder = screen.getByRole('button', { name: '주문 보기' });
  const portal = viewOrder.closest<HTMLElement>('.ui-portal-host')!;
  portal.style.pointerEvents = 'none';
  await user.click(screen.getByRole('button', { name: '주문/결제' }));
  await settle(() => expect(screen.getByRole('tab', { name: '주문' })).toHaveAttribute('aria-selected', 'true'));
  await user.hover(screen.getByRole('button', { name: '주문 보기' }));
  await user.click(screen.getByRole('button', { name: '관리' }));
  await settle(() => expect(screen.getByRole('button', { name: '관리' })).toHaveAttribute('aria-current', 'page'));
  await user.click(screen.getByRole('button', { name: '주문 보기' }));
  await settle(() => expect(screen.getByRole('tab', { name: /주문 현황/ })).toHaveAttribute('aria-selected', 'true'));
  expect(run.getState().shopSettings.posPreferences?.showStatus).toBe(false);
  const panel = screen.getByRole('region', { name: new RegExp(`^#${missing.orderNo} ·`) });
  fireEvent.click(within(panel).getByRole('button', { name: '완료' }));
  expect(run.getState().pos.orders.find(o => o.orderId === missing.orderId)?.preparation).toBe('completed');
  expect(run.getState().posUi.orderUndo).toBeTruthy();
  expect(document.querySelector(`[data-grid-row-id="${slow.orderId}"][data-grid-column-id="status"]`)).toHaveTextContent('오래 걸려요');
  await user.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(run.getState().pos.orders.find(o => o.orderId === missing.orderId)?.preparation).toBe('accepted');
  expect(run.getState().posUi.orderUndo).toBeNull();
  fireEvent.click(screen.getByRole('navigation', { name: '화면' }).querySelector('[data-layer="management"]')!);
  await settle(() => expect(screen.getByRole('button', { name: '관리' })).toHaveAttribute('aria-current', 'page'));
  expect(screen.queryByRole('button', { name: '주문 보기' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '주문/결제' }));
  await settle(() => expect(screen.getByRole('tab', { name: '주문' })).toHaveAttribute('aria-selected', 'true'));
  expect(screen.queryByRole('tab', { name: /주문 현황/ })).not.toBeInTheDocument();
  // Independently constructed coordinator uses the same run snapshot after undo.
  expect(selectOrderSummary(actions.pos.read())).toMatchObject({ missingCount: 1, avgWaitMin: 0.5 });
  actions.pos.dispose(); run.dispose();
}, 60000);

// A pending reservation must defer a fresh alert and suspend an already shown one
// without consuming or resetting its once-per-order notification state.
it.each([false, true])('reservation visit prompt blocks the alert (already shown: %s)', async alreadyShown => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  run.actions.saveOnboardingTables(createTableLayout());
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data), pos = actions.pos;
  expect(actions.completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  run.actions.switchLayer('orders-payment');
  const { missing } = stageAlertOrders(actions);
  expect(data.dispatch({ type: 'booking.create', date: POS_BUSINESS_DATE, time: '16:00',
    guest: { name: '테스트 방문 손님' }, partySize: 2, tableChoice: { tableId: 'T4' }, idempotencyKey: 'alert-visit' }).ok).toBe(true);
  const submit = () => {
    expect(pos.execute({ type: 'cart.add', menuId: 'm-basque-cake', optionIds: [], meta: { runId: run.getState().runId, idempotencyKey: 'visit-cart' } }).ok).toBe(true);
    expect(pos.execute({ type: 'bill.submitOrder', cartId: pos.read().pos.cart.cartId, tableId: 'T4', meta: { runId: run.getState().runId, idempotencyKey: 'visit-order' } }).ok).toBe(true);
  };
  if (!alreadyShown) submit();
  render(<I18nProvider locale="ko"><WidgetDataProvider store={data}><PosProvider value={pos}><UiProvider screenPreset={screenPresets.A} reducedMotion><VisitPrompt onNotice={() => {}}/><PosAlertHost run={run}/></UiProvider></PosProvider></WidgetDataProvider></I18nProvider>);
  const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); check(); }, { timeout: 5000, interval: 50 });
  if (alreadyShown) {
    await settle(() => expect(screen.getByRole('button', { name: '주문 보기' })).toBeInTheDocument());
    expect(run.getState().posUi.orderAlert?.notifiedIds).toEqual([missing.orderId]);
    act(submit);
  }
  await settle(() => expect(screen.getByRole('button', { name: '방문 완료로 바꾸기' })).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: '주문 보기' })).not.toBeInTheDocument();
  expect(run.getState().posUi.orderAlert?.notifiedIds ?? []).toEqual(alreadyShown ? [missing.orderId] : []);
  fireEvent.click(screen.getByRole('button', { name: '방문 완료로 바꾸기' }));
  expect(run.getState().pos.reservationPrompts.at(-1)?.decision).toBe('accepted');
  await settle(() => expect(screen.getByRole('button', { name: '주문 보기' })).toBeInTheDocument());
  expect(run.getState().posUi.orderAlert?.notifiedIds).toEqual([missing.orderId]);
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await settle(() => expect(screen.queryByRole('button', { name: '주문 보기' })).not.toBeInTheDocument());
  act(() => { run.actions.switchLayer('management'); run.actions.switchLayer('orders-payment'); });
  await settle(() => expect(screen.queryByRole('button', { name: '주문 보기' })).not.toBeInTheDocument());
  expect(run.getState().posUi.orderAlert?.notifiedIds).toEqual([missing.orderId]);
  pos.dispose(); run.dispose();
}, 60000);
