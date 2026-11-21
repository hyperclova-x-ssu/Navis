// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createWidgetDataStore, deriveOpenOrders, deriveStock, TODAY } from '../../../data/widget-data';
import { createAgentActions } from '../agent-actions';
// @ts-expect-error The shared corpus loader is JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';
// @ts-expect-error Server adapter modules have no TypeScript declarations.
import { createSupplierAdapters } from '../../../../server/navis/suppliers.mjs';
// @ts-expect-error Server adapter modules have no TypeScript declarations.
import { navigationAdapters } from '../../../../server/navis/navigation.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
import { addDays } from '../../../data/db/time';
import { readModel, resolveDataText, selectCalendar, selectMenus } from '../../../data/widget-data';
import { createAssistantProvider } from '../provider';
import { navisTranslator } from '../messages';
import { createDomainRegistry, registeredDomains } from './registry';
import { createSuppliersDomain, projectSupplierFacts, supplierDetailEntry, suppliersDomain } from './suppliers';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { createRunStore } from '../../../state';
import { beginDashboard } from '../../../app/test-session';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import type { DataSnapshot } from '../../../data/db/types';

const domain = createSuppliersDomain({ allowLocalScheduling: true });
const registry = createDomainRegistry([domain]);
const milk = 'i-milk';

function fixtureOrder(store = createWidgetDataStore(), qty = 12) {
  const item = store.getSnapshot().tables.purchaseItem.find(row => row.itemId === milk)!;
  const result = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: item.purchaseItemId, qty, dueDate: TODAY, idempotencyKey: 'fixture-order' });
  if (!result.ok) throw Error(result.messageKey);
  const order = deriveOpenOrders(store.getSnapshot(), { date: TODAY }).open.find(row => row.lines.some(line => line.itemId === milk))!;
  return { store, item, order };
}

it('S1-220 records one receipt and expense candidate, then restores both via the receipt undo', () => {
  const { store, order } = fixtureOrder();
  const before = store.getSnapshot(), line = order.lines[0];
  const match = registry.reader('purchaseOrderLine')!.search({ snapshot: before, query: '우유', privateLookup: true, locale: 'ko' })[0];
  const actions = createAgentActions(store, registry);
  const prepared = actions.prepare({ proposalId: 'wire-receipt', command: 'suppliers.recordReceipt',
    args: { polId: { handle: match.handle }, qty: { slot: 'qty' } }, snapshotRevision: before.revision, runId: before.runId!, layer: 'management', tier: 'normal' },
  { qty: 12 }, before, undefined, new Map([[match.handle, { kind: 'purchaseOrderLine', id: line.polId }]]));
  expect(prepared.kind).toBe('proposal');
  if (prepared.kind !== 'proposal') throw Error(prepared.kind);
  expect(store.getSnapshot()).toBe(before);
  expect(prepared.proposal.confirm(createWidgetDataStore()).frame.outcome).toBe('conflict');
  const receipt = prepared.proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  expect(prepared.proposal.confirm(store).frame).toEqual(receipt.frame);
  const after = store.getSnapshot();
  expect(after.tables.receipt).toHaveLength(before.tables.receipt.length + 1);
  expect(after.tables.expense.at(-1)).toMatchObject({ status: 'candidate', amount: line.unitPrice * 12 });
  expect(after.tables.purchaseOrder.find(row => row.poId === order.poId)?.status).toBe('complete');
  const stock = (snapshot: typeof before) => deriveStock(snapshot, { date: TODAY }).rows.find(row => row.itemId === milk)!.stock;
  expect(stock(after) - stock(before)).toBeCloseTo(line.basePerUnit! * 12);
  expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
  for (const table of ['purchaseOrder', 'purchaseOrderLine', 'receipt', 'expense'] as const) {
    expect(store.getSnapshot().tables[table]).toEqual(before.tables[table]);
  }
});

it('S1-209 calculates a read-only estimate and S1-236 rejects a time change', () => {
  const { store } = fixtureOrder();
  const before = store.getSnapshot();
  expect(domain.route('우유 10리터 발주 초안 만들어줘', before, 'ko')).toMatchObject({ intent: { kind: 'read', recordKind: 'purchaseItem', querySlot: 'estimate' } });
  expect(domain.route('우유 입고 오후 5시로 바꿔줘', before, 'ko')).toMatchObject({ kind: 'refusal' });
  expect(store.getSnapshot()).toBe(before);
});

