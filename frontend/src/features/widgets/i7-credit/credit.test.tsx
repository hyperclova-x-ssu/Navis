import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/widget-data';
import { selectMoneyRead } from '../../../data/pos/projection';
import { renderWithKit } from '../../../ui/test-utils';
import { panelShape } from '../../../ui';
import { CreditDetail, CreditPanel, memberMoneyBinding } from './index';
import { binding, transaction } from './test-fixtures';


const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const detail = { featureId: 'members' as const, condition: { kind: 'default' as const }, detailRef: { featureId: 'members' as const }, host };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('omits the compact third line and gives both larger balances equal metric blocks', () => {
  const panel = { ...detail, ...binding(), width: 1 as const, height: 1 as const, shape: 'Q' as const, presetId: 'A' as const, editing: false };
  const { container, rerender } = renderWithKit(<CreditPanel {...panel} />);
  expect(screen.queryByText(/총 외상 10,000원/)).not.toBeInTheDocument();
  expect(container.querySelectorAll('[data-credit-metric]')).toHaveLength(1);
  rerender(<CreditPanel {...panel} width={2} shape="W" />);
  const metrics = container.querySelector('.credit-metrics')!;
  expect(metrics.querySelectorAll('[data-credit-metric]')).toHaveLength(2);
  expect(within(metrics as HTMLElement).getByText('총 외상')).toBeInTheDocument();
  expect(container.querySelector('.credit-secondary')).toBeNull();
});

it.each([1, 2, 3, 4] as const)('renders all four heights at width %s with number before label and Korean copy', width => {
  for (const height of [1, 2, 3, 4] as const) {
    const result = renderWithKit(<CreditPanel {...detail} {...binding()} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={false} />, { locale: 'en', textScale: 125, reducedMotion: true, theme: 'dark' });
    const metric = result.container.querySelector('[data-credit-metric]')!;
    expect(metric.textContent).toContain('55,000');
    expect(metric.textContent!.indexOf('55,000')).toBeLessThan(metric.textContent!.indexOf('총 충전금'));
    expect(result.container.textContent).not.toMatch(/김지현|0101234|선결제|정액권/);
    result.unmount();
  }
});

it('searches a member by name or phone suffix while masking both displayed values', async () => {
  renderWithKit(<CreditDetail {...detail} {...binding()} />);
  const search = screen.getByRole('searchbox');
  await userEvent.type(search, '지현');
  expect(screen.getByRole('grid', { name: '회원별 현황' }).textContent).toContain('김○현');
  expect(document.body.textContent).not.toContain('김지현');
  await userEvent.clear(search); await userEvent.type(search, '7711');
  expect(screen.getByRole('grid').textContent).toContain('정○아');
  expect(screen.getByRole('grid').textContent).not.toContain('김○현');
});

it('uses the standard table search field across all three tabs', async () => {
  const styles = readFileSync('src/ui/mastermanage.css', 'utf8');
  renderWithKit(<><style>{styles}</style><CreditDetail {...detail} {...binding()} /></>);
  const prompt = '이름이나 연락처 끝자리로 찾아보세요';
  const search = screen.getByRole('searchbox', { name: prompt });
  expect(search).toHaveAttribute('placeholder', prompt);
  const field = search.closest('.ui-search-field')!;
  expect(field.parentElement).toHaveClass('ui-data-grid__toolbar');
  expect(getComputedStyle(field).width).toBe('var(--table-search-width)');
  expect(field.querySelector('.ui-search-field__control > svg[aria-hidden="true"]')).toBeInTheDocument();

  await userEvent.type(search, '2481');
  await userEvent.tab();
  expect(screen.getByRole('button', { name: '검색어 지우기' })).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(search).toHaveFocus();
  expect(search).toHaveValue('');
  for (const tab of ['충전금 내역', '외상·수금 내역']) {
    await userEvent.click(screen.getByRole('tab', { name: tab }));
    expect(screen.getByRole('searchbox', { name: prompt })).toBe(search);
  }
});

