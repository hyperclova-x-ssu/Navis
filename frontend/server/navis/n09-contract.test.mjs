import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { prepareSupplierEstimate, prepareSupplierReceipt } from './suppliers.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const vite = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
  envFile: false, envDir: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false } });
let data, addDays, actions, registry, suppliers, tr, corpus;
try {
  data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  ({ addDays } = await vite.ssrLoadModule('/src/data/db/time.ts'));
  ({ createAgentActions: actions } = await vite.ssrLoadModule('/src/features/assistant/agent-actions.ts'));
  ({ createDomainRegistry: registry } = await vite.ssrLoadModule('/src/features/assistant/domains/registry.ts'));
  ({ createSuppliersDomain: suppliers } = await vite.ssrLoadModule('/src/features/assistant/domains/suppliers.ts'));
  tr = (await vite.ssrLoadModule('/src/features/assistant/messages.ts')).navisTranslator('ko');
  ({ corpus } = await readCafeScenarios(vite));
} finally {
  await vite.close();
}

const { TODAY, createWidgetDataStore, readModel, resolveDataText } = data;
const milk = 'i-milk', beans = 'i-bean-house', cups = 'i-cup-takeout', oat = 'fixture-oat-milk';
const defaultCondition = { kind: 'default' };
const widget = { featureId: 'suppliers', condition: defaultCondition };
const catalog = [{ id: 'suppliers', name: '발주', layer: 'management', conditions: [defaultCondition] }];
const lookup = (kind, querySlot = 'name') => ({ name: 'search_records', args: { kind, querySlot } });
const wireSlot = slot => ({ slot });
const wireHandle = handle => ({ handle });
const poStatus = (snapshot, poId) => snapshot.tables.purchaseOrder.find(row => row.poId === poId)?.status;
const projection = snapshot => readModel(snapshot, 'suppliers');
const purchase = (snapshot, itemId = milk) => snapshot.tables.purchaseItem.find(row => row.itemId === itemId);
const supplier = (snapshot, supplierId) => projection(snapshot).suppliers.find(row => row.supplierId === supplierId);
const inventory = snapshot => readModel(snapshot, 'inventory-booking');
const quantity = (value, unit) => tr.format.quantity(value, unit);
const money = value => tr.format.money(value, 'full');
const label = (value, key) => resolveDataText(tr.t, value ?? { key });
const rowName = (snapshot, itemId) => {
  const row = snapshot.tables.inventoryItem.find(item => item.itemId === itemId);
  return label(row.name, row.nameKey);
};
const fact = (key, value, display, label) => ({ key, value, display, label, unit: '' });
const request = (before, intent, extras) => ({ runId: before.runId, snapshotRevision: before.revision, businessDate: TODAY,
  layer: 'management', locale: 'ko', catalog, intent, slots: [], searches: [], snapshot: [], ...extras });

function accept(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

// Setup uses explicit test orders because the café normal seed has no open deliveries.
function scheduledStore(itemId = milk, { dueDate = TODAY, qty, lowStock = itemId === milk } = {}) {
  const store = createWidgetDataStore();
  const item = purchase(store.getSnapshot(), itemId);
  if (lowStock) accept(store.dispatch({ type: 'inventory.updateItem', itemId, threshold: 24_000 }));
  const result = accept(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: item.purchaseItemId,
    qty: qty ?? item.minimumQty, dueDate, idempotencyKey: 'fixture-order' }));
  const order = projection(store.getSnapshot()).orders.find(row => row.poId === result.value.poId);
  return { store, order };
}

function scopes(snapshot) {
  const targets = new Map(), searches = [], slots = {};
  function add(kind, querySlot, id, fields, bind = id !== undefined) {
    slots[querySlot] ??= 'fixture query';
    const handle = `h${searches.length + 1}`;
    const matches = id === undefined ? [] : [{ handle, match: 'exact', ...(fields ? { fields } : {}) }];
    searches.push({ kind, querySlot, matches });
    if (bind) targets.set(handle, { id, kind });
    return wireHandle(handle);
  }
  function purchaseItem(itemId = milk) {
    const row = purchase(snapshot, itemId);
    const item = snapshot.tables.inventoryItem.find(entry => entry.itemId === itemId);
    const { minimumQty, unitPrice, orderStep, leadDays } = row;
    return add('purchaseItem', 'name', row.purchaseItemId, { unit: row.purchaseUnit ?? item.unit,
      minimumQty, unitPrice, orderStep, leadDays,
      referenced: snapshot.tables.recipeLine.some(line => line.itemId === itemId) ||
        snapshot.tables.menuItem.some(menu => menu.optionGroups?.some(group => group.options.some(option => option.extraRecipe.some(line => line.itemId === itemId)))),
      suggested: projection(snapshot).suggestions.some(entry => entry.itemId === itemId),
    });
  }
  function supplierRecord(id, querySlot = 'name', bind = true) {
    const referenced = snapshot.tables.purchaseItem.some(item => item.supplierId === id) ||
      data.deriveOpenOrders(snapshot, { date: TODAY }).open.some(order => order.supplierId === id);
    return add('supplier', querySlot, id, id && { referenced }, bind && Boolean(id));
  }
  function stock(itemId) {
    const { kind, unit, sku } = snapshot.tables.inventoryItem.find(row => row.itemId === itemId);
    return add('stock', 'name', itemId, { kind, unit, sku });
  }
  function orderRecord(order, withLine = false) {
    if (!order) return add(withLine ? 'purchaseOrderLine' : 'purchaseOrder', 'name', undefined);
    if (withLine) {
      const { polId, unit, unitPrice, remaining } = order.lines[0];
      return add('purchaseOrderLine', 'name', polId, { unit, unitPrice, remaining, status: order.status, open: order.open });
    }
    return add('purchaseOrder', 'name', order.poId, { date: order.dueDate, status: order.status, open: order.open });
  }
  function value(key, value) {
    slots[key] = value;
    return wireSlot(key);
  }
  return { targets, searches, slots, add, purchaseItem, supplierRecord, stock, orderRecord, value };
}

