import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createVisibleSlotRegistry, VisibleSlotProvider } from '../../../ui/visible-slots';
import { createWidgetDataStore, readModel, selectWidget, TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { LedgerDetail, LedgerPanel } from './ledger';
import { BriefingDetail, BriefingPanel } from './briefing';
import { MarginPanel } from './margin';
import { addIsoDays } from './shared';
import { briefingOf, closingOf, ledgerOf, marginOf, percent, won } from './test-values';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const detail = <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />;

it('shows the exact selected dates and daily profit, sales and expenses for multi-day periods', () => {
  const store = createWidgetDataStore();
  renderWithKit(detail, { store });
  fireEvent.click(screen.getByRole('tab', { name: '순이익' }));
  const monthStart = `${TODAY.slice(0, 7)}-01`;
  for (const [label, start, count] of [['최근 7일', addIsoDays(TODAY, -6), 7], ['최근 30일', addIsoDays(TODAY, -29), 30], ['이번 달', monthStart, Number(TODAY.slice(8, 10))]] as const) {
    fireEvent.click(screen.getByRole('radio', { name: label }));
    const view = selectWidget(store.getSnapshot(), 'ledger', { kind: 'dateRange', start, end: TODAY }, 'normal');
    if (view.status !== 'ready') throw new Error('손익을 읽지 못했어요');
    const profit = screen.getByRole('region', { name: '기간별 순이익' });
    const compare = screen.getByRole('region', { name: '매출·지출 비교' });
    expect(profit.querySelectorAll('[data-date]')).toHaveLength(count);
    expect(compare.querySelectorAll('[data-date]')).toHaveLength(count);
    for (const point of view.model.periodTrend) {
      expect(profit.querySelector(`[data-date="${point.date}"] [data-series="netProfit"]`)).toHaveAttribute('data-value', String(point.netProfit));
      expect(compare.querySelector(`[data-date="${point.date}"] [data-series="net"]`)).toHaveAttribute('data-value', String(point.net));
      expect(compare.querySelector(`[data-date="${point.date}"] [data-series="expenses"]`)).toHaveAttribute('data-value', String(point.expenses));
    }
  }
});

it('compares today’s expense categories and profit using the recorded amounts', () => {
  const store = createWidgetDataStore();
  const model = ledgerOf(store);
  renderWithKit(detail, { store });
  fireEvent.click(screen.getByRole('tab', { name: '지출' }));
  // One day: the bars are the categories, one per recorded category.
  const expenseChart = screen.getByRole('region', { name: '지출 항목별' });
  expect(within(expenseChart).getByRole('img', { name: /지출 항목별:/ })).toBeInTheDocument();
  const expenseBars = [...expenseChart.querySelectorAll<HTMLElement>('[data-series="expenses"]')];
  expect(expenseBars).toHaveLength(model.expenses.byCategory.length);
  expect(expenseBars.reduce((sum, bar) => sum + Number(bar.dataset.value), 0)).toBe(model.expenses.total);

  // Profit by hour: sales so far minus the day's expenses, so the last bar is the profit figure.
  fireEvent.click(screen.getByRole('tab', { name: '순이익' }));
  const profit = screen.getByRole('region', { name: '시간대별 누적 순이익' });
  expect(within(profit).getByRole('img', { name: /시간대별 누적 순이익: .*시/ })).toBeInTheDocument();
  const profitBars = [...profit.querySelectorAll<HTMLElement>('[data-series="netProfit"]')];
  expect(profitBars.length).toBeGreaterThan(1);
  expect(Number(profitBars.at(-1)!.dataset.value)).toBe(model.remaining);
  const compare = screen.getByRole('region', { name: '매출·지출 비교' });
  expect(compare.querySelector('[data-series="net"]')).toHaveAttribute('data-value', String(model.sales.net));
  expect(compare.querySelector('[data-series="expenses"]')).toHaveAttribute('data-value', String(model.expenses.total));
});

it('uses the selected period for sales and expense trends and updates the expense point immediately', () => {
  const store = createWidgetDataStore();
  renderWithKit(detail, { store });
  fireEvent.click(screen.getByRole('radio', { name: '최근 30일' }));
  expect(screen.getByRole('region', { name: '기간별 매출' }).querySelectorAll('[data-date]')).toHaveLength(30);
  fireEvent.click(screen.getByRole('tab', { name: '지출' }));
  expect(screen.getByRole('region', { name: '기간별 지출' }).querySelectorAll('[data-date]')).toHaveLength(30);
  const todayExpenses = ledgerOf(store).expenses.total;
  act(() => { store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 30000, evidence: 'receipt' }); });
  expect(screen.getByRole('region', { name: '기간별 지출' }).querySelector(`[data-date="${TODAY}"] [data-series="expenses"]`)).toHaveAttribute('data-value', String(todayExpenses + 30000));
});

