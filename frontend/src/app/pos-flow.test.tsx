import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { quoteCart, selectPosDayTotals } from '../pos/domain';
import { timePolicy } from '../ui';
import { seedToday } from '../data/db/generated/today';
import { seedCatalog } from '../data/db/generated/catalog';
import { POS_NOW } from '../pos/clock';
import { beginDashboard } from './test-session';
import { App } from './App';
import { createWidgetDataStore } from '../data/widget-data';
import { createSessionActions, sessionGateFor } from './session-actions';
import * as sessionActionsModule from './session-actions';
import { attachMoneyApprovalScheduler } from './pos-host';

const baseline = seedToday.rollup;
const americano = seedCatalog.menu.find(menu => menu.menuId === 'm-americano')!;
const iceRegular = americano.groups.flatMap(group => group.options.filter(option => ['ICE', '레귤러'].includes(option.name)).map(option => option.optionId));
const newOrderNo = seedToday.pos.orders.at(-1)!.orderNo + 1;

afterEach(async () => { cleanup(); await act(async () => { vi.advanceTimersByTime(500); }); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([false, true])('prepaid root flow: failure=%s, retry, one approval and shared closing', async failure => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.skipWidgetCoaches();
  expect(run.actions.switchLayer('orders-payment')).toBe(true);
  if (failure) run.actions.setPosPreview('payment-failure');
  const sessions = vi.spyOn(sessionActionsModule, 'createSessionActions');
  const view = render(<App run={run} manageLifecycle={false}/>);
  const money = sessions.mock.results.at(-1)!.value.money;
  // Drive presentation timers until the actual state is ready. CPU contention in
  // the parallel suite must not change the business/interaction assertions.
  const settle = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    check();
  }, { timeout: 5000, interval: 50 });
  await settle(() => expect(screen.getByRole('button', { name: /^아메리카노, / })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^아메리카노, / }));
  await settle(() => expect(screen.getByRole('dialog', { name: '아메리카노 옵션' })).toBeInTheDocument());
  const options = screen.getByRole('dialog', { name: '아메리카노 옵션' });
  fireEvent.click(within(options).getByRole('radio', { name: /ICE/ }));
  fireEvent.click(within(options).getByRole('radio', { name: /레귤러/ }));
  fireEvent.click(within(options).getByRole('button', { name: '담기' }));
  await settle(() => expect(screen.queryByRole('dialog', { name: '아메리카노 옵션' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '아메리카노 하나 더' }));
  expect(run.getState().pos.cart.lines[0].qty).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: '주문 비우기' }));
  expect(run.getState().pos.cart.lines).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(run.getState().pos.cart.lines[0].qty).toBe(2);
  fireEvent.click(screen.getByRole('tab', { name: /주문 현황/ }));
  expect(screen.getByRole('grid')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: `전체 ${baseline.orders}` }));
  expect(within(screen.getByRole('grid')).getAllByRole('row')).toHaveLength(baseline.orders + 1);
  fireEvent.click(screen.getByRole('tab', { name: '주문' }));
  expect(run.getState().pos.cart.lines[0].qty).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: '결제하기' }));
  const payment = screen.getByRole('dialog', { name: '결제' });
  const card = within(payment).getByRole('button', { name: '카드' });
  fireEvent.click(card); fireEvent.click(card);
  expect(money.approval()?.status).toBe('pending');
  fireEvent.click(within(payment).getByRole('button', { name: '현금' }));
  fireEvent.keyDown(payment, { key: 'Escape', code: 'Escape' });
  fireEvent.keyUp(payment, { key: 'Escape', code: 'Escape' });
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount);
  await settle(() => expect(money.approval()?.status).toBe(failure ? 'failed' : 'succeeded'));
  if (failure) {
    expect(money.approval()?.status).toBe('failed');
    expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount);
    expect(run.getState().pos.cart.lines[0].qty).toBe(2);
    act(() => run.actions.setPosPreview('normal'));
    fireEvent.click(within(payment).getByRole('button', { name: '다시 시도' }));
    expect(money.approval()?.status).toBe('pending');
    await settle(() => expect(money.approval()?.status).toBe('succeeded'));
  }
  expect(run.getState().pos.orders.at(-1)).toMatchObject({ orderNo: newOrderNo, preparation: 'accepted', orderedAt: POS_NOW });
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount + 1);
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ revenue: baseline.net + americano.price * 2, byMethod: { card: baseline.byMethod.card + americano.price * 2 }, methodCounts: { card: baseline.methodCounts.card + 1 } });
  expect(run.getState().pos.cart.lines).toHaveLength(0);
  await settle(() => expect(screen.queryByRole('dialog', { name: '결제' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('tab', { name: /주문 현황/ }));
  expect(run.getState().posUi.tab).toBe('status');
  const grid = screen.getByRole('grid');
  fireEvent.click(within(grid).getByRole('gridcell', { name: new RegExp(`${newOrderNo}번.*주문 번호`) }));
  expect(screen.getByRole('region', { name: new RegExp(`#${newOrderNo}.*접수`) })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '마감 정산 열기' }));
  const closing = screen.getByRole('dialog', { name: '오늘 마감 정산' });
  fireEvent.click(within(closing).getByRole('button', { name: '마감 정산하기' }));
  fireEvent.click(within(closing).getByRole('button', { name: '닫기' }));
  await settle(() => expect(screen.queryByRole('dialog', { name: '오늘 마감 정산' })).not.toBeInTheDocument());
  expect(document.querySelector('[data-pos-closed]')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '마감 되돌리기' }));
  expect(document.querySelector('[data-pos-closed]')).toBeNull();
  expect(selectPosDayTotals(run.getState().pos).paymentCount).toBe(baseline.paymentCount + 1);
  view.unmount(); run.dispose();
}, 90_000); // The root flow mounts both full cafe grids under parallel load.

it('scheduler ignores repeated, retired and disposed callbacks without a second payment', () => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light' });
  beginDashboard(run, 'cafe');
  const store = createWidgetDataStore({ shopSettings: { ...run.getState().shopSettings, layoutActivated: false } }, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const session = createSessionActions(run, store), runtime = session.pos;
  const callbacks: (() => void)[] = [];
  const stop = attachMoneyApprovalScheduler(session.money, { schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel: () => undefined });
  const add = (key: string) => runtime.execute({ type: 'cart.add', menuId: 'm-americano', optionIds: iceRegular, qty: 2, meta: { runId: run.getState().runId, idempotencyKey: key } });
  const begin = (key: string) => { const read = runtime.read(), quote = quoteCart(read); return runtime.beginApproval({ meta: { runId: read.runId, idempotencyKey: key }, cartId: quote.cartId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: quote.payable }] }); };
  expect(add('first').ok).toBe(true);
  const pending = begin('first');
  expect(pending, pending.ok ? 'accepted' : pending.reason).toMatchObject({ ok: true, status: 'pending' }); callbacks[0](); callbacks[0]();
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount + 1);
  runtime.dismissApproval(); add('second'); begin('second');
  callbacks[0]();
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount + 1);
  stop(); callbacks[1]();
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount + 1);
  const stopNext = attachMoneyApprovalScheduler(session.money, { schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel: () => undefined });
  run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' });
  callbacks[2]();
  expect(run.getState().pos.payments).toHaveLength(baseline.paymentCount);
  stopNext(); runtime.dispose(); run.dispose();
});