it('validates topup and partial collection before opening the shared checkout, without mutating balances', async () => {
  const b = binding();
  renderWithKit(<CreditDetail {...detail} detailRef={{ ...detail.detailRef, itemId: 'M-0005' }} {...b} />);
  const side = screen.getByRole('region');
  const amount = within(side).getByRole('spinbutton', { name: '금액' });
  await userEvent.type(amount, '15000'); await userEvent.click(within(side).getByRole('button', { name: '외상 수금하기' }));
  expect(within(side).getByText('남은 외상 금액 10,000원까지 수금할 수 있어요')).toBeInTheDocument();
  expect(b.port.openSettlement).not.toHaveBeenCalled();
  await userEvent.clear(amount); await userEvent.type(amount, '0'); await userEvent.click(within(side).getByRole('button', { name: '충전하기' }));
  expect(within(side).getByText('1원 이상 넣어 주세요')).toBeInTheDocument();
  await userEvent.clear(amount); await userEvent.type(amount, '5000'); await userEvent.click(within(side).getByRole('button', { name: '외상 수금하기' }));
  expect(b.port.openSettlement).toHaveBeenLastCalledWith({ purpose: 'receivable_collection', memberId: 'M-0005', amount: 5000 }, expect.objectContaining({ selectedId: 'M-0005', returnFocusRef: expect.any(Object) }));
  expect(b.view.status === 'ready' && b.view.model.receivableBalance).toBe(10000);
  await userEvent.click(within(side).getByRole('button', { name: '충전하기' }));
  expect(b.port.openSettlement).toHaveBeenLastCalledWith({ purpose: 'charge_topup', memberId: 'M-0005', amount: 5000 }, expect.any(Object));
  expect(within(side).queryByRole('button', { name: /외상 추가|외상 만들기/ })).not.toBeInTheDocument();
});

it('disables collection with zero debt and keeps original transactions available for reversals', async () => {
  const b = binding();
  renderWithKit(<CreditDetail {...detail} detailRef={{ ...detail.detailRef, itemId: 'M-0001' }} {...b} />);
  const side = screen.getByRole('region');
  expect(within(side).getByRole('button', { name: '외상 수금하기' })).toBeDisabled();
  await userEvent.click(within(side).getByRole('button', { name: /원거래 보기/ }));
  expect(b.port.openOriginalTransaction).toHaveBeenCalledWith(transaction, expect.objectContaining({ selectedId: 'M-0001' }));
});

it('filters charge and receivable history without silently combining account values', async () => {
  const b = binding();
  if (b.view.status !== 'ready') throw Error('fixture');
  const debt = b.view.model.members[2]!.transactions[0]!;
  const view = { status: 'ready' as const, model: { ...b.view.model, transactions: [transaction, debt] } };
  renderWithKit(<CreditDetail {...detail} {...b} view={view} />);
  await userEvent.click(screen.getByRole('tab', { name: '외상·수금 내역' }));
  expect(screen.getByRole('grid').textContent).toContain('외상 발생');
  expect(screen.getByRole('grid').textContent).not.toContain('충전');
  await userEvent.click(screen.getByRole('tab', { name: '충전금 내역' }));
  expect(screen.getByRole('grid').textContent).toContain('충전');
  expect(screen.getByRole('grid').textContent).not.toContain('외상 발생');
});

it('shows readable original transactions in both demo histories', async () => {
  const read = selectMoneyRead(createWidgetDataStore().getSnapshot());
  const bound = memberMoneyBinding(read, binding().port);
  if (bound.view.status !== 'ready') throw Error('the cafe seed carries account data');
  const model = bound.view.model;
  // The cafe seed holds opening balances only (no bill or settlement behind them): the labels come from the same adapter the widget reads.
  const labels = (account: 'charge' | 'receivable') => model.transactions.filter(txn => txn.account === account).map(txn => txn.originalLabel).sort();
  const readable = /^(—|수금|충전|계산서( B-\d+)?)$/;
  renderWithKit(<CreditDetail {...detail} {...bound} />);

  await userEvent.click(screen.getByRole('tab', { name: '외상·수금 내역' }));
  const receivable = screen.getByRole('grid', { name: '외상·수금 내역' });
  const receivableCells = within(receivable).getAllByRole('gridcell', { name: /원거래/ }).map(cell => cell.textContent!);
  expect(receivableCells).toHaveLength(labels('receivable').length);
  expect([...receivableCells].sort()).toEqual(labels('receivable'));
  for (const label of receivableCells) expect(label).toMatch(readable);
  expect(receivable).not.toHaveTextContent(/seed/i);

  await userEvent.click(screen.getByRole('tab', { name: '충전금 내역' }));
  const charge = screen.getByRole('grid', { name: '충전금 내역' });
  const originals = within(charge).getAllByRole('gridcell', { name: /원거래/ }).map(cell => cell.textContent!);
  expect(originals).toHaveLength(labels('charge').length);
  expect([...originals].sort()).toEqual(labels('charge'));
  for (const label of originals) expect(label).toMatch(readable);
  expect(charge).not.toHaveTextContent(/seed/i);
});

