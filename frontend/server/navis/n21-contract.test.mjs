import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness } from '../fixtures/navis-eval-fake.mjs';
import { createAgentMultiSequence } from './registry.mjs';
import {
  AGENT_COMMAND_CATALOG, AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentMultiPlan,
} from '../../shared/navis-agent-schema.mjs';
import { evidence, readTrace } from './scenario-fixtures.mjs';

const runId = 'n21-run';
const command = (name, args) => ({ kind: 'command', command: name, ...(args && { args }) });
const read = featureId => ({ kind: 'read', featureId });
const step = (id, intent, dependsOn) => ({ id, intent, ...(dependsOn && { dependsOn }) });
const plan = (...steps) => ({ planId: 'ordered-plan', runId, steps });
const request = (intent, snapshotRevision = 10, extra = {}) => ({
  runId, snapshotRevision, layer: 'management', page: 1, businessDate: '2026-11-17',
  intent, slots: [], catalog: [], snapshot: [], searches: [], ...extra,
});
const sequence = (...steps) => createAgentMultiSequence(plan(...steps));
const proposal = (input, proposalId, tier = 'normal') => ({
  proposalId, runId: input.runId, snapshotRevision: input.snapshotRevision, layer: input.layer, page: input.page,
  command: input.intent.command, args: input.intent.args, tier,
});
const localCard = (input, id, wireProposalId, tier = 'normal') => ({
  id, wireProposalId, command: input.intent.command, snapshotRevision: input.snapshotRevision, tier,
});
const cardResult = (proposalId, outcome, revision) => ({
  frame: { proposalId, outcome, ...(revision === undefined ? {} : { revision }) },
});
const priced = slot => command('menu.update', { menuId: { handle: 'latte' }, patch: { price: { slot } } });
const blocked = { outcome: 'refused', refusal: { reason: 'invalid_target' } };

test('N21 accepts unique ordered steps and prior-only dependencies in a bounded plan', () => {
  const price = step('price', command('menu.update'));
  const margin = step('margin', read('margin'), ['price']);
  assert.ok(validateAgentMultiPlan(plan(price, margin)));
  assert.ok(!validateAgentMultiPlan(plan()));
  assert.ok(!validateAgentMultiPlan(plan(price)));
  assert.ok(!validateAgentMultiPlan(plan(price, price)));
  assert.ok(!validateAgentMultiPlan(plan(margin, price)));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', read('margin'), ['bad']))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', read('margin'), ['price', 'price']))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', { kind: 'conversation', action: 'confirm', pendingId: 'price' }))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', command('propose_action')))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', priced('price')))));
  assert.ok(!validateAgentMultiPlan(plan(step('one', command('menu.delete')), step('two', command('calendar.deleteEvent')))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', { kind: 'read', featureId: 'margin', sourceId: 'pos' }))));
  assert.ok(!validateAgentMultiPlan(plan(price, step('bad', { kind: 'read', condition: { kind: 'dateRange', start: '2026-12-01', end: '2026-11-01' } }))));
});

test('N21 permits only the active request, then a bound card and a fresh dependent read', () => {
  const flow = sequence(step('price', command('menu.update')), step('margin', read('margin'), ['price']));
  const input = request(priced('price'), 10, { slots: ['price', 'otherPrice'] });
  assert.equal(flow.begin('margin', request(read('margin'))), undefined);
  assert.equal(flow.begin('price', { ...input, runId: 'another-run' }), undefined);
  const attempt = flow.begin('price', input);
  assert.ok(attempt);
  assert.equal(flow.begin('price', input), undefined);
  assert.equal(flow.recordCard(attempt, cardResult('wire-card', 'applied', 11)), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, { ...proposal(input, 'wire-card'), page: 2 }), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, { ...proposal(input, 'wire-card'), args: priced('otherPrice').args }), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, proposal(input, 'wire-card')), true);
  assert.equal(flow.begin('margin', request(read('margin'), 11)), undefined);
  assert.equal(flow.bindCard(attempt, { ...localCard(input, 'local-card', 'wire-card'), snapshotRevision: 9 }), false);
  assert.equal(flow.bindCard(attempt, localCard(input, 'local-card', 'unrelated-wire-card')), false);
  assert.equal(flow.bindCard(attempt, localCard(input, 'local-card', 'wire-card')), true);
  assert.equal(flow.recordCard(attempt, cardResult('wire-card', 'applied', 11)), false);
  assert.equal(flow.recordCard(attempt, cardResult('local-card', 'busy')), true);
  assert.equal(flow.getState().phase, 'awaiting_card');
  assert.equal(flow.recordCard(attempt, cardResult('local-card', 'applied')), false);
  assert.equal(flow.recordCard(attempt, cardResult('local-card', 'applied', 11), true), true);
  assert.equal(flow.recordCard(attempt, cardResult('local-card', 'applied', 11), true), false);
  assert.equal(flow.begin('margin', request(read('margin'), 10)), undefined);
  assert.equal(flow.begin('margin', request(read('ledger'), 11)), undefined);
  const next = flow.begin('margin', request(read('margin'), 11));
  assert.ok(next);
  assert.equal(flow.recordTurn(attempt, blocked), false);
  assert.equal(flow.recordTurn(next, { outcome: 'reply' }), true);
  assert.deepEqual(flow.getState(), {
    phase: 'complete', results: [
      { stepId: 'price', outcome: 'applied', proposalId: 'local-card', revision: 11 },
      { stepId: 'margin', outcome: 'read' },
    ],
    latestUndo: { stepId: 'price', proposalId: 'local-card' },
  });
});