async function checkCommand(harness, store, command, args, scope, want = 'proposal') {
  const before = store.getSnapshot();
  const suggestion = command === 'suppliers.createOrder' && args.suggestionItemId;
  const snapshot = suggestion ? [{ ...widget, facts: projection(before).suggestions.map(row =>
    fact('suppliers.suggestions.item', row.qty, quantity(row.qty, row.unit), rowName(before, row.itemId))) }] : [];
  const result = await harness.run(request(before, { kind: 'command', command, args, ...(scope.searches[0] && { querySlot: scope.searches[0].querySlot }) },
    { snapshot, searches: scope.searches, slots: Object.keys(scope.slots), ...(command === 'suppliers.createOrder' && { conversation: true }) }));
  assert.equal(result.status, 200, result.raw);
  assert.equal(result.terminal.outcome, want, result.raw);
  assert.equal(store.getSnapshot(), before);
  if (want !== 'proposal') {
    assert.equal(result.proposal, undefined);
    return result;
  }
  assert.deepEqual(result.calls, [
    ...(suggestion ? [{ name: 'get_widget', args: widget }] : []),
    ...scope.searches.map(({ kind, querySlot }) => lookup(kind, querySlot)),
    { name: 'propose_action', args: { command, args } },
  ]);
  assert.deepEqual({ ...result.proposal, proposalId: 'fixture' }, { proposalId: 'fixture', command, args,
    runId: before.runId, snapshotRevision: before.revision, layer: 'management',
    tier: ['suppliers.cancelOrder', 'suppliers.deleteSupplier', 'suppliers.deletePurchaseItem'].includes(command) ? 'extra-confirm' : 'normal' });
  return result;
}

const approvedClient = suppliers({ allowLocalScheduling: true });
const defaultClient = suppliers();
function atCard(store, frame, scope, domain = approvedClient) {
  return actions(store, registry([domain])).prepare(frame, scope.slots, store.getSnapshot(), undefined, scope.targets);
}

async function apply(harness, store, command, wire, scope, verify) {
  const before = store.getSnapshot();
  const response = await checkCommand(harness, store, command, wire, scope);
  const prepared = atCard(store, response.proposal, scope);
  assert.equal(prepared.kind, 'proposal', JSON.stringify(prepared));
  const card = prepared.proposal;
  assert.equal(store.getSnapshot(), before);
  if (command === 'suppliers.createOrder') {
    const typed = await harness.run(request(before, { kind: 'conversation', action: 'confirm', pendingId: card.id }, { conversation: true }));
    assert.equal(typed.status, 200, typed.raw);
    assert.equal(typed.proposal, undefined);
    assert.ok(!typed.raw.includes('event: action_result'), typed.raw);
    assert.equal(store.getSnapshot(), before);
  }
  assert.equal(card.confirm(createWidgetDataStore()).frame.outcome, 'conflict');
  if (card.tier === 'extra-confirm') {
    assert.equal(card.confirm(store).requiresExtraConfirmation, true);
    assert.equal(store.getSnapshot(), before);
  }
  const receipt = card.confirm(store, card.tier === 'extra-confirm' ? card.id : undefined);
  assert.equal(receipt.frame.outcome, 'applied');
  const after = store.getSnapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(card.confirm(store).frame, receipt.frame);
  assert.equal(store.getSnapshot(), after);
  verify(after, before, card.preview);
  assert.ok(receipt.undoToken);
  accept(store.undo(receipt.undoToken));
  for (const table of ['purchaseOrder', 'purchaseOrderLine', 'purchaseItem', 'supplier', 'receipt', 'expense']) {
    assert.deepEqual(store.getSnapshot().tables[table], before.tables[table], table);
  }
}

async function read(harness, snapshot, facts, scope, searchKind) {
  const searchFields = searchKind ? { recordKind: searchKind, querySlot: 'name' } : {};
  const result = await harness.run(request(snapshot, { kind: 'read', ...widget, ...searchFields },
    { snapshot: [{ ...widget, facts }], ...(scope && { slots: Object.keys(scope.slots), searches: scope.searches }) }));
  assert.equal(result.terminal?.outcome, 'reply', result.raw);
  assert.deepEqual(result.calls, [...(searchKind ? [lookup(searchKind)] : []), ...(facts.length ? [{ name: 'get_widget', args: widget }] : [])]);
  for (const { display } of facts) assert.ok(result.answer.includes(display), result.answer);
  assert.equal(result.proposal, undefined);
  return result;
}

async function navigate(harness, snapshot, view, order) {
  const scope = scopes(snapshot);
  const args = { featureId: 'suppliers', view, ...(order && { itemId: scope.orderRecord(order) }) };
  const response = await harness.run(request(snapshot, { kind: 'command', command: 'ui.openDetail', args },
    { slots: Object.keys(scope.slots), searches: scope.searches }));
  assert.equal(response.terminal.outcome, 'navigate', response.raw);
  assert.deepEqual(response.terminal.navigation.args, args);
  assert.deepEqual(response.calls, []);
}

