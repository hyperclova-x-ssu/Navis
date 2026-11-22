import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisContractFake, navigationRequest, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { inventoryQuantityInUnit, prepareInventoryPreview } from './inventory.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envDir: false, logLevel: 'silent',
  server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
let data, tr, parseNavisNumber, readInventoryTurn, inventoryDomain, cafe, corpus;
try {
  data = await vite.ssrLoadModule('/src/data/widget-data.ts');
  const { navisTranslator } = await vite.ssrLoadModule('/src/features/assistant/messages.ts');
  ({ parseNavisNumber } = await vite.ssrLoadModule('/src/features/assistant/navis-input.ts'));
  ({ readInventoryTurn, inventoryDomain } = await vite.ssrLoadModule('/src/features/assistant/domains/inventory.ts'));
  ({ corpus, facts: cafe } = await readCafeScenarios(vite));
  tr = navisTranslator('ko');
} finally {
  await vite.close();
}

const stockFeature = 'inventory-booking';
const day = { kind: 'snapshot', asOf: cafe.today };
const catalog = [{ id: stockFeature, layer: 'management', name: tr.t('widget.inventory-booking.title'), conditions: [day, cafe.week] },
  { id: 'suppliers', layer: 'management', name: tr.t('widget.suppliers.title'), conditions: [{ kind: 'default' }] }];
const legacyIds = { 'it-milk': 'i-milk', 'it-beans': 'i-bean-house', 'it-cups': 'i-cup-takeout' };
const milk = legacyIds['it-milk'], beans = legacyIds['it-beans'], cup = legacyIds['it-cups'];
const stockTool = { name: 'search_records', args: { kind: 'stock', querySlot: 'name' } };
const sourceName = row => data.resolveDataText(tr.t, row.name ?? { key: row.nameKey });
const getRow = (snapshot, id) => data.deriveStock(snapshot, { date: cafe.today }).rows.find(item => item.itemId === id);
const activeItems = snapshot => snapshot.tables.inventoryItem.filter(row => !row.deletedAt);
const stockRecord = (rows, querySlot = 'name', match = 'exact') => ({
  ...stockTool.args, querySlot,
  matches: rows.map(({ handle, row, fields }) => ({
    handle, match, label: sourceName(row),
    fields: { kind: row.kind, unit: row.unit, ...(row.sku ? { sku: row.sku } : {}), ...fields },
  })),
});
const queryMatches = (snapshot, ids) => ids.map((id, index) => {
  const row = activeItems(snapshot).find(item => item.itemId === id);
  assert.ok(row, id);
  return { handle: `stock-${index + 1}`, row };
});

