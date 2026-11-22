/** F09 test helper: an in-memory POS finance service behind the F00 fake fetch, with the `money` domain loaded over HTTP. Not shipped in the app bundle. */
import { createWidgetDataStore } from '../../widget-data';
import { addDays, TODAY } from '../../db/time';
import { createRealPort } from '../00';
import { autoloadedAdapters } from '../00/autoload';
import { fakeBackend } from '../00/testing';
import { emptyTotals, type ClosingDto, type ExpenseDto, type FinanceTotalsDto, type MarginDto, type SalesByMethodDto } from './dto';

export const YESTERDAY = addDays(TODAY, -1);
export const AS_OF = `${TODAY}T06:00:00.000Z`;
export const page = (items: readonly unknown[]) => ({ items, nextCursor: null, asOf: AS_OF, sourceRevision: items.length + 1 });
export const CLOSING_ID = '22222222-2222-4222-8222-222222222222';

/**
 * B09-2 tender of the day's recognized sales. Today (₩9,000): ₩4,000 cash plus one ₩5,000 sale paid with card ₩3,000 and charge ₩2,000, so the mixed
 * subtotal (₩5,000) overlaps the method amounts. Any other day is all cash.
 */
export const methodsOf = (sales: number): SalesByMethodDto => sales === 9000
  ? { cash: 4000, card: 3000, easy_pay: 0, charge: 2000, receivable: 0, mixed: 5000 }
  : { cash: sales, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 };
/** A snapshot archived before B09-2 (or a service that does not send the field). */
export const withoutMethods = (totals: FinanceTotalsDto): FinanceTotalsDto => {
  const { gross, discount, refund, total, bySource } = totals.sales;
  return { ...totals, sales: { gross, discount, refund, total, bySource } };
};

/** Today: ₩9,000 recognized (₩10,000 − ₩500 discount − ₩500 refund), ₩3,000 known cost, ₩2,000 expenses. Yesterday has a pickup without a cost. */
function day(base: Partial<FinanceTotalsDto>, sales: number, cost: number | null, expenses = 0, byMethod: SalesByMethodDto = methodsOf(sales)): FinanceTotalsDto {
  const total = emptyTotals();
  return { ...total, ...base, sales: { gross: sales + 1000, discount: 500, refund: 500, total: sales, bySource: { menu: cost === null ? sales - 4000 : sales, customPickup: cost === null ? 4000 : 0 }, byMethod },
    expenses, cost, knownCost: cost ?? 1000, unknownCostCount: cost === null ? 1 : 0, unknownCostSales: cost === null ? 4000 : 0, profit: sales - expenses,
    contribution: cost === null ? null : sales - cost, orderCount: 2, realPaymentCount: 2,
    deposits: { ...total.deposits, gross: sales, total: sales, byMethod: { card: 5000, easy_pay: 0, cash: sales - 5000 }, byMethodGross: { card: 5000, easy_pay: 0, cash: sales - 5000 },
      byPurpose: { ...total.deposits.byPurpose, sale: sales } } };
}

function server() {
  const state = { expenses: [] as ExpenseDto[], candidates: [] as ExpenseDto[], closed: false, revision: 11, drawerActual: null as number | null,
    /** `true`: the ledger and today's closing omit `sales.byMethod` (a service older than B09-2). */
    noMethods: false,
    /** Frozen closings of earlier days, listed by `GET /closings` (an archived snapshot may predate `byMethod`). */
    archived: [] as ClosingDto[] };
  state.candidates.push({ expenseId: 'candidate-1', businessDate: TODAY, category: 'ingredients', amount: 2300, evidence: 'receipt', memo: null, supplierId: null, receiptId: 'receipt-1', status: 'candidate', revision: 3 });
  const totals = () => {
    const spent = state.expenses.reduce((n, e) => n + e.amount, 0);
    const today = day({}, 9000, 3000, spent), yesterday = day({}, 6000, null);
    return state.noMethods ? { today: withoutMethods(today), yesterday: withoutMethods(yesterday) } : { today, yesterday };
  };
  const closing = (): ClosingDto => ({
    businessDate: TODAY, status: state.closed ? 'closed' : 'open', revision: state.revision, totals: totals().today, pendingBills: [], writable: !state.closed,
    closingId: state.closed ? CLOSING_ID : null, closedAt: state.closed ? AS_OF : null, reopenedAt: null,
    drawer: { opening: 10000, actual: state.drawerActual, memo: '', expected: 14000, difference: state.drawerActual === null ? null : state.drawerActual - 14000, in: 0, out: 0, cashApproved: 4000, cashReturned: 0, movements: [] },
  });
  const margin = (kind: 'menu' | 'custom-pickup', over: Partial<MarginDto>): MarginDto => ({ marginId: `m-${kind}`, kind, menuId: null, name: '', recipeVersion: null, settlementId: null, sourceId: 'source', quantity: 1, sales: 0, discount: 0, refund: 0,
    unitPrice: null, unitCost: null, cost: 0, knownCost: 0, unknownCostCount: 0, contribution: 0, unitMargin: null, ...over });
  return { state, closing, totals, margin };
}

export async function session(options?: Parameters<typeof createWidgetDataStore>[1]) {
  const store = createWidgetDataStore(undefined, options);
  const menuId = store.getSnapshot().tables.menuItem[0]!.menuId;
  const backend = fakeBackend();
  const fake = server();
  const { state } = fake;
  backend.on('GET', '/pos/ledger', () => {
    const { today, yesterday } = fake.totals();
    return { from: addDays(TODAY, -59), to: TODAY, totals: today, days: [{ businessDate: YESTERDAY, ...yesterday }, { businessDate: TODAY, ...today }], hours: [{ businessDate: TODAY, hour: 10, sales: 9000 }], asOf: AS_OF, sourceRevision: 7 };
  });
  backend.on('GET', '/pos/deposits', () => page([{ depositId: 'dep-1', paymentId: 'pay-1', correctionId: null, settlementId: 'set-1', purpose: 'sale', businessDate: TODAY, at: AS_OF, kind: 'payment', splits: [{ method: 'cash', amount: 4000 }], amount: 4000, transactionNo: 'T-1' }]));
  backend.on('GET', '/pos/margins', call => {
    const week = call.query.from !== TODAY;
    const sold = fake.margin('menu', { marginId: 'm-1', menuId, name: '아메리카노', quantity: 2, sales: 9000, cost: 3000, knownCost: 3000, contribution: 6000, unitPrice: 4500, unitCost: 1500 });
    const pickup = fake.margin('custom-pickup', { marginId: 'm-2', name: '케이크 주문', sales: 4000, cost: null, knownCost: 0, unknownCostCount: 1, contribution: null });
    return page(week ? [sold, pickup] : [sold]);
  });
  backend.on('GET', '/pos/expenses', () => page(state.expenses));
  backend.on('GET', '/pos/expense-candidates', () => page(state.candidates));
  backend.on('GET', `/pos/closings/${TODAY}`, () => fake.closing());
  backend.on('GET', '/pos/closings', () => page([...state.archived, ...(state.closed ? [fake.closing()] : [])]));
  const port = createRealPort({ store, source: domain => domain === 'money' ? 'http' : 'fixture', adapters: autoloadedAdapters(), fetch: backend.fetch });
  store.bindReal(port);
  if ((await port.load('money')).status !== 'ready') throw new Error('The money domain did not load');
  return { backend, state, store, port, fake };
}