test('N21 rejects a terminal from a different plan with the same step and run', () => {
  const steps = [step('one', read('margin')), step('two', read('menu'))];
  const first = createAgentMultiSequence({ ...plan(...steps), planId: 'first-plan' });
  const second = createAgentMultiSequence({ ...plan(...steps), planId: 'second-plan' });
  const obsolete = first.begin('one', request(read('margin')));
  const active = second.begin('one', request(read('margin')));
  assert.deepEqual(active, { planId: 'second-plan', stepId: 'one' });
  assert.equal(second.recordTurn(obsolete, { outcome: 'reply' }), false);
  assert.equal(second.recordTurn({ ...active }, { outcome: 'reply' }), false);
  assert.equal(second.getState().phase, 'preparing');
  assert.equal(second.recordTurn(active, { outcome: 'reply' }), true);
});

test('N21 retains typed clarification and blocks only dependents on a final conflict', () => {
  const name = 'menu.setSaleStatus';
  const flow = sequence(step('sale', command(name)), step('dependent', read('menu'), ['sale']), step('independent', read('ledger')));
  const intent = command(name, { menuId: { handle: 'americano' } });
  const terminal = { outcome: 'clarify', pendingId: 'sale-status', clarification: {
    command: name, field: 'status', promptKey: 'menu.status', choices: [
      { id: 'selling', value: 'selling' }, { id: 'sold_out', value: 'sold_out' },
    ],
  } };
  const attempt = flow.begin('sale', request(intent));
  assert.equal(flow.recordTurn(attempt, terminal), true);
  assert.deepEqual(flow.getState().pending, terminal);
  assert.equal(flow.begin('dependent', request(read('menu'))), undefined);
  const input = request(command(name, { ...intent.args, status: 'sold_out' }), 11);
  const retry = flow.begin('sale', input);
  assert.equal(flow.recordTurn(retry, { outcome: 'proposal' }, proposal(input, 'sale-wire')), true);
  assert.equal(flow.bindCard(retry, localCard(input, 'sale-card', 'sale-wire')), true);
  assert.equal(flow.recordCard(retry, cardResult('sale-card', 'conflict', 12)), true);
  assert.deepEqual(flow.getState().pending, { outcome: 'conflict' });
  assert.equal(flow.finishConflict('dependent'), false);
  assert.equal(flow.finishConflict('sale'), true);
  assert.deepEqual(flow.getState().results, [
    { stepId: 'sale', outcome: 'conflict', proposalId: 'sale-card', revision: 12 },
    { stepId: 'dependent', outcome: 'blocked', blockedBy: ['sale'] },
  ]);
  assert.equal(flow.begin('independent', request(read('ledger'), 11)), undefined);
  assert.ok(flow.begin('independent', request(read('ledger'), 12)));
});

test('N21 ambiguity can ask only about handles from the active lookup scope', () => {
  const intent = { kind: 'read', reads: [{ name: 'search_records', args: { kind: 'menu', querySlot: 'name' } }] };
  const flow = sequence(step('lookup', intent), step('dependent', read('menu'), ['lookup']));
  const search = { kind: 'menu', querySlot: 'name', queryBinding: 'lookup-name', matches: [
    { handle: 'one', match: 'similar' }, { handle: 'two', match: 'similar' },
  ] };
  const input = request(intent, 10, { slots: ['name'], searches: [search] });
  const attempt = flow.begin('lookup', input);
  const clarification = {
    field: 'name', promptKey: 'menu.target', recordKind: 'menu', querySlot: 'name', queryBinding: 'lookup-name',
    choices: [{ id: 'one', handle: 'one' }, { id: 'two', handle: 'two' }],
  };
  const terminal = { outcome: 'ambiguous', clarification };
  assert.equal(flow.recordTurn(attempt, { ...terminal, clarification: { ...clarification, queryBinding: 'old-lookup' } }), false);
  assert.equal(flow.recordTurn(attempt, { ...terminal, clarification: { ...clarification, choices: [{ id: 'other', handle: 'other' }] } }), false);
  assert.equal(flow.recordTurn(attempt, terminal), true);
  assert.deepEqual(flow.getState().pending, terminal);
});

