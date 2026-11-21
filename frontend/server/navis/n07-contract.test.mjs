import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import {
  createNavisContractFake, createNavisMenuHarness, navigationRequest, reading,
} from '../fixtures/navis-eval-fake.mjs';
import { readCafeScenarios, readTrace, scenarioVariant } from './scenario-fixtures.mjs';

const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false, logLevel: 'silent',
  server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
let corpus, facts, layout, registry, conditions, runtime;
try {
  ({ corpus, facts } = await readCafeScenarios(vite));
  [layout, registry, conditions] = await Promise.all([
    vite.ssrLoadModule('/src/layout/index.ts'), vite.ssrLoadModule('/src/catalog/index.ts'), vite.ssrLoadModule('/src/data/conditions.ts'),
  ]);
  const [state, data, fixtures, policy, actions, domains, domain] = await Promise.all([
    vite.ssrLoadModule('/src/state/index.ts'), vite.ssrLoadModule('/src/data/db/store.ts'),
    vite.ssrLoadModule('/src/state/test-fixtures.ts'), vite.ssrLoadModule('/src/layout/test-policy.ts'),
    vite.ssrLoadModule('/src/features/assistant/agent-actions.ts'), vite.ssrLoadModule('/src/features/assistant/domains/registry.ts'),
    vite.ssrLoadModule('/src/features/assistant/domains/layout.ts'),
  ]);
  runtime = { ...state, ...data, ...fixtures, ...policy, ...actions, ...domains, ...domain };
} finally {
  await vite.close();
}

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N07');
const dependent = trace.filter(row => row.required_slices.split('|').includes('N07'));
const layers = ['management', 'marketing'];
const grid = layout.screenPresets.A.grid;
const registryA = registry.getRegistry('A');
const catalog = registryA.map(({ id, label, layer }) => ({ id, name: label, layer, conditions: conditions.supportedConditions(id) }));
const names = new Map(catalog.map(({ id, name }) => [id, name]));
const cafeTemplate = registry.getManagementTemplates({ businessType: 'cafe', paymentStyle: 'prepaid', presetId: 'A' })[0].panels;
const marketingPreset = registry.getMarketingPreset('cafe');
const coupons = ['slot-coupon', 'expiry-coupon', 'coupon-status'];

const apply = (panels, intent) => layout.preview(panels, intent, grid, registryA);
function panel(panels, id) {
  const match = panels.find(entry => entry.featureId === id);
  assert.ok(match, id);
  return match;
}
function fill(panels, ids) {
  return ids.reduce((before, featureId) => {
    const result = apply(before, { type: 'add-tap', featureId });
    assert.equal(result.status, 'accepted');
    return result.panels;
  }, panels);
}
const full = fill(cafeTemplate, ['tax', 'grants', 'manuals', 'members', 'staff-schedule', 'credit-receivable', 'store-environment', 'custom-order']);
const almostFull = [
  ['custom-order', 0, 0, 2, 2], ['suppliers', 2, 0, 2, 2], ['tax', 4, 0, 2, 2],
  ['credit-receivable', 0, 2, 2, 1], ['members', 2, 2, 2, 1], ['customer-analysis', 4, 2, 2, 1],
  ...['store-environment', 'manuals', 'grants', 'staff-schedule', 'voice-booking'].map((id, column) => [id, column, 3, 1, 1]),
].map(([featureId, column, row, width, height]) => ({ featureId, column, row, width, height }));

function fixture(id) {
  const management = [cafeTemplate], marketing = [[]];
  const layer = ['S5-079', 'S7-009', 'S7-023', 'S7-024', 'S7-060'].includes(id) ? 'marketing' : 'management';
  if (['S7-009', 'S7-023', 'S7-024'].includes(id)) {
    marketing[0] = id === 'S7-009' ? marketingPreset.filter(({ featureId }) => !coupons.includes(featureId)) : marketingPreset;
  }
  if (['S7-010', 'S7-049'].includes(id)) management[0] = full;
  if (id === 'S7-025') management[0] = fill([], ['menu']);
  if (['S7-058', 'S7-059', 'S7-060', 'S7-216'].includes(id)) management[0] = [];
  if (['S7-021', 'S7-036', 'S7-037', 'S7-038', 'S7-040', 'S7-183', 'S7-219'].includes(id)) management.push([]);
  if (['S7-039', 'S7-052'].includes(id)) management.push([], [], [], []);
  if (id === 'S7-021') {
    const target = panel(management[0], 'calendar');
    management[1] = [{ ...target, ...layout.nearestEmptyRect([], grid, target.width, target.height, target.column, target.row) }];
    management[0] = management[0].filter(({ featureId }) => featureId !== 'calendar');
  }
  if (id === 'S7-040') management[1] = almostFull;
  return { layer, page: id === 'S7-219' ? 2 : 1, boards: { management, marketing } };
}

