// FIX-PKG-A (gate r1a): ledger display fixes — T-25 transaction reference, T-27 reading names of the period chart.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { renderWithKit } from '../../../ui/test-utils';
import { AccountingTransactions, LedgerDetail, type AccountingTransaction } from './ledger';
import { MiniSeries } from './shared';

afterEach(cleanup);
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const UUID = '3f2a1c9b-7d4e-4b8a-9c1d-5e6f7a8b9c0d';
const ISO_DAY = /\d{4}-\d{2}-\d{2}/;
const row = (over: Partial<AccountingTransaction>): AccountingTransaction => ({
  id: 'deposit-1', at: '2026-11-22T11:47', purpose: 'sale', kind: 'receipt', amount: 4500, salesAmount: null,
  methods: [{ method: 'card', amount: 4500 }], settlementKinds: [], settlementId: 'settlement-1', ...over,
});

it('never shows the service-internal id inside a transaction reference (T-25)', () => {
  renderWithKit(<AccountingTransactions rows={[row({ transactionNo: `기록-${UUID}` }), row({ id: 'deposit-2', kind: 'refund', amount: -4500, transactionNo: `기록-${UUID}`, originalId: UUID })]} />);
  const grid = screen.getByRole('grid');
  expect(grid.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  expect(within(grid).queryByText(/기록-/)).not.toBeInTheDocument();
});

it('keeps a short owner-readable transaction number as it is (T-25)', () => {
  renderWithKit(<AccountingTransactions rows={[row({ transactionNo: '거래-20261122-0004' })]} />);
  expect(screen.getByRole('gridcell', { name: /거래-20261122-0004/ })).toBeInTheDocument();
});

it('reads the period chart by the same day labels the owner sees, not by ISO dates (T-27)', async () => {
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { reducedMotion: true });
  await userEvent.click(screen.getByRole('radio', { name: '최근 7일' }));
  const plots = [...document.querySelectorAll<HTMLElement>('[role="img"][aria-label]')];
  expect(plots.length).toBeGreaterThan(0);
  for (const plot of plots) expect(plot.getAttribute('aria-label')).not.toMatch(ISO_DAY);
  expect(plots.some(plot => /\d{1,2}\/\d{1,2}\([월화수목금토일]\)/.test(plot.getAttribute('aria-label')!))).toBe(true);
});

// T-50 (D-381): a bar's value label sits above the bar, so it must not be inside the filled element (a contrast check reads the label's own ancestors: light text on the bar's fill read 1.34:1 in dark).
it('keeps a bar value label out of the element that carries the bar fill (T-50)', () => {
  const { container } = renderWithKit(<MiniSeries data={{ kind: 'bar', labels: ['8시', '9시'], values: [58000, 156000], format: n => `${n / 10000}만 원`, ariaLabel: '시간대별 매출', valueLabels: true,
    series: [{ id: 'sales', label: '매출', values: [58000, 156000] }] }} />);
  const label = container.querySelector('.mm-chart__bar-value')!;
  expect(label).toHaveTextContent('5.8만 원');
  const box = label.closest('.mm-chart__paired-bar') as HTMLElement;
  expect(box.style.height).not.toBe('');
  expect(label.closest('.mm-chart__paired-fill')).toBeNull();
  expect(box.querySelector(':scope > .mm-chart__paired-fill')).not.toBeNull();
});