it('shows zero upcoming orders and opens a validated, unsaved prefilled order form', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(projectSupplierFacts(snapshot, 'suppliers', { kind: 'default' }, 'ko')).toMatchObject({
    facts: expect.arrayContaining([expect.objectContaining({ key: 'suppliers.upcoming.count', value: 0 })]),
  });
  const item = snapshot.tables.purchaseItem.find(row => row.itemId === milk)!;
  expect(supplierDetailEntry({ featureId: 'suppliers', view: 'register', prefill: { kind: 'widget-draft', command: 'suppliers.createOrder', fields: { purchaseItemId: item.purchaseItemId, qty: 12, dueDate: TODAY } } }, snapshot))
    .toMatchObject({ tab: 'orders', orderForm: { id: item.purchaseItemId, qty: 12, dueDate: TODAY } });
});

type Kind = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate';
interface CorpusRow {
  readonly id: string;
  readonly utterances: readonly string[];
  readonly expected: { readonly kind: Kind; readonly tools: readonly { readonly name: string; readonly args?: Record<string, unknown> }[]; readonly ask?: readonly string[]; readonly answer_must_contain?: readonly string[] };
}
interface TraceRow { readonly scenario_id: string; readonly slice_id: string; readonly required_slices: string }
const trace: TraceRow[] = readTrace();
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, { expected?: Partial<CorpusRow['expected']>; precondition?: string; utterances?: readonly string[] }>;
const corpus: CorpusRow[] = JSON.parse(evidence('MERGED.json'));
const scenarios = trace.filter(row => row.slice_id === 'N09').map(({ scenario_id }) => {
  const row = corpus.find(scenario => scenario.id === scenario_id)!;
  return { ...row, utterances: overlay[scenario_id]?.utterances ?? row.utterances, expected: { ...row.expected, ...overlay[scenario_id]?.expected } };
});
const fixtureSupplier = 'fixture-produce-supplier';
const beans = 'i-bean-house', cup = 'i-cup-takeout';
const formats = navisTranslator('ko');
const nameOf = (snapshot: DataSnapshot, itemId: string) => {
  const row = snapshot.tables.inventoryItem.find(item => item.itemId === itemId)!;
  return resolveDataText(formats.t, row.name ?? { key: row.nameKey });
};
const scenarioDomains = createDomainRegistry(registeredDomains.map(adapter => adapter === suppliersDomain ? domain : adapter));
const fakeBridge = () => createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
  createBridge({ ...options, agentMode: 'fake', onDiagnostics() {}, agentAdapters: [...createSupplierAdapters({ allowLocalScheduling: true }), ...navigationAdapters] }),
validateAgentFrame, navisAgentFakeFetch);

function scenarioStore(id: string, runId: string) {
  const store = createWidgetDataStore(undefined, { runId });
  const stock = store.getSnapshot();
  const orderSetup = (itemId: string, qty: number, dueDate = TODAY) => {
    const purchase = store.getSnapshot().tables.purchaseItem.find(row => row.itemId === itemId)!;
    const result = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: purchase.purchaseItemId, qty, dueDate, idempotencyKey: `fixture-${itemId}` });
    expect(result.ok).toBe(true);
    return deriveOpenOrders(store.getSnapshot(), { date: TODAY }).open.find(row => row.lines.some(line => line.itemId === itemId))!;
  };
  if (['S1-152', 'S1-220', 'S1-221', 'S1-222', 'S1-223', 'S1-224', 'S1-228', 'S1-230', 'S3-251'].includes(id)) {
    const order = orderSetup(milk, 12);
    if (id === 'S1-228') {
      expect(store.dispatch({ type: 'suppliers.recordReceipt', polId: order.lines[0].polId, qty: 12, idempotencyKey: 'fixture-receipt' }).ok).toBe(true);
    }
  }
  if (['S1-206', 'S1-229', 'S1-232', 'S1-233', 'S1-234'].includes(id)) orderSetup(beans, 2, addDays(TODAY, 1));
  if (['S1-227', 'S1-231', 'S1-237'].includes(id)) orderSetup(cup, 500);
  if (id === 'S1-219') expect(store.dispatch({ type: 'inventory.updateItem', itemId: cup, stock: 120 }).ok).toBe(true);
  if (id === 'S7-089') {
    const order = orderSetup(beans, 2);
    const snapshot = store.getSnapshot();
    return createWidgetDataStore({ purchaseOrder: [...stock.tables.purchaseOrder, { ...order, dueDate: addDays(TODAY, -2) }],
      purchaseOrderLine: snapshot.tables.purchaseOrderLine }, { runId });
  }
  if (['S1-249', 'S1-250'].includes(id)) {
    expect(store.dispatch({ type: 'inventory.createItem', sku: 'OAT-01', name: '귀리우유', unit: 'L', stock: 10, threshold: 1,
      idempotencyKey: 'fixture-oat' }).ok).toBe(true);
  }
  if (id === 'S1-260') {
    expect(overlay[id].precondition).toContain(fixtureSupplier);
    return createWidgetDataStore({ supplier: [...stock.tables.supplier, {
      supplierId: fixtureSupplier, name: { raw: 'E농산' }, nameKey: '', contactKey: '', phoneMask: '',
    }] }, { runId });
  }
  return store;
}