test('N21 compiled reads wait for verified ordered terminal statuses before releasing dependencies', () => {
  const condition = { kind: 'default' };
  const intent = { kind: 'read', reads: [
    { name: 'get_widget', args: { featureId: 'inventory-booking' } },
    { name: 'get_widget', args: { featureId: 'suppliers', condition } },
  ] };
  const flow = sequence(step('read', intent), step('dependent', command('suppliers.createOrder'), ['read']),
    step('independent', read('ledger')));
  const terminal = { outcome: 'reply', readStatuses: ['ready', 'missing'] };
  const canonical = { ...intent, reads: [{ ...intent.reads[0], args: { ...intent.reads[0].args, condition } }, intent.reads[1]] };
  assert.equal(flow.begin('read', request({ ...canonical, reads: canonical.reads.toReversed() })), undefined);
  const attempt = flow.begin('read', request(canonical));
  assert.ok(attempt);
  assert.equal(flow.recordTurn(attempt, { outcome: 'reply', readStatuses: ['ready'] }), false);
  assert.equal(flow.recordTurn(attempt, terminal), true);
  assert.deepEqual(flow.getState().results, [
    { stepId: 'read', outcome: 'unavailable', readStatuses: ['ready', 'missing'] },
    { stepId: 'dependent', outcome: 'blocked', blockedBy: ['read'] },
  ]);
  assert.ok(flow.begin('independent', request(read('ledger'))));
});

test('N21 conflict needs a new card, destructive cards need extra confirmation, and partial results stay ordered', () => {
  const name = 'menu.delete';
  const input = request(command(name, { menuId: { handle: 'vanilla' } }));
  const flow = sequence(step('delete', command(name)), step('dependent', read('menu'), ['delete']),
    step('independent', read('ledger')));
  let attempt = flow.begin('delete', input);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, proposal(input, 'bad-tier')), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, proposal(input, 'server-1', 'extra-confirm')), true);
  assert.equal(flow.bindCard(attempt, localCard(input, 'card-1', 'server-1')), false);
  assert.equal(flow.bindCard(attempt, localCard(input, 'card-1', 'server-1', 'extra-confirm')), true);
  assert.equal(flow.recordCard(attempt, cardResult('card-1', 'applied', 11)), false);
  assert.equal(flow.recordCard(attempt, { ...cardResult('card-1', 'invalid'), requiresExtraConfirmation: true }), true);
  assert.equal(flow.getState().phase, 'awaiting_card');
  assert.equal(flow.recordCard(attempt, cardResult('card-1', 'conflict', 12)), true);
  assert.equal(flow.getState().phase, 'awaiting_input');
  assert.equal(flow.begin('delete', input), undefined);
  const newer = { ...input, snapshotRevision: 12 };
  const old = attempt;
  attempt = flow.begin('delete', newer);
  assert.ok(attempt && attempt !== old);
  assert.equal(flow.recordCard(old, cardResult('card-1', 'applied', 13)), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, proposal(newer, 'server-1', 'extra-confirm')), false);
  assert.equal(flow.recordTurn(attempt, { outcome: 'proposal' }, proposal(newer, 'server-2', 'extra-confirm')), true);
  assert.equal(flow.bindCard(attempt, localCard(newer, 'card-1', 'server-2', 'extra-confirm')), false);
  assert.equal(flow.bindCard(attempt, localCard(newer, 'card-2', 'server-2', 'extra-confirm')), true);
  assert.equal(flow.recordCard(attempt, cardResult('card-2', 'cancelled')), true);
  assert.equal(flow.begin('dependent', request(read('menu'), 12)), undefined);
  const next = flow.begin('independent', request(read('ledger'), 12));
  assert.equal(flow.recordTurn(next, { outcome: 'reply' }), true);
  assert.deepEqual(flow.getState(), {
    phase: 'complete', results: [
      { stepId: 'delete', outcome: 'cancelled', proposalId: 'card-2' },
      { stepId: 'dependent', outcome: 'blocked', blockedBy: ['delete'] },
      { stepId: 'independent', outcome: 'read' },
    ],
  });
});

test('N21 waits for local navigation before reading the new layer and preserves a widget-only refusal', () => {
  const flow = sequence(step('switch', command('ui.switch_layer')), step('read', read('customer-groups'), ['switch']),
    step('tax', command('tax.markPaid')));
  const input = request(command('ui.switch_layer', { layer: 'marketing' }));
  const attempt = flow.begin('switch', input);
  const { runId, snapshotRevision, layer, page } = input;
  const done = { outcome: 'navigate', navigation: { runId, snapshotRevision, layer, page,
    command: 'ui.switch_layer', args: { layer: 'marketing' } } };
  assert.equal(flow.recordTurn(attempt, { ...done, navigation: { ...done.navigation, args: { layer: 'pos' } } }), false);
  assert.equal(flow.recordTurn(attempt, done), true);
  assert.equal(flow.begin('read', request(read('customer-groups'))), undefined);
  assert.equal(flow.recordNavigation(attempt, 'opened'), false);
  assert.equal(flow.recordNavigation(attempt, 'opened', { runId, layer: 'management', page: 1 }), false);
  const destination = { runId, layer: 'marketing', page: 1 };
  assert.equal(flow.recordNavigation(attempt, 'opened', destination), true);
  assert.deepEqual(flow.getState().results[0].destination, destination);
  const next = flow.begin('read', request(read('customer-groups'), snapshotRevision, { layer: 'marketing' }));
  assert.equal(flow.recordTurn(next, { outcome: 'reply' }), true);
  const tax = flow.begin('tax', request(command('tax.markPaid')));
  assert.equal(flow.recordTurn(tax, { outcome: 'refused', refusal: { reason: 'widget_only' } }), true);
  assert.deepEqual(flow.getState().results.map(({ outcome }) => outcome), ['navigated', 'read', 'refused']);
});

