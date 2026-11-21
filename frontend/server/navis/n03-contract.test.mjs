import assert from 'node:assert/strict';
import test from 'node:test';
import * as schema from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import {
  createNavisContractFake, createNavisNavigationHarness, defaultCondition,
  navigationRequest, reading,
} from '../fixtures/navis-eval-fake.mjs';

import { readCafeScenarios, readTrace, releasedScenario, scenarioVariant } from './scenario-fixtures.mjs';

const { corpus } = await readCafeScenarios();

const detailAliases = new Set(['open_detail', 'ui.open_detail', 'NEW:navigate']);
const marketing = new Set(['notice-send', 'local-changes', 'trade-area', 'local-trends', 'ai-response', 'community',
  'marketing-today', 'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups', 'marketing-performance']);
const widgetLayer = id => marketing.has(id) ? 'marketing' : 'management';
const widget = (id, condition = defaultCondition) => ({ id, name: id, layer: widgetLayer(id), conditions: [condition] });
const noEffectPolicy = {
  'S5-065': 'community.accept', 'S5-067': 'community.sendInterest', 'S5-070': 'community.accept',
  'S5-071': 'community.decline', 'S5-072': 'community.sendInterest', 'S5-073': 'community.accept',
  'S5-130': 'coupon.sendSlot', 'S5-131': 'coupon.sendSlot', 'S5-132': 'coupon.sendSlot',
  'S5-133': 'coupon.sendSlot', 'S5-134': 'coupon.sendSlot', 'S5-156': 'coupon.markPosted',
  'S5-158': 'coupon.sendReachOut', 'S5-159': 'coupon.markPosted',
  'S6-028': 'video.make', 'S6-030': 'video.retry',
  'S7-151': 'shop.updateSettings', 'S7-154': 'shop.updateSettings', 'S7-166': 'pos.refund', 'S7-209': 'closing.closeDay',
};

const limitCases = new Map([
  ['S7-067', 'reply'], ['S7-073', 'clarify'], ['S7-098', 'refused'], ['S7-100', 'refused'], ['S7-148', 'refused'],
]);

function fixtureState(scenario, command, args) {
  const { id } = scenario;
  const layer = id === 'S7-065' || id === 'S7-107' || id === 'S7-112' || id === 'S7-068' && command === 'ui.go_to_page' ? 'marketing'
    : command === 'ui.set_pos_tab' ? 'pos' : id === 'S5-046' ? 'marketing' : 'management';
  const page = id === 'S7-071' || id === 'S7-055' ? 2 : 1;
  const board = { 'board.pageCount': id === 'S7-074' ? 3 : 2, 'board.panelCount': ['S7-111', 'S7-112'].includes(id) ? 0 : 6 };
  if (id === 'S7-097') board['board.panel.ledger.page'] = 2;
  if (['S7-096', 'S7-099'].includes(id)) board['board.panel.inventory-booking.page'] = 1;
  if (id === 'S5-046') board['board.panel.ai-response.page'] = 1;
  const ui = {
    'ui.overlay': ['S7-102', 'S7-103'].includes(id) ? 'drawer' : id === 'S7-109' ? 'detail' : 'none',
    'ui.editing': id === 'S7-113',
    'ui.backAvailable': id === 'S7-107',
    'ui.tablesConfigurable': id !== 'S7-148',
  };
  const readings = [reading('get_board', { layer }, board), reading('get_ui_state', { section: 'display' }, ui)];
  if (command === 'ui.open_closing') {
    readings.push(reading('get_closing_state', {}, { 'closing.status': 'open' }));
  }
  return { layer, page, catalog: typeof args.featureId === 'string' ? [widget(args.featureId)] : [], readings };
}