async function driveScenario(id: string, utterance: string, enableScheduling = true) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = scenarioStore(id, run.getState().runId), before = store.getSnapshot();
  const requests: AgentRequest[] = [], calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const provider = createAssistantProvider({ store, domains: enableScheduling ? scenarioDomains : undefined, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) return new Response(null, { status: 422 });
    requests.push(request);
    const bridge = fakeBridge();
    try {
      const result = await bridge.run(request);
      calls.push(...result.calls);
      return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
    } finally {
      bridge.close();
    }
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const plan = classifyNavigation(utterance, run.getState(), before);
  const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
  let detail: Record<string, unknown> | undefined;
  const reply = await provider.ask({ text: utterance, signal: new AbortController().signal, ...(prepared ? {
    agentTurn: prepared.agentTurn,
    onNavigation: action => { detail = prepared.resolve(action); },
  } : {}) });
  expect(store.getSnapshot()).toBe(before);
  if (detail && plan?.command === 'ui.openDetail') expect(await navigation.execute(plan.command, detail)).toBe('opened');
  const overlay = run.getState().overlay;
  const detailRef = overlay.type === 'detail' ? overlay.stack?.at(-1) : undefined;
  const actual: Kind = detailRef ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
    : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
      : reply.turn?.kind === 'refusal' ? 'refuse' : 'answer';
  const field = reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? reply.turn.field : undefined;
  return { actual, field, reply, detail: detailRef, before, store, provider, requests, calls };
}

describe('N09 café corpus', () => {
  it('accounts for the complete slice and downstream dependencies', () => {
    expect(scenarios).toHaveLength(70);
    expect(new Set(scenarios.map(row => row.id)).size).toBe(70);
    const dependent = trace.filter(row => row.required_slices.split('|').includes('N09'));
    expect(dependent).toHaveLength(80);
    expect(dependent.filter(row => row.slice_id !== 'N09').map(row => row.scenario_id)).toEqual([
      'S1-298', 'S1-319', 'S1-320', 'S1-322', 'S1-326', 'S1-329', 'S1-331', 'S4-125', 'S8-063', 'S8-070',
    ]);
  });

  it.each(scenarios)('$id verifies the café contract and traces its variants', async row => {
    const request = row.utterances[0];
    const result = await driveScenario(row.id, request);
    const expected = row.expected.kind;
    expect(result.actual, request).toBe(expected);
    await checkOutcome(row, result);

    // Exercise all authored texts, including those with obsolete names or dates.
    for (const [index, utterance] of corpus.find(scenario => scenario.id === row.id)!.utterances.entries()) {
      const variant = utterance === request ? result : await driveScenario(row.id, utterance);
      expect(variant.reply.answer || variant.detail || variant.reply.proposalSession, utterance).toBeTruthy();
      if (process.env.N09_OBSERVATIONS) appendFileSync(process.env.N09_OBSERVATIONS, JSON.stringify({
        id: row.id, variant: index + 1, utterance, expected: row.expected.kind, actual: variant.actual,
        field: variant.field, detail: variant.detail, copy: variant.reply.answer.replaceAll('\n', ' / ').slice(0, 180),
        calls: variant.calls.map(call => call.name), intent: variant.requests[0]?.intent,
      }) + '\n');
    }
  });
});

type Driven = Awaited<ReturnType<typeof driveScenario>>;
const changedTables = ['purchaseItem', 'supplier', 'purchaseOrder', 'purchaseOrderLine', 'receipt', 'expense'] as const;
const purchaseOf = (snapshot: DataSnapshot, itemId = milk) => snapshot.tables.purchaseItem.find(item => item.itemId === itemId)!;

