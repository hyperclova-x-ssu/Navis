import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore, selectWidget, TODAY } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { UiProvider, timePolicy } from '../../ui';
import { BriefingOverlay } from './index';

afterEach(cleanup);

function setup(locale: Locale = 'ko', withShortage = false) {
  let now = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  act(() => { beginDashboard(run,'cafe'); run.actions.visualSettled(); }); advance(400);
  act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); advance(200);
  for (let i = 0; i < 12 && (run.getState().guidance.active || run.getState().guidance.activeWidget || run.getState().guidance.queue.length || run.getState().guidance.widgetQueue.length); i += 1) { act(() => run.actions.dismissCoach()); advance(300); }
  act(() => { run.actions.clearNotice(); run.actions.finishEditing(); });
  advance(1300);
  const store = createWidgetDataStore();
  if (withShortage) expect(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', stock: 0 }).ok).toBe(true);
  render(<I18nProvider locale={locale}><WidgetDataProvider store={store}><UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion><BriefingOverlay run={run} /></UiProvider></WidgetDataProvider></I18nProvider>);
  return { run, store };
}

describe('arrival briefing card v4 (SCR-17, AC-240)', () => {
  it('shows the cafe schedule, reservations and active alert groups without weather', async () => {
    const { run, store } = setup();
    expect(run.getState().overlay.type).toBe('briefing');
    const dialog = await screen.findByRole('dialog', { name: '오늘 가게 소식이에요' });
    const view = selectWidget(store.getSnapshot(), 'briefing', { kind: 'default' }, 'normal');
    if (view.status !== 'ready') throw new Error('briefing model not ready');
    expect(view.model.importantAlerts.count).toBe(2);
    const items=within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(dialog).getByText('오늘 일정 3개')).toBeInTheDocument();
    expect(within(dialog).getByText('오늘 4건 · 10명')).toBeInTheDocument();
    expect(within(dialog).getByText('변경 및 취소 1건')).toBeInTheDocument();
    expect(items.map(item=>item.querySelector('h4')?.textContent)).toEqual(['세금 납부','주요 업무']);
    expect(dialog.textContent).not.toMatch(/동네 소식|답하지 않은 문의|내일 예상 손님/);
    expect(dialog.textContent).not.toMatch(/날씨|weather/i);

    const milk = store.getSnapshot().tables.purchaseItem.find(item => item.itemId === 'i-milk')!;
    act(() => {
      expect(store.dispatch({ type: 'inventory.updateItem', itemId: milk.itemId, stock: 0 })).toMatchObject({ ok: true });
      expect(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: milk.purchaseItemId, qty: milk.minimumQty, dueDate: TODAY, idempotencyKey: 'briefing-order' })).toMatchObject({ ok: true });
    });
    expect(within(dialog).getByText('중요 알림 4개')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem').map(item => item.querySelector('h4')?.textContent)).toEqual(['발주·입고', '재고 부족', '세금 납부', '주요 업무']);
  });
  it('opens the source widget detail when an item is pressed: the card closes, the layer stays', async () => {
    const { run } = setup('ko', true);
    const dialog = await screen.findByRole('dialog', { name: '오늘 가게 소식이에요' });
    const layer = run.getState().layer;
    fireEvent.click(within(dialog).getByRole('button', { name: /^보충 필요 1개 품목/ }));
    const overlay = run.getState().overlay;
    expect(overlay).toMatchObject({ type: 'detail', featureId: 'inventory-booking' });
    expect(run.getState().layer).toBe(layer);
    expect(run.getState().briefing).toBe('dismissed');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '오늘 가게 소식이에요' })).toBeNull());
  });
  it.each([
    ['en', "Here's today's shop news", '오늘 일정 3개', '1 item to restock', '중요 알림 3개'],
    ['zh-Hans', '今天的店铺消息', '오늘 일정 3개', '需要补货 1 种商品', '중요 알림 3개'],
  ] as const)('reads in %s', async (locale, title, first, second, third) => {
    setup(locale, true);
    const dialog = await screen.findByRole('dialog', { name: title });
    const items = within(dialog).getAllByRole('listitem');
    expect(within(dialog).getByText(first)).toBeInTheDocument();expect(items[0]).toHaveTextContent(second);expect(within(dialog).getByText(third)).toBeInTheDocument();
    // The card fades in (opacity 0 → 1, also with reduced motion): wait for the first frame instead of racing it.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: locale === 'en' ? 'Close' : '关闭' })).toBeVisible());
  });
});