const trace = readTrace().filter(row => row.required_slices.split('|').includes('N21'));
const corpus = new Map(JSON.parse(evidence('MERGED.json')).map(scenario => [scenario.id, scenario]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json'));
const reviewed = id => ({ ...corpus.get(id).expected, ...overlay[id]?.expected, ...overlay[id]?.policyGap?.expected });
const defaultCondition = { kind: 'default' };
const ref = slot => ({ slot });

const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const [data, state, testSession, presets, motion, catalog, provider, promo, fakePromo] = await Promise.all([
  'data/widget-data', 'state/index', 'app/test-session', 'layout/presets', 'ui/motion', 'catalog/index',
  'features/assistant/provider', 'features/widgets/mkt-promo/promo-session', 'features/widgets/mkt-promo/promo-test-server',
].map(path => vite.ssrLoadModule(`/src/${path}.ts`))).finally(() => vite.close());

function ok(result) {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

function fixture(t, steps, { layer = 'management', seed, marketing } = {}) {
  const run = state.createRunStore({
    screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true,
  });
  testSession.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (layer !== 'management') run.actions.switchLayer(layer);
  const liveRunId = run.getState().runId;
  const store = data.createWidgetDataStore(marketing && { marketing }, { runId: liveRunId });
  seed?.(store);
  const flow = createAgentMultiSequence({ ...plan(...steps), runId: liveRunId });
  const bridge = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }),
    validateAgentFrame);
  t.after(bridge.close);

  const calls = [];
  let stepId, attempt, turn;
  const assistant = provider.createAssistantProvider({
    store, run,
    async fetcher(url, init) {
      assert.equal(url, '/api/navis/chat');
      assert.equal(attempt, undefined, 'one wire request per step attempt');
      const input = JSON.parse(init.body);
      attempt = flow.begin(stepId, input);
      assert.ok(attempt, JSON.stringify(input.intent));
      turn = await bridge.run(input);
      assert.equal(turn.status, 200, turn.raw);
      assert.equal(turn.terminal.code, undefined, turn.raw);
      assert.ok(flow.recordTurn(attempt, turn.terminal, turn.proposal), turn.raw);
      calls.push(...turn.calls);
      return new globalThis.Response(turn.raw, { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
    },
  });
  async function ask(id, text, agentTurn) {
    stepId = id;
    attempt = undefined;
    turn = undefined;
    const before = store.getSnapshot();
    const reply = await assistant.ask({ text, locale: 'ko', layer, signal: new globalThis.AbortController().signal, agentTurn });
    assert.ok(store.getSnapshot() === before, 'asking or previewing cannot mutate the store');
    assert.ok(attempt, reply.answer);
    const card = reply.proposalSession;
    if (card) assert.ok(flow.bindCard(attempt, card.getSnapshot().proposal), reply.answer);
    return { attempt, turn, reply, before, card };
  }
  function press({ attempt, card, reply, turn }, tier = 'normal') {
    assert.ok(card?.isPending(), JSON.stringify({ answer: reply.answer, kind: reply.turn?.kind, terminal: turn?.terminal }));
    const { id, tier: actualTier } = card.getSnapshot().proposal;
    assert.equal(actualTier, tier);
    assert.equal(card.confirm(store, 'another-card'), undefined);
    const before = store.getSnapshot();
    const first = card.confirm(store, id);
    if (tier === 'extra-confirm') {
      assert.ok(first.requiresExtraConfirmation);
      assert.ok(flow.recordCard(attempt, first));
      assert.equal(flow.getState().phase, 'awaiting_card');
      assert.ok(store.getSnapshot() === before);
    }
    const receipt = tier === 'extra-confirm' ? card.confirm(store, id, true) : first;
    assert.equal(receipt.frame.outcome, 'applied', JSON.stringify(receipt));
    assert.ok(flow.recordCard(attempt, receipt, Boolean(receipt.undoToken)));
    const after = store.getSnapshot();
    assert.equal(card.confirm(store, id, true), undefined, 'completed card ignores a second press');
    assert.ok(store.getSnapshot() === after, 'retry cannot apply a second effect');
    return receipt;
  }
  function askWidget(id, featureId, text, condition) {
    return ask(id, text, { intent: { ...read(featureId), ...(condition && { condition }) }, slots: {} });
  }
  return { flow, store, run, calls, ask, askWidget, press };
}

const menuRow = (env, menuId) => data.selectMenus(env.store.getSnapshot(), {}).rows.find(row => row.menuId === menuId);
const widget = (env, featureId) => {
  const view = data.selectWidget(env.store.getSnapshot(), featureId, defaultCondition, 'normal');
  assert.equal(view.status, 'ready');
  return view.model;
};
const outcomes = env => env.flow.getState().results.map(({ outcome }) => outcome);
const readStep = (id, featureId, dependsOn) => step(id, read(featureId), dependsOn);
const writeStep = (id, name, dependsOn) => step(id, command(name), dependsOn);

test('N21 clarification-only intents reach the fake bridge with only their authored prerequisite reads', async t => {
  const bridge = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }),
    validateAgentFrame);
  t.after(bridge.close);
  const condition = { kind: 'default' };
  const cases = [
    ['S1-054', 'menu.setSaleStatus', 'menuId', {}, []],
    ['S1-312', 'ledger.confirmCandidate', 'expenseId', {
      catalog: [{ id: 'ledger', name: '가계부', layer: 'management', conditions: [condition] }],
      snapshot: [{ featureId: 'ledger', condition, facts: [] }],
    }, [{ name: 'get_widget', args: { featureId: 'ledger', condition } }]],
    ['S8-076', 'menu.setSaleStatus', 'status', {
      slots: ['name'], querySlot: 'name',
      searches: [{ kind: 'menu', querySlot: 'name', matches: [{ handle: 'one', match: 'exact' }] }],
    }, [{ name: 'search_records', args: { kind: 'menu', querySlot: 'name' } }]],
  ];
  for (const [id, name, clarify, { querySlot, ...projection }, calls] of cases) {
    const flow = sequence(writeStep('clarify', name), readStep('dependent', 'menu', ['clarify']));
    const input = request({ ...command(name), clarify, ...(querySlot && { querySlot }) }, 10, projection);
    const attempt = flow.begin('clarify', input);
    assert.ok(attempt, id);
    const turn = await bridge.run(input);
    assert.equal(turn.status, 200, `${id} ${turn.raw}`);
    assert.deepEqual(turn.calls, calls, id);
    assert.equal(turn.proposal, undefined, id);
    assert.equal(turn.terminal?.outcome, 'clarify', id);
    assert.equal(turn.terminal?.clarification.field, clarify, id);
    assert.equal(flow.recordTurn(attempt, turn.terminal), true, id);
    assert.equal(flow.getState().phase, 'awaiting_input', id);
    assert.deepEqual(flow.getState().results, [], id);
  }
});