function projectBoard(fixture, args) {
  const pages = fixture.boards[args.layer];
  const current = args.page ?? (fixture.layer === args.layer ? fixture.page : 1);
  const panels = pages[current - 1];
  const placements = Object.fromEntries(pages.flatMap((entries, index) => entries.flatMap(({ featureId, ...rect }) => [
    [`board.panel.${featureId}.page`, index + 1],
    ...(index + 1 === current ? ['column', 'row', 'width', 'height'].map(field => [`board.panel.${featureId}.${field}`, rect[field]]) : []),
  ])));
  return reading('get_board', args, {
    'board.pageCount': pages.length, ...(panels ? {
      'board.page': current, 'board.grid.columns': grid.columns, 'board.grid.rows': grid.rows,
      'board.cells.free': layout.evaluate(panels, grid, registryA).remainingCells, ...placements,
    } : {}),
  });
}

async function send(state, intent, readings, transport) {
  // Scope the command catalog to the affected widgets. Board reads may use both layers.
  const args = intent.args ?? {};
  const targetIds = new Set(args.featureIds ?? args.widgets?.map(widget => widget.featureId) ?? [args.featureId, args.a, args.b]);
  const scopedCatalog = intent.kind === 'read' ? catalog.filter(entry => readings.some(read => read.args.layer === entry.layer))
    : catalog.filter(({ id }) => targetIds.has(id));
  const candidates = transport ? scopedCatalog.filter(entry => !state.boards[entry.layer]
    .some(page => page.some(panel => panel.featureId === entry.id))) : scopedCatalog;
  const harness = createNavisMenuHarness(createBridge, schema.validateAgentFrame, transport);
  try {
    return await harness.run(navigationRequest(intent.command, args, {
      runId: state.runId ?? 'fixture-run', snapshotRevision: state.revision ?? 7,
      businessDate: facts.today, locale: state.locale ?? 'ko', layer: state.layer, page: state.page, intent, readings, catalog: candidates,
    }));
  } finally {
    harness.close();
  }
}

async function command(state, name, args, outcome, detail, project = projectBoard) {
  const layer = args.layer ?? state.layer;
  const source = { layer, ...(args.page === undefined ? {} : { page: args.page }) };
  const addresses = [source];
  if (name === 'layout.move_to_page' && args.destinationPage !== undefined && args.destinationPage !== args.page) {
    addresses.push({ layer, page: args.destinationPage });
  }
  const reads = addresses.map(address => project(state, address));
  const before = structuredClone(state);
  const result = await send(state, { kind: 'command', command: name, args }, reads);
  assert.equal(result.status, outcome === 'bad_request' ? 400 : 200, result.raw);
  if (outcome === 'bad_request') {
    assert.deepEqual(result.calls, []);
    return;
  }
  assert.equal(result.terminal.outcome, outcome, result.raw);
  assert.equal(result.proposal !== undefined, outcome === 'proposal', result.raw);
  assert.doesNotMatch(result.raw, /event: action_result/u);
  assert.deepEqual(state, before);
  if (outcome === 'clarify') {
    assert.equal(result.terminal.clarification.field, detail);
  } else {
    if (outcome === 'refused') assert.equal(result.terminal.refusal.reason, detail);
    const ordered = addresses.map(args => ({ name: 'get_board', args }));
    if (outcome === 'proposal') ordered.push({ name: 'propose_action', args: { command: name, args } });
    assert.deepEqual(result.calls, ordered);
  }
  if (outcome === 'proposal') {
    assert.deepEqual({ ...result.proposal, proposalId: 'fixture' }, {
      command: name, args, layer: state.layer, page: state.page, snapshotRevision: state.revision ?? 7,
      runId: state.runId ?? 'fixture-run', proposalId: 'fixture',
      tier: /^layout\.remove_widget/u.test(name) ? 'extra-confirm' : 'normal',
    });
  }
  return result;
}

