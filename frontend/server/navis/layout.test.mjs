import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, defaultCondition, navigationRequest, reading } from '../fixtures/navis-eval-fake.mjs';
import { validateAgentFrame, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';

const target = { layer: 'management', page: 2 };
const catalog = [
  { id: 'menu', name: '메뉴', layer: 'management', conditions: [defaultCondition] },
  { id: 'inventory-booking', name: '재고', layer: 'management', conditions: [defaultCondition] },
  { id: 'community', name: '커뮤니티', layer: 'marketing', conditions: [defaultCondition] },
];
function board(args, facts) {
  return reading('get_board', args, {
    'board.pageCount': 2, 'board.page': args.page ?? 1, 'board.grid.columns': 6,
    'board.grid.rows': 4, 'board.cells.free': 24, ...facts,
  });
}
const placed = (id, page, column = 0) => ({
  [`board.panel.${id}.page`]: page, [`board.panel.${id}.column`]: column,
  [`board.panel.${id}.row`]: 0, [`board.panel.${id}.width`]: 1, [`board.panel.${id}.height`]: 1,
});
async function run(command, args, readings = [], extra = {}) {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame);
  try { return await harness.run(navigationRequest(`layout.${command}`, args, { catalog, readings, ...extra })); }
  finally { harness.close(); }
}

test('layout add proposes a scoped write with the active origin and explicit target preserved', async () => {
  const args = { featureId: 'menu', ...target };
  const result = await run('add_widget', args, [board(target)]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [
    { name: 'get_board', args: target },
    { name: 'propose_action', args: { command: 'layout.add_widget', args } },
  ]);
  assert.deepEqual({ ...result.proposal, proposalId: null }, {
    command: 'layout.add_widget', args, layer: 'management', page: 1,
    proposalId: null, runId: 'fixture-run', snapshotRevision: 7, tier: 'normal',
  });
  assert.doesNotMatch(result.raw, /event: action_result/u);
});

test('a widget already on another page blocks a duplicate add', async () => {
  const result = await run('add_widget', { featureId: 'menu', ...target },
    [board(target, { 'board.panel.menu.page': 1 })]);
  assert.equal(result.terminal.refusal.reason, 'duplicate');
  assert.equal(result.proposal, undefined);
});

test('a missing board projection cannot authorize a layout write', async () => {
  const result = await run('add_widget', { featureId: 'menu', ...target },
    [board({ layer: 'management' })]);
  assert.equal(result.terminal.refusal.reason, 'unavailable');
  assert.equal(result.proposal, undefined);
});

test('an explicit marketing add is allowed from management while an implicit one is out of scope', async () => {
  const args = { featureId: 'community', layer: 'marketing', page: 1 };
  const explicit = await run('add_widget', args, [board({ layer: 'marketing', page: 1 })]);
  assert.equal(explicit.proposal?.layer, 'management');
  assert.deepEqual(explicit.proposal?.args, args);
  const implicit = await run('add_widget', { featureId: 'community' }, [board({ layer: 'management' })]);
  assert.equal(implicit.terminal.refusal.reason, 'out_of_scope');
  assert.equal(implicit.proposal, undefined);
});

test('an invalid batch item prevents a proposal for the entire batch', async () => {
  const result = await run('add_widgets', { ...target, widgets: [
    { featureId: 'menu' }, { featureId: 'inventory-booking', page: 1 },
  ] }, [board(target)]);
  assert.deepEqual(result.calls, [{ name: 'get_board', args: target }]);
  assert.equal(result.terminal.refusal.reason, 'out_of_scope');
  assert.equal(result.proposal, undefined);
});

test('batch removal requires extra confirmation on the whole scoped proposal', async () => {
  const args = { featureIds: ['menu', 'inventory-booking'], ...target };
  assert.equal(validateAgentToolArgs('propose_action', { command: 'layout.remove_widgets', args }), true);
  const result = await run('remove_widgets', args, [board(target, {
    ...placed('menu', 2), ...placed('inventory-booking', 2, 1), 'board.cells.free': 22,
  })]);
  assert.equal(result.proposal?.tier, 'extra-confirm');
  assert.deepEqual(result.proposal?.args, args);
  assert.equal(validateAgentFrame('action_proposal', { ...result.proposal, tier: 'normal' }), false);
  assert.equal(validateAgentToolArgs('propose_action', {
    command: 'layout.remove_widgets', args: { featureIds: ['menu', 'menu'] },
  }), false);
});

test('page move checks the destination projection and declines a full destination', async () => {
  const source = { layer: 'management', page: 1 };
  const result = await run('move_to_page', { featureId: 'menu', ...source, destinationPage: 2 },
    [board(source, { ...placed('menu', 1), 'board.cells.free': 23 }),
      board(target, { 'board.cells.free': 0, 'board.panel.menu.page': 1 })]);
  assert.deepEqual(result.calls, [{ name: 'get_board', args: source }, { name: 'get_board', args: target }]);
  assert.equal(result.terminal.refusal.reason, 'unavailable');
  assert.equal(result.proposal, undefined);
});

test('a resize beyond the current preset asks for a size without producing a write', async () => {
  const result = await run('resize_widget', { featureId: 'menu', width: 3, height: 1, ...target },
    [board(target, { ...placed('menu', 2, 4), 'board.cells.free': 23 })]);
  assert.equal(result.terminal.clarification.field, 'width');
  assert.equal(result.proposal, undefined);
});