it('shows the cafe sample members by their already masked names and the cafe totals in two summary cards', async () => {
  const read = selectMoneyRead(createWidgetDataStore().getSnapshot());
  const bound = memberMoneyBinding(read, binding().port);
  if (bound.view.status !== 'ready') throw Error('the cafe seed carries account data');
  const { model } = bound.view;
  const { container } = renderWithKit(<CreditDetail {...detail} {...bound} />);
  const cards = container.querySelectorAll('.credit-summary > .credit-summary-card');
  expect(cards).toHaveLength(2);
  expect(cards[0]).toHaveTextContent(`총 충전금 · 유효기간 없음${model.chargeBalance.toLocaleString('ko-KR')}원`);
  expect(cards[1]).toHaveTextContent(`총 외상(미수금)${model.receivableBalance.toLocaleString('ko-KR')}원`);
  // Members who hold a balance lead the list; a name the data already masked is never masked a second time.
  const firstRow = screen.getAllByRole('row').find(row => row.hasAttribute('data-grid-row'))!;
  const first = model.members.find(member => member.memberId === firstRow.getAttribute('data-grid-row'))!;
  expect(first.chargeBalance + first.receivableBalance).toBeGreaterThan(0);
  expect(firstRow.textContent).toContain(first.name);
  expect(firstRow.textContent).not.toMatch(/○{3}/);
  expect(screen.queryByRole('columnheader', { name: '연락처' })).not.toBeInTheDocument();
});

it('writes dates through the locale formatter and negative amounts with the real minus sign (D1, D2)', async () => {
  const b = binding();
  if (b.view.status !== 'ready') throw Error('fixture');
  const use = { ...transaction, txnId: 'TX-USE', kind: 'use' as const, amount: -5000, at: '2026-10-26T13:50:00', originalLabel: '계산서 B-029' };
  const view = { status: 'ready' as const, model: { ...b.view.model, transactions: [transaction, use] } };
  renderWithKit(<CreditDetail {...detail} {...b} view={view} />);
  await userEvent.click(screen.getByRole('tab', { name: '충전금 내역' }));
  const grid = screen.getByRole('grid', { name: '충전금 내역' });
  expect(grid).toHaveTextContent('10/26(월) 13:50');
  expect(grid).toHaveTextContent('−5,000원');
  expect(grid).toHaveTextContent('+50,000원');
  expect(grid.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|(^|\s)-\d/);
});

it('words zero rows by their cause and offers the way back (A10)', async () => {
  const b = binding();
  if (b.view.status !== 'ready') throw Error('fixture');
  const onlyCharge = { status: 'ready' as const, model: { ...b.view.model, transactions: [transaction] } };
  renderWithKit(<CreditDetail {...detail} {...b} view={onlyCharge} />);
  // the tab itself has no rows: a sentence about that tab, not the whole-widget empty sentence
  await userEvent.click(screen.getByRole('tab', { name: '외상·수금 내역' }));
  expect(screen.getByText('아직 외상 거래가 없어요')).toBeInTheDocument();
  expect(screen.queryByText('아직 충전금·외상 거래가 없어요')).not.toBeInTheDocument();
  // a kind chip with no rows: the chip's own sentence and [거르기 풀기]
  await userEvent.click(screen.getByRole('tab', { name: '충전금 내역' }));
  await userEvent.click(screen.getByRole('radio', { name: '취소·환불' }));
  expect(screen.getByText('취소·환불 거래가 없어요')).toBeInTheDocument();
  expect(screen.queryByText('아직 충전금·외상 거래가 없어요')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '거르기 풀기' }));
  expect(within(screen.getByRole('grid', { name: '충전금 내역' })).getAllByRole('row').some(row => row.hasAttribute('data-grid-row'))).toBe(true);
  // a search with no rows: [검색어 지우기] clears it and hands the focus back to the search box
  const search = screen.getByRole('searchbox');
  await userEvent.type(search, '없는손님');
  expect(screen.getByText('검색 결과가 없어요')).toBeInTheDocument();
  const zero = screen.getByRole('grid', { name: '충전금 내역' });
  await userEvent.click(within(zero).getByRole('button', { name: '검색어 지우기' }));
  expect(search).toHaveValue('');
  expect(search).toHaveFocus();
  expect(screen.queryByText('검색 결과가 없어요')).not.toBeInTheDocument();
});

