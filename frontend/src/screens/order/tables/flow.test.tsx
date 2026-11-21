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
import * as sessionActionsModule from '../../../app/session-actions';
import { App } from '../../../app/App';
import { selectPosDayTotals } from '../../../pos/domain';
import { timePolicy } from '../../../ui';
import { POS_BUSINESS_DATE, POS_NOW } from '../../../pos/clock';
import * as widgetData from '../../../data/widget-data';
import { seedToday } from '../../../data/db/generated/today';

afterEach(async () => { cleanup(); await act(async () => { vi.advanceTimersByTime(500); }); vi.restoreAllMocks(); vi.useRealTimers(); });

// Removing bill checkout/table selection must break this complete public UI flow.
it('postpaid root: T2 order, additional order, request, full card settlement, clean and reservation attendance', async () => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  run.actions.saveOnboardingTables(createTableLayout());
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  expect(createSessionActions(run, data).completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  run.actions.switchLayer('orders-payment');
  const stores = vi.spyOn(widgetData, 'createWidgetDataStore');
  const sessions = vi.spyOn(sessionActionsModule, 'createSessionActions');
  render(<App run={run} manageLifecycle={false}/>);
  const appActions = sessions.mock.results.at(-1)!.value;
  const money = appActions.money;
  const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); check(); }, { timeout: 5000, interval: 50 });
  const add = async (name: string, temperature?: string) => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}, `) }));
    const dialog = screen.queryByRole('dialog', { name: `${name} 옵션` });
    if (dialog) {
      if (temperature) fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(`^${temperature}`) }));
      if (name === '아메리카노') fireEvent.click(within(dialog).getByRole('radio', { name: /^레귤러/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: '담기' }));
      await settle(() => expect(screen.queryByRole('dialog', { name: `${name} 옵션` })).not.toBeInTheDocument());
    }
  };
  await settle(() => expect(screen.getByRole('tab', { name: '테이블' })).toHaveAttribute('aria-selected', 'true'));
  fireEvent.click(screen.getByRole('button', { name: /^T2, / }));
  await add('아메리카노', 'HOT'); await add('카페라떼', 'ICE');
  fireEvent.click(screen.getByRole('button', { name: '주문 넣기' }));
  expect(run.getState().pos.orders.at(-1)?.orderNo).toBe(154);
  expect(selectPosDayTotals(run.getState().pos).revenue).toBe(seedToday.rollup.net);
  fireEvent.click(screen.getByRole('button', { name: /^T2, / }));
  fireEvent.click(screen.getByRole('button', { name: '주문 추가' }));
  await add('바스크 치즈케이크');
  fireEvent.click(screen.getByRole('button', { name: '주문 넣기' }));
  fireEvent.click(screen.getByRole('button', { name: /^T2, / }));
  fireEvent.click(screen.getByRole('button', { name: '계산 요청' }));
  expect(run.getState().pos.bills.find(b => b.billId === 'B-154')?.requestedAt).toBe(POS_NOW);
  fireEvent.click(screen.getByRole('button', { name: '마감 정산 열기' }));
  const closing = screen.getByRole('dialog', { name: '오늘 마감 정산' });
  expect(within(closing).getByRole('button', { name: '마감 정산하기' })).toBeDisabled();
  fireEvent.click(within(closing).getByRole('button', { name: '주문/결제에서 보기' }));
  await settle(() => expect(screen.queryByRole('dialog', { name: '오늘 마감 정산' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /^T2, / }));
  fireEvent.click(screen.getByRole('button', { name: '계산하기' }));
  const payment = screen.getByRole('dialog', { name: '결제' });
  const card = within(payment).getByRole('button', { name: '카드' });
  fireEvent.click(card); fireEvent.click(card);
  expect(money.approval()?.status).toBe('pending');
  await settle(() => expect(money.approval()?.status).toBe('succeeded'));
  expect(selectPosDayTotals(run.getState().pos)).toMatchObject({ revenue: 843220, paymentCount: 154, byMethod: { card: 569050 } });
  await settle(() => expect(screen.queryByRole('dialog', { name: '결제' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '정리 완료' }));
  expect(run.getState().pos.tableSessions.find(s => s.tableId === 'T2')?.cleaning).toBe(false);
  const appData = stores.mock.results.at(-1)!.value as typeof data;
  act(() => {
    expect(appData.dispatch({ type: 'booking.create', date: POS_BUSINESS_DATE, time: '16:00',
      guest: { name: '테스트 방문 손님' }, partySize: 2, tableChoice: { tableId: 'T4' }, idempotencyKey: 'table-visit' }).ok).toBe(true);
  });
  fireEvent.click(screen.getByRole('button', { name: /^T4, / }));
  await add('바스크 치즈케이크');
  fireEvent.click(screen.getByRole('button', { name: '주문 넣기' }));
  fireEvent.click(screen.getByRole('button', { name: '방문 완료로 바꾸기' }));
  expect(run.getState().pos.reservationPrompts.at(-1)?.decision).toBe('accepted');
  expect(screen.queryByRole('button', { name: '방문 완료로 바꾸기' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '설정' }));
  const settings = screen.getByRole('dialog', { name: '설정' });
  fireEvent.click(within(settings).getByRole('button', { name: /주문\/결제 화면/ }));
  await settle(() => expect(within(settings).getByRole('switch', { name: '테이블' })).toBeDisabled());
  fireEvent.click(within(settings).getByRole('radio', { name: '주문 현황' }));
  expect(run.getState().shopSettings.posPreferences?.startTab).toBe('status');
  fireEvent.click(within(settings).getByRole('switch', { name: '주문 현황' }));
  expect(run.getState().shopSettings.posPreferences).toMatchObject({ startTab: 'order', showStatus: false, showTables: true });
  run.dispose();
}, 60000);