async function checkNavigation(harness, id) {
  if (id === 'S1-207' || id === 'S1-208') {
    return navigate(harness, createWidgetDataStore().getSnapshot(), id === 'S1-207' ? 'register' : 'suppliers');
  }
  const itemId = ['S1-152', 'S3-251'].includes(id) ? milk : beans;
  const baseline = createWidgetDataStore().getSnapshot();
  assert.equal(projection(baseline).orders.some(row => row.open), false);
  const { store, order } = scheduledStore(itemId, { dueDate: id === 'S1-206' ? addDays(TODAY, 1) : TODAY });
  let snapshot = store.getSnapshot(), target = order;
  if (id === 'S7-089') {
    // Explicit overdue record for this boundary. The normal model must still have none.
    const overdueStore = createWidgetDataStore({ purchaseOrder: [{ ...order, dueDate: addDays(TODAY, -2) }],
      purchaseOrderLine: snapshot.tables.purchaseOrderLine.filter(row => row.poId === order.poId) });
    snapshot = overdueStore.getSnapshot();
    target = projection(snapshot).overdue[0];
    assert.equal(target.poId, order.poId);
  }
  if (id === 'S3-251') {
    const event = data.selectCalendar(snapshot, { date: TODAY }).todayEntries.find(row => row.sourceId === target.poId);
    assert.deepEqual(event.ref, { featureId: 'suppliers', view: 'order', itemId: target.poId });
  }
  await navigate(harness, snapshot, 'order', target);
}

async function checkRead(harness, id, store, expected) {
  const snapshot = store.getSnapshot(), model = projection(snapshot), scope = scopes(snapshot);
  const item = purchase(snapshot), ops = [];
  const milkSupplier = supplier(snapshot, item.supplierId);
  switch (id) {
    case 'S1-195':
      assert.equal(model.overdueCount, 0);
      ops.push(fact('suppliers.overdue.count', model.overdueCount, quantity(model.overdueCount, 'count'), '입고 확인 필요'));
      break;
    case 'S1-196':
      assert.deepEqual([model.monthCount, model.monthTotal], [20, 2_656_800]);
      ops.push(fact('suppliers.month.count', model.monthCount, quantity(model.monthCount, 'count'), '이번 달 발주'),
        fact('suppliers.month.total', model.monthTotal, money(model.monthTotal), '이번 달 발주 금액'));
      break;
    case 'S1-197':
      assert.equal(model.suggestions.length, 0);
      assert.equal(inventory(snapshot).restockCount, 0);
      ops.push(fact('suppliers.suggestion.count', model.suggestions.length, '지금 발주할 품목이 없어요', '발주 제안'));
      break;
    case 'S1-198':
      assert.equal(item.unitPrice, 2900);
      ops.push(fact('suppliers.item.unitPrice', item.unitPrice, money(item.unitPrice), '우유 단가'));
      break;
    case 'S1-199':
      assert.equal(item.minimumQty, 1);
      ops.push(fact('suppliers.item.minimumQty', item.minimumQty, quantity(item.minimumQty, item.purchaseUnit), '최소 주문'));
      break;
    case 'S1-200':
      assert.equal(model.suppliers.length, 5);
      for (const [index, row] of model.suppliers.entries()) {
        const name = label(row.name, row.nameKey);
        ops.push(fact(`suppliers.supplier.${index}`, name, name, '발주사'));
      }
      break;
    case 'S1-201': {
      const name = label(milkSupplier.name, milkSupplier.nameKey);
      assert.equal(name, '한강목장 유업유통');
      ops.push(fact('suppliers.item.supplier', name, name, '우유 발주사'));
      break;
    }
    case 'S1-202':
      assert.equal(milkSupplier.phoneMask, '02-****-0001');
      ops.push(fact('suppliers.supplier.phone', milkSupplier.phoneMask, milkSupplier.phoneMask, '연락처'));
      break;
    case 'S1-203': {
      assert.ok(model.past.length > 0);
      assert.equal(model.past[0].status, 'complete');
      const latest = model.past[0];
      const items = latest.lines.map(line => rowName(snapshot, line.itemId)).join(' · ');
      ops.push(fact('suppliers.history.latest', items, items, '지난 발주'),
        fact('suppliers.history.status', latest.status, '입고 완료', '입고 상태'));
      break;
    }
  }
  const byItem = ['S1-198', 'S1-199', 'S1-201'].includes(id);
  if (byItem) scope.purchaseItem();
  const result = await read(harness, snapshot, ops, byItem ? scope : undefined, byItem ? 'purchaseItem' : undefined);
  for (const fragment of expected.answer_must_contain ?? []) assert.ok(result.answer.includes(fragment), result.answer);
  assert.equal(store.getSnapshot(), snapshot);
}

async function checkEstimate(harness, store, expected) {
  const snapshot = store.getSnapshot();
  const p = purchase(snapshot), qty = 10;
  const estimate = prepareSupplierEstimate({ item: { ...p, unit: p.purchaseUnit }, qty, businessDate: TODAY,
    hasOpenOrder: projection(snapshot).orders.some(order => order.open && order.lines.some(line => line.itemId === milk)) });
  assert.deepEqual(estimate, { outcome: 'ready', qty, unit: 'L', unitPrice: 2900, total: qty * 2900,
    dueDate: '2026-11-18', hasOpenOrder: false });
  const seller = supplier(snapshot, p.supplierId), scope = scopes(snapshot);
  scope.purchaseItem();
  const sellerName = label(seller.name, seller.nameKey);
  const result = await read(harness, snapshot, [
    fact('suppliers.estimate.qty', qty, quantity(qty, estimate.unit), rowName(snapshot, milk)),
    fact('suppliers.estimate.supplier', sellerName, sellerName, '발주사'),
    fact('suppliers.estimate.unitPrice', estimate.unitPrice, money(estimate.unitPrice), '단가'),
    fact('suppliers.estimate.total', estimate.total, money(estimate.total), '예상 금액'),
    fact('suppliers.estimate.arrival', estimate.dueDate, '11/18', '입고 예정'),
  ], scope, 'purchaseItem');
  for (const fragment of expected.answer_must_contain ?? []) assert.ok(result.answer.includes(fragment), result.answer);
  assert.equal(store.getSnapshot(), snapshot);
}