async function checkOutcome(row: CorpusRow, result: Driven) {
  const { before, store, reply, detail, actual, calls } = result;
  const model = readModel(before, 'suppliers');
  if (actual === 'navigate') {
    expect(detail?.featureId).toBe('suppliers');
    const entry = supplierDetailEntry(detail!, before);
    if (['S1-152', 'S1-206', 'S3-251', 'S7-089'].includes(row.id)) {
      const order = row.id === 'S7-089' ? model.overdue[0] : model.upcoming[0];
      expect(entry.orderId).toBe(order.poId);
      if (row.id === 'S3-251') {
        expect(selectCalendar(before, { date: TODAY }).todayEntries.find(event => event.sourceId === order.poId)?.ref).toMatchObject(detail!);
      }
    } else if (row.id === 'S1-207') {
      expect(entry.orderForm).toMatchObject({ qty: before.tables.purchaseItem[0].minimumQty });
    } else expect(entry.tab).toBe('suppliers');
    return;
  }
  if (actual === 'clarify') {
    expect(row.expected.ask, row.id).toContain(result.field);
    expect(reply.answer).not.toBe('');
    return;
  }
  if (actual === 'refuse') {
    expect(reply.turn).toMatchObject({ kind: 'refusal' });
    expect(reply.proposalSession).toBeUndefined();
    return;
  }
  if (actual === 'answer') {
    const supplier = (itemId = milk) => {
      const row = model.suppliers.find(value => value.supplierId === purchaseOf(before, itemId).supplierId)!;
      return resolveDataText(formats.t, row.name ?? { key: row.nameKey });
    };
    const milkPurchase = purchaseOf(before);
    const expected: Readonly<Record<string, readonly string[]>> = {
      'S1-195': ['입고 확인 필요', `${model.overdueCount}건`],
      'S1-196': [`${model.monthCount}건`, formats.format.money(model.monthTotal, 'full')],
      'S1-197': ['지금 발주할 품목이 없어요'],
      'S1-198': [formats.format.money(milkPurchase.unitPrice, 'full')],
      'S1-199': [formats.format.quantity(milkPurchase.minimumQty, milkPurchase.purchaseUnit!)],
      'S1-200': model.suppliers.map(row => resolveDataText(formats.t, row.name ?? { key: row.nameKey })),
      'S1-201': [supplier()],
      'S1-202': [model.suppliers.find(row => row.supplierId === milkPurchase.supplierId)!.phoneMask],
      'S1-203': ['입고 완료', model.past[0].lines.map(line => nameOf(before, line.itemId)).join(' · ')],
      'S1-209': [formats.format.money(10 * milkPurchase.unitPrice, 'full'), supplier(), formats.format.date(addDays(TODAY, milkPurchase.leadDays), 'short')],
      'S1-228': ['이미 입고를 기록했어요'],
      'S1-234': ['이미 같은 날짜예요'],
    };
    for (const value of overlay[row.id]?.expected?.answer_must_contain ?? expected[row.id] ?? []) expect(reply.answer).toContain(value);
    const reads = ['S1-195', 'S1-196', 'S1-197', 'S1-200', 'S1-203'].includes(row.id) ? ['get_widget']
      : ['S1-198', 'S1-199', 'S1-201', 'S1-202', 'S1-209'].includes(row.id) ? ['search_records'] : [];
    expect(calls.map(call => call.name)).toEqual(reads);
    return;
  }

  const card = reply.proposalSession!;
  expect(card).toBeDefined();
  const proposal = card.getSnapshot().proposal;
  const expectedCommand = row.expected.tools.find(tool => tool.name === 'propose_action')?.args?.command ?? 'suppliers.createOrder';
  expect(proposal.command).toBe(expectedCommand);
  expect(calls.at(-1)).toEqual({ name: 'propose_action', args: { command: expectedCommand, args: (result.requests[0].intent as { args: unknown }).args } });
  expect(result.requests[0].searches.every(search => search.matches.every(match => match.label === undefined))).toBe(true);
  await result.provider.ask({ text: '확인', signal: new AbortController().signal });
  expect(store.getSnapshot()).toBe(before);
  const first = card.confirm(store, proposal.id);
  if (!first || typeof first === 'string') throw new Error('The confirmation card is unavailable');
  const extraConfirmation = ['suppliers.cancelOrder', 'suppliers.deleteSupplier', 'suppliers.deletePurchaseItem'].includes(proposal.command);
  expect(Boolean(first.requiresExtraConfirmation)).toBe(extraConfirmation);
  if (extraConfirmation) expect(store.getSnapshot()).toBe(before);
  const receipt = extraConfirmation ? card.confirm(store, proposal.id, true) : first;
  if (!receipt || typeof receipt === 'string') throw new Error('The confirmation receipt is unavailable');
  expect(receipt.frame.outcome).toBe('applied');
  const after = store.getSnapshot();
  expect(after.revision).toBe(before.revision + 1);
  expect(card.confirm(store, proposal.id, true)).toBeUndefined();
  expect(store.getSnapshot()).toBe(after);
  checkEffects(row.id, expectedCommand, before, after);
  await result.provider.ask({ text: '되돌려 줘', signal: new AbortController().signal });
  expect(store.getSnapshot()).toBe(after);
  expect(receipt.notice?.undo).toMatchObject({ target: 'data', token: receipt.undoToken });
  expect(store.undo(receipt.undoToken!).ok).toBe(true);
  for (const table of changedTables) expect(store.getSnapshot().tables[table]).toEqual(before.tables[table]);
}

