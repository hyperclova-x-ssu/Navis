// REAL-PLAN F09: over HTTP the ledger form waits for the finance service's receipt, and the grid re-reads what the service stored.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { AS_OF, session, withoutMethods, YESTERDAY } from '../../../data/reality/09/testing';
import { reply } from '../../../data/reality/00/testing';
import { createRealPort } from '../../../data/reality/00';
import { moneyAdapter } from '../../../data/reality/09/adapter';
import { createWidgetDataStore } from '../../../data/db/store';
import type { ReactElement } from 'react';
import type { ExpenseDto } from '../../../data/reality/09/dto';
import { selectAccountingPresentation } from '../../../data/pos/projection';
import { AccountingPresentationProvider, LedgerDetail, SalesDepositSplitCard } from './ledger';
import { MarginDetail } from './margin';

afterEach(cleanup);
const host = (): WidgetHost => ({ layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() });

it('keeps the form pending until the receipt, sends one request and shows the stored expense with its undo deadline', async () => {
  const { store, backend, state } = await session();
  let answer!: () => void;
  const gate = new Promise<void>(resolve => { answer = resolve; });
  backend.on('POST', '/pos/expenses', async call => {
    const body = call.body as { date: string; category: ExpenseDto['category']; amount: number; evidence: ExpenseDto['evidence'] };
    await gate;
    state.expenses.push({ expenseId: 'expense-1', businessDate: body.date, category: body.category, amount: body.amount, evidence: body.evidence, memo: null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
    return { resourceId: 'expense-1', revision: 1, receiptId: 'receipt-e1', undoUntil: '2999-01-01T00:00:00Z', affectedSources: ['pos.expenses', 'pos.ledger', 'pos.closings', 'pos.finance'] };
  });
  const ui = host();
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={ui} />, { store, reducedMotion: true });
  await userEvent.click(await screen.findByRole('tab', { name: '지출' }));
  await userEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
  await userEvent.type(screen.getByRole('spinbutton', { name: /금액/ }), '2000');
  await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
  // Pending: the form is still open, nothing is listed or announced as saved, and pressing again adds no second request.
  expect(screen.getByRole('spinbutton', { name: /금액/ })).toBeInTheDocument();
  expect(ui.notify).not.toHaveBeenCalled();
  expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(1);
  answer();
  await waitFor(() => expect(screen.queryByRole('spinbutton', { name: /금액/ })).not.toBeInTheDocument());
  expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(1);
  expect(backend.callsTo('POST', '/pos/expenses')[0]!.body).toMatchObject({ date: TODAY, category: 'ingredients', amount: 2000, evidence: 'receipt' });
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', undoToken: 'real-undo:receipt-e1', undoUntil: '2999-01-01T00:00:00Z' }));
  const grid = await screen.findByRole('grid', { name: '지출 내역' });
  expect(within(grid).getByRole('gridcell', { name: /금액.*2,000/ })).toBeInTheDocument();
}, 30_000);

it('answers a likely duplicate next to the form and records it only after the owner insists', async () => {
  const { store, backend, state } = await session();
  let first = true;
  backend.on('POST', '/pos/expenses', call => {
    const body = call.body as { date: string; category: ExpenseDto['category']; amount: number; confirmDuplicate?: boolean };
    if (first) { first = false; return { status: 409, body: { code: 'CONFLICT', reason: 'LIKELY_DUPLICATE_EXPENSE', details: { expenseId: 'old', date: TODAY, category: body.category, amount: body.amount } } }; }
    state.expenses.push({ expenseId: 'expense-2', businessDate: body.date, category: body.category, amount: body.amount, evidence: 'receipt', memo: null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
    return { resourceId: 'expense-2', revision: 1, receiptId: 'receipt-e2', affectedSources: ['pos.expenses', 'pos.ledger'] };
  });
  const ui = host();
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={ui} />, { store, reducedMotion: true });
  await userEvent.click(await screen.findByRole('tab', { name: '지출' }));
  await userEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
  await userEvent.type(screen.getByRole('spinbutton', { name: /금액/ }), '2000');
  await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
  await userEvent.click(await screen.findByRole('button', { name: '그래도 기록하기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(2));
  expect(backend.callsTo('POST', '/pos/expenses')[1]!.body).toMatchObject({ confirmDuplicate: true });
  await waitFor(() => expect(state.expenses).toHaveLength(1));
}, 30_000);

// REAL-PLAN F09-2: the service's sales split by real tender (B09-2 `sales.byMethod`) replaces the hidden method rows.
const withPresentation = (store: Awaited<ReturnType<typeof session>>['store'], ui: ReactElement) =>
  <AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>{ui}</AccountingPresentationProvider>;
const ledgerDetail = () => <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host()} />;

it('lists the day\'s sales by card, easy pay and cash, charge and receivable, and keeps the mixed subtotal apart as an overlap', async () => {
  const { store } = await session();
  renderWithKit(withPresentation(store, ledgerDetail()), { store, reducedMotion: true });
  const methods = await screen.findByRole('table', { name: '판매분 결제 수단' });
  expect(within(methods).getByRole('row', { name: /카드 판매분.*3,000원/ })).toBeInTheDocument();
  expect(within(methods).getByRole('row', { name: /간편결제 판매분.*0원/ })).toBeInTheDocument();
  expect(within(methods).getByRole('row', { name: /현금 판매분.*4,000원/ })).toBeInTheDocument();
  // The mixed subtotal is not one of the tender rows: it overlaps them and is labelled so.
  expect(within(methods).queryByText(/섞어/)).not.toBeInTheDocument();
  const settlement = screen.getByRole('table', { name: '정산 유형별 매출' });
  expect(within(settlement).getByRole('row', { name: /충전금 사용액.*2,000원/ })).toBeInTheDocument();
  expect(within(settlement).getByRole('row', { name: /외상 발생액.*0원/ })).toBeInTheDocument();
  // PAR-1: the original settlement rows are all there; the finance service does not split sales by membership source, so those say so instead of 0원.
  expect(within(settlement).getByRole('row', { name: /주문제작 수령 매출.*0원/ })).toBeInTheDocument();
  for (const label of ['횟수권 이용분', '구독권 기간분', '기한 만료 매출']) expect(within(settlement).getByRole('row', { name: new RegExp(`${label}.*아직 기록 없음`) })).toBeInTheDocument();
  const overlap = screen.getByRole('table', { name: /다른 항목과 겹치는 금액/ });
  expect(within(overlap).getByRole('row', { name: /복합 결제.*5,000원/ })).toBeInTheDocument();
  // The headline stays the service's recognized sales: tender rows are never added to it.
  expect(screen.getAllByText(/9,000/).length).toBeGreaterThan(0);
}, 30_000);

it('says the split is not available, with no zero amounts, when the service sends no sales.byMethod', async () => {
  const { store, state, port } = await session();
  state.noMethods = true;
  await port.retry('money');
  renderWithKit(withPresentation(store, ledgerDetail()), { store, reducedMotion: true });
  const methods = await screen.findByRole('table', { name: '판매분 결제 수단' });
  expect(within(methods).getByRole('row', { name: /아직 기록 없음/ })).toBeInTheDocument();
  expect(within(methods).queryByText(/0원/)).not.toBeInTheDocument();
  expect(screen.queryByRole('table', { name: /다른 항목과 겹치는 금액/ })).not.toBeInTheDocument();
}, 30_000);

it('shows an archived closing that predates the field as not available, never as zeros', async () => {
  const { store, state, fake, port } = await session();
  state.archived.push({ ...fake.closing(), businessDate: YESTERDAY, status: 'closed', closingId: 'archived-1', closedAt: `${YESTERDAY}T14:00:00.000Z`, revision: 4,
    totals: withoutMethods(fake.totals().yesterday) });
  state.closed = true;
  await port.retry('money');
  const { history } = selectAccountingPresentation(store.getSnapshot());
  const old = history.find(view => view.period.start === YESTERDAY)!;
  const live = history.find(view => view.period.start === TODAY)!;
  const { rerender } = renderWithKit(<SalesDepositSplitCard stacked view={old} />, { store, reducedMotion: true });
  const methods = screen.getByRole('table', { name: '판매분 결제 수단' });
  expect(within(methods).getByRole('row', { name: /아직 기록 없음/ })).toBeInTheDocument();
  expect(within(methods).queryByText(/0원/)).not.toBeInTheDocument();
  // The frozen snapshot of the closed day carries the split: the same rows a new session shows.
  rerender(<SalesDepositSplitCard stacked view={live} />);
  expect(within(screen.getByRole('table', { name: '판매분 결제 수단' })).getByRole('row', { name: /카드 판매분.*3,000원/ })).toBeInTheDocument();
  expect(within(screen.getByRole('table', { name: /다른 항목과 겹치는 금액/ })).getByRole('row', { name: /복합 결제.*5,000원/ })).toBeInTheDocument();
}, 30_000);

it('shows the same tender split for the margin period, from the service rows', async () => {
  const { store } = await session();
  renderWithKit(withPresentation(store, <MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host()} />), { store, reducedMotion: true });
  const methods = await screen.findByRole('table', { name: '판매분 결제 수단' });
  expect(within(methods).getByRole('row', { name: /카드 판매분.*3,000원/ })).toBeInTheDocument();
  expect(within(methods).getByRole('row', { name: /현금 판매분.*4,000원/ })).toBeInTheDocument();
}, 30_000);
it('retries the HTTP ledger read from the error state', async () => {
  const { backend, fake } = await session();
  backend.on('GET', '/pos/ledger', () => reply(503, {}));
  const fresh = createWidgetDataStore();
  const freshPort = createRealPort({ store: fresh, adapters: [moneyAdapter], source: domain => domain === 'money' ? 'http' : 'fixture', fetch: backend.fetch });
  fresh.bindReal(freshPort);
  renderWithKit(ledgerDetail(), { store: fresh, reducedMotion: true });
  expect(await screen.findByText('손익을 불러오지 못했어요')).toBeVisible();
  backend.on('GET', '/pos/ledger', () => ({ from: TODAY, to: TODAY, totals: fake.totals().today,
    days: [{ businessDate: TODAY, ...fake.totals().today }], hours: [], asOf: AS_OF, sourceRevision: 9 }));
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(freshPort.state('money').status).toBe('ready'));
  expect(backend.callsTo('GET', '/pos/ledger')).toHaveLength(3);
});
