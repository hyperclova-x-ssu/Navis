import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectBriefing, TODAY } from '../../../data/widget-data';
import { selectNextTaxPayment } from '../../../data/commands/management-guards';
import type { WidgetHost } from '../../../contracts';
import { TaxDetail } from './tax';
afterEach(cleanup);
// The cafe seed's tax payments (11월 원천세 12/10, 하반기 부가세 준비 1/25), read from the same table the widget reads.
const rawName = (payment: { type: { raw: string } | object }) => ('raw' in payment.type ? payment.type.raw : '');
const payments = (store: ReturnType<typeof createWidgetDataStore>) => store.getSnapshot().tables.taxPayment;
const withholdingOf = (store: ReturnType<typeof createWidgetDataStore>) => payments(store).find(p => rawName(p).includes('원천세'))!;
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };

it('UX-A-21 downloads a CSV and omits the old connection chips', () => {
 const store = createWidgetDataStore();
 const objects = URL.createObjectURL;
 const makeUrl = vi.fn(() => 'blob:tax-file');
 URL.createObjectURL = makeUrl;
 let filename = '';
 const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
   filename = this.download;
 });
 try {
  renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store });
  fireEvent.click(screen.getByRole('button', { name: '세무사 자료 받기' }));
  expect(makeUrl).toHaveBeenCalledWith(expect.objectContaining({ type: 'text/csv;charset=utf-8' }));
  expect(filename).toMatch(/^tax-.*\.csv$/);
  expect(screen.queryByRole('heading', { name: '자료 연결 상태' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).not.toHaveTextContent('예시');
 } finally {
  URL.createObjectURL = objects;
  click.mockRestore();
 }
});
it('records a payment and removes its briefing alert when paid', async () => {
 const store = createWidgetDataStore();
 const withholding = withholdingOf(store);
 renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store, reducedMotion: true, textScale: 125 });
 await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
 const row = screen.getByText(/원천세/).closest('tr')!;
 await userEvent.click(within(row as HTMLElement).getByRole('button', { name: '납부 완료로 표시하기' }));
 expect(selectBriefing(store.getSnapshot(), { date: TODAY }).importantAlerts.groups.some(g => g.id === 'tax')).toBe(false);
 expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({messageKey:'data.management.notice.taxPaid', params:{name:rawName(withholding)}, undoToken:expect.any(String)}));
 await userEvent.click(screen.getByRole('button', { name: '납부 기록 추가하기' }));
 await userEvent.type(screen.getByRole('textbox', { name: '세금 종류' }), '부가가치세');
 await userEvent.type(screen.getByRole('spinbutton', { name: /납부 금액/ }), '950000');
 // the due date is a DateField (never an ISO text box): pick a day in the calendar
 await userEvent.click(within(document.querySelector('tr.ui-grid-new-row') as HTMLElement).getByRole('button', { name: /^납부 기한/ }));
 await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '11월 20일 금요일' }));
 await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
 expect(store.getSnapshot().tables.taxPayment.some(p => 'raw' in p.type && p.type.raw === '부가가치세' && p.amount === 950000 && p.dueOn === '2026-11-20')).toBe(true);
}, 20000);
it('shows an empty payment history and resets its preview when adding', async () => {
 const resetPreview = vi.fn();
 renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={{ ...host, resetPreview }} />, { preview: { family: 'empty', overrides: {} } });
 await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
 expect(screen.getByText('아직 기록한 납부 이력이 없어요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '납부 기록 추가하기' }));
 expect(resetPreview).toHaveBeenCalled();
 expect(screen.getByRole('textbox', { name: '세금 종류' })).toBeInTheDocument();
});
it('starts with the latest deadline and sorts amounts with keyboard navigation', async () => {
 const store = createWidgetDataStore();
 const latest = [...payments(store)].sort((a, b) => b.dueOn.localeCompare(a.dueOn))[0]!;
 renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store });
 await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
 const grid = screen.getByRole('grid', { name: '세금 납부 이력' });
 const rows = within(grid).getAllByRole('row');
 expect(rows[1]).toHaveTextContent(rawName(latest));
 const first = grid.querySelector<HTMLElement>('[tabindex="0"]')!;
 first.focus();
 await userEvent.keyboard('{ArrowRight}');
 expect(document.activeElement).not.toBe(first);
});
it('shows the next unpaid tax and its deadline in the wide panel', async () => {
 const { TaxPanel } = await import('./tax');
 const store = createWidgetDataStore();
 const next = selectNextTaxPayment(payments(store))!;
 const [, month, day] = next.dueOn.split('-');
 renderWithKit(<TaxPanel featureId="tax" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={host} />, { store });
 expect(screen.getByText(new RegExp(rawName(next)))).toBeInTheDocument();
 expect(screen.getByText(new RegExp(`${(next.amount / 10000).toFixed(1).replace('.', '\\.')}만`))).toBeInTheDocument();
 expect(screen.getAllByText(new RegExp(`${Number(month)}/${Number(day)}`)).length).toBeGreaterThan(0);
});