const refusal = {
  'S7-006': 'duplicate', 'S7-010': 'unavailable', 'S7-022': 'invalid_target', 'S7-023': 'out_of_scope',
  'S7-033': 'duplicate', 'S7-037': 'duplicate', 'S7-040': 'unavailable', 'S7-047': 'duplicate',
  'S7-049': 'unavailable', 'S7-052': 'unavailable', 'S7-061': 'duplicate', 'S7-219': 'duplicate',
};
const geometry = {
  'S7-001': [4, 2, 1, 1], 'S7-002': [4, 2, 2, 2], 'S7-003': [0, 3, 1, 1], 'S7-004': [0, 2, 1, 1],
  'S7-029': [0, 3, 2, 1], 'S7-030': [1, 2, 2, 1], 'S7-042': [0, 2, 2, 2], 'S7-048': [0, 0, 1, 1],
  'S7-050': [0, 2, 3, 1], 'S7-218': [0, 0, 3, 3], 'S5-079': [0, 0, 1, 1], 'S7-058': [0, 0, 1, 1],
};
const displacements = { 'S7-004': ['inventory-booking'], 'S7-030': ['menu'], 'S7-050': ['menu'],
  'S7-218': ['ledger', 'margin', 'inventory-booking', 'menu'] };
const position = ({ column, row, width, height }) => [column, row, width, height];

function verifyEnginePreview(id, state, name, args) {
  const layer = args.layer ?? state.layer;
  const pages = state.boards[layer];
  const panels = pages[(args.page ?? (state.layer === layer ? state.page : 1)) - 1];
  const { featureId, ...draft } = args;
  if (geometry[id]) {
    const type = name === 'layout.move_widget' ? 'move' : name === 'layout.resize_widget' ? 'resize'
      : args.column === undefined ? 'add-candidate-tap' : 'add-ai';
    const result = apply(panels, { type, featureId, width: 1, height: 1, ...draft });
    assert.equal(result.status, 'accepted');
    assert.deepEqual(position(panel(result.panels, featureId)), geometry[id]);
    assert.deepEqual(result.displacements.map(item => item.featureId).sort(), (displacements[id] ?? []).toSorted());
  } else if (id === 'S7-016') {
    const proposed = args.widgets.reduce((before, widget) => {
      const result = apply(before, { type: 'add-candidate-tap', ...widget });
      assert.equal(result.status, 'accepted');
      return result.panels;
    }, panels);
    assert.deepEqual(position(panel(proposed, 'suppliers')), [4, 2, 1, 1]);
    assert.deepEqual(position(panel(proposed, 'tax')), [5, 2, 1, 1]);
    assert.equal(proposed.length, 8);
  } else if (['S7-036', 'S7-039', 'S7-040'].includes(id)) {
    const target = panel(panels, featureId);
    const next = layout.nearestEmptyRect(pages[args.destinationPage - 1], grid, target.width, target.height, target.column, target.row);
    assert.deepEqual(next, id === 'S7-040' ? null : { column: 0, row: 2 });
  } else if (id === 'S7-059') {
    const recommended = registry.getBusinessPreset('cafe').starterIds;
    const result = apply(panels, { type: 'starter', featureIds: recommended });
    assert.deepEqual(result.panels.map(({ featureId }) => featureId), ['ledger', 'margin', 'calendar']);
    assert.deepEqual(result.panels.map(position), [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1]]);
  } else if (id === 'S7-060') {
    const result = layout.evaluate(marketingPreset, grid, registryA);
    assert.equal(result.valid, true);
    assert.equal(result.panels.length, 8);
  }
}

