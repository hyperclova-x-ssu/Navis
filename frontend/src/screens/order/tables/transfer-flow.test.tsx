import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { createTableLayout } from '../../../layout/table-layout';
import { createRunStore } from '../../../state';
import { createWidgetDataStore } from '../../../data/widget-data';
import { createSessionActions, sessionGateFor } from '../../../app/session-actions';
import { App } from '../../../app/App';
import { quoteBill, selectTableMap } from '../../../pos/tables';
import { timePolicy } from '../../../ui';

afterEach(async () => { cleanup(); await act(async () => { vi.advanceTimersByTime(500); }); vi.useRealTimers(); });

// Removing a transfer control, the bill-allocation projection, or the pos undo wiring breaks this flow.
it('root table flow moves and undoes, merges, separates a selected quantity, then calculates that table allocation', async () => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' }); run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' }); run.actions.saveOnboardingTables(createTableLayout());
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data);
  expect(actions.completeOnboarding(null).ok).toBe(true); run.actions.skipWidgetCoaches();
  let seq = 0;
  const meta = () => ({ runId: run.getState().runId, idempotencyKey: `flow:${++seq}` });
  for (const [tableId, menuId, qty] of [['T2', 'm-americano', 1], ['T3', 'm-cafe-latte', 2]] as const) {
    const menu = actions.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'HOT')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    expect(actions.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: meta() }).ok).toBe(true);
    expect(actions.pos.execute({ type: 'bill.submitOrder', cartId: actions.pos.read().pos.cart.cartId, tableId, meta: meta() }).ok).toBe(true);
  }
  run.actions.switchLayer('orders-payment');
  render(<App run={run} manageLifecycle={false}/>);
  const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); check(); }, { timeout: 3800, interval: 50 });
  const pick = (n: number) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^T${n}, `) }));
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  await settle(() => expect(screen.getByRole('tab', { name: '테이블' })).toHaveAttribute('aria-selected', 'true'));
  pick(2); press('옮기기');
  await settle(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  pick(1);
  expect(selectTableMap(actions.pos.read()).tables.find(t => t.tableId === 'T1')?.total).toBe(3000);
  press('되돌리기');
  expect(selectTableMap(actions.pos.read()).tables.find(t => t.tableId === 'T2')?.total).toBe(3000);
  pick(2); press('합석');
  await settle(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  pick(3);
  expect(quoteBill(actions.pos.read(), 'B-155').payable).toBe(10600);
  pick(3); press('분리');
  await settle(() => expect(screen.getByRole('dialog', { name: '계산서 분리' })).toBeInTheDocument());
  const split = screen.getByRole('dialog', { name: '계산서 분리' });
  fireEvent.click(within(split).getByRole('checkbox', { name: /카페라떼/ }));
  fireEvent.click(within(split).getByRole('button', { name: '다음' }));
  await settle(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  pick(1);
  expect(selectTableMap(actions.pos.read()).tables.find(t => t.tableId === 'T3')?.total).toBe(6800);
  expect(selectTableMap(actions.pos.read()).tables.find(t => t.tableId === 'T1')?.total).toBe(3800);
  expect(run.getState().pos.orders).toHaveLength(155);
  pick(1);
  const detail = screen.getByRole('region', { name: 'T1 계산서' });
  expect(within(detail).queryByText(/아메리카노/)).not.toBeInTheDocument();
  press('계산하기');
  await settle(() => expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument());
  expect(within(screen.getByRole('dialog', { name: '결제' })).getByText((_,node) => node?.textContent === '3,800원', { selector: '.ui-pos-money--display' })).toBeInTheDocument();
  run.dispose();
}, 60000);