it('formats payment amounts in both display and accessible cell names', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<TaxDetail featureId="tax" condition={{kind:'default'}} detailRef={{featureId:'tax'}} host={host} />, { store });
 await userEvent.click(screen.getByRole('tab', {name:'세금 납부 이력'}));
 for (const payment of payments(store)) {
  const amount = `${payment.amount.toLocaleString('ko-KR')}원`;
  expect(screen.getByRole('gridcell', {name: new RegExp(amount)})).toHaveTextContent(amount);
 }
});
it('gives the tax type the remaining width and keeps its parenthetical qualifier together', async () => {
 const store = createWidgetDataStore();
 store.dispatch({ type: 'tax.createPayment', taxType: '부가가치세(2026년 2기 예정 고지)', amount: 132000, dueOn: '2026-12-20', idempotencyKey: 'tax-test-vat' });
 renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store });
 await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
 const grid = screen.getByRole('grid', { name: '세금 납부 이력' });
 expect(grid.style.getPropertyValue('--data-grid-columns')).toBe('minmax(180px, 1fr) 160px 160px 130px 140px 120px var(--table-action-width)');
 const vat = within(grid).getByRole('gridcell', { name: /세금 종류, 부가가치세\(2026년 2기 예정 고지\)/ });
 const qualifier = within(vat).getByText('(2026년 2기 예정 고지)');
 expect(qualifier.previousElementSibling?.tagName).toBe('WBR');
 expect(vat).toHaveTextContent('부가가치세(2026년 2기 예정 고지)');
});
it('aligns payment actions to the same two columns at 125% text size', async () => {
 const styles = ['src/ui/tokens.css', 'src/features/widgets/mgmt-money/widget.css']
  .map(path => readFileSync(path, 'utf8')).join('\n');
 renderWithKit(<><style>{styles}</style><TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} /></>, { textScale: 125 });
 await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
 const table = within(screen.getByRole('grid', { name: '세금 납부 이력' }));
 const primaryButtons = [...table.getAllByRole('button', { name: '납부 완료로 표시하기' }), ...table.queryAllByRole('button', { name: '증빙 추가하기' })];
 expect(primaryButtons.length).toBeGreaterThan(0);

 for (const primary of primaryButtons) {
  const actions = primary.parentElement!;
  const more = within(actions).getByRole('button', { name: /더 보기$/ });
  const layout = getComputedStyle(actions);
  expect(layout.display).toBe('grid');
  expect(layout.gridTemplateColumns).toBe('max-content var(--target-default)');
  expect(layout.justifyContent).toBe('end');
  expect(layout.whiteSpace).toBe('nowrap');
  const sizer = actions.querySelector('[aria-hidden="true"]')!;
  expect(sizer).toHaveTextContent('납부 완료로 표시하기');
  expect(getComputedStyle(sizer).visibility).toBe('hidden');
  expect(getComputedStyle(sizer).gridArea).toBe('1 / 1');
  expect(getComputedStyle(primary).gridArea).toBe('1 / 1');
  expect(getComputedStyle(primary).inlineSize).toBe('100%');
  expect(getComputedStyle(more).gridArea).toBe('1 / 2');
  expect(getComputedStyle(primary).minHeight).toBe('var(--target-default)');
  expect(getComputedStyle(more).height).toBe('var(--target-default)');
 }
});
it('shows one named primary row action and keeps secondary actions in more', async () => {
 const store = createWidgetDataStore();
 store.dispatch({ type: 'tax.createPayment', taxType: '지방소득세', amount: 88000, dueOn: '2026-12-31', idempotencyKey: 'tax-test-local' });
 renderWithKit(<TaxDetail featureId="tax" condition={{kind:'default'}} detailRef={{featureId:'tax'}} host={host}/>, { store });
 await userEvent.click(screen.getByRole('tab',{name:'세금 납부 이력'}));
 // a row that already has its evidence: one primary (mark paid) and no 증빙 추가하기 anywhere in the row
 const withEvidence=screen.getByText(/원천세/).closest('tr')!;
 const name=rawName(withholdingOf(store));
 expect(within(withEvidence).getByRole('button',{name:'납부 완료로 표시하기'})).toBeVisible();
 expect(within(withEvidence).queryByRole('button',{name:'증빙 추가하기'})).toBeNull();
 await userEvent.click(within(withEvidence).getByRole('button',{name:`${name} 더 보기`}));
 let menu=document.querySelector('.mm-tax-actions__menu') as HTMLElement;
 expect(within(menu).queryByRole('button',{name:'증빙 추가하기'})).toBeNull();
 expect(within(menu).getByRole('button',{name:'납부 기록 고치기'})).toBeVisible();
 expect(within(menu).getByRole('button',{name:'납부 기록 지우기'})).toBeVisible();
 await userEvent.keyboard('{Escape}');
 // a row without evidence offers it in more
 const without=screen.getByText('지방소득세').closest('tr')!;
 await userEvent.click(within(without).getByRole('button',{name:'지방소득세 더 보기'}));
 menu=document.querySelector('.mm-tax-actions__menu') as HTMLElement;
 expect(within(menu).getByRole('button',{name:'증빙 추가하기'})).toBeVisible();
 expect(within(menu).getByRole('button',{name:'납부 기록 고치기'})).toBeVisible();
 await userEvent.click(within(menu).getByRole('button',{name:'납부 기록 고치기'}));
 expect(screen.getByRole('textbox',{name:'지방소득세, 세금 종류'})).toBeVisible();
});