async function checkScheduling(harness, id, store, expected) {
  const before = store.getSnapshot(), scope = scopes(before);
  if (id === 'S1-218') {
    const response = await checkCommand(harness, store, 'suppliers.createOrder', {}, scope, 'clarify');
    assert.equal(response.terminal.clarification.field, 'purchaseItemId');
    return;
  }
  const itemId = ['S1-213', 'S1-215', 'S1-216', 'S1-219', 'S8-133'].includes(id) ? cups : id === 'S1-217' ? beans : milk;
  const purchaseItem = purchase(before, itemId);
  const suggestion = projection(before).suggestions.find(row => row.itemId === itemId);
  const reviewed = expected.tools.find(tool => tool.name === 'propose_action')?.args.args;
  const qty = reviewed?.qty ?? { 'S1-213': 150, 'S1-214': 4.5, 'S1-215': 200,
    'S1-216': 100, 'S1-217': 0.2, 'S8-133': 150 }[id];
  const date = reviewed?.dueDate ?? ({ 'S1-215': '2026-11-24', 'S1-216': addDays(TODAY, -1) })[id];
  if (reviewed?.purchaseItemId && ['S1-210', 'S1-212', 'S1-219', 'S8-132'].includes(id)) {
    assert.equal(reviewed.purchaseItemId, purchaseItem.purchaseItemId);
  }
  const wire = { purchaseItemId: scope.purchaseItem(itemId), ...(qty !== undefined && { qty: scope.value('qty', qty) }),
    ...(date && { dueDate: scope.value('dueDate', date) }), ...(suggestion && id === 'S1-219' && { suggestionItemId: scope.stock(itemId) }) };
  if (id === 'S1-211') {
    const response = await checkCommand(harness, store, 'suppliers.createOrder', wire, scope, 'clarify');
    assert.equal(response.terminal.clarification.field, 'qty');
    return;
  }
  if (id === 'S1-219') {
    assert.deepEqual([suggestion.qty, suggestion.total, suggestion.dueDate], [1000, 110_000, '2026-11-20']);
    const stale = scopes(before);
    const staleItem = stale.purchaseItem(milk);
    const staleStock = stale.stock(milk);
    await checkCommand(harness, store, 'suppliers.createOrder',
      { purchaseItemId: staleItem, qty: stale.value('qty', 12), suggestionItemId: staleStock }, stale, 'refused');
  }
  const estimate = prepareSupplierEstimate({ item: { ...purchaseItem, unit: purchaseItem.purchaseUnit }, qty, businessDate: TODAY, dueDate: date });
  const invalid = { 'S1-213': 'minimumQty', 'S1-214': 'orderStep', 'S1-215': 'minimumQty', 'S1-216': 'minimumQty',
    'S1-217': 'minimumQty', 'S8-133': 'minimumQty' }[id];
  if (invalid) {
    assert.deepEqual(estimate, { outcome: 'clarify', field: invalid });
    const response = await checkCommand(harness, store, 'suppliers.createOrder', wire, scope);
    assert.equal(atCard(store, response.proposal, scope).kind, 'invalid');
    if (id === 'S1-216') {
      const validQty = scopes(before);
      const prior = { purchaseItemId: validQty.purchaseItem(cups), qty: validQty.value('qty', 500),
        dueDate: validQty.value('dueDate', date) };
      const offered = await checkCommand(harness, store, 'suppliers.createOrder', prior, validQty);
      const local = atCard(store, offered.proposal, validQty);
      assert.deepEqual([local.kind, local.field], ['invalid', 'dueDate']);
    }
    assert.equal(store.getSnapshot(), before);
    return;
  }
  assert.equal(estimate.outcome, 'ready');
  if (id === 'S1-210') {
    const send = await checkCommand(harness, store, 'supplier.sendOrder', wire, scope, 'refused');
    assert.equal(send.terminal.refusal.reason, 'widget_only');
    assert.equal(send.terminal.refusal.alternative.featureId, 'suppliers');
    assert.deepEqual(send.calls, []);
  }
  await apply(harness, store, 'suppliers.createOrder', wire, scope, (after, previous, preview) => {
    if (id === 'S1-210') {
      const seller = supplier(previous, purchaseItem.supplierId);
      assert.equal(preview.target, rowName(previous, itemId));
      const values = preview.fields.map(field => field.after);
      for (const value of [label(seller.name, seller.nameKey), '10 L', '29,000원', '11/18(수)']) {
        assert.ok(values.includes(value), JSON.stringify(preview));
      }
    }
    assert.equal(after.tables.purchaseOrder.length, previous.tables.purchaseOrder.length + 1);
    assert.equal(after.tables.purchaseOrderLine.length, previous.tables.purchaseOrderLine.length + 1);
    const order = after.tables.purchaseOrder.at(-1), line = after.tables.purchaseOrderLine.at(-1);
    assert.deepEqual([order.status, order.expectedTime, order.orderedOn, order.dueDate, order.supplierId],
      ['scheduled', null, TODAY, estimate.dueDate, purchaseItem.supplierId]);
    assert.deepEqual([line.poId, line.itemId, line.qtyOrdered, line.unitPrice], [order.poId, itemId, qty, purchaseItem.unitPrice]);
    assert.equal(projection(after).upcomingCount, projection(previous).upcomingCount + 1);
    const calendar = data.selectCalendar(after, { date: order.dueDate });
    assert.ok(calendar.todayEntries.some(row => row.source === 'delivery' && row.sourceId === order.poId && !row.editable));
    assert.deepEqual(after.tables.inventoryItem, previous.tables.inventoryItem);
    assert.deepEqual(after.tables.stockAdjustment, previous.tables.stockAdjustment);
    assert.deepEqual(after.tables.receipt, previous.tables.receipt);
    assert.deepEqual(after.tables.expense, previous.tables.expense);
    if (suggestion && id === 'S1-219') assert.equal(projection(after).suggestions.some(row => row.itemId === itemId), false);
  });
}