test('N21 S6-029 applies the draft, waits for reference selection and starts one offline job on its own card', async t => {
  const expected = reviewed('S6-029');
  const draft = expected.tools[0].args.args;
  const seed = data.createWidgetDataStore().getSnapshot().tables.marketing;
  const marketing = {
    ...seed,
    promoMenu: [...seed.promoMenu, {
      menuId: draft.menuIds[0], names: { ko: '휘낭시에', en: 'Financier', 'zh-Hans': '费南雪', 'zh-Hant': '費南雪' },
      order: seed.promoMenu.length,
    }],
    promoPhoto: [...seed.promoPhoto, ...draft.photoIds.map((photoId, order) => ({
      photoId, menuId: draft.menuIds[0], order, width: 1280, height: 960, url: '/fixture/photo.jpg',
    }))],
  };
  const [edit, clarification, make] = expected.tools;
  assert.equal(clarification.args.field, 'referenceId');
  const env = fixture(t, [writeStep('draft', edit.args.command), writeStep('make', make.args.command, ['draft'])], {
    layer: 'marketing', marketing,
  });
  const promoSession = promo.promoSession(env.store);
  t.after(() => promoSession.dispose());
  promoSession.setDraft({ menuIds: [], photoIds: [], moods: [], concepts: [], memo: '', referenceId: null, lengthSec: 10 });
  const fake = fakePromo.createFakeServer();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(String(url), '/api/promo/estimate-model');
    return fake.fetch(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const draftBefore = promoSession.getState().draft;
  const draftTurn = await env.ask('draft', corpus.get('S6-029').utterances[0], {
    intent: command(edit.args.command, { menuIds: ref('menuIds'), photoIds: ref('photoIds'), moods: ref('moods'),
      concepts: ref('concepts'), lengthSec: draft.lengthSec }),
    slots: { ...draft, navisLocale: 'ko' },
  });
  assert.equal(promoSession.getState().draft, draftBefore);
  assert.equal(env.flow.getState().step.id, 'draft');
  env.press(draftTurn);
  const savedDraft = promoSession.getState().draft;
  for (const [field, value] of Object.entries({ ...draft, memo: '', referenceId: null })) {
    assert.deepEqual(savedDraft[field], value, field);
  }
  assert.equal(env.flow.recordLocal('make', 'clarify'), true);
  assert.equal(env.flow.getState().phase, 'awaiting_input');
  assert.equal(env.store.getSnapshot().tables.marketing.promoVideo.length, 0);

  promoSession.setDraft({ referenceId: 'ref-2' });
  await promoSession.loadEstimate();
  const makeTurn = await env.ask('make', '영상 만들어줘');
  assert.deepEqual(makeTurn.turn.calls.map(({ name }) => name), ['get_promotion_preflight', 'propose_action']);
  assert.equal(env.store.getSnapshot().tables.marketing.promoVideo.length, 0);
  const receipt = env.press(makeTurn);
  assert.equal(receipt.frame.messageKey, 'data.marketing.notice.videoStarted');
  const video = env.store.getSnapshot().tables.marketing.promoVideo.at(-1);
  assert.equal(env.store.getSnapshot().tables.marketing.promoVideo.length, 1);
  assert.deepEqual(video.input, { ...draft, memo: '', referenceId: 'ref-2', locale: 'ko' });
  assert.deepEqual(outcomes(env), ['applied', 'applied']);
  assert.equal(fake.job, null);
});

// D-365: the reviewed second step (a read of the removed 마케팅 성과 widget) is gone; the mark-posted press and its counting effect stay.
test('N21 S6-048 requires the posted press before reading the video widget, and the post is counted', async t => {
  const expected = reviewed('S6-048');
  const [mark] = expected.tools;
  let videoId;
  const env = fixture(t, [writeStep('mark', mark.args.command), readStep('video', 'promo-video', ['mark'])], {
    layer: 'marketing',
    seed(store) {
      const menuId = 'm-americano';
      const photoIds = store.getSnapshot().tables.marketing.promoPhoto.filter(photo => photo.menuId === menuId).slice(0, 6)
        .map(photo => photo.photoId);
      videoId = ok(store.dispatch({ type: 'video.make', idempotencyKey: 'n21-video-fixture', input: {
        menuIds: [menuId], photoIds, moods: ['warm'], concepts: ['review-roundup'], memo: '', lengthSec: 15,
        referenceId: 'ref-2', locale: 'ko',
      } })).videoId;
      ok(store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'done', result: {
        durationSec: 15, music: { trackId: 'fixture', title: 'Fixture', artist: 'Fixture', licenseLabel: 'Fixture' },
        fileUrl: '/fixture/video.mp4', sizeBytes: 1, madeAt: data.NOW,
      } } }));
    },
  });
  const marking = await env.ask('mark', '영상 클립에 올렸다고 표시해줘');
  assert.ok(!widget(env, 'marketing-performance').byVideo.find(row => row.videoId === videoId)?.postedRoute);
  const issuedBefore = widget(env, 'marketing-performance').issued;
  const receipt = env.press(marking, expected.confirmation.tier);
  assert.equal(receipt.frame.messageKey, 'data.marketing.notice.counting');
  const report = await env.askWidget('video', 'promo-video', '영상 몇 편 올렸는지 보여줘');
  assert.ok(report.turn.calls.some(call => call.name === 'get_widget' && call.args.featureId === 'promo-video'));
  const after = widget(env, 'marketing-performance');
  const row = after.byVideo.find(row => row.videoId === videoId);
  assert.equal(row.postedRoute, 'clip');
  assert.ok(row.issued > 0);
  assert.equal(after.issued, issuedBefore + row.issued);
  assert.deepEqual(outcomes(env), ['applied', 'read']);
});

