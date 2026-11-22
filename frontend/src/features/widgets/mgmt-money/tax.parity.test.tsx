/** PAR-1 (D-384, D-355): the 세무관리 window shows the same tabs, sections, export rows and buttons over HTTP as with the example data. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { session } from '../../../data/reality/09/testing';
import { selectAccountingPresentation } from '../../../data/pos/projection';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailFooterContext } from '../../../ui';
import { AccountingPresentationProvider } from './ledger';
import { structureDifference, windowStructure } from './parity-structure';
import { TaxDetail } from './tax';

afterEach(cleanup);
const host = (): WidgetHost => ({ layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() });
const asOf = `${TODAY}T06:45:00Z`;
const page = { asOf, sourceRevision: 19, nextCursor: null };
const payment = { taxPaymentId: 'payment-1', type: '교육세', amount: 18300, status: 'unpaid', dueOn: TODAY, paidOn: null, evidence: 'none', evidenceFiles: [], overdue: false, revision: 2, createdAt: asOf, updatedAt: asOf, paidRecordedAt: null };
const review = { refId: 'expense-1', expenseId: 'expense-1', refType: 'expense', date: TODAY, amount: 9000, memo: '봉투', category: 'supplies', reason: 'missing-evidence', status: 'needs-check', expenseRevision: 4, reviewRevision: null, checkedAt: null };

/** The money session of the finance cards plus the tax service: both domains over HTTP, the rest from the seed. */
async function httpSession() {
  const money = await session();
  const { backend, store } = money;
  backend.on('GET', '/pos/tax-payments', () => ({ ...page, today: TODAY, items: [payment] }));
  backend.on('GET', '/pos/tax-reviews', call => ({ ...page, ...call.query, reviewCount: call.query.to === TODAY ? 1 : 0, items: call.query.to === TODAY ? [review] : [] }));
  backend.on('GET', '/pos/tax-exports/preview', call => ({
    ...page, ...call.query, connections: [], officialLinks: { hometax: 'https://www.hometax.go.kr/' }, estimate: null,
    preview: { sales: { total: 9000 }, deposits: { total: 9000 }, expenses: { total: 9000, count: 1, evidenceRecorded: 0, missingEvidence: 1 },
      reviews: { needsCheck: 1, checked: 0 }, taxPayments: { count: 1, paidTotal: 0, unpaidTotal: 18300, withEvidenceFile: 0 }, cashReceipts: null, rowCount: 2 },
    verification: { status: 'verified', checks: [] },
  }));
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'tax' || domain === 'money' ? 'http' : 'fixture' });
  store.bindReal(port);
  await port.load('money');
  await port.load('tax');
  return store;
}
/** The checked item and the "more items" button show the owner's own records, whose number differs between the service and the example day. */
const DATA = '[data-slot="tax.item"], .mm-select-list ~ button';
const detail = () => <TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host()} />;

it('shows the same tabs, sales and deposit cards, export rows and buttons of 세무관리 over HTTP and with the example data', async () => {
  const seen: ReturnType<typeof windowStructure>[][] = [];
  for (const mode of ['http', 'example'] as const) {
    const store = mode === 'http' ? await httpSession() : createWidgetDataStore();
    const { container } = renderWithKit(<AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>{detail()}</AccountingPresentationProvider>, { store, reducedMotion: true });
    await screen.findByRole('tab', { name: '세무 자료' });
    await screen.findByRole('heading', { name: '실제 입금' });
    const tabs = [windowStructure(container, DATA)];
    fireEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '세금 납부 이력' })).toHaveAttribute('aria-selected', 'true'));
    const table = screen.getByRole('grid', { name: '세금 납부 이력' });
    expect(table.style.getPropertyValue('--data-grid-columns').split(' ')[0]).not.toMatch(/^minmax/);
    tabs.push(windowStructure(container, DATA));
    seen.push(tabs);
    cleanup();
  }
  const [http, example] = seen;
  expect(http![0]!.tabs).toEqual(['세무 자료', '세금 납부 이력']);
  const optionalTotals = new Set(['매출 합계', '실제 입금']);
  const totals = (structure: ReturnType<typeof windowStructure>) => structure.tables.flatMap(table => table.rows.filter(row => optionalTotals.has(row)));
  const withoutOptionalTotals = (structure: ReturnType<typeof windowStructure>) => ({
    ...structure, tables: structure.tables.map(table => ({ ...table, rows: table.rows.filter(row => !optionalTotals.has(row)) })),
  });
  http!.forEach((structure, index) => expect(structureDifference(withoutOptionalTotals(structure), withoutOptionalTotals(example![index]!)), `tab ${index}`).toEqual({}));
  // The example totals match its cards. This HTTP session deliberately supplies a distinct export basis.
  expect(totals(example![0]!)).toEqual([]);
  expect(totals(http![0]!)).toEqual(['매출 합계', '실제 입금']);
}, 60_000);

it('places the accountant file action and format control in the same fixed footer in both modes', async () => {
  for (const store of [createWidgetDataStore(), await httpSession()]) {
    const slot = document.createElement('footer');
    document.body.append(slot);
    try {
      const rendered = renderWithKit(<DetailFooterContext.Provider value={{ slot, claim: () => {} }}>
        <AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>{detail()}</AccountingPresentationProvider>
      </DetailFooterContext.Provider>, { store, reducedMotion: true });
      expect(await within(slot).findByRole('button', { name: '세무사 자료 받기' })).toBeInTheDocument();
      expect(within(slot).getByRole('radio', { name: 'CSV' })).toBeInTheDocument();
      expect(within(rendered.container).queryByRole('button', { name: '세무사 자료 받기' })).toBeNull();
    } finally {
      cleanup();
      slot.remove();
    }
  }
}, 60_000);
