import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CellSpan, WidgetHost } from '../../../contracts';
import { renderWithKit } from '../../../ui/test-utils';
import { screenPresets } from '../../../layout/presets';
import { LedgerDetail, LedgerPanel, LEDGER_FIT } from './ledger';
import { TaxPanel } from './tax';
import { MarginPanel } from './margin';
import { BriefingPanel } from './briefing';
import { GrantsPanel } from './grants';
import { MiniSeries, MONEY_FIT } from './shared';
import { runFit } from './fit';
import { STORE_FIT } from '../mgmt-store/shared';
import { createWidgetDataStore, supportedConditions } from '../../../data/widget-data';
import { marginOf, openReceipt } from './test-values';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

it.each(['sales', 'expenses', 'profit', 'candidates'] as const)('opens the requested ledger view: %s', view => {
  const store = createWidgetDataStore();
  expect(store.dispatch({ type: 'suppliers.recordReceipt', ...openReceipt(store), idempotencyKey: '후보 열기' }).ok).toBe(true);
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view }} host={host} />, { store });
  expect(screen.getByRole('tab', { name: view === 'sales' ? '매출' : view === 'profit' ? '순이익' : '지출' })).toHaveAttribute('aria-selected', 'true');
  if (view === 'candidates') expect(screen.getByRole('heading', { name: '확인할 지출 후보' })).toBeInTheDocument();
});

it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('uses the specified ledger detail headings in %s', locale => {
  const store = createWidgetDataStore();
  expect(store.dispatch({ type: 'suppliers.recordReceipt', ...openReceipt(store), idempotencyKey: '문구 확인' }).ok).toBe(true);
  // A single day charts its categories (the bars are the 지출 항목 list); a period charts its days and lists the categories next to them.
  const { unmount } = renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'candidates' }} host={host} />, { store, locale });
  for (const text of ['지출 항목별', '확인할 지출 후보']) {
    const heading = screen.getByRole('heading', { name: text });
    expect(heading.closest('[lang]')).toHaveAttribute('lang', 'ko');
  }
  expect(screen.getByText(locale === 'ko' ? '오늘 매출' : '총매출')).toHaveAttribute('lang', 'ko');
  expect(screen.getByText('총지출')).toHaveAttribute('lang', 'ko');
  unmount();
  const week = renderWithKit(<LedgerDetail featureId="ledger" condition={supportedConditions('ledger')[1]!} detailRef={{ featureId: 'ledger', view: 'expenses' }} host={host} />, { store, locale });
  for (const text of ['기간별 지출', '지출 항목', '확인할 지출 후보']) {
    const heading = screen.getByRole('heading', { name: text });
    expect(heading.closest('[lang]')).toHaveAttribute('lang', 'ko');
  }
  week.unmount();

  const sales = renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'sales' }} host={host} />, { store, locale });
  expect(screen.getByText('결제 수단별 매출')).toHaveAttribute('lang', 'ko');
  expect(screen.getByRole('grid', { name: '매출 내역' })).toBeInTheDocument();
  sales.unmount();

  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'profit' }} host={host} />, { store, locale });
  expect(screen.getByText('총 순이익')).toHaveAttribute('lang', 'ko');
  expect(screen.getByRole('heading', { name: '매출·지출 비교' }).closest('[lang]')).toHaveAttribute('lang', 'ko');
});

it.each([TaxPanel, MarginPanel])('uses the kit state layout instead of a key-value sentence in every shape', Panel => {
  const id = Panel === TaxPanel ? 'tax' : 'margin';
  for (let w = 1; w <= 4; w++) for (let h = 1; h <= 4; h++) {
    const shape = h === 1 ? w === 1 ? 'Q' : 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L';
    const { container, unmount } = renderWithKit(<Panel featureId={id} condition={{ kind: 'default' }} width={w as CellSpan} height={h as CellSpan} shape={shape} presetId="A" editing={false} host={host} />, { preview: { family: 'normal', overrides: { [id]: id === 'tax' ? 'missing-data' : 'missing-cost' } } });
    expect(container.querySelector('.ui-panel-state__message')).toHaveTextContent(id === 'tax' ? '자료 기간을 선택해 주세요' : '원가 확인 필요');
    expect(container.querySelector('.ui-panel-state__icon')).not.toBeNull();
    expect(container.querySelector('.mm-label,.mm-text-value,.mm-value')).toBeNull();
    if (id === 'tax') expect(container.querySelector('.ui-panel-state .ui-status-chip[data-compact]')).toHaveTextContent('추가 확인 필요');
    unmount();
  }
}, 60_000);

it('renders all-checked tax as an informational state without a label or metric', () => {
  const { container } = renderWithKit(<TaxPanel featureId="tax" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} />, { preview: { family: 'normal', overrides: { tax: 'all-checked' } } });
  expect(container.querySelector('.ui-panel-state__message')).toHaveTextContent('확인할 세무 자료가 없어요');
  expect(container.querySelector('.mm-label,.mm-text-value,.mm-value')).toBeNull();
});

it.each(['A', 'B'] as const)('uses the height budget for margin rows in preset %s, at both scales', preset => {
  for (const scale of [100, 125] as const) for (const height of [2, 3, 4] as const) {
    // The height budget (SCREENS 3.1), capped by the items there are to list.
    const budget = { A: { 100: [3, 5, 7], 125: [2, 4, 5] }, B: { 100: [3, 6, 8], 125: [3, 5, 6] } }[preset][scale][height - 2]!;
    const expected = Math.min(budget, marginOf().menus.length);
    const { container, unmount } = renderWithKit(<MarginPanel featureId="margin" condition={{ kind: 'default' }} width={1} height={height} shape="T" presetId={preset} editing={false} host={host} />, { preset: screenPresets[preset], textScale: scale });
    expect(container.querySelectorAll('.mm-row')).toHaveLength(expected);
    expect(container.querySelector('.mm-rows')).toHaveAttribute('data-row-limit', String(budget));
    unmount();
  }
});