test('N21 S6-163 reads churn risk first and the separate card sends once to exactly the eligible recipients', async t => {
  const [groups, send] = reviewed('S6-163').tools;
  const env = fixture(t, [readStep('groups', groups.args.featureId), writeStep('send', send.args.command, ['groups'])],
    { layer: 'marketing' });
  const report = await env.askWidget('groups', groups.args.featureId, '떠날 손님 몇 명이야?');
  assert.equal(report.turn.calls[0].args.featureId, groups.args.featureId);
  const audience = widget(env, 'customer-groups').reachOut.recipientIds;
  assert.ok(audience.length);
  const pending = await env.ask('send', '떠날 손님한테 쿠폰 문자 보내줘');
  const before = pending.before.tables.marketing.messageSend.length;
  const receipt = env.press(pending);
  assert.equal(receipt.frame.messageKey, 'data.notice.sent');
  const sends = env.store.getSnapshot().tables.marketing.messageSend.slice(before);
  assert.deepEqual(sends.map(row => row.customerId), audience);
  assert.ok(sends.every(row => row.status === 'mock'));
  assert.deepEqual(outcomes(env), ['read', 'applied']);
  assert.equal(env.flow.getState().latestUndo, undefined);
});

test('N21 S8-064 separates two menu cards and retains the second undo only', async t => {
  const [sale, update] = reviewed('S8-064').tools.filter(tool => tool.name === 'propose_action');
  const env = fixture(t, [writeStep('sale', sale.args.command), writeStep('update', update.args.command)]);
  const first = await env.ask('sale', '아메리카노 품절로 바꿔줘');
  const firstReceipt = env.press(first);
  assert.equal(menuRow(env, 'm-americano').saleStatus, 'sold_out');
  const previousPrice = menuRow(env, 'm-cafe-latte').price;
  const second = await env.ask('update', '카페라테 가격 5,500원으로 올려줘');
  const secondReceipt = env.press(second);
  assert.equal(menuRow(env, 'm-cafe-latte').price, 5500);
  assert.ok(firstReceipt.undoToken && secondReceipt.undoToken);
  assert.deepEqual(outcomes(env), ['applied', 'applied']);
  assert.deepEqual(env.flow.getState().latestUndo, { stepId: 'update', proposalId: secondReceipt.frame.proposalId });
  assert.equal(env.flow.clearUndo(firstReceipt.frame.proposalId), false);
  assert.equal(env.store.undo(firstReceipt.undoToken).ok, false);
  ok(env.store.undo(secondReceipt.undoToken));
  assert.equal(env.flow.clearUndo(secondReceipt.frame.proposalId), true);
  assert.equal(env.flow.getState().latestUndo, undefined);
  assert.equal(menuRow(env, 'm-cafe-latte').price, previousPrice);
  assert.equal(menuRow(env, 'm-americano').saleStatus, 'sold_out');
});