function checkEffects(id: string, command: unknown, before: DataSnapshot, after: DataSnapshot) {
  const old = readModel(before, 'suppliers'), next = readModel(after, 'suppliers');
  if (command === 'suppliers.createOrder') {
    const qty = id === 'S1-210' ? 10 : id === 'S1-212' ? 3 : id === 'S8-132' ? 2 : old.suggestions[0].qty;
    expect(next.orders).toHaveLength(old.orders.length + 1);
    expect(next.upcomingCount).toBe(old.upcomingCount + 1);
    const added = next.upcoming.find(row => !old.orders.some(order => order.poId === row.poId))!;
    expect(added.lines[0].ordered).toBe(qty);
    expect(selectCalendar(after, { date: added.dueDate! }).todayEntries.some(event => event.sourceId === added.poId)).toBe(true);
    if (id === 'S1-219') expect(next.suggestions).toHaveLength(old.suggestions.length - 1);
  } else if (command === 'suppliers.recordReceipt') {
    const qty = id === 'S1-220' ? 12 : id === 'S1-221' ? 8 : 300;
    const order = old.upcoming[0], line = order.lines[0];
    expect(after.tables.receipt).toHaveLength(before.tables.receipt.length + 1);
    expect(after.tables.receipt.at(-1)).toMatchObject({ polId: line.polId, qty });
    expect(after.tables.expense.at(-1)).toMatchObject({ amount: qty * line.unitPrice, status: 'candidate', supplierId: order.supplierId });
    expect(next.orders.find(row => row.poId === order.poId)?.lines[0].remaining).toBe(line.remaining - qty);
  } else if (command === 'suppliers.changeDueDate') {
    const date = id === 'S1-229' ? addDays(TODAY, 2) : id === 'S1-230' ? addDays(TODAY, 1) : '2026-11-24';
    expect(next.orders.find(row => row.poId === old.upcoming[0].poId)?.dueDate).toBe(date);
  } else if (command === 'suppliers.cancelOrder') {
    expect(next.orders.find(row => row.poId === old.upcoming[0].poId)?.status).toBe('canceled');
    expect(next.upcomingCount).toBe(old.upcomingCount - 1);
  } else if (command === 'suppliers.updatePurchaseItem') {
    const current = purchaseOf(after, id === 'S1-245' ? cup : milk);
    if (id === 'S1-242' || id === 'S2-029') {
      expect(current.unitPrice).toBe(id === 'S1-242' ? 3800 : 4000);
      expect(after.tables.purchaseOrderLine).toEqual(before.tables.purchaseOrderLine);
      const latte = (snapshot: DataSnapshot) => selectMenus(snapshot, {}).rows.find(row => row.menuId === 'm-cafe-latte')!;
      expect(latte(after).cost! - latte(before).cost!).toBeCloseTo((current.unitPrice - purchaseOf(before).unitPrice) * 0.26);
    } else if (id === 'S1-244') expect(current.minimumQty).toBe(6);
    else if (id === 'S1-245') expect(current.orderStep).toBe(200);
    else expect(current.supplierId).toBe('s-roaster');
  } else if (command === 'suppliers.createPurchaseItem') {
    const item = after.tables.inventoryItem.find(row => row.sku === 'OAT-01')!;
    expect(after.tables.purchaseItem).toHaveLength(before.tables.purchaseItem.length + 1);
    expect(purchaseOf(after, item.itemId)).toMatchObject({ supplierId: 's-roaster', minimumQty: 4, orderStep: 1, leadDays: 2, unitPrice: 4200 });
  } else if (command === 'suppliers.createSupplier') {
    expect(after.tables.supplier).toHaveLength(before.tables.supplier.length + 1);
    expect(after.tables.supplier.at(-1)).toMatchObject({ name: { raw: 'E농산' }, contact: { raw: '김사장' }, phoneMask: '*******4444' });
  } else if (command === 'suppliers.deleteSupplier') {
    expect(after.tables.supplier.find(row => row.supplierId === fixtureSupplier)?.deletedAt).toBeTruthy();
  } else if (command === 'suppliers.updateSupplier') {
    const supplierId = id === 'S1-256' ? 's-roaster' : id === 'S1-257' ? 's-package' : 's-dairy';
    const row = after.tables.supplier.find(row => row.supplierId === supplierId);
    expect(row).toMatchObject(id === 'S1-255' ? { memo: { raw: '월요일 휴무' } } : id === 'S1-256' ? { contact: { raw: '이사장' } }
      : id === 'S1-257' ? { phoneMask: '*******8888' } : { name: { raw: '한강우유유통' } });
  } else throw new Error(`Unexpected N09 command ${String(command)}`);
}

