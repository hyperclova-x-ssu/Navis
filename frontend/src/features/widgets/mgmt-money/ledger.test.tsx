// PRD 12.6: receipt expectations follow real-method transactions separately from the day's orders.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { LedgerDetail } from './ledger';
import { closingOf, ledgerOf, man, menuLabel, paymentsOf, won } from './test-values';
afterEach(cleanup);
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('shows the specified ledger grid headers and payment content in %s', async locale => {
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { locale });
 const sales = screen.getByRole('grid', { name: '매출 내역' });
 const salesHeaders = within(sales).getAllByRole('columnheader').map(header => header.textContent);
 expect(salesHeaders).toEqual(['시각', '금액', '결제 수단', '내용', '상태']);
 const firstPayment = within(sales).getAllByRole('row')[1]!;
 expect(within(firstPayment).getByRole('gridcell', { name: /내용/ })).not.toBeEmptyDOMElement();
 await userEvent.click(screen.getByRole('tab', { name: locale === 'ko' ? '지출' : locale === 'en' ? 'Expenses' : locale === 'zh-Hans' ? '支出' : '支出' }));
 const expenses = screen.getByRole('grid', { name: '지출 내역' });
 const expenseHeaders = within(expenses).getAllByRole('columnheader').map(header => header.textContent);
 expect(expenseHeaders[1]).toBe('지출 항목');
 expect(expenseHeaders[4]).toBe('메모');
});
/** The cafe day has no refund, so one is added to the snapshot the widget reads (a copy of the day's latest payment, filed at the start of the day so the latest payment stays the first row). */
function storeWithRefund() {
 const store = createWidgetDataStore();
 const snapshot = store.getSnapshot();
 const source = paymentsOf(store)[0]!;
 const menu = snapshot.tables.menuItem.find(item => item.menuId !== source.lines[0]!.menuId)!;
 const refundId = 'refund-of-latest';
 const withRefund = { ...snapshot, tables: { ...snapshot.tables,
  payment: [...snapshot.tables.payment, { ...snapshot.tables.payment.find(payment => payment.paymentId === source.paymentId)!, paymentId: refundId, kind: 'refund' as const, refundAmount: 2 * menu.price, time: '00:00', seq: snapshot.tables.payment.length + 1 }],
  paymentLine: [...snapshot.tables.paymentLine, { ...source.lines[0]!, paymentId: refundId, paymentLineId: `${refundId}:line`, menuId: menu.menuId, qty: 2 }] } };
 return { store: { ...store, getSnapshot: () => withRefund } as typeof store, menu: menuLabel(store, menu.menuId), first: `${menuLabel(store, source.lines[0]!.menuId)} ${source.lines[0]!.qty}` };
}
it('shows the purchased menu and quantity for payment and refund rows', () => {
 const { store, menu, first } = storeWithRefund();
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { store });
 const rows = within(screen.getByRole('grid', { name: '매출 내역' })).getAllByRole('row');
 expect(within(rows[1]!).getByRole('gridcell', { name: /내용/ })).toHaveTextContent(first);
 const refund = rows.find(row => within(row).queryByRole('gridcell', { name: /상태.*환불/ }))!;
 expect(within(refund).getByRole('gridcell', { name: /내용/ })).toHaveTextContent(`${menu} 2`);
});
it('shows shared payment rows and opens closing from the ledger', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { store, textScale: 125, reducedMotion: true });
 expect(within(screen.getByRole('grid', { name: '매출 내역' })).getAllByRole('row')).toHaveLength(paymentsOf(store).length + 1);
 await userEvent.click(screen.getByRole('button', { name: '마감 정산하기' }));
 expect(host.openClosing).toHaveBeenCalled();
 await userEvent.click(screen.getByRole('tab', { name: '순이익' }));
 expect(screen.getAllByText(man(ledgerOf(store).remaining!)).length).toBeGreaterThan(0);
}, 30_000);
it('records 30,000 won of expense and updates the net profit', async () => {
 const store = createWidgetDataStore();
 const before = ledgerOf(store).remaining!;
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { store, reducedMotion: true });
 await userEvent.click(screen.getByRole('tab', { name: '지출' }));
 await userEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
 await userEvent.type(screen.getByRole('spinbutton', { name: /금액/ }), '30000');
 await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
 await userEvent.click(screen.getByRole('tab', { name: '순이익' }));
 expect(screen.getAllByText(man(before - 30_000)).length).toBeGreaterThan(0);
 expect(ledgerOf(store).remaining).toBe(before - 30_000);
}, 30_000);
it('presents expense rows in a single-entry keyboard grid', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { store });
 await userEvent.click(screen.getByRole('tab', { name: '지출' }));
 const grid = screen.getByRole('grid', { name: '지출 내역' });
 const expense = ledgerOf(store).expenses.items[0]!;
 expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
 expect(within(grid).getByRole('gridcell', { name: new RegExp(`금액.*${won(expense.amount)}`) })).toHaveTextContent(won(expense.amount));
 expect(grid).not.toHaveTextContent('[object Object]');
}, 30_000);
it('shows the shared closing status in the compact panel', async () => {
 const { LedgerPanel } = await import('./ledger');
 renderWithKit(<LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} />);
 expect(screen.getByText('아직 마감 정산 전이에요')).toBeInTheDocument();
});
it('shows the three financial figures in the wide panel', async () => {
 const { LedgerPanel } = await import('./ledger');
 const model = ledgerOf();
 renderWithKit(<LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={host} />);
 const list = screen.getByRole('list');
 expect(within(list).queryByText('오늘 매출')).not.toBeInTheDocument();
 expect(within(list).getByText('순이익')).toBeInTheDocument();
 expect(within(list).getByText(new RegExp(man(model.expenses.total).replace('.', '\\.')))).toBeInTheDocument();
});
it('retains later expense changes when the shared closing is undone', async () => {
 const store = createWidgetDataStore();
 const profit = ledgerOf(store).remaining!;
 const openClosing = vi.fn(() => true);
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={{ ...host, openClosing }} />, { store });
 await userEvent.click(screen.getByRole('button', { name: '마감 정산하기' }));
 expect(openClosing).toHaveBeenCalledWith('ledger.closing');
 const closed = store.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: closingOf(store).generation, idempotencyKey: 't206-close' });
 expect(closed.ok).toBe(true);
 const closing = store.getSnapshot().tables.dayClosing.at(-1)!;
 expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'ingredients', amount: 30000, evidence: 'receipt' }).ok).toBe(true);
 expect(store.dispatch({ type: 'closing.undoDay', date: TODAY, scenario: 'normal', closingId: closing.closingId, idempotencyKey: 't206-undo' }).ok).toBe(true);
 const { selectClosing } = await import('../../../data/widget-data');
 expect(selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' })).toMatchObject({ status: 'reopened', netProfit: profit - 30_000 });
}, 30_000);
it('compares sales and expenses in the net profit tab', async () => {
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />);
 await userEvent.click(screen.getByRole('tab', { name: '순이익' }));
 expect(screen.getByRole('region', { name: '매출·지출 비교' })).toBeInTheDocument();
});
it('renders the margin trend in the wide panel', async () => {
 const { MarginPanel }=await import('./margin');
 const { container }=renderWithKit(<MarginPanel featureId="margin" condition={{kind:'default'}} width={2} height={1} shape="W" presetId="A" editing={false} host={host}/>);
 expect(container.querySelector('.mm-chart')).toBeInTheDocument();
 expect(container.querySelector('.mm-chart')).not.toHaveAttribute('data-fit-hidden');
});