async function readBoard(id, state, expected) {
  const primary = id === 'S5-079' ? expected.tools[0].args : { layer: id === 'S7-186' ? 'marketing' : 'management' };
  const boardQuestion = { 'S5-079': 'widget', 'S7-183': 'pages', 'S7-184': 'free', 'S7-185': 'widget', 'S7-187': 'unplaced' }[id] ?? 'panels';
  const { run, snapshot } = liveBoard(id);
  let content;
  try {
    const tool = runtime.layoutDomain.tools.find(tool => tool.tool === 'get_board');
    content = tool.read(snapshot, primary, 'ko', { boardQuestion, boardFeature: id === 'S5-079' ? 'community' : 'inventory-booking' }, new Map(), run.getState());
  } finally {
    run.dispose();
  }
  assert.ok(content.facts?.length);
  const rows = [{ tool: 'get_board', args: primary, facts: content.facts }];
  const script = boardQuestion === 'unplaced'
    ? createNavisContractFake(expected.tools, { outcome: 'reply', facts: content.facts.map((_, index) => `f${index}`) }).fetchImpl
    : undefined;
  const intent = script ? { kind: 'read' } : { kind: 'read', tool: 'get_board' };
  const result = await send(state, intent, rows, script);
  assert.equal(result.terminal.outcome, 'reply', result.raw);
  assert.equal(result.proposal, undefined);
  assert.ok(result.calls.some(({ name, args }) => name === 'get_board' && args.layer === primary.layer));
  if (script) assert.deepEqual(result.calls, expected.tools.map(({ name, args }) => ({ name, args })));
  for (const phrase of expected.answer_must_contain) assert.ok(result.answer.includes(phrase), `${phrase}: ${result.answer}`);
}

const incomplete = {
  'S7-009': ['add_widget', {}, 'featureId'], 'S7-024': ['remove_widget', {}, 'featureId'],
  'S7-032': ['move_widget', { featureId: 'inventory-booking', column: 6, row: 2 }, 'column'],
  'S7-034': ['move_widget', { featureId: 'inventory-booking' }, 'column'], 'S7-035': ['move_widget', {}, 'featureId'],
  'S7-038': ['move_to_page', { featureId: 'inventory-booking', page: 1, destinationPage: 3 }, 'destinationPage'],
  'S7-043': ['resize_widget', { featureId: 'menu' }, 'width'],
  'S7-044': ['resize_widget', { featureId: 'calendar', width: 3, height: 2 }, 'width'],
  'S7-045': ['resize_widget', { featureId: 'ledger', height: 1 }, 'width'],
  'S7-216': ['add_widget', { layer: 'marketing' }, 'featureId'], 'S7-220': ['add_widget', {}, 'featureId'],
};

async function checkScenario(id, scenario) {
  const state = fixture(id), { expected } = scenario;
  if (expected.tools.some(step => step.name === 'get_board')) return readBoard(id, state, expected);
  if (incomplete[id]) {
    const [verb, args, field] = incomplete[id];
    assert.equal(expected.kind, 'clarify');
    if (['S7-009', 'S7-024', 'S7-216'].includes(id)) {
      const matches = registryA.filter(entry => entry.aliases.includes('쿠폰')).map(entry => entry.id);
      assert.deepEqual(matches.toSorted(), coupons.toSorted());
      assert.deepEqual(expected.answer_must_contain, coupons.map(id => names.get(id)));
    }
    await command(state, `layout.${verb}`, args, 'clarify', field);
    return;
  }
  if (id === 'S7-005' || id === 'S7-046') {
    const verb = id === 'S7-005' ? 'add_widget' : 'resize_widget';
    const featureId = id === 'S7-005' ? 'tax' : 'inventory-booking';
    for (const width of [0, 5, 6]) await command(state, `layout.${verb}`, { featureId, width, height: 1 }, 'bad_request');
    return;
  }

  const step = expected.tools.find(step => step.name.startsWith('layout.'));
  assert.ok(step, id);
  let { name, args } = step;
  if (id === 'S7-019') {
    const sevenDays = conditions.supportedConditions('ledger').find(condition => condition.kind === 'dateRange');
    assert.deepEqual(args.condition, sevenDays);
  }
  if (id === 'S7-219') args = { ...args, page: 2 };
  if (id === 'S7-028') {
    name = 'layout.remove_widgets';
    args = { featureIds: expected.tools.map(step => step.args.featureId) };
  }
  if (id === 'S7-037' || id === 'S7-040') args = { featureId: args.featureId, page: 1, destinationPage: id === 'S7-037' ? 1 : 2 };
  if (id === 'S7-180') {
    const result = await command(state, name, args, 'proposal');
    assert.equal(result.proposal.snapshotRevision, 7);
    const changed = structuredClone(state);
    changed.boards.management[0] = changed.boards.management[0].filter(({ featureId }) => featureId !== 'margin');
    await command(changed, name, args, 'refused', 'invalid_target');
    return;
  }
  if (id === 'S7-058') {
    const step = expected.tools.find(step => step.name === 'ui.switch_layer');
    const navigation = await send(state, { kind: 'command', command: step.name, args: step.args }, []);
    assert.equal(navigation.terminal.outcome, 'navigate');
    assert.deepEqual(navigation.terminal.navigation.args, { layer: 'marketing' });
  }
  await command(state, name, args, refusal[id] ? 'refused' : 'proposal', refusal[id]);
  verifyEnginePreview(id, state, name, args);
}

