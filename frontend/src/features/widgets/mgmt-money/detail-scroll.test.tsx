// PRD 12.6: receipt expectations follow real-method transactions separately from the day's orders.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { renderWithKit } from '../../../ui/test-utils';
import { LedgerDetail } from './ledger';
import { MarginDetail } from './margin';
import { TaxDetail } from './tax';
import { GrantsDetail } from './grants';
import { ledgerOf, man, paymentsOf } from './test-values';

let style: HTMLStyleElement;
beforeEach(() => {
  style = document.createElement('style');
  style.textContent = ['src/ui/mastermanage.css', 'src/features/widgets/mgmt-money/widget.css']
    .map(path => readFileSync(path, 'utf8')).join('\n');
  document.head.append(style);
});
afterEach(() => { cleanup(); style.remove(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

it.each([
  { id: 'ledger', Detail: LedgerDetail, view: 'sales', grid: 'ledger-payments', tab: undefined },
  { id: 'ledger', Detail: LedgerDetail, view: 'expenses', grid: 'ledger-expenses', tab: undefined },
  { id: 'margin', Detail: MarginDetail, view: undefined, grid: 'margin-items', tab: undefined },
  { id: 'tax', Detail: TaxDetail, view: undefined, grid: 'tax-payments', tab: '세금 납부 이력' },
  { id: 'grants', Detail: GrantsDetail, view: undefined, grid: 'grant-applications', tab: '지원 현황' },
] as const)('gives $grid a bounded flex path through its detail root', ({ id, Detail, view, grid, tab }) => {
  renderWithKit(<Detail featureId={id} condition={{ kind: 'default' }} detailRef={{ featureId: id, ...(view ? { view } : {}) }} host={host} />);
  if (tab) fireEvent.click(screen.getByRole('tab', { name: tab }));
  const root = document.querySelector<HTMLElement>(`[data-widget="${id}"]`)!;
  expect(getComputedStyle(root).height).toBe(id === 'ledger' || id === 'margin' ? 'auto' : '100%');
  expect(getComputedStyle(root).minHeight).toBe('0');
  expect(getComputedStyle(root).display).toBe('flex');
  expect(getComputedStyle(root).flexDirection).toBe('column');
  expect(getComputedStyle(root).overflowY).toBe(id === 'ledger' || id === 'margin' ? 'visible' : 'hidden');
  const dataGrid = document.getElementById(`${grid}-label`)!.closest('.ui-data-grid')!;
  if (id === 'tax' || id === 'grants') {
    const scroller = dataGrid.querySelector('.ui-data-grid__scroll')!;
    expect(getComputedStyle(scroller).overflow).toBe('auto');
    for (const node of [dataGrid.parentElement!, dataGrid, scroller]) {
      const css = getComputedStyle(node);
      expect(css.minHeight, node.className).toBe('0');
      // DS 12.1 (D-227): beside the tab bar the table card takes the height that is left, shrinks below it and scrolls inside.
      expect(css.flexGrow, node.className).toBe('1');
      expect(css.flexShrink, node.className).toBe('1');
      expect(css.flexBasis, node.className).toMatch(/^0(px|%)?$/);
    }
  }
});

it('lets the dialog scroll the ledger overview without a nested scrollbox', () => {
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'sales' }} host={host} />);
  const overview = document.querySelector<HTMLElement>('.mm-detail__overview');
  expect(overview).not.toBeNull();
  expect(getComputedStyle(overview!).overflowY).toBe('visible');
  expect(getComputedStyle(overview!).maxHeight).toBe('none');
  expect(overview!.querySelector('.ui-data-grid')).toBeNull();
  expect(document.querySelector('.mm-table')).toBeInTheDocument();
  expect(document.querySelectorAll('[data-grid-row]')).toHaveLength(paymentsOf().length);
});

it('lets the item margin card take its height from the table at 125% text size', () => {
  renderWithKit(
    <MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />,
    { textScale: 125 },
  );

  const card = screen.getByRole('region', { name: '품목별 마진' });
  const table = screen.getByRole('grid', { name: '품목 표' });
  const grid = table.closest('.ui-data-grid')!;
  expect(card).toContainElement(table);
  expect(grid.parentElement).toBe(card);

  const cardStyle = getComputedStyle(card);
  expect(cardStyle.height || 'auto').toBe('auto');
  expect(cardStyle.maxHeight || 'none').toBe('none');
  expect(cardStyle.flexShrink).toBe('0');

  const gridStyle = getComputedStyle(grid);
  expect(gridStyle.height).toBe('auto');
  expect(gridStyle.flexBasis).toBe('auto');
  expect(gridStyle.flexShrink).toBe('0');
  expect(getComputedStyle(table.parentElement!).flexBasis).toBe('auto');
});

it.each([{ textScale: 100 }, { textScale: 125 }] as const)('keeps the four ledger KPI cards in one stretched row at $textScale% text size', ({ textScale }) => {
  const openClosing = vi.fn(() => true);
  const { container } = renderWithKit(
    <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={{ ...host, openClosing }} />,
    { textScale },
  );

  const row = container.querySelector('[data-slot="ledger.kpis"]')!;
  const cards = Array.from(row.children);
  expect(cards.map((card) => card.getAttribute('data-slot'))).toEqual([
    'ledger.kpi.sales', 'ledger.kpi.expenses', 'ledger.kpi.remaining', 'ledger.kpi.missing',
  ]);
  const grid = getComputedStyle(row);
  expect(grid.display).toBe('grid');
  expect(grid.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
  expect(grid.alignItems).toBe('stretch');

  const sales = cards[0]!;
  const closing = screen.getByRole('button', { name: '마감 정산 열기' });
  const model = ledgerOf();
  const comparison = screen.getByText(new RegExp(`지난주 같은 요일 대비.*${Math.abs(model.comparison!.delta.value)}%`));
  expect(sales.children[0]).toHaveTextContent(new RegExp(`${man(model.sales.net).replace('.', '\\.')}\\s*만 원`));
  expect(sales.children[1]).toHaveTextContent('오늘 매출');
  expect(sales.children[2]).toBe(closing);
  expect(sales.children[3]).toBe(comparison);
  expect(closing).toHaveTextContent('아직 마감 정산 전이에요');
  expect(getComputedStyle(sales).gap).toBe('var(--space-2)');
  fireEvent.click(closing);
  expect(openClosing).toHaveBeenCalledWith('ledger.closing.status');
});