async function checkReceipt(harness, id, store, order) {
  const before = store.getSnapshot(), scope = scopes(before);
  const qty = { 'S1-220': 12, 'S1-221': 8, 'S1-223': 13, 'S1-224': 0.5, 'S1-225': 41, 'S1-226': 30, 'S1-227': 300, 'S1-228': 12 }[id];
  const wire = { polId: scope.orderRecord(order, true), ...(qty !== undefined && { qty: scope.value('qty', qty) }) };
  if (['S1-225', 'S1-226', 'S1-228'].includes(id)) {
    await checkCommand(harness, store, 'suppliers.recordReceipt', wire, scope, 'refused');
    if (id === 'S1-228') {
      const originalCount = before.tables.receipt.length;
      const answer = approvedClient.route('우유 12리터 입고 처리 한 번 더', before, 'ko');
      assert.match(answer.answer, /이미/u);
      assert.equal(store.getSnapshot().tables.receipt.length, originalCount);
    }
    return;
  }
  if (id === 'S1-222') {
    const missing = await checkCommand(harness, store, 'suppliers.recordReceipt', wire, scope, 'clarify');
    assert.equal(missing.terminal.clarification.field, 'qty');
    return;
  }
  const line = order.lines[0];
  const local = prepareSupplierReceipt({ line: { ...line, status: order.status, open: order.open }, qty });
  if (['S1-223', 'S1-224'].includes(id)) {
    assert.deepEqual(local, { outcome: 'clarify', field: 'qty' });
    const result = await checkCommand(harness, store, 'suppliers.recordReceipt', wire, scope);
    assert.equal(atCard(store, result.proposal, scope).kind, 'invalid');
    assert.equal(store.getSnapshot(), before);
    return;
  }
  const complete = id === 'S1-220';
  const stock = snapshot => inventory(snapshot).ingredients.find(row => row.itemId === line.itemId).stock;
  await apply(harness, store, 'suppliers.recordReceipt', wire, scope, (after, previous) => {
    assert.equal(after.tables.receipt.length, previous.tables.receipt.length + 1);
    assert.equal(after.tables.expense.length, previous.tables.expense.length + 1);
    const receipt = after.tables.receipt.at(-1), expense = after.tables.expense.at(-1);
    const expectedAmount = { 'S1-220': 34_800, 'S1-221': 23_200, 'S1-227': 33_000 }[id];
    assert.deepEqual([receipt.polId, receipt.qty], [line.polId, qty]);
    assert.deepEqual([expense.receiptId, expense.status, expense.amount, expense.supplierId], [receipt.receiptId, 'candidate', expectedAmount, order.supplierId]);
    assert.equal(poStatus(after, order.poId), complete ? 'complete' : 'partial');
    const newOrder = projection(after).orders.find(row => row.poId === order.poId);
    assert.equal(newOrder.lines[0].remaining, line.ordered - qty);
    assert.equal(stock(after) - stock(previous), line.itemId === milk ? qty * 1000 : qty);
    assert.equal(projection(after).upcomingCount, projection(previous).upcomingCount - Number(complete));
    assert.deepEqual(readModel(after, 'ledger').expenses, readModel(previous, 'ledger').expenses);
    assert.equal(readModel(after, 'ledger').candidates.length, readModel(previous, 'ledger').candidates.length + 1);
    if (line.itemId === milk) {
      assert.equal(inventory(previous).restockCount, 1);
      assert.equal(inventory(after).restockCount, 0);
    }
    if (complete) {
      // A delivery stays on the calendar only while quantity is open (DATA_MODEL 10.14): it is there before the last receipt and gone after it.
      const onCalendar = snapshot => data.selectCalendar(snapshot, { date: TODAY }).todayEntries.some(entry => entry.sourceId === order.poId);
      assert.equal(onCalendar(previous), true);
      assert.equal(onCalendar(after), false);
      const alert = snapshot => data.selectBriefing(snapshot, { date: TODAY }).importantAlerts.groups
        .some(group => group.items.some(entry => entry.id === `order:${order.poId}`));
      assert.equal(alert(previous), true);
      assert.equal(alert(after), false);
    }
  });
}

async function checkOrderEdit(harness, id, store, order) {
  const before = store.getSnapshot(), scope = scopes(before);
  const cancel = ['S1-237', 'S1-238', 'S1-239'].includes(id);
  const command = cancel ? 'suppliers.cancelOrder' : 'suppliers.changeDueDate';
  const newDate = ({ 'S1-229': '2026-11-19', 'S1-230': '2026-11-18', 'S1-231': '2026-11-24',
    'S1-233': '2026-11-16', 'S1-234': '2026-11-18', 'S1-235': '2026-11-19' })[id];
  const wire = { poId: scope.orderRecord(order), ...(newDate && { date: scope.value('date', newDate) }) };
  if (['S1-235', 'S1-238', 'S1-239'].includes(id)) {
    await checkCommand(harness, store, command, wire, scope, 'refused');
    return;
  }
  if (id === 'S1-236') {
    const local = defaultClient.route('우유 입고 오후 5시로 바꿔줘', before, 'ko');
    assert.deepEqual([local.kind, local.reason], ['refusal', 'unsupported']);
    assert.match(local.answer, /입고 예정일/u);
    assert.equal(schema.validateAgentDraft(command, { ...wire, expectedTime: wireSlot('time') }), false);
    const response = await harness.run(request(before, { kind: 'unsupported' }));
    assert.equal(response.terminal.outcome, 'refused');
    assert.equal(response.proposal, undefined);
    assert.equal(store.getSnapshot(), before);
    return;
  }
  if (id === 'S1-232') {
    const missing = await checkCommand(harness, store, command, wire, scope, 'clarify');
    assert.equal(missing.terminal.clarification.field, 'date');
    return;
  }
  if (id === 'S1-233' || id === 'S1-234') {
    const response = await checkCommand(harness, store, command, wire, scope);
    const local = atCard(store, response.proposal, scope);
    assert.equal(local.kind, id === 'S1-233' ? 'invalid' : 'unchanged');
    assert.equal(store.getSnapshot(), before);
    return;
  }
  await apply(harness, store, command, wire, scope, (after, previous) => {
    const updated = projection(after).orders.find(row => row.poId === order.poId);
    if (cancel) {
      assert.equal(updated.status, 'canceled');
      assert.equal(projection(after).upcomingCount, projection(previous).upcomingCount - 1);
    } else {
      assert.equal(updated.dueDate, newDate);
      assert.equal(updated.expectedTime, order.expectedTime);
      const calendarEntry = data.selectCalendar(after, { date: newDate }).todayEntries.find(row => row.sourceId === order.poId);
      assert.equal(calendarEntry.date, newDate);
    }
    assert.deepEqual(after.tables.purchaseOrderLine, previous.tables.purchaseOrderLine);
  });
}