test('TRACE accounts for all N07 assignments and downstream dependencies', () => {
  assert.equal(assigned.length, 54);
  assert.ok(assigned.every(row => dependent.includes(row)));
  assert.equal(dependent.length, 66);
  assert.deepEqual(dependent.filter(row => row.slice_id !== 'N07').map(row => row.scenario_id), [
    'S7-001', 'S7-007', 'S7-008', 'S7-017', 'S7-041', 'S7-055', 'S7-056', 'S7-057', 'S7-058', 'S7-209', 'S7-210', 'S7-214',
  ]);
});

function liveBoard(id) {
  const state = fixture(id);
  const run = runtime.createRunStore({ screenPreset: layout.screenPresets.A, catalog: registryA,
    theme: 'light', time: runtime.testTime, clock: () => 0 });
  runtime.completeEmptyOnboarding(run);
  for (const layer of layers) {
    if (run.getState().activeBoard !== layer) run.actions.switchLayer(layer);
    for (const [index, panels] of state.boards[layer].entries()) {
      if (index) assert.equal(run.actions.addPage().ok, true);
      if (panels.length) assert.equal(run.actions.applyLayoutIntent({ type: 'restore', panels }).status, 'accepted');
    }
    run.actions.goToPage(layer === state.layer ? state.page - 1 : 0);
  }
  if (run.getState().activeBoard !== state.layer) run.actions.switchLayer(state.layer);
  const store = runtime.createWidgetDataStore(undefined, { runId: run.getState().runId });
  const snapshot = store.getSnapshot();
  const actions = runtime.createAgentActions(store, runtime.createDomainRegistry([runtime.layoutDomain]), run);
  return { run, store, snapshot, actions, state: { ...state, runId: snapshot.runId, revision: snapshot.revision } };
}

const boundaryCases = [
  ['S7-001', 'add_widget', { featureId: 'tax' }, 'management', 0, ['tax']],
  ['S7-016', 'add_widgets', { widgets: [{ featureId: 'suppliers' }, { featureId: 'tax' }] }, 'management', 0, ['suppliers', 'tax']],
  ['S7-021', 'remove_widget', { featureId: 'calendar', page: 2 }, 'management', 1, []],
  ['S7-028', 'remove_widgets', { featureIds: ['margin', 'calendar'] }, 'management', 0, []],
  ['S7-036', 'move_to_page', { featureId: 'inventory-booking', layer: 'management', page: 1, destinationPage: 2 }, 'management', 1, ['inventory-booking']],
  ['S7-039', 'move_to_page', { featureId: 'inventory-booking', layer: 'management', page: 1, destinationPage: 5 }, 'management', 4, ['inventory-booking']],
  ['S7-048', 'resize_widget', { featureId: 'briefing', width: 1, height: 1 }, 'management', 0, ['briefing']],
  ['S7-058', 'add_widget', { featureId: 'coupon-status', layer: 'marketing' }, 'marketing', 0, ['coupon-status']],
];