it('marks a payment with its status chip and says 지웠어요 when it is removed', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<TaxDetail featureId="tax" condition={{kind:'default'}} detailRef={{featureId:'tax'}} host={host}/>, { store, reducedMotion: true });
 await userEvent.click(screen.getByRole('tab',{name:'세금 납부 이력'}));
 const row=screen.getByText(/원천세/).closest('tr')!;
 const chip=within(row as HTMLElement).getByText('납부 전').closest('.ui-status-chip')!;
 expect(chip).toHaveAttribute('data-semantic','waiting');
 await userEvent.click(within(row as HTMLElement).getByRole('button',{name:'납부 완료로 표시하기'}));
 expect(within(screen.getByText(/원천세/).closest('tr') as HTMLElement).getByText('납부 완료').closest('.ui-status-chip')).toHaveAttribute('data-semantic','done');
 await userEvent.click(within(screen.getByText(/원천세/).closest('tr') as HTMLElement).getByRole('button',{name:/더 보기$/}));
 await userEvent.click(within(document.querySelector('.mm-tax-actions__menu') as HTMLElement).getByRole('button',{name:'납부 기록 지우기'}));
 expect(withholdingOf(store)).toBeDefined();
 const confirm = screen.getByRole('alertdialog', { name: '납부 기록을 지울까요?' });
 await userEvent.click(within(confirm).getByRole('button', { name: '납부 기록 지우기' }));
 expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({messageKey:'data.management.notice.deleted', undoToken:expect.any(String)}));
});

it('puts the add form in the table as its first row and shows the due date as a long date, never ISO', async () => {
 renderWithKit(<TaxDetail featureId="tax" condition={{kind:'default'}} detailRef={{featureId:'tax'}} host={host}/>, { reducedMotion: true });
 await userEvent.click(screen.getByRole('tab',{name:'세금 납부 이력'}));
 await userEvent.click(screen.getByRole('button',{name:'납부 기록 추가하기'}));
 const newRow=document.querySelector('tr.ui-grid-new-row') as HTMLElement;
 expect(newRow.closest('table')).not.toBeNull();
 expect(within(newRow).getByRole('button',{name:/^납부 기한/})).toHaveTextContent('11월 17일 화요일');
 expect(newRow.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
 await userEvent.click(within(newRow).getByRole('button',{name:'저장하기'}));
 expect(within(newRow).getByText('납부 금액을 넣어 주세요')).toBeVisible();
});

it('lists the review items before the data sources, shows a few at first and the rest on request, and names the export action', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<TaxDetail featureId="tax" condition={{kind:'default'}} detailRef={{featureId:'tax'}} host={host}/>, { store, reducedMotion: true });
 const headings=screen.getAllByRole('heading',{level:3}).map(h=>h.textContent);
 expect(headings).toContain('확인 목록');
 expect(headings).not.toContain('자료 연결 상태');
 const rows=()=>document.querySelectorAll('[data-slot="tax.list"] .mm-select-row').length;
 const total=Number((screen.getByRole('button',{name:/^나머지 \d+건 더 보기$/}).textContent!.match(/\d+/) ?? ['0'])[0]);
 expect(rows()).toBe(5);
 await userEvent.click(screen.getByRole('button',{name:/^나머지 \d+건 더 보기$/}));
 expect(rows()).toBe(5+total);
 expect(screen.queryByRole('button',{name:/더 보기$/})).toBeNull();
 expect(screen.getByRole('button',{name:'세무사 자료 받기'})).toBeVisible();
 // the export preview is a kit Table with a header row
 expect(document.querySelector('[data-slot="tax.export"] table.ui-table thead th')).not.toBeNull();
});