it('opens the original transaction from the 원거래 cell, which is a link with an arrow only when an original exists (A8)', async () => {
  const b = binding();
  if (b.view.status !== 'ready') throw Error('fixture');
  const opening = { ...transaction, txnId: 'TX-OPEN', kind: 'opening' as const, at: '2026-10-25T09:00:00', settlementId: null, originalTxnId: null, sourceRef: null, originalLabel: '—' };
  const view = { status: 'ready' as const, model: { ...b.view.model, transactions: [{ ...transaction, originalLabel: '충전' }, opening] } };
  renderWithKit(<CreditDetail {...detail} {...b} view={view} />);
  await userEvent.click(screen.getByRole('tab', { name: '충전금 내역' }));
  const grid = screen.getByRole('grid', { name: '충전금 내역' });
  const links = within(grid).getAllByRole('link');
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAccessibleName('충전, 원거래 보기');
  expect(links[0]!.querySelector('svg')).toBeInTheDocument();
  await userEvent.click(links[0]!);
  expect(b.port.openOriginalTransaction).toHaveBeenCalledWith(expect.objectContaining({ txnId: 'TX-1' }), expect.objectContaining({ selectedId: 'M-0001' }));
  // the opening line has nothing to open: plain text, no link
  expect(within(grid).getAllByRole('gridcell', { name: /원거래/ }).map(cell => cell.textContent)).toEqual(['충전', '—']);
});

it('gives the empty state a next action and explains a disabled collection button (H1)', async () => {
  const b = binding();
  const result = renderWithKit(<CreditDetail {...detail} {...b} view={{ status: 'empty' }} />);
  expect(screen.getByText('아직 충전금·외상 거래가 없어요')).toBeInTheDocument();
  expect(screen.getByText('회원목록에서 회원을 골라 충전해 보세요')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /회원목록 보기/ }));
  expect(host.openLinked).toHaveBeenCalledWith({ featureId: 'members' });
  result.unmount();
  renderWithKit(<CreditDetail {...detail} detailRef={{ ...detail.detailRef, itemId: 'M-0001' }} {...b} />);
  const side = screen.getByRole('region');
  const collect = within(side).getByRole('button', { name: '외상 수금하기' });
  expect(collect).toBeDisabled();
  expect(collect).toHaveAccessibleDescription('남은 외상이 없어서 수금할 수 없어요');
});

it('offers the member list from an empty panel, opened like the panel\'s own windows (H1)', async () => {
  const panel = { ...detail, ...binding(), view: { status: 'empty' as const }, width: 2 as const, height: 2 as const, shape: 'S' as const, presetId: 'A' as const, editing: false };
  renderWithKit(<CreditPanel {...panel} />);
  expect(screen.getByText('아직 충전금·외상 거래가 없어요')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /회원목록 보기/ }));
  expect(host.openDetail).toHaveBeenCalledWith({ featureId: 'members' });
  expect(host.openLinked).not.toHaveBeenCalled();
});

it('lays the panel out so the fit guard can see overflow, with the kit table header at 48 (P-1, K-A item 5)', () => {
  const css = readFileSync('src/features/widgets/i7-credit/credit.css', 'utf8');
  // .mc-root clips and FitProbe reads its overflow: a clipping .credit-root would hide it and cut the action buttons at 125 %
  expect(/\.credit-root\s*\{[^}]*overflow\s*:\s*(hidden|clip)/.test(css)).toBe(false);
  expect(css).toMatch(/\.credit-panel-table \.ui-table thead th \{[^}]*height: var\(--table-header-height\)/);
  const panel = { ...detail, ...binding(), width: 3 as const, height: 2 as const, shape: 'L' as const, presetId: 'A' as const, editing: false };
  const { container } = renderWithKit(<CreditPanel {...panel} />);
  expect(container.querySelector('.credit-panel-table table.ui-table')).toBeInTheDocument();
  expect(container.querySelector('.credit-panel-table')?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

it('renders empty, disconnected and search-empty states without offering a nonmember balance path', async () => {
  const b = binding();
  const result = renderWithKit(<CreditDetail {...detail} {...b} view={{ status: 'empty' }} />, { locale: 'zh-Hans' });
  expect(screen.getByText('아직 충전금·외상 거래가 없어요')).toBeInTheDocument();
  result.rerender(<CreditDetail {...detail} {...b} view={{ status: 'error' }} />);
  await userEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
  expect(host.resetPreview).toHaveBeenCalledOnce();
  result.rerender(<CreditDetail {...detail} {...b} />);
  await userEvent.type(screen.getByRole('searchbox'), '없는손님');
  expect(screen.getByText('검색 결과가 없어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '충전하기' })).not.toBeInTheDocument();
});