for (const [id, verb, args, layer, page, present] of boundaryCases) {
  test(`${id} confirms an actual projected proposal once and undoes the entire change`, async t => {
    const { run, store, snapshot, actions, state } = liveBoard(id);
    t.after(() => run.dispose());
    const before = run.getState();
    const result = await command(state, `layout.${verb}`, args, 'proposal', undefined,
      (_state, address) => runtime.projectNavisBoard(before, address, 'ko'));
    assert.equal(run.getState(), before);
    const local = actions.prepare(result.proposal, {}, snapshot);
    assert.equal(local.kind, 'proposal', JSON.stringify(local));
    if (id === 'S7-001') {
      const otherStore = runtime.createWidgetDataStore(undefined, { runId: snapshot.runId });
      assert.equal(local.proposal.confirm(otherStore).frame.outcome, 'conflict');
      assert.equal(run.getState(), before);
    }
    const removal = verb.startsWith('remove_widget');
    if (removal) {
      assert.equal(local.proposal.confirm(store).requiresExtraConfirmation, true);
      assert.equal(run.getState(), before);
    }
    const receipt = local.proposal.confirm(store, local.proposal.id);
    assert.equal(receipt.frame.outcome, 'applied');
    const after = run.getState();
    assert.equal(after.layoutRevision, before.layoutRevision + 1);
    assert.equal(after.boards[layer].revision, before.boards[layer].revision + 1);
    assert.equal(after.activeBoard, before.activeBoard);
    assert.equal(after.boards[layer].currentPage, verb === 'move_to_page' ? page : before.boards[layer].currentPage);
    const changed = after.boards[layer].pages[page].panels;
    for (const featureId of present) assert.ok(changed.some(panel => panel.featureId === featureId), featureId);
    if (removal) {
      for (const featureId of args.featureIds ?? [args.featureId]) assert.equal(changed.some(panel => panel.featureId === featureId), false);
    }
    if (geometry[id]) assert.deepEqual(position(panel(changed, args.featureId)), geometry[id]);
    if (verb === 'move_to_page') {
      assert.equal(after.boards[layer].pages[0].panels.some(panel => panel.featureId === args.featureId), false);
      assert.deepEqual(position(panel(changed, args.featureId)), [0, 2, 2, 1]);
    }
    assert.equal(local.proposal.confirm(store, local.proposal.id).frame.outcome, 'applied');
    assert.equal(run.getState(), after);
    const token = after.boards[layer].undo?.token;
    assert.ok(token);
    assert.equal(run.actions.undo(token).status, 'accepted');
    assert.deepEqual(run.getState().boards[layer].pages, before.boards[layer].pages);
    assert.equal(store.getSnapshot(), snapshot);
  });
}

test('S7-180 stale card rejects the final confirmation after a manual board revision', async t => {
  const { run, store, snapshot, actions, state } = liveBoard('S7-180');
  t.after(() => run.dispose());
  const before = run.getState();
  const result = await command(state, 'layout.remove_widget', { featureId: 'margin' }, 'proposal', undefined,
    (_state, address) => runtime.projectNavisBoard(before, address, 'ko'));
  const local = actions.prepare(result.proposal, {}, snapshot);
  assert.equal(local.kind, 'proposal');
  assert.equal(local.proposal.confirm(store).requiresExtraConfirmation, true);
  assert.equal(run.actions.applyLayoutIntent({ type: 'move', featureId: 'calendar', column: 4, row: 2 }).status, 'accepted');
  const afterManualMove = run.getState();
  assert.equal(local.proposal.confirm(store, local.proposal.id).frame.outcome, 'conflict');
  assert.equal(run.getState(), afterManualMove);
  assert.ok(afterManualMove.panels.some(panel => panel.featureId === 'margin'));
});

test('an empty English preset B board projects all 40 free cells and accepts a scoped proposal', async t => {
  const run = runtime.createRunStore({ screenPreset: layout.screenPresets.B, catalog: registry.getRegistry('B'),
    theme: 'light', time: runtime.testTime, clock: () => 0 });
  t.after(() => run.dispose());
  runtime.completeEmptyOnboarding(run);
  const source = { layer: 'marketing' };
  const board = runtime.projectNavisBoard(run.getState(), source, 'en');
  const cells = board.facts?.find(({ key }) => key === 'board.cells.positions');
  assert.equal(cells?.value.split(' ').length, 40);
  assert.ok(cells.value.includes('7,4'));
  await command({ ...fixture('S7-060'), layer: 'management', locale: 'en' }, 'layout.add_widget',
    { featureId: 'community', ...source, column: 7, row: 4 }, 'proposal', undefined, () => board);
});

for (const row of assigned) {
  const id = row.scenario_id;
  test(id, async () => {
    const scenario = corpus.get(id);
    await checkScenario(id, scenario);
    if (id === 'S5-079') {
      for (const index of [1, 2]) await checkScenario(id, scenarioVariant(scenario, index));
    }
  });
}
for (const id of ['S7-001', 'S7-058']) {
  test(`${id} N07 dependency anchor`, () => checkScenario(id, corpus.get(id)));
}

test('N07 reports scenario and dependency counts', t => {
  t.diagnostic(`${assigned.length} of 54 pass, 0 listed exceptions. N07 appears in ${dependent.length} required_slices rows, ${dependent.length - assigned.length} outside slice_id N07.`);
});
