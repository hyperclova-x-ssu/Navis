import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { MarginDetail } from './margin';
import { marginOf, menuLabel, won } from './test-values';
afterEach(cleanup);
/** One sold item with a registered cost, picked from the margin model (not named in the test). */
const pick = (store = createWidgetDataStore()) => { const row = marginOf(store).menus.find(menu => menu.unitCost !== null)!; return { store, row, name: menuLabel(store, row.menuId) }; };
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
it('shows current unit economics separately from sales-time results', () => {
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />, { textScale: 125, reducedMotion: true });
 const grid = screen.getByRole('grid', { name: '품목 표' });
 expect(within(grid).getAllByRole('row')).toHaveLength(marginOf().menus.length + 1);
 expect(within(grid).getByRole('columnheader', { name: '판매가' })).toBeInTheDocument();
 expect(screen.getByText('오늘 판매분은 판매할 때의 원가로 계산해요')).toBeInTheDocument();
 expect(screen.getByText('수익성 비교')).toBeInTheDocument();
});
it('simulates a price change without changing the current recipe cost', async () => {
 const { default: userEvent } = await import('@testing-library/user-event');
 const { store, row, name } = pick();
 const before = store.getSnapshot();
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />, { store });
 await userEvent.click(screen.getByRole('gridcell', { name: `${name}, 품목, ${name}` }));
 const cost = screen.getByRole('spinbutton', { name: /예상 단위 원가/ });
 await userEvent.clear(cost); await userEvent.type(cost, '2000');
 const result = document.querySelector<HTMLElement>('[data-slot="margin.sim-result"]')!;
 const profit = row.price - 2000;
 expect(within(result).getByText(won(profit))).toBeInTheDocument();
 expect(within(result).getByText(`${Number((profit / row.price * 100).toFixed(1))}%`)).toBeInTheDocument();
 expect(store.getSnapshot()).toBe(before);
});
it('opens the selected item breakdown directly below its grid row', async () => {
 const { default: userEvent } = await import('@testing-library/user-event');
 const { store, name } = pick();
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />, { store });
 await userEvent.click(screen.getByRole('gridcell', { name: `${name}, 품목, ${name}` }));
 const grid = screen.getByRole('grid', { name: '품목 표' });
 expect(within(grid).getByRole('region', { name })).toBeInTheDocument();
});
it('shows each item contribution and reconciles today sales and cost', () => {
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />);
 const chart = screen.getByRole('region', { name: '수익성 비교' });
 expect(within(chart).getAllByRole('meter')).toHaveLength(marginOf().menus.length);
 expect(within(chart).getByText(/오늘 매출.*원가.*마진/)).toBeInTheDocument();
});

it('uses the correct Korean ending for the highest profit item', () => {
 renderWithKit(<MarginDetail featureId="margin" condition={{kind:'default'}} detailRef={{featureId:'margin'}} host={host} />);
 expect(screen.getByText(/오늘 마진이 가장 큰 품목은 아메리카노예요/)).toBeInTheDocument();
});

it('an empty margin offers the next step: a wider period', async () => {
 const { default: userEvent } = await import('@testing-library/user-event');
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />, { preview: { family: 'normal', overrides: { margin: 'no-sales' } } });
 expect(screen.getByText('오늘 판매가 없어요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '최근 7일 보기' }));
 expect(screen.getByRole('radio', { name: '최근 7일' })).toHaveAttribute('aria-checked', 'true');
});

it('shows money in whole won in one unit per column and a chip for a missing cost', () => {
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />);
 const grid = screen.getByRole('grid', { name: '품목 표' });
 for (const columnId of ['price', 'unitCost', 'unitMargin']) {
  for (const cell of grid.querySelectorAll(`[data-grid-column-id="${columnId}"]`)) expect(cell.textContent, columnId).toMatch(/^[\d,]+원$/);
 }
 expect(within(grid).getAllByRole('columnheader').map(header => header.textContent?.replace(/\s*[▲▼]$/, ''))).toEqual(['품목', '판매가', '원가', '마진', '마진율', '판매량']);
});

it('shows a missing cost as a chip with its icon and words', () => {
 renderWithKit(<MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host} />, { preview: { family: 'normal', overrides: { margin: 'missing-cost' } } });
 const chips = [...document.querySelectorAll('.ui-status-chip,.ui-status-badge')].filter(chip => chip.textContent?.includes('원가'));
 expect(chips.length).toBeGreaterThan(0);
 for (const chip of chips) expect(chip.querySelector('svg')).not.toBeNull();
});
