import '@testing-library/jest-dom/vitest';
import '../ui/test-setup';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderWithKit } from '../ui/test-utils';
import { M2RunHost } from './pos-host';
import { createCustomOrderSeed } from '../data/iteration7/custom-orders';
import { TODAY, YESTERDAY } from '../data/db/time';
import { ClosingOverlay, CustomClosingSales } from './ClosingOverlay';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { createWidgetDataStore } from '../data/widget-data';
import { createSessionActions, SessionActionsProvider, sessionGateFor } from './session-actions';
import { PosProvider } from '../pos/react';
import { selectPosDrawer } from '../pos/closing';
import { timePolicy } from '../ui';

afterEach(cleanup);
it('adds a handover component to closing without counting an advance twice', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos });
  const { custom, ...actions } = createSessionActions(run, store);
  // CO-001 is already approved in the café seed: quote the order that is still waiting for its first quote.
  const customOrderId = createCustomOrderSeed().tables.customOrder.find(order => order.quoteRevision === 0)!.customOrderId;
  const quoteAmount = 45_600;
  expect(custom.dispatch({ type: 'customOrder.quote', customOrderId, quoteAmount, proposedPickupAt: `${TODAY}T17:00`, idempotencyKey: 'quote' })).toMatchObject({ ok: true, value: { quoteRevision: 1 } });
  expect(custom.dispatch({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'approve' })).toMatchObject({ ok: true });
  const quote = custom.quoteSettlement({ customOrderId, allocations: [{ kind: 'method', method: 'card', amount: quoteAmount }] });
  expect(custom.beginApproval({ quote, idempotencyKey: 'pay' })).toMatchObject({ ok: true });
  expect(custom.finishApproval({ runId: run.getState().runId, attemptId: custom.approval()!.attemptId, outcome: 'approved' })).toMatchObject({ ok: true });
  custom.dismissApproval();
  expect(custom.dispatch({ type: 'customOrder.setStage', customOrderId, nextStage: 'production_complete', idempotencyKey: 'produce' })).toMatchObject({ ok: true });
  renderWithKit(<SessionActionsProvider value={{ ...actions, custom }}><PosProvider value={actions.pos}><M2RunHost run={run}><CustomClosingSales date={TODAY} /></M2RunHost></PosProvider></SessionActionsProvider>, { store, reducedMotion: true });
  expect(screen.queryByRole('region', { name: '주문제작 수령 매출' })).not.toBeInTheDocument();
  act(() => { expect(custom.dispatch({ type: 'customOrder.receive', customOrderId, idempotencyKey: 'handover' })).toMatchObject({ ok: true }); });
  const region = screen.getByRole('region', { name: '주문제작 수령 매출' });
  expect(within(region).getByText(`${quoteAmount.toLocaleString('ko-KR')}원`)).toBeInTheDocument();
  expect(within(region).getByText('원가 미등록')).toBeInTheDocument();
  expect(custom.read().money.payments).toHaveLength(1);
  actions.pos.dispose(); run.dispose();
});

it('M3 closing keeps recognized sales, deposits and unknown-count drawer separate', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, store);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  actions.completeOnboarding(null);
  run.actions.skipWidgetCoaches();
  run.actions.openClosing('opener');
  const accounting = {
    status: 'ready' as const, period: { start: TODAY, end: TODAY },
    summary: {
      sales: { total: 1284000, byRealMethodSale: { card: 864336, easy_pay: 298000, cash: 74000 }, chargeUsed: 15000, receivableCreated: 10000, membershipCount: 8000, subscriptionDaily: 14664, membershipExpiry: 0, customPickup: 0, gross: 1315000, discount: 35664, refund: 10000, discountBySource: { membership: 15500, coupon: 2500, direct: 17664 } },
      deposits: { total: 1386336, byMethod: { card: 959336, easy_pay: 338000, cash: 89000 }, byPurpose: { sale: 1236336, charge_topup: 50000, receivable_collection: 15000, membership_sale: 40000, custom_order: 45000 }, grossReceived: 1396336, returned: 10000, pendingReceived: 0 },
      orderCount: 94, realPaymentCount: 90,
    },
    transactions: [], unknownCostSales: [],
    drawer: { ...selectPosDrawer(run.getState().pos), cashPayments: 89000, approvedCash: 89000, cashNet: 89000, expected: 189000, actual: null, difference: null },
  };
  renderWithKit(<PosProvider value={actions.pos}><ClosingOverlay run={run} onOpenReceipt={() => {}} {...{ accounting }} /></PosProvider>, { store, reducedMotion: true });
  const dialog = screen.getByRole('dialog', { name: '오늘 마감 정산' });
  const sales = within(dialog).getByRole('region', { name: '오늘 매출' });
  expect(sales.querySelector('p.app-closing-sales-notes')).toHaveTextContent('주문 금액');
  expect(sales.querySelector('dl.app-closing-sales-notes')).toHaveTextContent('0원');
  expect(within(dialog).queryByRole('columnheader', { name: '거래번호' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('columnheader', { name: '정산 유형' })).not.toBeInTheDocument();
  expect(within(within(dialog).getByRole('region', { name: '오늘 매출' })).getByText((_, node) => node?.textContent === '1,284,000원', { selector: '.ui-pos-money' })).toBeInTheDocument();
  expect(within(within(dialog).getByRole('region', { name: '실제 입금' })).getByText((_, node) => node?.textContent === '1,386,336원', { selector: '.ui-pos-money' })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('tab', { name: '현금 시재' }));
  expect(within(dialog).getByText((_, node) => node?.textContent === '189,000원', { selector: '.ui-pos-money' })).toBeInTheDocument();
  expect(within(dialog).getByRole('textbox', { name: '실제 현금' })).toHaveValue('');
  expect(dialog.querySelector('.ui-pos-diff')).toBeEmptyDOMElement();
  fireEvent.click(within(dialog).getByRole('tab', { name: '정산 이력' }));
  const pastCell = dialog.querySelector<HTMLElement>(`[data-grid-column-id="date"][data-grid-row-id="${YESTERDAY}"]`)!;
  fireEvent.click(pastCell);
  expect(within(dialog).getByText('이 날짜의 실제 입금 자료가 없어요')).toBeInTheDocument();
  actions.pos.dispose(); run.dispose();
});
