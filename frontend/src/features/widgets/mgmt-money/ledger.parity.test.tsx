/** PAR-1 (D-384, D-355): the 손익 and 마진 windows show the same sections, tables and buttons over HTTP as with the example data. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { session } from '../../../data/reality/09/testing';
import { selectAccountingPresentation } from '../../../data/pos/projection';
import { renderWithKit } from '../../../ui/test-utils';
import { AccountingPresentationProvider, LedgerDetail } from './ledger';
import { MarginDetail } from './margin';
import { structureDifference, windowStructure, type WindowStructure } from './parity-structure';

afterEach(cleanup);
const host = (): WidgetHost => ({ layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() });
type Store = Awaited<ReturnType<typeof session>>['store'];
const withPresentation = (store: Store, ui: ReactElement) =>
  <AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>{ui}</AccountingPresentationProvider>;
const ledger = () => <LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger' }} host={host()} />;
const margin = () => <MarginDetail featureId="margin" condition={{ kind: 'default' }} detailRef={{ featureId: 'margin' }} host={host()} />;

async function bothModes(ui: () => ReactElement, ready: () => Promise<unknown>, observe: (container: HTMLElement) => Promise<WindowStructure[]>) {
  const { store, state, port } = await session();
  // The example day has one recorded expense and no look-alike candidates; the service gets the same so only the figures differ.
  state.candidates.length = 0;
  state.expenses.push({ expenseId: 'expense-1', businessDate: TODAY, category: 'ingredients', amount: 2000, evidence: 'receipt', memo: null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
  await port.retry('money');
  const http = renderWithKit(withPresentation(store, ui()), { store, reducedMotion: true });
  await ready();
  const fromHttp = await observe(http.container);
  cleanup();
  const example = createWidgetDataStore();
  const fixture = renderWithKit(withPresentation(example, ui()), { store: example, reducedMotion: true });
  await ready();
  const fromExample = await observe(fixture.container);
  return { fromHttp, fromExample };
}

it('shows the same sales, expenses and profit tabs of 손익 over HTTP and with the example data', async () => {
  const { fromHttp, fromExample } = await bothModes(ledger, () => screen.findByRole('table', { name: '판매분 결제 수단' }), async container => {
    const seen = [windowStructure(container)];
    for (const name of ['지출', '순이익']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      await waitFor(() => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true'));
      seen.push(windowStructure(container));
    }
    return seen;
  });
  const [httpSales] = fromHttp;
  const [exampleSales] = fromExample;
  // Both modes hide empty columns. The HTTP fixture has transaction numbers, and the example fixture has per-row recognized amounts.
  expect(structureDifference(httpSales!, exampleSales!)).toEqual({ columns: { onlyHttp: ['거래번호'], onlyExample: ['매출'] } });
  fromHttp.slice(1).forEach((structure, index) => expect(structureDifference(structure, fromExample[index + 1]!), `tab ${index + 1}`).toEqual({}));
  // The sales tab keeps the original two tables (sales by tender, sales by settlement type) in the original order, then the mixed-tender subtotal.
  expect(fromHttp[0]!.tables.map(table => table.caption)).toEqual(fromExample[0]!.tables.map(table => table.caption));
  const settlement = fromHttp[0]!.tables.find(table => table.caption === '정산 유형별 매출');
  expect(settlement?.rows).toEqual(['충전금 사용액', '외상 발생액', '횟수권 이용분', '구독권 기간분', '기한 만료 매출', '주문제작 수령 매출']);
}, 60_000);

it('shows the same sales-by-tender card in 마진 over HTTP and with the example data', async () => {
  const { fromHttp, fromExample } = await bothModes(margin, () => screen.findByRole('heading', { name: '매출을 받은 수단' }), async container => [windowStructure(container)]);
  expect(structureDifference(fromHttp[0]!, fromExample[0]!)).toEqual({});
  expect(fromExample[0]!.headings).toContain('매출을 받은 수단');
  expect(fromHttp[0]!.tables.map(table => table.caption)).toEqual(fromExample[0]!.tables.map(table => table.caption));
}, 60_000);
