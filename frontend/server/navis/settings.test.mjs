import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import { normalizeConversationTurn } from './conversation.mjs';
import { createNavisMenuHarness, navigationRequest, reading } from '../fixtures/navis-eval-fake.mjs';
import { validateAgentFrame } from '../../shared/navis-agent-schema.mjs';

const settings = (section, values) => reading('get_ui_state', { section }, values);
const idle = settings('pos', { 'ui.pos.approvalPending': 0 });
const display = settings('display', { 'ui.theme': 'light' });
const preview = settings('preview', {
  'ui.preview.family': 'empty',
  'ui.preview.pos': 'inherit',
  'ui.preview.overrideCount': 1,
  'ui.preview.variant.menu': 'no-menus',
  'ui.preview.variant.inventory-booking': 'partial-data',
  'ui.preview.override.inventory-booking': 'partial-data',
});

function bridgeHarness(t) {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(() => harness.close());
  return (command, args, readings = [], slots = []) => harness.run(navigationRequest(command, args, { readings, slots }));
}

test('settings emits a revision-bound normal confirmation card and blocks typed confirmation', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(() => harness.close());
  const command = 'settings.set_theme';
  const args = { theme: 'dark' };
  const request = navigationRequest(command, args, { readings: [idle, display], conversation: true });
  const turn = await harness.run(request);
  assert.deepEqual(turn.terminal, { outcome: 'proposal' });
  assert.deepEqual(turn.calls, [{ name: 'propose_action', args: { command, args } }]);
  assert.deepEqual({ ...turn.proposal, proposalId: 'fixture' }, {
    proposalId: 'fixture', command, args, snapshotRevision: request.snapshotRevision, runId: request.runId,
    layer: request.layer, page: request.page, tier: 'normal',
  });
  assert.doesNotMatch(turn.raw, /^event: action_result$/mu);

  const { kind: action } = normalizeConversationTurn('네', { pending: true });
  assert.equal(action, 'hold');
  const typed = await harness.run({ ...request, readings: [], intent: { kind: 'conversation', action } });
  assert.deepEqual(typed.terminal, { outcome: 'conversation', resolution: { type: 'hold' } });
  assert.deepEqual(typed.calls, []);
  assert.equal(typed.proposal, undefined);
  assert.doesNotMatch(typed.raw, /^event: action_result$/mu);
});

test('settings current values must be present and agree', async t => {
  const run = bridgeHarness(t);
  for (const readings of [[], [idle], [idle, display, reading('get_ui_state', {}, { 'ui.theme': 'dark' })]]) {
    const turn = await run('settings.set_theme', { theme: 'dark' }, readings);
    assert.deepEqual(turn.terminal, { outcome: 'refused', refusal: { reason: 'unavailable' } });
    assert.deepEqual(turn.calls, []);
  }
});

test('settings refuses a repeated theme and a pending POS approval before calling the model', async t => {
  const run = bridgeHarness(t);
  for (const [args, readings] of [
    [{ theme: 'light' }, [idle, display]],
    [{ theme: 'dark' }, [settings('pos', { 'ui.pos.approvalPending': 1 }), display]],
  ]) {
    const turn = await run('settings.set_theme', args, readings);
    assert.deepEqual(turn.terminal, { outcome: 'refused', refusal: { reason: 'unavailable' } });
    assert.deepEqual(turn.calls, []);
    assert.equal(turn.proposal, undefined);
  }
});

test('a widget preview variant must belong to the targeted widget registry', async t => {
  const run = bridgeHarness(t);
  const wrong = await run('settings.set_preview_variant', { featureId: 'menu', variant: 'partial-data' }, [idle, preview]);
  assert.deepEqual(wrong.terminal, { outcome: 'clarify', clarification: {
    command: 'settings.set_preview_variant', field: 'variant', promptKey: 'settings.set_preview_variant.variant', choices: [{ id: 'manual' }],
  } });
  assert.deepEqual(wrong.calls, []);
  const right = await run('settings.set_preview_variant', { featureId: 'menu', variant: 'no-menus' }, [idle, preview]);
  assert.equal(right.proposal?.args.variant, 'no-menus');
});

test('retrying a preview family is a new change when it clears widget overrides', async t => {
  const run = bridgeHarness(t);
  const turn = await run('settings.set_preview_family', { family: 'empty' }, [idle, preview]);
  assert.equal(turn.proposal?.args.family, 'empty');
  const unchanged = await run('settings.set_preview_family', { family: 'empty' }, [idle, settings('preview', {
    'ui.preview.family': 'empty', 'ui.preview.overrideCount': 0, 'ui.preview.pos': 'inherit',
  })]);
  assert.equal(unchanged.terminal.refusal?.reason, 'unavailable');
  assert.deepEqual(unchanged.calls, []);
});

test('payment failure uses one proposal and stays blocked during approval', async t => {
  const run = bridgeHarness(t);
  const args = { scenario: 'payment-failure' };
  const turn = await run('settings.set_pos_preview', args, [idle, preview]);
  assert.deepEqual(turn.calls, [{ name: 'propose_action', args: { command: 'settings.set_pos_preview', args } }]);
  assert.deepEqual(turn.proposal?.args, args);
  const busy = await run('settings.set_pos_preview', args, [settings('pos', { 'ui.pos.approvalPending': 1 }), preview]);
  assert.deepEqual(busy.terminal, { outcome: 'refused', refusal: { reason: 'unavailable' } });
  assert.deepEqual(busy.calls, []);
});

test('shop settings remain widget-only even with a valid draft', async t => {
  const run = bridgeHarness(t);
  for (const args of [{ businessType: { slot: 'businessType' } }, { paymentStyle: { slot: 'paymentStyle' } }, { tablesEnabled: true }]) {
    const turn = await run('shop.updateSettings', args, [idle, display], Object.keys(args));
    assert.equal(turn.terminal.outcome, 'refused');
    assert.equal(turn.terminal.refusal.reason, 'widget_only');
    assert.equal(turn.terminal.refusal.alternative.featureId, 'settings');
    assert.deepEqual(turn.calls, []);
    assert.equal(turn.proposal, undefined);
  }
});

test('closing status and pending counts reject values from the display preview', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  t.after(() => harness.close());
  const scope = { sourceId: 'pos', condition: { kind: 'default' } };
  for (const [key, value] of [['closing.status', 'error'], ['closing.pendingBills', -1]]) {
    const fact = { key, value, label: '마감 상태', display: String(value), unit: '' };
    const turn = await harness.run(navigationRequest('', {}, {
      intent: { kind: 'read', ...scope }, snapshot: [{ ...scope, facts: [fact] }],
    }));
    assert.equal(turn.status, 400);
    assert.deepEqual(turn.calls, []);
  }
});