function oatStore() {
  const { tables } = createWidgetDataStore().getSnapshot();
  const item = tables.inventoryItem.find(row => row.itemId === 'i-oat-milk');
  return createWidgetDataStore({ inventoryItem: [...tables.inventoryItem, { ...item, itemId: oat, sku: 'OAT-01', name: { raw: '귀리우유' } }] });
}

async function checkPurchase(harness, id, store) {
  const before = store.getSnapshot(), scope = scopes(before);
  if (['S1-248', 'S1-249', 'S1-250'].includes(id)) {
    const itemId = id === 'S1-248' ? milk : oat;
    const item = scope.stock(itemId);
    if (id === 'S1-250') {
      const result = await checkCommand(harness, store, 'suppliers.createPurchaseItem', { itemId: item }, scope, 'clarify');
      assert.equal(result.terminal.clarification.field, 'supplierId');
      return;
    }
    if (id === 'S1-248') scope.purchaseItem(milk);
    else scope.add('purchaseItem', 'name');
    const supplierId = 's-roaster';
    const wire = { itemId: item, supplierId: scope.supplierRecord(supplierId, 'supplierId'),
      minimumQty: scope.value('minimumQty', 4), unitPrice: scope.value('unitPrice', 4200), orderStep: scope.value('orderStep', 1), leadDays: scope.value('leadDays', 2) };
    if (id === 'S1-248') {
      const result = await checkCommand(harness, store, 'suppliers.createPurchaseItem', wire, scope, 'refused');
      assert.equal(result.terminal.refusal.reason, 'duplicate');
      return;
    }
    await apply(harness, store, 'suppliers.createPurchaseItem', wire, scope, after => {
      const p = purchase(after, oat);
      assert.deepEqual([p.supplierId, p.unitPrice, p.minimumQty, p.orderStep, p.leadDays], [supplierId, 4200, 4, 1, 2]);
    });
    return;
  }
  const itemId = id === 'S1-245' ? cups : id === 'S1-246' ? beans : milk;
  const wire = { purchaseItemId: scope.purchaseItem(itemId) };
  if (id === 'S1-251') {
    const result = await checkCommand(harness, store, 'suppliers.deletePurchaseItem', wire, scope, 'refused');
    assert.equal(result.terminal.refusal.reason, 'invalid_target');
    return;
  }
  const [field, newValue] = ({ 'S1-242': ['unitPrice', 3800], 'S1-243': ['unitPrice', -500], 'S1-244': ['minimumQty', 6],
    'S1-245': ['orderStep', 200], 'S1-246': ['leadDays', 3], 'S1-247': ['supplierId', 's-roaster'], 'S2-029': ['unitPrice', 4000] })[id];
  wire.patch = { [field]: field === 'supplierId' ? scope.supplierRecord(newValue, 'supplierId') : scope.value(field, newValue) };
  const command = 'suppliers.updatePurchaseItem';
  if (id === 'S1-243') {
    const result = await checkCommand(harness, store, command, wire, scope);
    assert.equal(atCard(store, result.proposal, scope).kind, 'invalid');
    assert.equal(store.getSnapshot(), before);
    return;
  }
  await apply(harness, store, command, wire, scope, (after, previous) => {
    assert.equal(purchase(after, itemId)[field], newValue);
    assert.deepEqual(after.tables.purchaseOrder, previous.tables.purchaseOrder);
    assert.deepEqual(after.tables.purchaseOrderLine, previous.tables.purchaseOrderLine);
    if (id === 'S1-242') {
      const costs = snapshot => readModel(snapshot, 'margin').menus
        .filter(row => ['m-cafe-latte', 'm-vanilla-latte'].includes(row.menuId)).map(row => [row.menuId, row.unitCost, row.rate]);
      const originalCosts = costs(previous), newCosts = costs(after);
      assert.deepEqual(originalCosts, [['m-vanilla-latte', 1558, 63.8], ['m-cafe-latte', 1278, 66.4]]);
      assert.deepEqual(newCosts, [['m-vanilla-latte', 1774, 58.7], ['m-cafe-latte', 1512, 60.2]]);
    }
  });
}