function encodeNavigation(command, args, scenario) {
  const slots = {}, handles = {}, searches = [];
  const slot = (field, value) => {
    slots[field] = value;
    return { slot: field };
  };
  const handle = (kind, value) => {
    const ref = `h${searches.length + 1}`;
    const querySlot = `target${searches.length + 1}`;
    slots[querySlot] = 'fixture target query';
    handles[ref] = value;
    searches.push({ kind, querySlot, matches: [{ handle: ref, match: 'exact' }] });
    return { handle: ref };
  };
  const wire = { ...args };
  if (command === 'ui.openDetail') {
    const { itemId, prefill, ...ref } = args;
    if (itemId) {
      const kinds = schema.agentNavigationItemKinds(ref);
      const authoredKind = scenario.expected.tools.find(step => step.name === 'search_records')?.args.kind;
      if (ref.featureId === 'local-trends') wire.itemId = slot('itemId', itemId);
      else wire.itemId = handle(kinds.includes(authoredKind) ? authoredKind : kinds[0], itemId);
    }
    if (prefill) {
      wire.prefill = Object.fromEntries(Object.entries(prefill).map(([key, value]) => {
        if (key === 'slotId') return [key, handle('slot', value)];
        if (key === 'itemId') return [key, handle('stock', value)];
        if (['benefit', 'sendMode', 'withSet'].includes(key)) return [key, value];
        return [key, slot(key, value)];
      }));
    }
  }
  if (command === 'ui.open_drawer' && args.query !== undefined) wire.query = slot('query', args.query);
  if (command === 'ui.openSettlement') {
    wire.amount = slot('amount', args.amount);
    wire.memberId = handle('member', args.memberId);
  }
  if (command === 'ui.setDraftField') wire.value = slot('value', args.value);
  function expand(value) {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'slot')) return slots[value.slot];
    if (Object.hasOwn(value, 'handle')) return handles[value.handle];
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
  }
  assert.deepEqual(expand(wire), args, `${command} round trip`);
  return { wire, slots: Object.keys(slots), searches, expand };
}

async function navigationStep(run, scenario, command, args, expectation = 'navigate', field) {
  const local = schema.validateAgentNavigationArgs(command, args);
  const invalid = scenario.id === 'S7-073' || (scenario.n03?.rejectHourItemId === true && Object.hasOwn(args, 'itemId'));
  assert.equal(local, !invalid, 'expanded navigation validation');
  const { wire, slots, searches, expand } = local ? encodeNavigation(command, args, scenario)
    : { wire: args, slots: [], searches: [], expand: value => value };
  assert.equal(schema.validateAgentNavigationWireArgs(command, wire), local);
  const state = fixtureState(scenario, command, args);
  const outcome = await run(navigationRequest(command, wire, { ...state, slots, searches }));
  assert.equal(outcome.outcome, expectation, command);
  if (expectation === 'clarify' && field) assert.equal(outcome.clarification.field, field);
  if (expectation !== 'navigate') return;
  const routeArgs = command === 'ui.show_panel'
    ? { ...args, layer: state.layer, page: scenario.id === 'S7-097' ? 2 : 1 } : args;
  assert.equal(outcome.navigation.command, command);
  assert.deepEqual(expand(outcome.navigation.args), routeArgs, 'exact expanded navigation arguments');
  assert.equal(outcome.navigation.layer, state.layer, 'origin board binding');
  assert.equal(outcome.navigation.page, state.page, 'origin page binding');
}

async function checkedRead(scenario, tool) {
  const { args } = tool;
  assert.ok(schema.validateAgentToolArgs('get_widget', args));
  const fake = createNavisContractFake([tool]);
  const harness = createNavisNavigationHarness(createBridge, schema.validateAgentFrame, fake.fetchImpl);
  try {
    const outcome = await harness.run(navigationRequest(undefined, undefined, {
      catalog: [widget(args.featureId, args.condition)],
      intent: { kind: 'read', ...args }, snapshot: [{ ...args, status: 'missing' }],
    }));
    assert.equal(outcome.outcome, 'reply');
    assert.deepEqual(fake.requests[1].messages.at(-2).toolCalls[0].function, { name: 'get_widget', arguments: args });
    assert.equal(fake.requests.length, 2);
  } finally {
    harness.close();
  }
}

async function checkedPolicy(run, command) {
  assert.equal(schema.agentCommandPolicy(command).policy, 'widget-only');
  const result = await run(navigationRequest(command, {}));
  const featureId = schema.agentCommandPolicy(command).featureId;
  assert.deepEqual(result, { outcome: 'refused', refusal: { reason: 'widget_only', alternative: {
    command, featureId, draft: {}, runId: 'fixture-run', snapshotRevision: 7,
  } } });
}