test('N21 S8-069 resolves a new café menu against the first card receipt before making the second card', async t => {
  const [create, sale] = reviewed('S8-069').tools.filter(tool => tool.name === 'propose_action');
  const env = fixture(t, [writeStep('create', create.args.command), writeStep('sale', sale.args.command, ['create'])]);
  // The café name lookup already considers the authored name a similar match.
  const name = '체리 히비스커스티';
  const first = await env.ask('create', `${name} 음료 메뉴에 5,800원으로 추가해줘`);
  const { createdRecord } = env.press(first);
  assert.equal(createdRecord?.kind, 'menu');
  assert.deepEqual(env.flow.getState().results[0].createdRecord, createdRecord);
  const inserted = menuRow(env, createdRecord.id);
  assert.equal(inserted.saleStatus, 'selling');
  const second = await env.ask('sale', `${inserted.name.raw} 품절로 바꿔줘`);
  assert.ok(second.turn.calls.some(call => call.name === 'search_records'));
  env.press(second);
  assert.equal(menuRow(env, createdRecord.id).saleStatus, 'sold_out');
  assert.deepEqual(outcomes(env), ['applied', 'applied']);
});

for (const id of ['S1-321', 'S2-027']) {
  test(`N21 ${id} refreshes margin only after the café latte price edit has been pressed`, async t => {
    const [edit, margin] = reviewed(id).tools.filter(tool => tool.name !== 'search_records');
    const env = fixture(t, [writeStep('edit', edit.args.command), readStep('margin', margin.args.featureId, ['edit'])]);
    const editTurn = await env.ask('edit', '카페라테 가격 5,500원으로 올려줘');
    const marginBefore = widget(env, 'margin').menus.find(row => row.menuId === 'm-cafe-latte').rate;
    env.press(editTurn);
    const answer = await env.askWidget('margin', margin.args.featureId, '메뉴 마진 알려줘');
    assert.equal(answer.turn.calls[0].args.featureId, 'margin');
    const marginAfter = widget(env, 'margin').menus.find(row => row.menuId === 'm-cafe-latte').rate;
    assert.ok(marginAfter > marginBefore);
    assert.deepEqual(outcomes(env), ['applied', 'read']);
  });
}

