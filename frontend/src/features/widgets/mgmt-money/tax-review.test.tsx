import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setup } from '../../../pos/loyalty/test-setup';
import { PosProvider } from '../../../pos/react';
import { renderWithKit } from '../../../ui/test-utils';
import { M2RunHost } from '../../../app/pos-host';
import { SessionActionsProvider } from '../../../app/session-actions';
import type { WidgetHost } from '../../../contracts';
import { selectWidget, TODAY } from '../../../data/widget-data';
import { LedgerDetail } from './ledger';
import { TaxDetail } from './tax';

afterEach(cleanup);

it('smoke 1 default tax month uses canonical sales and deposits, including its example export', () => {
  const h = setup();
  const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  // The tax widget's default "이번 달" runs from the 1st to the demo's today.
  const month = { kind: 'dateRange' as const, start: `${TODAY.slice(0, 8)}01`, end: TODAY };
  const ledgerMonth = selectWidget(h.data.getSnapshot(), 'ledger', month, 'normal');
  const ledgerToday = selectWidget(h.data.getSnapshot(), 'ledger', { kind: 'default' }, 'normal');
  if (ledgerMonth.status !== 'ready' || ledgerToday.status !== 'ready') throw new Error('Monthly ledger fixture must be available');
  const todaySales = ledgerToday.model.sales.net;
  const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;
  const monthlySales = won(ledgerMonth.model.sales.net);
  // The month holds the historical days beyond the current-day sales.
  expect(ledgerMonth.model.sales.net).toBeGreaterThan(todaySales);
  renderWithKit(<SessionActionsProvider value={h.actions}><PosProvider value={h.pos}><M2RunHost run={h.run}>
    <section aria-label="세무 확인"><TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host}/></section>
    <section aria-label="손익 확인"><LedgerDetail featureId="ledger" condition={month} detailRef={{ featureId: 'ledger' }} host={host}/></section>
  </M2RunHost></PosProvider></SessionActionsProvider>, { store: h.data, reducedMotion: true });
  const tax = within(screen.getByRole('region', { name: '세무 확인' }));
  const ledger = within(screen.getByRole('region', { name: '손익 확인' }));
  expect(tax.getByRole('radio', { name: '이번 달' })).toBeChecked();
  const split = within(tax.getByRole('region', { name: '매출 · 실제 입금' }));
  const ledgerSplit = within(ledger.getByRole('region', { name: '매출 · 실제 입금' }));
  const sampleCards = [/^매출$/, /^실제 입금$/].map(name => split.getByRole('region', { name }));
  // D-329: the tax screen no longer carries the small 「예시」 chip.
  expect(split.queryByText('예시')).toBeNull();
  for (const card of sampleCards) expect(within(card).getByRole('heading', { level: 3 })).toBeInTheDocument();
  // The cafe seed has a payment record for every day of the month: deposits equal the ledger's month sales, nothing predates the payments.
  const displayed = (scope: ReturnType<typeof within>, value: string) => scope.getAllByText((_: string, node: Element | null) => node?.textContent === value, {selector:'.ui-pos-money--display'});
  expect(displayed(split, monthlySales)).toHaveLength(2);
  expect(displayed(ledgerSplit, monthlySales)).toHaveLength(1);
  expect(screen.getByRole('region', { name: '손익 확인' }).querySelector('[data-slot="ledger.kpi.sales"] .ui-metric-fit')).toHaveTextContent(monthlySales);
  expect(tax.queryByText(/자료만 있어요/)).toBeNull();
  expect(split.queryByText(/이전 날짜 매출/)).toBeNull();
  const exported = document.querySelector('[data-slot="tax.export"]')! as HTMLElement;
  const exportHeading = within(exported).getByRole('heading', { level: 3 });
  expect(within(exportHeading.parentElement!).queryByText('예시')).toBeNull();
  expect(tax.queryByText('예시')).toBeNull();
  expect(within(exported).queryByRole('row', { name: `매출 합계 ${monthlySales}` })).toBeNull();
  expect(within(exported).queryByRole('row', { name: /이전 날짜 매출/ })).toBeNull();
  expect(within(exported).queryByRole('row', { name: `실제 입금 ${monthlySales}` })).toBeNull();
  expect(within(exported).getByRole('button', { name: '세무사 자료 받기' })).toBeEnabled();
  act(() => {
    const money = h.actions.money;
    const quote = money.quoteSettlement({ target: { purpose: 'charge_topup', memberId: 'M-0001', amount: 50000 }, allocations: [{ kind: 'method', method: 'card', amount: 50000 }] });
    expect(money.beginApproval({ quote, idempotencyKey: 'tax-month-topup' }).ok).toBe(true);
    const pending = money.approval()!;
    expect(money.finishApproval({ runId: pending.runId, attemptId: pending.attemptId, outcome: 'approved' }).ok).toBe(true);
  });
  const depositsAfterTopup = won(ledgerMonth.model.sales.net + 50000);
  expect(displayed(split, monthlySales)).toHaveLength(1);
  expect(displayed(split, depositsAfterTopup)).toHaveLength(1);
  expect(ledgerSplit.queryByText((_, node) => node?.textContent === monthlySales, { selector: '.ui-pos-money--display' })).toBeNull();
  expect(displayed(ledgerSplit, depositsAfterTopup)).toHaveLength(1);
  expect(within(exported).queryByRole('row', { name: `매출 합계 ${monthlySales}` })).toBeNull();
  expect(within(exported).queryByRole('row', { name: `실제 입금 ${depositsAfterTopup}` })).toBeNull();
  fireEvent.click(tax.getByRole('radio', { name: '지난달' }));
  // The cafe seed keeps closed days for last month too: the cards and the export preview read the same canonical projection.
  expect(tax.getByText('자료 기간 10월 1일(목)~31일(토)', { exact: false })).toBeInTheDocument();
  const [lastSales, lastDeposits] = Array.from(tax.getByRole('region', { name: '매출 · 실제 입금' }).querySelectorAll('.ui-pos-money--display'), node => node.textContent ?? '');
  expect(lastSales).toMatch(/^[1-9][\d,]*원$/);
  expect(lastDeposits).toMatch(/^[1-9][\d,]*원$/);
  expect(within(exported).queryByRole('row', { name: `매출 합계 ${lastSales}` })).toBeNull();
  expect(within(exported).queryByRole('row', { name: `실제 입금 ${lastDeposits}` })).toBeNull();
  expect(within(exported).getByRole('button', { name: '세무사 자료 받기' })).toBeEnabled();
});

it('shows no deposit data and keeps the export disabled when the accounting projection is unavailable', () => {
  const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} accounting={{ status: 'unavailable', period: { start: '2000-01-01', end: '2000-01-31' } }} />, { reducedMotion: true });
  expect(screen.getByText('이 날짜의 실제 입금 자료가 없어요')).toBeInTheDocument();
  const exported = document.querySelector('[data-slot="tax.export"]')! as HTMLElement;
  expect(screen.queryByText('예시')).toBeNull();
  expect(within(exported).getByRole('row', { name: '매출 합계 —' })).toBeInTheDocument();
  expect(within(exported).getByRole('row', { name: '실제 입금 —' })).toBeInTheDocument();
  expect(within(exported).getByRole('button', { name: '세무사 자료 받기' })).toBeDisabled();
});
