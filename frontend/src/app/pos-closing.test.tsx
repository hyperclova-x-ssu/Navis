import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { createWidgetDataStore, TODAY } from '../data/widget-data';
import { timePolicy } from '../ui';
import { createSessionActions, sessionGateFor } from './session-actions';
import { selectPosDrawer } from '../pos/closing';
import { seedToday } from '../data/db/generated/today';
import { seedCatalog } from '../data/db/generated/catalog';
import { quoteCart } from '../pos/domain';
import { quoteReversal } from '../pos/reversals';
import { useState } from 'react';
import { I18nProvider } from '../i18n';
import { WidgetDataProvider } from '../data/react';
import { PosProvider } from '../pos/react';
import { UiProvider } from '../ui';
import { ClosingOverlay } from './ClosingOverlay';
import { PosReceiptHost } from './pos-host';
import type { ReversalReceiptEntry } from '../screens/order/ReversalReceipt';

afterEach(cleanup);

// Breaking receipt routing, drawer commits, closing snapshots or undo breaks this one core flow.
it('opens the original and cancellation receipt from management, counts cash, closes and undoes today', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data);
  expect(actions.completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  const h = { run }, runId = run.getState().runId;
  const menu = seedCatalog.menu.find(row => row.menuId === 'm-americano')!;
  const optionIds = menu.groups.flatMap(group => group.options.filter(option => ['HOT', '레귤러'].includes(option.name)).map(option => option.optionId));
  // Cafe history is prepared. Create two accepted orders to exercise whole and partial cancellation.
  const sell = (qty: number) => {
    const pos = actions.pos;
    expect(pos.execute({ type: 'cart.add', menuId: menu.menuId, optionIds, qty, meta: { runId, idempotencyKey: `add:${qty}` } })).toMatchObject({ ok: true });
    const cart = quoteCart(pos.read());
    expect(pos.beginApproval({ cartId: cart.cartId, quoteRevision: cart.revision, splits: [{ method: 'cash', amount: menu.price * qty }], meta: { runId, idempotencyKey: `approve:${qty}` } })).toMatchObject({ ok: true });
    const attempt = run.getState().posUi.approval!;
    expect(pos.finishApproval({ runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome: 'approved' })).toMatchObject({ ok: true });
    pos.dismissApproval();
    return { payment: pos.read().pos.payments.at(-1)!, order: pos.read().pos.orders.at(-1)! };
  };
  const whole = sell(1), partial = sell(2);
  const cancel = (paymentId: string, lines?: readonly { orderLineId: string; qty: number }[]) => {
    const quote = quoteReversal(actions.pos.read(), { paymentId, kind: 'cancel', lines });
    expect(quote.canSubmit, JSON.stringify(quote.issues)).toBe(true);
    expect(actions.pos.execute({ type: 'payment.reverse', quoteToken: quote.quoteToken, confirmed: true, meta: { runId, idempotencyKey: `closing-core:${paymentId}` } })).toMatchObject({ ok: true });
  };
  cancel(whole.payment.paymentId);
  cancel(partial.payment.paymentId, [{ orderLineId: partial.order.lines[0].orderLineId, qty: 1 }]);
  run.actions.openClosing('opener');
  function Host() {
    const [entry,setEntry]=useState<ReversalReceiptEntry|null>(null);
    return <I18nProvider locale="ko"><WidgetDataProvider store={data}><PosProvider value={actions.pos}><UiProvider screenPreset={screenPresets.A} reducedMotion><ClosingOverlay run={run} onOpenReceipt={setEntry}/><PosReceiptHost entry={entry} onClose={()=>setEntry(null)}/></UiProvider></PosProvider></WidgetDataProvider></I18nProvider>;
  }
  render(<Host/>);
  const closing = await screen.findByRole('dialog', { name: '오늘 마감 정산' });
  const correction = h.run.getState().pos.cancellations.at(-1)!;
  for (const [rowId, transaction] of [[whole.payment.paymentId, whole.payment.transactionNo], [whole.payment.paymentId, whole.payment.transactionNo], [correction.cancellationId, partial.payment.transactionNo]]) {
    const cell = closing.querySelector<HTMLElement>(`[data-grid-row-id="${rowId}"][data-grid-column-id="time"]`)!;
    expect(cell).not.toBeNull();
    cell.focus(); fireEvent.keyDown(cell, { key: 'Enter' });
    const receipt = await screen.findByRole('dialog', { name: '영수증 보기' });
    expect(within(receipt).getByText(transaction)).toBeInTheDocument();
    expect(h.run.getState().layer).toBe('management');
    expect(document.querySelector('.order-screen')).toBeNull();
    fireEvent.click(receipt.querySelector('button[data-ui-close]')!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '영수증 보기' })).not.toBeInTheDocument());
    await waitFor(() => expect(cell).toHaveFocus());
    expect(h.run.getState().overlay.type).toBe('closing');
  }
  fireEvent.click(within(closing).getByRole('tab', { name: '현금 시재' }));
  const expected = seedToday.rollup.expectedDrawer + menu.price, actual = expected + 3_500;
  fireEvent.change(within(closing).getByRole('textbox', { name: '실제 현금' }), { target: { value: String(actual) } });
  expect(selectPosDrawer(h.run.getState().pos)).toMatchObject({ expected, actual, difference: 3500 });
  fireEvent.click(within(closing).getByRole('button', { name: '마감 정산하기' }));
  fireEvent.click(within(closing).getByRole('tab', { name: '정산 이력' }));
  expect(closing.querySelector(`[data-grid-row-id="${TODAY}"]`)).toBeInTheDocument();
  fireEvent.click(within(closing).getByRole('button', { name: '마감 되돌리기' }));
  expect(closing.querySelector(`[data-grid-row-id="${TODAY}"]`)).toBeNull();
  expect(selectPosDrawer(h.run.getState().pos)).toMatchObject({ expected, actual, difference: 3500 });
  actions.pos.dispose(); run.dispose();
}, 30000);
