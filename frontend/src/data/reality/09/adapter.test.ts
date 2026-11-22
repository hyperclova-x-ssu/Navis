import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, selectWidget } from '../../widget-data';
import { addDays, LAST_MONTH_START, TODAY } from '../../db/time';
import { selectAccountingPresentation } from '../../pos/projection';
import { selectClosing } from '../../derive/payments';
import { reply } from '../00/testing';
import { projectMenuWidget } from '../../../features/assistant/domains/menu';
import { projectMoneyFacts, receiptExpenseDraft, receiptExpenseProposal } from '../../../features/assistant/domains/money';
import { createAgentActions } from '../../../features/assistant/agent-actions';
import type { ExpenseDto } from './dto';
import { emptyTotals, sumTotals } from './dto';
import { CLOSING_ID, page, session, withoutMethods } from './testing';

const YESTERDAY = addDays(TODAY, -1);
type ModelShape = { sales: { net: number; gross: number; discount: number; refund: number }; remaining: number | null; candidates: readonly { expenseId: string }[];
  expenses: { total: number }; netSales: number; cost: number | null; grossProfit: number | null; rate: number | null; costMissing: boolean };
const model = (store: ReturnType<typeof createWidgetDataStore>, id: 'ledger' | 'margin', condition: Parameters<typeof selectWidget>[2] = { kind: 'default' }) => {
  const view = selectWidget(store.getSnapshot(), id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} is ${view.status}`);
  return view.model as unknown as ModelShape;
};

describe('money domain over the POS finance API', () => {
  it('shows the linked settlement in the seven-day ledger after re-reading deposits over HTTP', async () => {
    const { store, backend, port } = await session();
    const transactions = [TODAY, YESTERDAY, addDays(TODAY, -10)].map((businessDate, index) => ({
      depositId: `deposit-${index}`, settlementId: `settlement-${index}`, paymentId: `payment-${index}`, correctionId: null,
      purpose: 'sale', businessDate, at: `${businessDate}T17:00:00Z`, kind: 'payment', amount: 3000,
      splits: [{ method: 'cash', amount: 3000 }], transactionNo: `T-${index}`,
    }));
    backend.on('GET', '/pos/deposits', ({ query }) => page(transactions.filter(row =>
      row.businessDate >= query.from! && row.businessDate <= query.to!)));
    await port.retry('money');

    const { views } = selectAccountingPresentation(store.getSnapshot());
    const ids = (start: string) => {
      const view = views.find(view => view.period.start === start && view.period.end === TODAY);
      return view?.status === 'ready' && view.transactions.map(row => row.settlementId);
    };
    expect(ids(addDays(TODAY, -6))).toEqual(['settlement-0', 'settlement-1']);
    expect(ids(TODAY)).toEqual(['settlement-0']);
    expect(ids(addDays(TODAY, -29))).toEqual(['settlement-0', 'settlement-1', 'settlement-2']);
    const requestedStart = backend.callsTo('GET', '/pos/deposits').at(-1)?.query.from;
    expect(requestedStart && requestedStart <= LAST_MONTH_START).toBe(true);
  });

  it('grounds the menu period rate in recognized POS sales and sale-time cost', async () => {
    const { store } = await session();
    const snapshot = store.getSnapshot();
    const condition = { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } as const;
    const result = projectMenuWidget(snapshot, 'margin', condition, 'ko');
    expect(result).toMatchObject({ facts: expect.arrayContaining([
      expect.objectContaining({ key: 'margin.menu.salesRate', label: '아메리카노', value: 66.7, start: condition.start, end: condition.end }),
      expect.objectContaining({ key: 'margin.menu.salesCost', label: '아메리카노', value: 3000, start: condition.start, end: condition.end }),
    ]) });
  });

  it('reads the ledger, margin, accounting cards and day close from the service tables', async () => {
    const { store, backend } = await session();
    const ledger = model(store, 'ledger');
    expect(ledger.sales).toMatchObject({ net: 9000, gross: 10000, discount: 500, refund: 500 });
    expect(ledger.remaining).toBe(9000);
    expect(ledger.candidates.map((row: { expenseId: string }) => row.expenseId)).toEqual(['candidate-1']);
    expect(ledger.expenses.total).toBe(0);
    // Margin: sales − source cost; the cost is `null` (never a number) while a sale in the period has no cost.
    const today = model(store, 'margin');
    expect(today).toMatchObject({ netSales: 9000, cost: 3000, grossProfit: 6000, costMissing: false });
    const week = model(store, 'margin', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY });
    expect(week).toMatchObject({ netSales: 15000, cost: null, grossProfit: null, rate: null, costMissing: true });
    const views = selectAccountingPresentation(store.getSnapshot()).views;
    const view = views.find(v => v.status === 'ready' && v.period.start === TODAY && v.period.end === TODAY);
    expect(view).toMatchObject({ status: 'ready', source: 'http', summary: { sales: { total: 9000 }, deposits: { byMethod: { cash: 4000, card: 5000 } } } });
    expect(view?.status === 'ready' && view.transactions).toMatchObject([{ id: 'dep-1', amount: 4000, kind: 'receipt', salesAmount: null }]);
    const weekView = views.find(v => v.status === 'ready' && v.period.start === addDays(TODAY, -6));
    expect(weekView?.status === 'ready' && weekView.unknownCostSales).toMatchObject([{ sourceId: 'source', amount: 4000, cost: null, label: '케이크 주문' }]);
    expect(selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' }).status).toBe('open');
    expect(backend.callsTo('GET', '/pos/margins')).toHaveLength(3);
  });

  it('records an expense only after the receipt, re-reads it and lets the owner undo it through that receipt', async () => {
    const { store, backend, state } = await session();
    backend.on('POST', '/pos/expenses', call => {
      const body = call.body as { date: string; category: ExpenseDto['category']; amount: number; evidence: ExpenseDto['evidence']; memo?: string };
      state.expenses.push({ expenseId: 'expense-1', businessDate: body.date, category: body.category, amount: body.amount, evidence: body.evidence, memo: body.memo ?? null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
      return { resourceId: 'expense-1', revision: 1, receiptId: 'receipt-e1', undoUntil: '2999-01-01T00:00:00Z', affectedSources: ['pos.expenses', 'pos.ledger', 'pos.closings', 'pos.finance'] };
    });
    backend.on('POST', '/pos/finance/receipts/receipt-e1/undo', () => { state.expenses.length = 0; return { resourceId: 'expense-1', revision: 2, receiptId: 'undo-e1', affectedSources: ['pos.expenses', 'pos.ledger'] }; });
    const command = { type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 2000, evidence: 'receipt', memo: '컵 홀더' } as const;
    expect(store.dispatch(command)).toMatchObject({ ok: false, reason: 'ASYNC_REQUIRED' });
    const [first, second] = await Promise.all([store.execute(command), store.execute(command)]);
    expect(first).toMatchObject({ ok: true, undoToken: 'real-undo:receipt-e1', noticeKey: 'data.management.notice.saved' });
    expect(second).toEqual(first);
    const posts = backend.callsTo('POST', '/pos/expenses');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ date: TODAY, category: 'supplies', amount: 2000, evidence: 'receipt', memo: '컵 홀더' });
    expect(posts[0]!.headers.get('idempotency-key')).toBeTruthy();
    const ledger = model(store, 'ledger');
    expect(ledger.expenses).toMatchObject({ total: 2000 });
    expect(ledger.remaining).toBe(7000);
    expect(selectAccountingPresentation(store.getSnapshot()).views[0]).toMatchObject({ summary: { expenses: 2000, profit: 7000 } });
    expect(await store.real!.undo('real-undo:receipt-e1')).toMatchObject({ ok: true });
    expect(model(store, 'ledger').expenses.total).toBe(0);
  });

  it('keeps the duplicate answer for the form and the closed-day refusal readable', async () => {
    const { store, backend } = await session();
    const duplicate = { expenseId: 'old', date: TODAY, category: 'supplies', amount: 2000 };
    backend.on('POST', '/pos/expenses', () => reply(409, { code: 'CONFLICT', reason: 'LIKELY_DUPLICATE_EXPENSE', details: duplicate }));
    const command = { type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 2000 } as const;
    expect(await store.execute(command)).toMatchObject({ ok: false, reason: 'LIKELY_DUPLICATE_EXPENSE', messageKey: 'data.management.error.LIKELY_DUPLICATE_EXPENSE', details: duplicate });
    backend.on('POST', '/pos/expenses', () => reply(409, { code: 'CONFLICT', reason: 'DAY_CLOSED' }));
    expect(await store.execute({ ...command, amount: 2100 })).toMatchObject({ ok: false, reason: 'DAY_CLOSED', messageKey: 'data.management.error.EXPENSE_DAY_CLOSED' });
  });

  it('confirms a purchase candidate with its server revision and maps the receipt window refusal', async () => {
    const { store, backend, state } = await session();
    backend.on('POST', '/pos/expense-candidates/candidate-1/confirm', call => {
      expect(call.body).toEqual({ expectedRevision: 3 });
      const [candidate] = state.candidates.splice(0, 1);
      state.expenses.push({ ...candidate!, status: 'confirmed', revision: 4 });
      return { resourceId: 'candidate-1', revision: 4, receiptId: 'receipt-c1', affectedSources: ['pos.expenses', 'pos.ledger', 'pos.finance'] };
    });
    expect(await store.execute({ type: 'ledger.confirmCandidate', expenseId: 'candidate-1' })).toMatchObject({ ok: true });
    const ledger = model(store, 'ledger');
    expect(ledger.candidates).toEqual([]);
    expect(ledger.expenses).toMatchObject({ total: 2300 });
    backend.on('POST', '/pos/expense-candidates/candidate-1/confirm', () => reply(409, { code: 'CONFLICT', reason: 'RECEIPT_PENDING' }));
    expect(await store.execute({ type: 'ledger.confirmCandidate', expenseId: 'candidate-1' })).toMatchObject({ ok: false, reason: 'RECEIPT_PENDING', messageKey: 'data.management.error.RECEIPT_PENDING' });
  });

  it('closes and reopens the day with the revision the owner saw, and saves the drawer count', async () => {
    const { store, backend, state } = await session();
    backend.on('POST', '/pos/closings', call => {
      expect(call.body).toEqual({ businessDate: TODAY, expectedRevision: 11 });
      state.closed = true; state.revision = 12;
      return { resourceId: CLOSING_ID, revision: 12, receiptId: 'receipt-close', closingId: CLOSING_ID, affectedSources: ['pos.closings', 'pos.ledger', 'pos.finance'] };
    });
    const close = await store.execute({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: 0, idempotencyKey: 'close-1' });
    expect(close).toMatchObject({ ok: true, noticeKey: 'data.management.notice.closed' });
    expect(selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' })).toMatchObject({ status: 'closed', closingId: CLOSING_ID, generation: 12 });
    backend.on('POST', `/pos/closings/${CLOSING_ID}/reopen`, call => {
      expect(call.body).toEqual({ confirmed: true, expectedRevision: 12 });
      state.closed = false; state.revision = 13;
      return { resourceId: CLOSING_ID, revision: 13, receiptId: 'receipt-reopen', affectedSources: ['pos.closings', 'pos.ledger', 'pos.finance'] };
    });
    expect(await store.execute({ type: 'closing.undoDay', date: TODAY, scenario: 'normal', closingId: CLOSING_ID, idempotencyKey: 'reopen-1' })).toMatchObject({ ok: true });
    expect(selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' }).status).not.toBe('closed');
    backend.on('PATCH', `/pos/closings/${TODAY}/drawer`, call => {
      expect(call.body).toEqual({ actual: 14000, expectedRevision: 13 });
      state.drawerActual = 14000; state.revision = 14;
      return { resourceId: TODAY, revision: 14, receiptId: 'receipt-drawer', affectedSources: ['pos.closings', 'pos.ledger', 'pos.finance'] };
    });
    expect(await store.execute({ type: 'closing.setDrawer', date: TODAY, actual: 14000 })).toMatchObject({ ok: true });
    expect(selectAccountingPresentation(store.getSnapshot()).views[0]).toMatchObject({ drawer: { actual: 14000, difference: 0, expected: 14000 } });
  });

  it('refuses the close while bills are unpaid with a readable message', async () => {
    const { store, backend } = await session();
    backend.on('POST', '/pos/closings', () => reply(409, { code: 'CONFLICT', reason: 'CLOSING_BLOCKED', details: { pendingBills: ['bill-1'] } }));
    expect(await store.execute({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: 11, idempotencyKey: 'blocked' })).toMatchObject({ ok: false, reason: 'CLOSING_BLOCKED', messageKey: 'data.management.error.CLOSING_BLOCKED' });
  });

  it('drops every finance row when access ends', async () => {
    const { store, backend, port } = await session();
    backend.on('GET', '/pos/ledger', () => reply(403, { code: 'STORE_FORBIDDEN' }));
    await port.retry('money');
    const tables = store.getSnapshot().tables;
    expect(tables.realFinance).toBeUndefined();
    expect(tables.expense).toEqual([]);
    // The service's day rows are gone (the POS state still projects its own row for today).
    expect(tables.dailySales.filter(row => row.businessDate === YESTERDAY)).toEqual([]);
    expect(tables.dayClosing).toEqual([]);
  });

  it('serves Navis ledger facts from the service rows, not the sample history', async () => {
    const { store } = await session();
    const result = projectMoneyFacts(store.getSnapshot(), 'ledger', { kind: 'default' }, 'ko');
    const facts = (result && 'facts' in result ? result.facts : []) as readonly { key: string; value: string | number }[];
    const byKey = (key: string) => facts.filter(fact => fact.key === key).map(fact => fact.value);
    expect(byKey('ledger.sales.net')).toEqual([9000]);
    expect(byKey('ledger.sales.hourly')).toEqual([9000]);
    expect(byKey('ledger.sales.menu')).toEqual([9000]);
    expect(byKey('ledger.candidates.count')).toEqual([1]);
    expect(byKey('ledger.closing.status')).toEqual(['open']);
  });

  it('runs the same expense command only when the Navis card is confirmed and settles it from the service receipt', async () => {
    const { store, backend, state } = await session({ runId: 'expense-http' });
    backend.on('POST', '/pos/expenses', call => {
      const body = call.body as { date: string; category: ExpenseDto['category']; amount: number; evidence: ExpenseDto['evidence'] };
      state.expenses.push({ expenseId: 'expense-n', businessDate: body.date, category: body.category, amount: body.amount, evidence: body.evidence, memo: null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
      return { resourceId: 'expense-n', revision: 1, receiptId: 'receipt-n', undoUntil: '2999-01-01T00:00:00Z', affectedSources: ['pos.expenses', 'pos.ledger', 'pos.finance'] };
    });
    const fields = { ...receiptExpenseDraft().fields, date: TODAY, amount: 3000, category: 'supplies' as const };
    const validation = receiptExpenseProposal(fields, TODAY, false);
    if ('invalid' in validation) throw new Error(`The expense draft is invalid (${validation.invalid})`);
    const snapshot = store.getSnapshot();
    const prepared = createAgentActions(store).prepare({ command: 'ledger.recordExpense', args: validation.args, snapshotRevision: snapshot.revision, proposalId: 'wire-expense',
      runId: 'expense-http', layer: 'management', tier: 'normal' } as never, validation.slots, snapshot);
    if (prepared.kind !== 'proposal') throw new Error(`The Navis expense card did not resolve (${prepared.kind})`);
    const card = prepared.proposal;
    // Typed or spoken text never commits: nothing is sent until the owner presses the card.
    expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(0);
    expect(card.confirm(store)).toMatchObject({ pending: true });
    card.confirm(store);
    expect(await card.settled()).toMatchObject({ frame: { outcome: 'applied' }, undoToken: 'real-undo:receipt-n' });
    expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(1);
    expect(backend.callsTo('POST', '/pos/expenses')[0]!.body).toMatchObject({ date: TODAY, category: 'supplies', amount: 3000 });
    expect(model(store, 'ledger').expenses.total).toBe(3000);
  });
});

describe('sales by real tender over HTTP (B09-2 sales.byMethod)', () => {
  type SalesRead = { total: number; byMethod?: Record<string, number>; byRealMethodSale: Record<string, number>; chargeUsed: number; receivableCreated: number };
  const todayView = (store: ReturnType<typeof createWidgetDataStore>) => {
    const view = selectAccountingPresentation(store.getSnapshot()).views.find(v => v.status === 'ready' && v.period.start === TODAY && v.period.end === TODAY);
    if (!view || view.status !== 'ready') throw new Error('today view is not ready');
    return view.summary.sales as unknown as SalesRead;
  };
  const factsOf = (store: ReturnType<typeof createWidgetDataStore>) => {
    const result = projectMoneyFacts(store.getSnapshot(), 'ledger', { kind: 'default' }, 'ko');
    return (result && 'facts' in result ? result.facts : []) as readonly { key: string; value: string | number; display: string }[];
  };

  it('binds the service split to the ledger, the accounting card and the sums of days; mixed overlaps and is never added', async () => {
    const { store } = await session();
    const ledger = model(store, 'ledger') as unknown as { sales: { byMethod: Record<string, number>; byMethodKnown?: boolean } };
    expect(ledger.sales.byMethod).toEqual({ card: 3000, cash: 4000, easyPay: 0 });
    expect(ledger.sales.byMethodKnown).toBe(true);
    const sales = todayView(store);
    expect(sales.byMethod).toEqual({ cash: 4000, card: 3000, easy_pay: 0, charge: 2000, receivable: 0, mixed: 5000 });
    expect(sales.byRealMethodSale).toEqual({ card: 3000, easy_pay: 0, cash: 4000 });
    expect(sales).toMatchObject({ chargeUsed: 2000, receivableCreated: 0 });
    // The five tender amounts make the recognized total; the mixed subtotal is already inside them.
    const { mixed, ...tender } = sales.byMethod!;
    expect(Object.values(tender).reduce((n, v) => n + v, 0)).toBe(sales.total);
    expect(mixed).toBeGreaterThan(0);
    // A period sums the service's days field by field (cash 4,000 + 6,000), mixed included.
    const week = selectAccountingPresentation(store.getSnapshot()).views.find(v => v.status === 'ready' && v.period.start === addDays(TODAY, -6));
    expect(week?.status === 'ready' && week.summary.sales).toMatchObject({ total: 15000, byMethod: { cash: 10000, card: 3000, charge: 2000, mixed: 5000 } });
  });

  it('gives Navis the same split as separate facts, with mixed named as an overlapping subtotal', async () => {
    const { store } = await session();
    const facts = factsOf(store);
    const value = (key: string) => facts.find(fact => fact.key === key)?.value;
    expect(value('ledger.sales.method.card')).toBe(3000);
    expect(value('ledger.sales.method.cash')).toBe(4000);
    expect(value('ledger.sales.method.charge')).toBe(2000);
    expect(value('ledger.sales.method.mixed')).toBe(5000);
    expect(facts.find(fact => fact.key === 'ledger.sales.method.mixed')?.display).toMatch(/겹/);
    expect(value('ledger.sales.net')).toBe(9000);
  });

  it('says "not available" for a service or archived snapshot without the field, never zeros', async () => {
    const { store, state, fake, port } = await session();
    state.archived.push({ ...fake.closing(), businessDate: YESTERDAY, status: 'closed', closingId: 'archived-1', closedAt: `${YESTERDAY}T14:00:00.000Z`, revision: 4,
      totals: withoutMethods(fake.totals().yesterday) });
    state.noMethods = true;
    await port.retry('money');
    const ledger = model(store, 'ledger') as unknown as { sales: { byMethodKnown?: boolean } };
    expect(ledger.sales.byMethodKnown).toBe(false);
    expect(todayView(store).byMethod).toBeUndefined();
    const old = selectAccountingPresentation(store.getSnapshot()).history.find(v => v.period.start === YESTERDAY);
    expect(old).toMatchObject({ status: 'ready', summary: { sales: { total: 6000 } } });
    expect(old?.status === 'ready' && old.summary.sales.byMethod).toBeUndefined();
    expect(factsOf(store).filter(fact => fact.key.startsWith('ledger.sales.method.'))).toEqual([]);
  });

  it('keeps a sum unavailable when any included day lacks the split', () => {
    const withSplit = { ...emptyTotals(), sales: { ...emptyTotals().sales, total: 8000, byMethod: { cash: 4000, card: 3000, easy_pay: 0, charge: 1000, receivable: 0, mixed: 5000 } } };
    expect(sumTotals([withSplit, withoutMethods(withSplit)]).sales.byMethod).toBeUndefined();
    expect(sumTotals([withSplit, withSplit]).sales.byMethod).toEqual({ cash: 8000, card: 6000, easy_pay: 0, charge: 2000, receivable: 0, mixed: 10000 });
    expect(sumTotals([]).sales.byMethod).toEqual({ cash: 0, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 });
  });
});