it.each([TaxPanel, GrantsPanel])('drops a one-row essential caption and label only as needed, then restores them', Panel => {
  const id = Panel === TaxPanel ? 'tax' : 'grants';
  const { container } = renderWithKit(<div className="ui-panel-content"><Panel featureId={id} condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} /></div>);
  const content = container.querySelector<HTMLElement>('.ui-panel-content')!;
  const sub = content.querySelector('.mm-sub--essential')!, label = content.querySelector('.mm-label')!;
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 80 });
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => 80 + [sub, label].filter(node => !node.hasAttribute('data-fit-hidden')).length * 30 });
  expect(runFit(content, MONEY_FIT)).toBe(2);
  expect(content.querySelector('.mm-value')).not.toHaveAttribute('data-fit-hidden');
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 80 });
  expect(runFit(content, MONEY_FIT)).toBe(0);
});

it('keeps briefing dots with the preceding item and marks Korean fallback on an English screen', () => {
  const { container } = renderWithKit(<BriefingPanel featureId="briefing" condition={{ kind: 'default' }} width={1} height={3} shape="T" presetId="B" editing={false} host={host} />, { locale: 'en' });
  for (const line of container.querySelectorAll('.mm-row__sub')) {
    expect(line.textContent).not.toMatch(/ · /u);
    if (/[가-힣]/u.test(line.textContent ?? '')) expect(line.closest('[lang]')).toHaveAttribute('lang', 'ko');
  }
});

it('does not shrink sentences through the old one-row metric CSS', () => {
  const css = readFileSync('src/features/widgets/mgmt-money/widget.css', 'utf8');
  expect(css).not.toMatch(/\[data-height="1"\][^{]*\.mm-text-value/u);
});

it('keeps every state message at its natural height', () => {
  const { container } = renderWithKit(<TaxPanel featureId="tax" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing host={host} />, { preview: { family: 'normal', overrides: { tax: 'missing-data' } } });
  const style = document.createElement('style');
  style.textContent = readFileSync('src/features/widgets/mgmt-money/widget.css', 'utf8');
  document.head.append(style);
  try {
    const message = container.querySelector('.ui-panel-state__message')!;
    for (let el: Element | null = message; el && container.contains(el); el = el.parentElement) {
      const css = getComputedStyle(el);
      expect(css.webkitLineClamp).not.toMatch(/^[1-9]/u);
      expect(css.overflow).not.toBe('hidden');
      expect(css.maxHeight).toMatch(/^(none)?$/u);
    }
    expect(getComputedStyle(container.querySelector('.mm-primary')!).flexShrink).toBe('0');
  } finally { style.remove(); }
});

it('drops the manual secondary text first and its label last, then restores them', () => {
  document.body.innerHTML = '<div class="ui-panel-content"><p class="mgmt-label">인수인계</p><p class="mgmt-sub">매장정보 3개</p></div>';
  const content = document.querySelector<HTMLElement>('.ui-panel-content')!;
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 80 });
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => content.querySelectorAll('[data-fit-hidden]').length === 2 ? 80 : 110 });
  expect(STORE_FIT[0]?.selector).toBe('.mgmt-sub');
  expect(STORE_FIT.at(-1)?.selector).toBe('.mgmt-label');
  expect(runFit(content, STORE_FIT)).toBe(2);
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 80 });
  expect(runFit(content, STORE_FIT)).toBe(0);
});

it('drops the ledger closing slot only after the label and restores it with space', () => {
  const { container } = renderWithKit(<LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing host={host} />);
  const closing = container.querySelector('[data-slot-id="ledger.dashboard.closing"]')!;
  const content = document.createElement('div'); content.className = 'ui-panel-content';
  container.before(content); content.append(container);
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 80 });
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => closing.hasAttribute('data-fit-hidden') ? 80 : 110 });
  expect(LEDGER_FIT.at(-1)?.selector).toContain('ledger.dashboard.closing');
  runFit(content, LEDGER_FIT);
  expect(closing).toHaveAttribute('data-fit-hidden');
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 80 });
  expect(runFit(content, LEDGER_FIT)).toBe(0);
  content.remove();
});

it('shows all chart labels only when each fits one line and restores them after growing', async () => {
  const { fitAxisLabels } = await import('./shared');
  const { container } = renderWithKit(<MiniSeries data={{ values: [1, 2, 3], labels: ['Nov 8, 2026', 'Nov 9, 2026', 'Nov 10, 2026'], kind: 'bar', format: String, ariaLabel: '매출', allLabels: true }} />);
  const axis = container.querySelector<HTMLElement>('.mm-chart__axis')!;
  let available = 50;
  Object.defineProperty(axis, 'clientWidth', { configurable: true, get: () => available * 3 });
  for (const span of axis.children) {
    Object.defineProperty(span, 'clientWidth', { configurable: true, get: () => available });
    Object.defineProperty(span, 'scrollWidth', { configurable: true, value: 90 });
  }
  fitAxisLabels(axis, true);
  expect(axis.children[1]).toHaveAttribute('data-visible', 'false');
  expect(axis.children[0]).toHaveAttribute('data-visible', 'true');
  expect(axis.children[2]).toHaveAttribute('data-visible', 'true');
  available = 100;
  fitAxisLabels(axis, true);
  expect(axis.children[1]).toHaveAttribute('data-visible', 'true');
});