async function checkedHandoff(run, scenario, command, args) {
  assert.ok(schema.validateAgentCommandArgs(command, args));
  assert.equal(schema.agentNavigationHandoffIssue(command, args), undefined);
  const { wire, slots, searches, expand } = encodeNavigation(command, args, scenario);
  assert.equal(schema.agentNavigationHandoffIssue(command, wire, true), undefined);
  const result = await run(navigationRequest(command, wire, { slots, searches }));
  assert.equal(result.outcome, 'handoff');
  assert.equal(result.handoff.command, command);
  assert.equal(result.handoff.featureId, schema.agentCommandPolicy(command, args).featureId);
  assert.deepEqual(expand(result.handoff.draft), args);
}

async function boundary(run, scenario) {
  const { id, expected } = scenario;
  if (id === 'S2-126') {
    const result = await run(navigationRequest('ui.openSettlement', { purpose: 'charge_topup', amount: { slot: 'amount' } }, { slots: ['amount'] }));
    assert.equal(result.clarification.field, 'memberId');
    return;
  }
  if (id === 'S7-116') {
    const result = await run(navigationRequest('ui.openDetail', { featureId: 'menu' }, {
      intent: { kind: 'command', command: 'ui.openDetail', args: { featureId: 'menu' }, querySlot: 'name' },
      slots: ['name'], searches: [{ kind: 'menu', querySlot: 'name', matches:
        scenario.n03.menuChoices.map(({ id, name }) => ({ handle: id, label: name, match: 'similar' })),
      }],
    }));
    assert.equal(result.outcome, 'ambiguous');
    assert.deepEqual(result.clarification.choices.map(choice => choice.handle), scenario.n03.menuChoices.map(({ id }) => id));
    return;
  }
  if (['S5-124', 'S5-125'].includes(id)) {
    const prefill = id === 'S5-124' ? { sendDate: { slot: 'pastDate' } } : { slotId: { handle: 'unselected' } };
    const result = await run(navigationRequest('ui.openDetail', { featureId: 'slot-coupon', view: 'send', prefill }));
    assert.equal(result.outcome, 'clarify');
    assert.equal(result.clarification.field, 'prefill');
    return;
  }
  if (expected.kind === 'clarify') {
    const result = await run(navigationRequest('ui.openDetail', {}));
    assert.equal(result.outcome, 'clarify');
    assert.equal(result.clarification.field, 'featureId');
    return;
  }
  const shell = {
    'S7-072': ['ui.go_to_page', { page: 1 }, 'reply'],
    'S7-108': ['ui.go_back', {}, 'reply'],
    'S7-111': ['ui.enter_layout_edit', {}, 'refused'], 'S7-112': ['ui.enter_layout_edit', {}, 'refused'],
    'S5-046': ['ui.show_panel', { featureId: 'ai-response' }, 'navigate'],
  }[id];
  if (shell) return navigationStep(run, scenario, ...shell);
  const result = await run(navigationRequest(undefined, undefined, { intent: { kind: expected.kind === 'answer' ? 'help' : 'unsupported' } }));
  assert.equal(result.outcome, expected.kind === 'answer' ? 'reply' : 'refused');
}