async function run(command, args, extra, fake = navisAgentFakeFetch, expectedStatus = 200) {
  const input = navigationRequest(command, args, { catalog, ...extra });
  assert.ok(validateAgentRequest(input), JSON.stringify(input.intent));
  const calls = [];
  const bridge = createBridge({ agentFetchImpl: async (url, options) => {
    const response = await fake(url, options);
    const event = /^data: (.+)$/mu.exec(await response.clone().text());
    const call = event && JSON.parse(event[1]).message.toolCalls?.[0]?.function;
    if (call) calls.push({ name: call.name, args: call.arguments });
    return response;
  } });
  try {
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    Object.assign(req, { method: 'POST', url: '/api/navis/chat', socket: { localAddress: '127.0.0.1', localPort: 5211 },
      headers: { host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json', 'x-navis-protocol': 'agent-v1' } });
    let raw = '', status;
    const res = new Writable({ write(chunk, _encoding, next) { raw += chunk; next(); } });
    res.writeHead = code => { status = code; };
    const done = new Promise(resolve => res.once('finish', resolve));
    await bridge(req, res);
    await done;
    assert.equal(status, expectedStatus, raw);
    if (expectedStatus !== 200) return { calls };
    const frames = [...raw.matchAll(/event: ([^\n]+)\ndata: (.+)\n\n/gu)].map(([, event, value]) => ({ event, value: JSON.parse(value) }));
    assert.ok(frames.every(({ event, value }) => validateAgentFrame(event, value)), raw);
    assert.equal(frames.at(-1)?.event, 'done', raw);
    const terminal = frames.at(-1).value;
    const proposal = frames.find(({ event }) => event === 'action_proposal')?.value;
    assert.equal(Boolean(proposal), terminal.outcome === 'proposal');
    assert.equal(frames.some(({ event }) => event === 'action_result'), false);
    return { ...terminal, proposal, calls, text: frames.filter(({ event }) => event === 'text_delta').map(frame => frame.value.delta).join('') };
  } finally {
    bridge.close();
  }
}

const fact = (key, value, unit, label, display, date) => ({
  key, value, unit, label, display, ...(date ? { date } : {}),
});
const qtyFact = (key, value, unit, label, date) => fact(key, value, unit, label, tr.format.quantity(value, unit), date);
const openingLabel = tr.t('data.management.history.opening');
const readStock = searches => run(undefined, undefined, {
  slots: ['name'], searches: [searches], intent: { kind: 'read', recordKind: 'stock', querySlot: 'name' },
});
const handles = (snapshot, ...ids) => stockRecord(queryMatches(snapshot, ids));
const storeInventory = snapshot => data.readModel(snapshot, stockFeature);

test('accepts an advertised stock source date and rejects an unadvertised missing frame', async () => {
  const condition = { kind: 'snapshot', asOf: '2026-11-21' };
  const intent = { kind: 'read', featureId: stockFeature, condition };
  const stock = qtyFact('product.channelBalance.retail.online', 40, 'pcs', '원두 200g · 온라인', condition.asOf);
  const ready = await run(undefined, undefined, {
    intent, catalog: [{ ...catalog[0], conditions: [condition] }],
    snapshot: [{ featureId: stockFeature, condition, facts: [stock] }],
  });
  assert.equal(ready.outcome, 'reply');
  assert.equal(ready.calls[0]?.name, 'get_widget');
  assert.equal(ready.proposal, undefined);

  const missing = { featureId: stockFeature, condition, status: 'missing' };
  const unavailable = await run(undefined, undefined, {
    intent, catalog: [{ ...catalog[0], conditions: [condition] }], snapshot: [missing],
  });
  assert.equal(unavailable.outcome, 'reply');
  assert.equal(unavailable.proposal, undefined);
  const invalid = await run(undefined, undefined, { intent, snapshot: [missing] }, navisAgentFakeFetch, 400);
  assert.deepEqual(invalid.calls, []);
});

async function checkRead(scenario, snapshot) {
  const { id, expected } = scenario;
  if (id === 'S1-145' || id === 'S1-146') {
    const search = id === 'S1-145' ? handles(snapshot, milk) : { ...handles(snapshot), status: 'missing' };
    const result = await readStock(search);
    assert.equal(result.outcome, 'reply');
    assert.deepEqual(result.calls, [stockTool]);
    if (id === 'S1-145') {
      const reader = inventoryDomain.reads[0];
      const matches = reader.search({ snapshot, locale: 'ko', query: sourceName(getRow(snapshot, milk)) });
      assert.equal(matches.length, 1);
      assert.deepEqual([reader.describe(matches[0])], expected.answer_must_contain);
    }
    else assert.match(result.text, /없어요/u);
    return;
  }
  const { args } = expected.tools[0];
  let facts, fake;
  const products = storeInventory(snapshot).products;
  if (id === 'S1-014') {
    facts = getRow(snapshot, milk).usingMenus.map(({ menuId, name }) => {
      const label = data.resolveDataText(tr.t, name);
      return fact(`inventory.usingMenu.${menuId}`, label, '', sourceName(getRow(snapshot, milk)), label);
    });
    assert.ok(facts.length > 2);
    fake = createNavisContractFake(expected.tools, { outcome: 'reply', facts: facts.map((_, index) => `f${index}`) }).fetchImpl;
  } else if (id === 'S1-133') {
    assert.equal(activeItems(snapshot).some(row => /크루아상/u.test(sourceName(row))), false);
    facts = [];
  } else if (id === 'S1-138' || id === 'S1-139') {
    assert.deepEqual(products.items, []);
    facts = [];
  } else if (id === 'S1-141') {
    const row = getRow(snapshot, milk);
    assert.equal(row.opening - row.usedToday + row.receivedToday, row.stock);
    facts = [
      qtyFact('inventory.stockHistory.opening', row.opening, row.unit, openingLabel),
      qtyFact('inventory.usedToday', row.usedToday, row.unit, sourceName(row)),
      qtyFact('inventory.stock', row.stock, row.unit, sourceName(row)),
    ];
  } else if (id === 'S1-142') {
    const history = data.selectStockHistory(snapshot, { itemId: milk, period: 'last7days' });
    assert.equal(history.dayGroups.length, 7);
    assert.equal(history.dayGroups[0].date, cafe.today);
    assert.equal(history.dayGroups.at(-1).date, cafe.week.start);
    facts = history.dayGroups.map(({ date, endingDisplay }) =>
      qtyFact('inventory.stockHistory.ending', endingDisplay, history.unit, tr.t('format.period.last7'), date));
  } else if (id === 'S1-144') {
    const row = getRow(snapshot, cup);
    assert.ok(row.usedToday > 0);
    facts = [qtyFact('inventory.stock', row.stock, row.unit, sourceName(row)),
      qtyFact('inventory.daysLeft', Math.floor(row.stock / row.usedToday), 'day', sourceName(row))];
  } else {
    assert.fail(`Unexpected read fixture ${id}`);
  }
  const result = await run(undefined, undefined, {
    slots: id === 'S1-014' ? ['name'] : [], intent: { kind: 'read', ...args },
    snapshot: [{ ...args, ...(facts.length ? { facts } : { status: 'missing' }) }],
    ...(id === 'S1-014' ? { searches: [{ ...expected.tools[1].args, status: 'missing', matches: [] }] } : {}),
  }, fake);
  assert.equal(result.outcome, 'reply');
  assert.deepEqual(result.calls, expected.tools);
  if (facts.length) for (const item of facts) assert.ok(result.text.includes(item.display), item.display);
  else assert.match(result.text, /없어요/u);
  if (scenario.review && expected.answer_must_contain && id !== 'S1-142') {
    for (const fragment of expected.answer_must_contain) assert.ok(result.text.includes(fragment), fragment);
  }
}

async function checkNavigation(scenario, snapshot) {
  const { id, expected } = scenario;
  const detail = expected.tools.at(-1).args;
  const focus = id === 'S7-079' ? { focus: 'action' } : {};
  const withTarget = typeof detail.itemId === 'string';
  const args = { ...detail, ...focus, ...(withTarget ? { itemId: { handle: 'stock-1' } } : {}) };
  const result = await run('ui.openDetail', args, withTarget ? { slots: ['name'], searches: [handles(snapshot, milk)] } : {});
  assert.equal(result.outcome, 'navigate');
  assert.deepEqual(result.navigation.args, args);
  assert.deepEqual(result.calls, []);
}

const quantities = {
  'S1-153': ['stock', 5, 'L'], 'S1-158': ['stock', 2500, 'g'], 'S1-161': ['threshold', 6, 'L'],
  'S1-162': ['threshold', 100, 'pcs'], 'S1-165': ['stock', 5, 'L'], 'S1-166': ['stock', 3, 'kg'],
  'S8-018': ['stock', 5, 'mL'], 'S8-042': ['stock', 500, 'mL'], 'S8-091': ['stock', 5, 'L'],
  'S8-095': ['stock', 5, 'L'], 'S8-125': ['stock', 5, 'L'], 'S8-126': ['stock', parseNavisNumber('3'), 'kg'],
  'S8-127': ['stock', parseNavisNumber('반'), 'kg'], 'S8-128': ['stock', parseNavisNumber('이백'), 'pcs'],
};
const searchTarget = {
  'S1-154': milk, 'S1-155': milk, 'S1-156': milk, 'S1-157': cup, 'S1-159': beans, 'S1-160': milk,
  'S1-164': cup, 'S1-186': milk, 'S1-188': milk, 'S8-017': milk, 'S8-019': milk, 'S8-129': cup,
};
const invalidAmounts = {
  'S1-156': [-3, 'L', 'stock'], 'S1-157': [12.5, 'pcs', 'stock'], 'S1-159': [2.0005, 'kg', 'stock'],
  'S1-160': [3, 'kg', 'unit'], 'S8-017': [5, 'pcs', 'unit'], 'S8-129': [2, 'box', 'packSize'],
};
const formCreate = new Set(['S1-171', 'S1-172', 'S1-173', 'S1-174', 'S1-175', 'S1-176']);

function authoredTarget(value) {
  const id = /^<handle: (.+)>$/u.exec(value)?.[1] ?? value;
  return legacyIds[id] ?? id;
}

function confirmAndUndo(store, before, command, args, proposal, expected) {
  assert.equal(store.getSnapshot(), before);
  const expanded = { type: command, ...args, baseRevision: proposal.snapshotRevision,
    ...(command === 'inventory.createItem' ? { idempotencyKey: proposal.proposalId } : {}) };
  const receipt = store.dispatch(expanded);
  assert.ok(receipt.ok && receipt.undoToken, JSON.stringify(receipt));
  assert.equal(receipt.revision, before.revision + 1);
  const after = store.getSnapshot();
  const receiptAgain = store.dispatch(expanded);
  assert.equal(store.getSnapshot(), after);
  if (command === 'inventory.createItem') {
    assert.equal(receiptAgain.duplicate, true);
  }
  else {
    assert.equal(receiptAgain.code, 'CONFLICT');
    assert.equal(receiptAgain.reason, 'STALE_REVISION');
  }
  if (command === 'inventory.updateItem') {
    const current = getRow(after, args.itemId), original = getRow(before, args.itemId);
    if (args.name !== undefined) assert.equal(sourceName(current), args.name);
    if (args.stock !== undefined) assert.equal(current.stock, args.stock);
    if (args.threshold !== undefined) assert.equal(current.restockThreshold, args.threshold);
    assert.equal(after.tables.stockAdjustment.length - before.tables.stockAdjustment.length, Number(args.stock !== undefined && original.raw !== args.stock));
    if (expected.inventoryEdit) {
      const stock = data.deriveStock(after, { date: cafe.today });
      assert.deepEqual({
        before: { stock: original.stock, threshold: original.restockThreshold },
        after: { stock: current.stock, threshold: current.restockThreshold },
        delta: current.raw - original.raw,
        unit: current.unit, display: tr.format.quantity(current.stock, current.unit),
        restockCount: stock.restockCount, outOfStockCount: stock.outOfStockCount,
      }, expected.inventoryEdit);
    }
  } else {
    const affected = after.tables.inventoryItem.find(row => row.itemId === (args.itemId ?? receipt.value.itemId));
    if (command === 'inventory.deleteItem') assert.ok(affected.deletedAt);
    else if (command === 'inventory.createItem') {
      assert.equal(affected.sku, args.sku);
      assert.equal(affected.trackRestock, args.trackRestock ?? true);
      assert.equal(getRow(after, affected.itemId).stock, args.stock);
    }
  }
  assert.equal(store.undo(receipt.undoToken).ok, true);
  const restored = store.getSnapshot();
  for (const table of ['inventoryItem', 'inventoryStock', 'stockAdjustment', 'inventoryTxn', 'purchaseItem']) {
    assert.deepEqual(restored.tables[table], before.tables[table]);
  }
}

async function checkProposal(scenario, store, step) {
  const { id } = scenario;
  const { command } = step.args;
  const args = { ...step.args.args };
  if (args.itemId) args.itemId = authoredTarget(args.itemId);
  if (id === 'S1-189') {
    const created = store.dispatch({ type: 'inventory.createItem', sku: 'OAT-01', name: '귀리우유', unit: 'L', stock: 4, threshold: 2, idempotencyKey: 'precondition-oat' });
    assert.ok(created.ok);
    args.itemId = created.value.itemId;
  }
  const before = store.getSnapshot();
  const row = args.itemId ? getRow(before, args.itemId) : null;
  for (const [field, value, unit] of [quantities[id], ...(id === 'S1-165' ? [['threshold', 6, 'L']] : [])].filter(Boolean)) {
    const resolved = inventoryQuantityInUnit(value, unit, row.unit);
    assert.ok('value' in resolved);
    assert.equal(resolved.value, args[field]);
  }
  const searches = row ? stockRecord(queryMatches(before, [row.itemId]).map(record => ({
    ...record, ...(command === 'inventory.deleteItem' ? { fields: { referenced: false } } : {}),
  }))) : handles(before);
  const privateFields = Object.keys(args).filter(key => ['sku', 'name', 'stock', 'threshold', 'qty'].includes(key));
  const wire = Object.fromEntries(Object.entries(args).map(([key, value]) =>
    [key, key === 'itemId' ? { handle: 'stock-1' } : privateFields.includes(key) ? { slot: key } : value]));
  const preview = prepareInventoryPreview(command, args, {
    target: row ? { ...row, rawStock: row.raw, threshold: row.restockThreshold, name: sourceName(row),
      ...(command === 'inventory.deleteItem' ? { referenced: false } : {}) } : undefined,
  });
  assert.equal(preview.outcome, 'ready');
  const result = await run(command, wire, { slots: [...new Set(['name', ...privateFields])], searches: [searches], snapshotRevision: before.revision });
  assert.equal(result.outcome, 'proposal');
  assert.deepEqual({ command: result.proposal.command, args: result.proposal.args }, { command, args: wire });
  assert.equal(result.proposal.tier, command === 'inventory.deleteItem' ? 'extra-confirm' : 'normal');
  assert.deepEqual(result.calls, [stockTool, { name: 'propose_action', args: { command, args: wire } }]);
  confirmAndUndo(store, before, command, args, result.proposal, scenario.expected);
}

async function checkRecipeDependency(scenario, store) {
  const { id, expected } = scenario;
  const before = store.getSnapshot();
  if (id === 'S1-061') {
    const result = await readStock({ ...handles(before), status: 'missing' });
    assert.equal(result.outcome, 'reply');
    assert.deepEqual(result.calls, [expected.tools[1]]);
    assert.match(result.text, /없어요/u);
    assert.equal(store.getSnapshot(), before);
    return;
  }
  const { menuId, lines } = expected.tools.at(-1).args.args;
  const menu = data.selectMenus(before, {}).rows.find(row => row.menuId === menuId);
  const ingredient = lines.at(-1);
  const result = await readStock(handles(before, ingredient.itemId));
  assert.deepEqual(result.calls, [expected.tools[1]]);
  const rest = data.deriveRecipeCost(before, menuId);
  const recorded = rest.recipeLines.map(row => qtyFact('menu.recipe.line', row.quantity, row.unit, sourceName(row)));
  const args = { menuId: { handle: 'menu-1' }, lines: { slot: 'lines' } };
  const { proposal, outcome, calls } = await run('menu.setRecipe', args, {
    slots: ['name', 'lines'], snapshotRevision: before.revision,
    intent: { kind: 'command', command: 'menu.setRecipe', args, querySlot: 'name' },
    searches: [{ kind: 'menu', querySlot: 'name', matches: [{ handle: 'menu-1', match: 'exact', label: sourceName(menu),
      fields: { kind: 'menu', status: 'selling' } }] }],
    readings: [{ tool: 'get_recipe', args: { menuId: args.menuId }, facts: recorded }],
  });
  assert.equal(outcome, 'proposal');
  assert.deepEqual(calls.map(call => call.name), ['search_records', 'get_recipe', 'propose_action']);
  assert.deepEqual(proposal.args, args);
  assert.equal(store.getSnapshot(), before);
  const receipt = store.dispatch({ type: 'menu.setRecipe', menuId, lines, baseRevision: proposal.snapshotRevision });
  assert.ok(receipt.ok && receipt.undoToken);
  assert.equal(data.deriveRecipeCost(store.getSnapshot(), menuId).cost, cafe.recipe.withSyrupResult.cost);
  assert.equal(store.undo(receipt.undoToken).ok, true);
  assert.deepEqual(store.getSnapshot().tables.recipeLine, before.tables.recipeLine);
}

async function checkBoundary(scenario, store) {
  const { id, expected } = scenario;
  const before = store.getSnapshot();
  if (id === 'S1-188' || id === 'S1-186') {
    const command = id === 'S1-188' ? 'inventory.deleteItem' : 'inventory.moveChannel';
    const row = getRow(before, milk);
    const referenced = row.usingMenus.length > 0;
    assert.ok(referenced);
    const searches = stockRecord(queryMatches(before, [milk]).map(match => ({ ...match, fields: { referenced } })));
    const args = { itemId: { handle: 'stock-1' }, ...(id === 'S1-186' ? { from: 'store', to: 'online', qty: { slot: 'qty' } } : {}) };
    const result = await run(command, args, { slots: ['name', 'qty'], searches: [searches] });
    assert.equal(result.outcome, 'refused');
    assert.equal(result.refusal.reason, 'invalid_target');
    assert.deepEqual(result.calls, [stockTool]);
  } else if (formCreate.has(id)) {
    const duplicateName = id === 'S1-174';
    const occupiedSku = id === 'S1-173' && activeItems(before).some(row => row.sku === 'RM-001');
    const found = duplicateName ? [milk] : [];
    const args = { sku: id === 'S1-171' ? undefined : id === 'S1-173' ? 'RM-001' : 'OAT-01',
      name: duplicateName ? sourceName(getRow(before, milk)) : '귀리우유',
      unit: id === 'S1-172' ? undefined : id === 'S1-175' ? 'box' : id === 'S1-176' ? 'pcs' : 'L',
      stock: id === 'S1-176' ? 2.5 : 4, threshold: 2 };
    const result = await readStock(handles(before, ...found));
    assert.deepEqual(result.calls, [stockTool]);
    assert.deepEqual(prepareInventoryPreview('inventory.createItem', args, { occupiedSku, duplicateName }),
      { outcome: 'clarify', field: expected.ask[0] });
  } else if (id === 'S1-167') {
    const added = store.dispatch({ type: 'inventory.createItem', sku: 'SYRUP-TEST', name: '카라멜 시럽', unit: 'mL', stock: 1000,
      threshold: 400, idempotencyKey: 'precondition-syrup' });
    assert.ok(added.ok);
    const captured = store.getSnapshot();
    const matches = activeItems(captured).filter(row => sourceName(row).includes('시럽'));
    const searches = stockRecord(queryMatches(captured, matches.map(item => item.itemId)), 'name', 'similar');
    const result = await readStock(searches);
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.clarification.recordKind, 'stock');
    assert.deepEqual(result.clarification.choices.map(choice => choice.label), searches.matches.map(match => match.label));
    assert.deepEqual(result.calls, [stockTool]);
    assert.equal(store.getSnapshot(), captured);
    return;
  } else {
    const targetId = searchTarget[id];
    assert.ok(targetId, id);
    const row = getRow(before, targetId);
    const result = await readStock(handles(before, targetId));
    assert.deepEqual(result.calls, [stockTool]);
    if (Object.hasOwn(invalidAmounts, id)) {
      const [amount, unit, field] = invalidAmounts[id];
      const checked = inventoryQuantityInUnit(amount, unit, row.unit);
      assert.ok('field' in checked);
      assert.equal(checked.field === 'quantity' ? 'stock' : checked.field, field);
      if (id === 'S8-017') assert.deepEqual([row.unit], expected.answer_must_contain);
    } else if (id === 'S1-154') {
      assert.deepEqual(prepareInventoryPreview('inventory.updateItem', { itemId: targetId }, { target: row }),
        { outcome: 'clarify', field: expected.ask[0] });
    } else if (id === 'S1-155') {
      const { args } = expected.tools[1];
      const suppliers = data.readModel(before, 'suppliers');
      const result = await run(undefined, undefined, { intent: { kind: 'read', ...args }, snapshot: [{ ...args, facts: [
        qtyFact('suppliers.upcoming.count', suppliers.upcomingCount, 'item', tr.t('widget.suppliers.title')),
      ] }] });
      assert.deepEqual(result.calls, [expected.tools[1]]);
      const route = readInventoryTurn(scenario.utterances[0], before, 'ko');
      assert.equal(route?.kind, 'clarification');
      assert.equal(route.field, expected.ask[0]);
    } else {
      assert.equal(id, 'S8-019');
      const route = readInventoryTurn(scenario.utterances[0], before, 'ko');
      assert.deepEqual([route?.kind, route?.field], ['clarification', 'method']);
    }
  }
  assert.equal(store.getSnapshot(), before);
}

async function checkMissingInventory(scenario, store) {
  const { expected, n05Missing, n05RejectedDraft } = scenario;
  const before = store.getSnapshot();
  if (n05Missing === '크루아상') {
    assert.ok(!activeItems(before).some(row => sourceName(row).includes(n05Missing)));
  } else {
    assert.deepEqual(storeInventory(before).products.items, []);
  }
  if (expected.tools[0].name === 'get_widget') return checkRead(scenario, before);

  const search = { ...stockTool.args, status: 'missing', matches: [] };
  let result;
  if (n05RejectedDraft) {
    const { command, args } = n05RejectedDraft;
    const numericFields = Object.keys(args).filter(key => typeof args[key] === 'number');
    const wire = { ...args, itemId: { handle: 'stock-missing' } };
    for (const key of numericFields) wire[key] = { slot: key };
    result = await run(command, wire, { slots: ['name', ...numericFields], searches: [search] });
    assert.equal(expected.kind, 'refuse');
    assert.equal(result.outcome, 'refused');
    // A3_BATCH2 B26 gives an invalid stock target fixed missing-target copy and no widget handoff.
    assert.deepEqual(result.refusal, { reason: 'invalid_target' });
    assert.equal(result.text, '해당 항목을 찾을 수 없어요. 이름이나 상태를 확인해 주세요.');
  } else {
    result = await readStock(search);
    assert.equal(expected.kind, 'answer');
    assert.equal(result.outcome, 'reply');
    assert.deepEqual([result.text], expected.answer_must_contain);
  }
  assert.deepEqual(result.calls, expected.tools);
  assert.equal(result.proposal, undefined);
  assert.equal(store.getSnapshot(), before);
}

test('N05 setting the stored cup count is unchanged', () => {
  const before = data.createWidgetDataStore().getSnapshot();
  const row = getRow(before, cup);
  const args = { itemId: cup, stock: row.raw };
  const target = { ...row, rawStock: row.raw };
  assert.deepEqual(prepareInventoryPreview('inventory.updateItem', args, { target }), { outcome: 'unchanged' });
});

test('N05 distinguishes package sizes from unit mismatches and preserves count units', () => {
  for (const unit of ['box', 'pack', 'tray']) {
    assert.deepEqual(inventoryQuantityInUnit(2, unit, 'pcs'), { field: 'packSize' });
    assert.deepEqual(inventoryQuantityInUnit(2, unit, 'mL'), { field: 'unit' });
  }
  assert.deepEqual(inventoryQuantityInUnit(200, 'sheet', 'pcs'), { value: 200 });
  assert.deepEqual(inventoryQuantityInUnit(200, 'sheet', 'mL'), { field: 'unit' });
  assert.deepEqual(inventoryQuantityInUnit(2500, 'g', 'kg'), { value: 2.5 });
  assert.deepEqual(inventoryQuantityInUnit(-3, 'L', 'mL'), { field: 'quantity' });
});

test('N05 server contracts for all 63 assigned inventory scenarios', async t => {
  const trace = readTrace();
  const assigned = trace.filter(row => row.slice_id === 'N05');
  const required = trace.filter(row => row.required_slices.split('|').includes('N05'));
  assert.equal(assigned.length, 63);
  assert.equal(required.length, 81);
  assert.equal(new Set(assigned.map(row => row.scenario_id)).size, assigned.length);
  assert.ok(assigned.every(row => required.includes(row)));
  const failures = [];
  let passed = 0;
  for (const { scenario_id: id } of assigned) {
    try {
      const scenario = corpus.get(id);
      assert.ok(scenario.utterances.length > 0, id);
      const store = data.createWidgetDataStore();
      const snapshot = store.getSnapshot();
      const proposal = scenario.expected.tools.find(tool => tool.name === 'propose_action');
      if (scenario.n05Missing) await checkMissingInventory(scenario, store);
      else if (id === 'S1-060' || id === 'S1-061') await checkRecipeDependency(scenario, store);
      else if (scenario.expected.kind === 'navigate') await checkNavigation(scenario, snapshot);
      else if (scenario.expected.kind === 'proposal') await checkProposal(scenario, store, proposal);
      else if (scenario.expected.kind === 'answer' && scenario.expected.risk === 'read') await checkRead(scenario, snapshot);
      else await checkBoundary(scenario, store);
      passed++;
    } catch (error) {
      failures.push(`${id} ${error.message}`);
    }
  }
  t.diagnostic(`${passed} of 63 passed the N05 server checks`);
  t.diagnostic(`${required.length} required_slices dependencies including ${assigned.length} assigned and ${required.length - assigned.length} assigned to another slice`);
  assert.deepEqual(failures, [], 'N05 unexpected scenario failures');
  assert.equal(passed, assigned.length);
});

test('N05 a scoped retail transfer conserves quantity and reverses both movements on undo', async () => {
  const baseline = data.createWidgetDataStore().getSnapshot();
  const itemId = 'test-retail';
  const item = { ...getRow(baseline, cup), itemId, kind: 'retail', name: { raw: 'N05 test item' } };
  const store = data.createWidgetDataStore({
    inventoryItem: [...baseline.tables.inventoryItem, item],
    inventoryStock: [{ itemId, channel: 'store', qty: 40 }, { itemId, channel: 'online', qty: 10 }],
  });
  const before = store.getSnapshot();
  const stock = storeInventory(before).products.items.find(item => item.itemId === itemId);
  const unit = { itemId, from: 'store', to: 'online', qty: 7 };
  const preview = prepareInventoryPreview('inventory.moveChannel', unit, { target: { ...stock, kind: 'retail' } });
  assert.equal(preview.outcome, 'ready');
  const command = 'inventory.moveChannel';
  const args = { ...unit, itemId: { handle: 'stock-1' }, qty: { slot: 'qty' } };
  const searches = stockRecord(queryMatches(before, [itemId]).map(record => ({
    ...record, fields: { store: stock.store, online: stock.online },
  })));
  const result = await run(command, args, { slots: ['name', 'qty'], searches: [searches], snapshotRevision: before.revision });
  assert.equal(result.outcome, 'proposal');
  assert.equal(result.proposal.tier, 'normal');
  assert.deepEqual(result.calls, [stockTool, { name: 'propose_action', args: { command, args } }]);
  assert.equal(store.getSnapshot(), before);
  const receipt = store.dispatch({ type: command, ...unit, baseRevision: result.proposal.snapshotRevision });
  assert.ok(receipt.ok && receipt.undoToken);
  const after = store.getSnapshot();
  const moved = storeInventory(after).products.items.find(item => item.itemId === itemId);
  assert.deepEqual([moved.store, moved.online, moved.total], [preview.after.store, preview.after.online, stock.total]);
  const movements = after.tables.inventoryTxn.slice(before.tables.inventoryTxn.length);
  assert.deepEqual(movements.map(row => [row.channel, row.qty]), [['store', -7], ['online', 7]]);
  assert.equal(movements[0].ref, movements[1].ref);
  assert.equal(store.undo(receipt.undoToken).ok, true);
  assert.deepEqual(store.getSnapshot().tables.inventoryStock, before.tables.inventoryStock);
  assert.deepEqual(store.getSnapshot().tables.inventoryTxn, before.tables.inventoryTxn);
});