for (const id of ['S3-254', 'S8-065']) {
  test(`N21 ${id} makes separate cards and receipts for an event and a to-do on the café-relative date`, async t => {
    const [event, todo] = reviewed(id).tools.filter(tool => tool.name === 'propose_action');
    const env = fixture(t, [writeStep('event', event.args.command), writeStep('todo', todo.args.command)]);
    const day = new Date(`${data.TODAY}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    const date = day.toISOString().slice(0, 10);
    const existing = new Set(env.store.getSnapshot().tables.calendarEvent.map(row => row.eventId));
    for (const [stepId, target] of [['event', event], ['todo', todo]]) {
      const { title, time } = target.args.args;
      const slots = { title, date, ...(time && { time }) };
      const args = Object.fromEntries(Object.keys(slots).map(field => [field, ref(field)]));
      const next = await env.ask(stepId, title, { intent: command(target.args.command, args), slots });
      assert.equal(env.flow.getState().step.id, stepId);
      const receipt = env.press(next);
      assert.ok(receipt.undoToken);
    }
    const rows = env.store.getSnapshot().tables.calendarEvent.filter(row => !existing.has(row.eventId));
    assert.deepEqual(rows.map(({ kind, title, date }) => [kind, title.raw, date]),
      [['event', event.args.args.title, date], ['todo', todo.args.args.title, date]]);
    assert.deepEqual(outcomes(env), ['applied', 'applied']);
    assert.equal(env.flow.getState().latestUndo.stepId, 'todo');
  });
}

test('N21 S8-066 leaves the sales read untouched and asks separately before marking the croissant out of stock', async t => {
  const [sales, sale] = reviewed('S8-066').tools.filter(tool => tool.name !== 'search_records');
  const featureId = sales.args.featureId;
  let croissantId;
  const env = fixture(t, [readStep('sales', featureId), writeStep('sale', sale.args.command)], {
    seed(store) {
      const live = data.selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === 'm-croissant'
        || row.nameKey === 'data.item.croissant' || row.name?.raw === '크루아상');
      croissantId = live?.menuId ?? ok(store.dispatch({
        type: 'menu.create', name: '크루아상', price: 3500, category: 'dessert', idempotencyKey: 'n21-croissant-fixture',
      })).menuId;
    },
  });
  const check = await env.askWidget('sales', featureId, '오늘 매출 알려줘');
  assert.ok(check.turn.calls.some(call => call.name === 'get_widget' && call.args.featureId === featureId));
  assert.equal(menuRow(env, croissantId).saleStatus, 'selling');
  env.press(await env.ask('sale', '크루아상 품절로 바꿔줘'));
  assert.equal(menuRow(env, croissantId).saleStatus, 'sold_out');
  assert.deepEqual(outcomes(env), ['read', 'applied']);
});

test('N21 S8-067 preserves a local invalid-price result and proceeds with the independent sale-status card', async t => {
  const sale = reviewed('S8-067').tools.find(tool => tool.name === 'propose_action');
  const env = fixture(t, [writeStep('price', 'menu.update'), writeStep('sale', sale.args.command)]);
  const price = menuRow(env, 'm-americano').price;
  assert.equal(env.flow.recordLocal('price', 'invalid'), true);
  env.press(await env.ask('sale', '카페라테 품절로 바꿔줘'));
  assert.equal(menuRow(env, 'm-americano').price, price);
  assert.equal(menuRow(env, 'm-cafe-latte').saleStatus, 'sold_out');
  assert.deepEqual(outcomes(env), ['invalid', 'applied']);
});

test('N21 S8-063 leaves the second step waiting for an order quantity after changing the stock', async t => {
  const stockEdit = reviewed('S8-063').tools.find(tool => tool.name === 'propose_action');
  const env = fixture(t, [writeStep('stock', stockEdit.args.command), writeStep('order', 'suppliers.createOrder', ['stock'])]);
  const before = env.store.getSnapshot().tables.purchaseOrder.length;
  const edit = await env.ask('stock', '우유 재고 5리터로 맞춰줘');
  const receipt = env.press(edit);
  assert.ok(receipt.undoToken);
  assert.equal(env.flow.recordLocal('order', 'clarify'), true);
  assert.equal(env.flow.getState().phase, 'awaiting_input');
  assert.equal(env.store.getSnapshot().tables.purchaseOrder.length, before);
  assert.deepEqual(outcomes(env), ['applied']);
  assert.equal(env.flow.getState().latestUndo.stepId, 'stock');
});

for (const id of ['S8-070', 'S8-071']) {
  test(`N21 ${id} issues a separate scoped widget read for each subject in request order`, async t => {
    // D-365: the reviewed cross-widget summary also read the removed 마케팅 성과 widget; that subject is no longer asked.
    const reads = reviewed(id).tools.filter(tool => tool.name === 'get_widget' && tool.args.featureId !== 'marketing-performance');
    const steps = reads.map(({ args: { featureId, condition } }, index) => {
      const scope = replayCondition(condition);
      return step(`read-${index}`, { ...read(featureId), ...(scope && { condition: scope }) });
    });
    const env = fixture(t, steps);
    for (const { id: stepId, intent: { featureId, condition } } of steps) {
      const { turn } = await env.askWidget(stepId, featureId, corpus.get(id).utterances[0], condition);
      assert.ok(turn.calls.some(call => call.name === 'get_widget' && call.args.featureId === featureId));
    }
    assert.deepEqual(outcomes(env), steps.map(() => 'read'));
  });
}

function replayCondition(condition) {
  if (condition?.cafe === 'inventoryToday') return { kind: 'snapshot', asOf: data.TODAY };
  if (condition?.cafe === 'monthToDate') return { kind: 'dateRange', start: `${data.TODAY.slice(0, 7)}-01`, end: data.TODAY };
  return condition;
}

function tracedIntent({ name, args }) {
  if (name === 'get_widget') return { ...read(args.featureId), ...(args.condition && { condition: replayCondition(args.condition) }) };
  if (name === 'get_source') return { kind: 'read', sourceId: args.sourceId, ...(args.condition && { condition: replayCondition(args.condition) }) };
  const navigation = ['open_detail', 'ui.open_detail', 'NEW:navigate'].includes(name) ? 'ui.openDetail' : name;
  const selected = name === 'propose_action' || name === '(refused)' ? args?.command : navigation;
  return Object.hasOwn(AGENT_COMMAND_CATALOG, selected) ? command(selected) : undefined;
}

test('N21 audits every TRACE row against the merged and café-reviewed step selectors', t => {
  assert.equal(trace.length, 111);
  assert.equal(new Set(trace.map(row => row.scenario_id)).size, trace.length);
  const exceptions = new Map();
  let mapped = 0;
  const except = (reason, id) => exceptions.set(reason, [...exceptions.get(reason) ?? [], id]);
  for (const { scenario_id: id } of trace) {
    assert.ok(corpus.has(id), id);
    const expected = reviewed(id);
    const tools = expected.tools ?? [];
    const steps = tools.map(tracedIntent).filter(Boolean).map((intent, index) => step(`step-${index + 1}`, intent));
    if (tools.some(tool => tool.name === '(approved_coupon_route)')) {
      except('exact approved coupon route and recipient need client resolution', id);
    } else if (steps.length < 2) {
      except('reviewed fixture omits two typed steps or requires a local boundary or clarification', id);
    } else if (!validateAgentMultiPlan(plan(...steps))) {
      except('authored selector needs a café or typed domain mapping', id);
    } else {
      const flow = createAgentMultiSequence(plan(...steps));
      assert.deepEqual(flow.getState().step, steps[0], id);
      assert.equal(flow.begin(steps[1].id, request(steps[1].intent)), undefined, id);
      mapped += 1;
    }
  }
  assert.equal(mapped + [...exceptions.values()].flat().length, 111);
  t.diagnostic(`TRACE selector audit: ${mapped}/111 typed plans; ${111 - mapped} exceptions`);
  for (const [reason, ids] of exceptions) t.diagnostic(`${reason}: ${ids.join(', ')}`);
});