it('answers a future expense date in the form (no toast) and clears the answer when the date changes', async () => {
 const store = createWidgetDataStore();
 const notify = vi.fn();
 // The form's date can not go past today, so the refusal is made by the store, as a typed-in command would meet it.
 const refusing = { ...store, dispatch: (command: Parameters<typeof store.dispatch>[0]) => command.type === 'ledger.recordExpense'
  ? { ok: false as const, code: 'VALIDATION' as const, field: 'date', reason: 'EXPENSE_DATE_FUTURE', messageKey: 'data.management.error.EXPENSE_DATE_FUTURE', details: { businessDate: TODAY } }
  : store.dispatch(command) } as typeof store;
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={{ ...host, notify }} />, { store: refusing });
 await userEvent.click(screen.getByRole('tab', { name: '지출' }));
 await userEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
 await userEvent.type(screen.getByRole('spinbutton', { name: /금액/ }), '12000');
 await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
 const error = document.querySelector('[data-slot="ledger.dateError"]') as HTMLElement;
 expect(error).toHaveTextContent('앞으로 쓸 돈은 기록하지 않아요');
 expect(error).toHaveAttribute('role', 'alert');
 expect(notify).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button', { name: '이전 날짜' }));
 expect(document.querySelector('[data-slot="ledger.dateError"]')).toBeNull();
});

it.each([
 { empty: 'no-sales', sentence: '아직 기록한 매출이 없어요' },
] as const)('an empty ledger ($empty) offers the next step: a wider period', async ({ empty, sentence }) => {
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host} />, { preview: { family: 'normal', overrides: { ledger: empty } } });
 expect(screen.getByText(sentence)).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '최근 7일 보기' }));
 expect(screen.getByRole('radio', { name: '최근 7일' })).toHaveAttribute('aria-checked', 'true');
 expect(screen.getByRole('button', { name: '최근 30일 보기' })).toBeInTheDocument();
});

it('draws profit by hour for today, ending on the profit figure, and by category for expenses', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'profit' }} host={host} />, { store });
 const chart = screen.getByRole('region', { name: '시간대별 누적 순이익' });
 const bars = [...chart.querySelectorAll<HTMLElement>('[data-series="netProfit"]')];
 expect(bars.length).toBeGreaterThan(1);
 expect(Number(bars.at(-1)!.dataset.value)).toBe(ledgerOf(store).remaining);
 const labels = [...chart.querySelectorAll('figcaption > span')].map(label => label.textContent);
 for (const label of labels) expect(label).toMatch(/^\d+시$/);
 // The expense list is not repeated beside the profit chart.
 expect(screen.queryByRole('region', { name: '지출 항목' })).toBeNull();
});

it('uses the kit table for the sales and settlement summaries, and the page scrolls once', async () => {
 renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'sales' }} host={host} />);
 for (const table of document.querySelectorAll('table.mm-table')) expect(table).toHaveClass('ui-table');
 expect(document.querySelectorAll('table.mm-table').length).toBeGreaterThan(0);
});