async function verifyScenario(run, scenario) {
  const { id, expected } = scenario;
  let checks = 0;
  const deferred = [];
  if (Object.hasOwn(noEffectPolicy, id)) {
    await checkedPolicy(run, noEffectPolicy[id]);
    checks++;
  }
  for (const call of expected.tools) {
    const command = detailAliases.has(call.name) ? 'ui.openDetail' : call.name;
    let args = { ...call.args };
    if (schema.isAgentNavigationCommand(command)) {
      if (args.layer === 'orders-payment') args.layer = 'pos';
      await navigationStep(run, scenario, command, args, limitCases.get(id) ?? 'navigate',
        id === 'S7-073' ? 'page' : undefined);
    } else if (command === 'ui.openSettlement') {
      if (id === 'S2-215') {
        const pending = { purpose: args.purpose, memberId: { handle: 'new-member' }, amount: { slot: 'amount' } };
        const result = await run(navigationRequest(command, pending, { slots: ['amount'] }));
        assert.equal(result.clarification.field, 'memberId');
        // Exercise the same step once N21 provides the preceding receipt's identity.
        args.memberId = 'new-member';
      }
      await checkedHandoff(run, scenario, command, args);
    } else if (command === 'ui.setDraftField') {
      args = id === 'S6-047' ? { featureId: 'promo-video', view: 'create', field: 'tab', value: args.tab }
        : { ...args, value: 'Fixture draft' };
      await checkedHandoff(run, scenario, command, args);
    } else if (command === '(refused)') {
      await checkedPolicy(run, args.command);
    } else if (command === 'get_widget' && expected.tools.length === 1) {
      await checkedRead(scenario, call);
      if (id === 'S5-046' || expected.kind === 'clarify') await boundary(run, scenario);
    } else if (command === 'propose_action' && args.command === 'coupon.createExpiry') {
      const { itemId, discountRate: rate, withSet } = args.args;
      await navigationStep(run, scenario, 'ui.openDetail', {
        featureId: 'expiry-coupon', view: 'create', prefill: { itemId, rate, ...(withSet === undefined ? {} : { withSet }) },
      });
    } else {
      // Non-N03 steps are exercised by the owning slice. These rows still
      // require a checked navigation, handoff, refusal, or boundary below.
      deferred.push(command === 'propose_action' ? args.command : command);
      continue;
    }
    checks++;
  }
  if (!checks) await boundary(run, scenario);
  if (scenario.n03?.rejectHourItemId) {
    await navigationStep(run, scenario, 'ui.openDetail', { featureId: 'trade-area', view: 'hour', itemId: '15' }, 'clarify', 'itemId');
  }
  if (scenario.n03?.requireDeclaredTime) {
    const result = await run(navigationRequest('ui.openDetail', {
      featureId: 'slot-coupon', view: 'send', prefill: { sendMode: 'schedule', sendTime: { slot: 'undeclared' } },
    }));
    assert.equal(result.outcome, 'clarify');
    assert.equal(result.clarification.field, 'prefill');
  }
  if (scenario.n03?.rejectEllipsis) {
    const { photoIds } = expected.tools.find(step => step.args.command === 'promo.draft.set').args.args;
    assert.equal(new Set(photoIds).size, 10);
    assert.ok(schema.validateAgentPrefill('promo-video', { photoIds }));
    assert.equal(schema.validateAgentPrefill('promo-video', { photoIds: [photoIds[0], '...', photoIds.at(-1)] }), false);
  }
  return deferred;
}

test('N03 corpus navigation, local prefills and policy across all 250 dependencies', async t => {
  const rows = readTrace().filter(row => row.required_slices.split('|').includes('N03'));
  assert.equal(rows.length, 250);
  assert.equal(new Set(rows.map(row => row.scenario_id)).size, rows.length);
  assert.equal(rows.filter(row => row.slice_id === 'N03').length, 87);
  const failures = [], deferred = [], policyGaps = [];
  let assignedPolicyGaps = 0;
  let assignedPassed = 0, totalPassed = 0;
  for (const row of rows) {
    const id = row.scenario_id, scenario = releasedScenario(corpus.get(id));
    try {
      assert.equal(scenario?.id, id);
      const variants = scenario.variants ? scenario.utterances.map((_, index) => scenarioVariant(scenario, index)) : [scenario];
      const steps = new Set();
      for (const variant of variants) {
        const harness = createNavisNavigationHarness(createBridge, schema.validateAgentFrame);
        try {
          for (const step of await verifyScenario(harness.run, variant)) steps.add(step);
        } finally {
          harness.close();
        }
      }
      if (steps.size) deferred.push(`${id} ${[...steps].join(', ')}`);
      if (scenario.policyGap) {
        policyGaps.push(`${id} (${scenario.policyGap.slice})`);
        if (row.slice_id === 'N03') assignedPolicyGaps++;
      } else {
        totalPassed++;
        if (row.slice_id === 'N03') assignedPassed++;
      }
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
    }
  }
  t.diagnostic(`${assignedPassed} of 87 assigned cases pass`);
  t.diagnostic(`${totalPassed} of 250 required-slice scenarios pass N03-level checks, including ${assignedPassed} assigned cases`);
  t.diagnostic(`D-323 deferred action receipt checks: ${policyGaps.join(', ')}`);
  t.diagnostic(`Non-N03 steps left to their owning slices (${deferred.length} cases) — ${deferred.join('; ')}`);
  assert.deepEqual(failures, [], 'unexpected N03 fixture failures');
  assert.equal(assignedPassed + assignedPolicyGaps, 87);
  assert.equal(totalPassed + policyGaps.length, 250);
});