it('D-325 quotes a scheduled order on the production card and applies it once', async () => {
  const { reply, provider, before, store } = await driveScenario('S1-210', '우유 10리터 발주 넣어줘', false);
  expect(reply.turn?.kind).toBe('proposal');
  if (reply.turn?.kind !== 'proposal') throw Error(reply.answer);
  const { proposal } = reply.turn;
  expect(proposal.command).toBe('suppliers.createOrder');
  expect(proposal.preview).toMatchObject({ fields: expect.arrayContaining([
    expect.objectContaining({ after: '29,000원' }),
  ]) });
  const say = (text: string) => provider.ask({ text, signal: new AbortController().signal });
  await say('응');
  expect(store.getSnapshot()).toBe(before);
  const receipt = proposal.confirm(store);
  expect(receipt.frame.outcome).toBe('applied');
  const after = store.getSnapshot();
  expect(after.tables.purchaseOrder).toHaveLength(before.tables.purchaseOrder.length + 1);
  expect(after.tables.purchaseOrder.at(-1)?.status).toBe('scheduled');
  expect(proposal.confirm(store).frame).toEqual(receipt.frame);
  await say('되돌려 줘');
  expect(store.getSnapshot()).toBe(after);
  expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
  expect(store.getSnapshot().tables.purchaseOrder).toEqual(before.tables.purchaseOrder);
  expect(store.getSnapshot().tables.purchaseOrderLine).toEqual(before.tables.purchaseOrderLine);
});

it('D-325 leaves transmission with the suppliers widget', () => {
  const before = createWidgetDataStore().getSnapshot();
  expect(suppliersDomain.route('발주서 공급처에 보내줘', before, 'ko')).toMatchObject({
    kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'suppliers', command: 'supplier.sendOrder' },
  });
});

it('keeps the typed order form scoped to the live item, quantity, and requested due date', async () => {
  const { detail, before } = await driveScenario('S1-207', '우유 12리터 내일 도착으로 발주 추가 화면 열어줘');
  expect(supplierDetailEntry(detail!, before).orderForm).toEqual({
    id: purchaseOf(before).purchaseItemId, qty: 12, dueDate: addDays(TODAY, 1),
  });
});

it('keeps a stale purchase-price card from overwriting a newer price', async () => {
  const { store, before, reply } = await driveScenario('S1-242', '우유 단가 3,800원으로 바꿔줘');
  const session = reply.proposalSession!;
  const { proposal } = session.getSnapshot();
  const row = purchaseOf(before);
  expect(store.dispatch({ type: 'suppliers.updatePurchaseItem', purchaseItemId: row.purchaseItemId, patch: { unitPrice: 3400 } }).ok).toBe(true);
  const concurrent = store.getSnapshot();
  const receipt = session.confirm(store, proposal.id);
  expect(receipt).toMatchObject({ frame: { outcome: 'conflict' } });
  expect(store.getSnapshot()).toBe(concurrent);
  expect(purchaseOf(concurrent).unitPrice).toBe(3400);
});

it('keeps an unrecognized purchase prefill from selecting another item', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(supplierDetailEntry({ featureId: 'suppliers', view: 'register', prefill: {
    kind: 'widget-draft', command: 'ui.openDetail', fields: { purchaseItemId: 'missing-record', qty: 12, dueDate: TODAY },
  } }, snapshot).orderForm).toBeUndefined();
});
