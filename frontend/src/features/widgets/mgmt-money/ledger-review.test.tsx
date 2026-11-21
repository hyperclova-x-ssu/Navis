import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setup } from '../../../pos/loyalty/test-setup';
import { PosProvider } from '../../../pos/react';
import { renderWithKit } from '../../../ui/test-utils';
import { M2RunHost } from '../../../app/pos-host';
import { SessionActionsProvider } from '../../../app/session-actions';
import type { WidgetHost } from '../../../contracts';
import { supportedConditions, TODAY } from '../../../data/widget-data';
import { selectAccountingPresentation, selectMoneyRead } from '../../../data/pos/projection';
import { LedgerDetail } from './ledger';
import { depositCoverageNote } from './iteration7-accounting-messages';
import { ledgerOf, won } from './test-values';

afterEach(cleanup);

it('FIX-3 labels this-month ledger deposits with their actual available date instead of implying a full month', () => {
  const h = setup();
  const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  // The cafe history covers every day of the month, so the real view is complete. A month whose history stops early is the real month view
  // with its coverage narrowed to the days that exist (today only), which is what the label has to name.
  const monthStart = `${TODAY.slice(0, 7)}-01`;
  const real = selectAccountingPresentation(h.data.getSnapshot()).views.find(view => view.status === 'ready' && view.period.start === monthStart && view.period.end === TODAY)!;
  const partial = { ...real, depositCoverage: { start: TODAY, end: TODAY, complete: false } };
  const month = supportedConditions('ledger')[3]!;
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><M2RunHost run={h.run}>
    <LedgerDetail featureId="ledger" condition={month} detailRef={{ featureId: 'ledger' }} host={host} accounting={partial as never}/>
  </M2RunHost></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  const deposits = within(screen.getByRole('region', { name: '실제 입금' }));
  const total = (real as { summary: { deposits: { total: number } } }).summary.deposits.total;
  expect(deposits.getByText((_,node) => node?.textContent === won(total), {selector:'.ui-pos-money--display'})).toBeInTheDocument();
  expect(deposits.getByText(depositCoverageNote(TODAY, TODAY))).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: '오늘' }));
  expect(screen.queryByText(depositCoverageNote(TODAY, TODAY))).not.toBeInTheDocument();
}, 30_000);

it('groups today’s recognized sales into hourly bars without counting deposits as sales', () => {
  const h = setup();
  const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><M2RunHost run={h.run}>
    <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host}/>
  </M2RunHost></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });

  const chart = screen.getByRole('region', { name: '기간별 매출' });
  expect(within(chart).getByRole('img', { name: /기간별 매출: .*시/ })).toBeInTheDocument();
  const bars = [...chart.querySelectorAll<HTMLElement>('[data-series="net"]')];
  const hours = new Map<string, number>();
  for (const row of selectMoneyRead(h.data.getSnapshot()).state.recognitions) {
    if (row.businessDate !== TODAY) continue;
    const hour = String(Number(row.at.slice(11, 13)));
    hours.set(hour, (hours.get(hour) ?? 0) + row.amount);
  }
  expect(bars).toHaveLength(8);
  const dayTotal = ledgerOf(h.data).sales.net;
  expect(dayTotal).toBe(831_220);
  expect(bars.reduce((sum, bar) => sum + Number(bar.dataset.value), 0)).toBe(dayTotal);
  const labels = [...chart.querySelectorAll('figcaption > span')];
  expect(labels.map(label => label.textContent)).toEqual(['8시', '9시', '10시', '11시', '12시', '13시', '14시', '15시']);
  expect(labels.filter(label => hours.has(label.textContent!.replace('시', '')))).toHaveLength(hours.size);
  labels.forEach((label, index) => {
    expect(bars[index]).toHaveAttribute('data-value', String(hours.get(label.textContent!.replace('시', '')) ?? 0));
  });
});

it('keeps the elapsed opening and current hour when all sales occur in between', () => {
  const { data } = setup();
  const current = data.getSnapshot();
  const payment = current.tables.payment.filter(row => row.businessDate === TODAY && row.time.startsWith('12:'));
  expect(payment.length).toBeGreaterThan(0);
  const snapshot = { ...current, pos: undefined, tables: { ...current.tables, payment } };
  const store = { ...data, getSnapshot: () => snapshot };
  const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { store });

  const chart = screen.getByRole('region', { name: '기간별 매출' });
  const bars = [...chart.querySelectorAll('[data-series="net"]')];
  const labels = [...chart.querySelectorAll('figcaption > span')];
  expect(labels.map(label => label.textContent)).toEqual(['8시', '9시', '10시', '11시', '12시', '13시', '14시', '15시']);
  expect(bars[0]).toHaveAttribute('data-value', '0');
  expect(bars.at(-1)).toHaveAttribute('data-value', '0');
});