const produceSupplier = 'fixture-produce-supplier';
async function checkSupplier(harness, id, store) {
  const before = store.getSnapshot(), scope = scopes(before);
  if (['S1-252', 'S1-253', 'S1-254'].includes(id)) {
    const name = id === 'S1-254' ? '한강목장 유업유통' : 'E농산';
    scope.supplierRecord(id === 'S1-254' ? 's-dairy' : undefined, 'target', false);
    const wire = { name: scope.value('name', name) };
    const command = 'suppliers.createSupplier';
    if (id === 'S1-253') {
      const missing = await checkCommand(harness, store, command, wire, scope, 'clarify');
      assert.equal(missing.terminal.clarification.field, 'contact');
      return;
    }
    wire.contact = scope.value('contact', '김사장');
    wire.phone = scope.value('phone', '01033334444');
    if (id === 'S1-254') {
      const duplicate = await checkCommand(harness, store, command, wire, scope, 'clarify');
      assert.equal(duplicate.terminal.clarification.field, 'name');
      return;
    }
    await apply(harness, store, command, wire, scope, after => {
      const saved = after.tables.supplier.at(-1);
      assert.equal(saved.name.raw, name);
      assert.equal(saved.contact.raw, '김사장');
      assert.equal(saved.phoneMask, '*******4444');
      assert.equal(after.tables.purchaseItem.some(item => item.supplierId === saved.supplierId), false);
    });
    return;
  }
  const supplierId = ({ 'S1-256': 's-roaster', 'S1-257': 's-package', 'S1-259': 's-bakery', 'S1-260': produceSupplier })[id] ?? 's-dairy';
  const wire = { supplierId: scope.supplierRecord(supplierId, 'target') };
  if (id === 'S1-259') {
    await checkCommand(harness, store, 'suppliers.deleteSupplier', wire, scope, 'refused');
    assert.equal(before.tables.purchaseItem.some(item => item.supplierId === supplierId), true);
    return;
  }
  if (id === 'S1-260') {
    await apply(harness, store, 'suppliers.deleteSupplier', wire, scope, after => {
      assert.ok(after.tables.supplier.find(row => row.supplierId === supplierId).deletedAt);
      assert.equal(supplier(after, supplierId), undefined);
    });
    return;
  }
  const [field, newValue] = ({ 'S1-255': ['memo', '월요일 휴무'], 'S1-256': ['contact', '이사장'],
    'S1-257': ['phone', '01099998888'], 'S1-258': ['name', '한강우유유통'] })[id];
  wire.patch = { [field]: scope.value(field, newValue) };
  if (field === 'name') scope.supplierRecord(undefined, 'name', false);
  await apply(harness, store, 'suppliers.updateSupplier', wire, scope, after => {
    const row = after.tables.supplier.find(row => row.supplierId === supplierId);
    assert.equal(field === 'phone' ? row.phone : row[field].raw, newValue);
    if (field === 'phone') assert.equal(row.phoneMask, '*******8888');
  });
}

function prerequisite(id) {
  if (['S1-220', 'S1-221', 'S1-222', 'S1-223', 'S1-224', 'S1-228', 'S1-230', 'S1-236'].includes(id)) {
    const { store, order } = scheduledStore(milk, { qty: 12 });
    if (id === 'S1-220') accept(store.dispatch({ type: 'suppliers.updatePurchaseItem', purchaseItemId: purchase(store.getSnapshot()).purchaseItemId,
      patch: { unitPrice: 3100 } }));
    if (id !== 'S1-228') return { store, order };
    accept(store.dispatch({ type: 'suppliers.recordReceipt', polId: order.lines[0].polId, qty: 12, idempotencyKey: 'fixture-receipt' }));
    return { store, order: projection(store.getSnapshot()).orders.find(row => row.poId === order.poId) };
  }
  if (['S1-229', 'S1-232', 'S1-233', 'S1-234'].includes(id)) return scheduledStore(beans, { dueDate: addDays(TODAY, 1) });
  if (['S1-227', 'S1-231', 'S1-237'].includes(id)) return scheduledStore(cups);
  if (['S1-249', 'S1-250'].includes(id)) return { store: oatStore() };
  const { tables } = createWidgetDataStore().getSnapshot();
  if (id === 'S1-219') {
    return { store: createWidgetDataStore({ stockAdjustment: [...tables.stockAdjustment,
      { adjustmentId: 'fixture-cup-shortage', itemId: cups, at: data.NOW, seq: 10_000, deltaBase: -1286, reason: 'cell-edit' }] }) };
  }
  if (id === 'S1-260') return { store: createWidgetDataStore({ supplier: [...tables.supplier, {
    supplierId: produceSupplier, name: { raw: 'E농산' }, nameKey: 'data.management.customSupplier', contactKey: 'data.management.contact',
    phoneMask: '*******4444', memo: null,
  }] }) };
  return { store: createWidgetDataStore() };
}