it('shows the three sales-time margin amounts in the square panel (AC-1065)', () => {
  renderWithKit(<MarginPanel featureId="margin" condition={{ kind: 'default' }} width={2} height={2} shape="S" presetId="A" editing={false} host={host} />);
  const list = screen.getByRole('list');
  const margin = marginOf();
  for (const value of [won(margin.netSales), won(margin.cost!), won(margin.grossProfit!)]) expect(within(list).getByText(value)).toBeInTheDocument();
});

it.each([[2, 3], [3, 2], [4, 4]] as const)('restores the seven-day paired bars in an expanded %s×%s panel', (width, height) => {
  renderWithKit(<LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={width} height={height} shape="L" presetId="A" editing={false} host={host} />);
  expect(screen.getByRole('img', { name: /7일 매출·지출/ })).toBeInTheDocument();
  expect(document.querySelectorAll('[data-series="net"]')).toHaveLength(7);
  expect(document.querySelectorAll('[data-series="expenses"]')).toHaveLength(7);
  expect(screen.getByText('순이익률')).toBeInTheDocument();
  expect(screen.getByText(percent(ledgerOf().profitRate!))).toBeInTheDocument();
});

it('opens closing from the status beside sales and marks each payment method confirmed afterwards', () => {
  const store = createWidgetDataStore();
  renderWithKit(detail, { store });
  fireEvent.click(screen.getByRole('button', { name: '마감 정산 열기' }));
  expect(host.openClosing).toHaveBeenCalledWith('ledger.closing.status');
  expect(screen.getByRole('button', { name: '마감 정산 열기' })).toHaveAttribute('id', 'ledger.closing.status');
  act(() => { store.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: 0, idempotencyKey: '상태 버튼' }); });
  expect(screen.getByRole('button', { name: '마감 정산 열기' })).toHaveTextContent('오늘 마감됨');
  expect(within(document.querySelector('[data-slot="ledger.sales-table"]') as HTMLElement).getAllByText('확정')).toHaveLength(3);
});

it('registers raw meaning values with matching DOM slots for both scopes and has no independent flashes', () => {
  const store = createWidgetDataStore(), registry = createVisibleSlotRegistry();
  const model = ledgerOf(store), alerts = briefingOf(store).importantAlerts;
  renderWithKit(<VisibleSlotProvider registry={registry}>
    <LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={2} height={2} shape="S" presetId="A" editing={false} host={host} />
    {detail}
    <BriefingPanel featureId="briefing" condition={{ kind: 'default' }} width={2} height={2} shape="S" presetId="A" editing={false} host={host} />
  </VisibleSlotProvider>, { store });
  const before = registry.getSnapshot();
  expect(before.filter(slot => slot.featureId === 'ledger' && slot.scope === 'dashboard').map(slot => slot.semanticValue)).toContain(model.expenses.total);
  expect(before.filter(slot => slot.featureId === 'ledger' && slot.scope === 'detail').map(slot => slot.semanticValue)).toContain(model.remaining);
  // PRD §12.4 F-279 / API-272: the alert number is the number of alert items.
  expect(before.filter(slot => slot.featureId === 'briefing').map(slot => slot.semanticValue)).toContain(alerts.count);
  act(() => { store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 1, evidence: 'receipt' }); });
  const after = registry.getSnapshot();
  expect(after.filter(slot => slot.featureId === 'ledger').map(slot => slot.semanticValue)).toContain(model.expenses.total + 1);
  expect(after.filter(slot => slot.featureId === 'ledger').map(slot => slot.semanticValue)).toContain(model.remaining! - 1);
  for (const slot of after) expect(document.querySelectorAll(`[data-slot-id="${slot.slotId}"]`)).toHaveLength(1);
  expect(document.querySelector('[data-flash="true"], [data-highlighted]')).toBeNull();
});

it('registers closing briefing status, profit and method values and keeps arrival information on the closing tab', () => {
  const registry = createVisibleSlotRegistry();
  renderWithKit(<VisibleSlotProvider registry={registry}><BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={host} /></VisibleSlotProvider>);
  fireEvent.click(screen.getByRole('tab', { name: '퇴근' }));
  expect(screen.getByText('예약 브리핑')).toBeInTheDocument();
  expect(registry.getSnapshot().map(slot => slot.semanticValue)).toContain(closingOf().netProfit);
  expect(registry.getSnapshot().map(slot => slot.semanticValue)).toContain('open');
  const alerts = readModel(createWidgetDataStore().getSnapshot(), 'briefing').importantAlerts;
  expect(alerts.count).toBe(alerts.groups.reduce((sum, group) => sum + group.items.length, 0)); // F-279 / API-272: the number counts items.
});