test('N09 server contracts for all 70 assigned supplier scenarios', async t => {
  const trace = readTrace();
  const assigned = trace.filter(row => row.slice_id === 'N09');
  const required = trace.filter(row => row.required_slices.split('|').includes('N09'));
  assert.equal(assigned.length, 70);
  assert.equal(required.length, 80);
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, assigned.length);
  const failures = [];
  let passed = 0;
  for (const { scenario_id: id } of assigned) {
    const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, navisAgentFakeFetch);
    try {
      const scenario = corpus.get(id);
      assert.ok(scenario?.utterances.length);
      const { store, order } = prerequisite(id);
      if (['S1-216', 'S1-217'].includes(id)) {
        const before = store.getSnapshot();
        const route = defaultClient.route(scenario.utterances[0], before, 'ko');
        if (scenario.expected.kind === 'clarify') {
          assert.equal(route?.kind, 'clarification');
          assert.equal(route.field, scenario.expected.ask[0]);
        } else {
          assert.equal(route?.kind, 'refusal');
          assert.match(route.answer, /지난 날짜/u);
        }
        assert.equal(store.getSnapshot(), before);
      }
      if (scenario.expected.kind === 'navigate') await checkNavigation(harness, id);
      else if (id === 'S1-209') await checkEstimate(harness, store, scenario.expected);
      else if (id === 'S8-130' || id === 'S8-131') {
        const before = store.getSnapshot();
        assert.equal(before.tables.inventoryItem.some(row => rowName(before, row.itemId).includes('크루아상')), false);
        assert.equal(defaultClient.route(scenario.utterances[0], before, 'ko')?.kind, 'refusal');
        assert.equal(scenario.expected.kind, 'refuse');
        assert.equal(store.getSnapshot(), before);
      }
      else if (id >= 'S1-195' && id <= 'S1-203') await checkRead(harness, id, store, scenario.expected);
      else if (id >= 'S1-210' && id <= 'S1-219' || ['S8-132', 'S8-133'].includes(id)) await checkScheduling(harness, id, store, scenario.expected);
      else if (id >= 'S1-220' && id <= 'S1-228') await checkReceipt(harness, id, store, order);
      else if (id >= 'S1-229' && id <= 'S1-239') await checkOrderEdit(harness, id, store, order);
      else if (id === 'S1-246') {
        const before = store.getSnapshot();
        const { intent, slots, lookups } = defaultClient.route(scenario.utterances[0], before, 'ko');
        const [{ kind, querySlot }] = lookups;
        const reader = defaultClient.reads.find(reader => reader.kind === kind);
        const matches = reader.search({ snapshot: before, locale: 'ko', query: slots[querySlot], querySlot,
          command: intent.command, privateLookup: true });
        assert.ok(matches.length > 1);
        const result = await harness.run(request(before, intent, { searches: [{ kind, querySlot, matches }], slots: Object.keys(slots) }));
        assert.equal(scenario.expected.kind, 'clarify');
        assert.equal(querySlot, scenario.expected.ask[0]);
        assert.equal(result.terminal.outcome, 'clarify', result.raw);
        assert.equal(result.terminal.clarification.field, 'purchaseItemId');
        assert.equal(result.proposal, undefined);
        assert.equal(store.getSnapshot(), before);
      }
      else if (id >= 'S1-242' && id <= 'S1-251' || id === 'S2-029') await checkPurchase(harness, id, store);
      else if (id >= 'S1-252' && id <= 'S1-260') await checkSupplier(harness, id, store);
      else assert.fail(`No contract for ${id}`);
      passed++;
    } catch (error) {
      failures.push(`${id} ${error.message}`);
    } finally {
      harness.close();
    }
  }
  t.diagnostic(`${passed} of 70 pass, 0 listed exceptions, ${failures.length} unexpected failures`);
  t.diagnostic(`${required.length} required_slices entries including ${assigned.length} primary and ${required.length - assigned.length} dependency-only`);
  assert.deepEqual(failures, []);
  assert.equal(passed, assigned.length);
});

test('a receipt card from an earlier supplier revision cannot apply', async () => {
  const { store, order } = scheduledStore(milk, { qty: 12 });
  const before = store.getSnapshot(), scope = scopes(before);
  const wire = { polId: scope.orderRecord(order, true), qty: scope.value('qty', 8) };
  const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, navisAgentFakeFetch);
  try {
    const response = await checkCommand(harness, store, 'suppliers.recordReceipt', wire, scope);
    const prepared = atCard(store, response.proposal, scope);
    assert.equal(prepared.kind, 'proposal');
    const update = { type: 'suppliers.changeDueDate', poId: order.poId, date: addDays(TODAY, 1) };
    accept(store.dispatch(update));
    const revised = store.getSnapshot();
    assert.equal(prepared.proposal.confirm(store).frame.outcome, 'conflict');
    assert.equal(store.getSnapshot(), revised);
    assert.deepEqual(revised.tables.receipt, before.tables.receipt);
    assert.deepEqual(revised.tables.expense, before.tables.expense);
  } finally {
    harness.close();
  }
});

test('an intake cannot bind a different local slot as the received quantity', async () => {
  const { store, order } = scheduledStore(milk, { qty: 12 });
  const scope = scopes(store.getSnapshot());
  const wire = { polId: scope.orderRecord(order, true), qty: scope.value('remaining', 12) };
  const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, navisAgentFakeFetch);
  try {
    await checkCommand(harness, store, 'suppliers.recordReceipt', wire, scope, 'clarify');
  } finally {
    harness.close();
  }
});

test('a suggested order card requires the exact projected quantity and due date', async () => {
  const { store } = prerequisite('S1-219');
  const before = store.getSnapshot(), scope = scopes(before);
  const suggestion = projection(before).suggestions.find(row => row.itemId === cups);
  const wire = { purchaseItemId: scope.purchaseItem(cups), suggestionItemId: scope.stock(cups),
    qty: scope.value('qty', suggestion.qty + 500), dueDate: scope.value('dueDate', suggestion.dueDate) };
  const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, navisAgentFakeFetch);
  try {
    const result = await checkCommand(harness, store, 'suppliers.createOrder', wire, scope);
    assert.equal(atCard(store, result.proposal, scope).kind, 'conflict');
    assert.equal(store.getSnapshot(), before);
  } finally {
    harness.close();
  }
});

test('a duplicate supplier rename returns a typed refusal and never opens a card', async t => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot(), scope = scopes(before);
  const supplierId = scope.supplierRecord('s-dairy', 'target');
  scope.supplierRecord('s-roaster', 'name', false);
  const replacement = supplier(before, 's-roaster');
  const name = scope.value('name', label(replacement.name, replacement.nameKey));
  const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const result = await checkCommand(harness, store, 'suppliers.updateSupplier', { supplierId, patch: { name } }, scope, 'refused');
  assert.equal(result.terminal.refusal.reason, 'duplicate');
  assert.deepEqual(result.calls, [lookup('supplier', 'target'), lookup('supplier')]);
});
