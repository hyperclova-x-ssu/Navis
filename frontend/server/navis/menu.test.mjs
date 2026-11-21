import assert from 'node:assert/strict';
import test from 'node:test';
import * as menu from './menu.mjs';
import * as schema from '../../shared/navis-agent-schema.mjs';

test('menu adapter requires a complete uniqueness lookup before preparing a proposal', () => {
  const input = { intent: { kind: 'menu.create', category: 'drink' }, slots: ['name', 'price'] };
  const adapter = menu.menuCreateAdapter;
  assert.deepEqual(adapter.lookups(input), [{ name: 'search_records', args: { kind: 'menu', querySlot: 'name' } }]);
  assert.equal(adapter.prepare({ input, reads: [{ status: 'unavailable', matches: [] }] }).outcome, 'refused');
  assert.equal(adapter.prepare({ input, reads: [{ status: 'ready', matches: [], nextCursor: 'more' }] }).outcome, 'refused');
  assert.equal(adapter.prepare({ input, reads: [{ status: 'ready', matches: [{ handle: 'h', match: 'exact' }] }] }).outcome, 'refused');
  assert.deepEqual(adapter.prepare({ input, reads: [{ status: 'missing', matches: [] }] }), {
    outcome: 'ready', args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } },
  });
});

const target = { handle: 'menu-1' };
const liveMatch = { ...target, match: 'exact', fields: { kind: 'menu', status: 'selling' } };
const result = (...matches) => ({ status: 'ready', matches });
const lookup = (querySlot = 'target') => ({ name: 'search_records', args: { kind: 'menu', querySlot } });
const draft = (command, args, slots = ['target']) => ({
  intent: { kind: 'command', command, querySlot: 'target', args }, slots,
});
const editAdapter = command => {
  const adapter = menu.menuEditAdapters?.find(entry => entry.command === command);
  assert.ok(adapter, `${command} adapter is registered`);
  return adapter;
};

test('menu edits preserve a verified draft and refuse unrelated, retail or missing target handles', () => {
  const adapter = editAdapter('menu.update');
  const args = { menuId: target, patch: { price: { slot: 'price' }, category: 'dessert', memo: null } };
  const input = draft('menu.update', args, ['target', 'price']);
  assert.deepEqual(adapter.lookups(input), [lookup()]);
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch)] }), { outcome: 'ready', args });
  for (const reads of [
    [result({ ...liveMatch, handle: 'menu-2' })], [result({ ...liveMatch, fields: { ...liveMatch.fields, kind: 'retail' } })],
    [result({ ...liveMatch, fields: undefined })], [{ status: 'missing', matches: [] }],
  ]) assert.deepEqual(adapter.prepare({ input, reads }), { outcome: 'refused', reason: 'invalid_target' });
});

test('rename needs a distinct complete name check and excludes its own exact match', () => {
  const adapter = editAdapter('menu.update');
  const args = { menuId: target, patch: { name: { slot: 'name' } } };
  const input = draft('menu.update', args, ['target', 'name']);
  assert.deepEqual(adapter.lookups(input), [lookup(), lookup('name')]);
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch), result(liveMatch)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch), result({ ...liveMatch, handle: 'other' })] }),
    { outcome: 'refused', reason: 'duplicate' });
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch), { ...result(), nextCursor: 'next' }] }),
    { outcome: 'refused', reason: 'unavailable' });
  const colliding = { ...input, intent: { ...input.intent, querySlot: 'name' } };
  assert.deepEqual(adapter.prepare({ input: colliding, reads: [result(liveMatch)] }), { outcome: 'refused', reason: 'unavailable' });
});

test('unknown or ambiguous targets never issue a menu edit proposal', () => {
  const adapter = editAdapter('menu.setSaleStatus');
  const input = draft('menu.setSaleStatus', { status: 'sold_out' });
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch)] }), { outcome: 'clarify', field: 'menuId' });
  assert.deepEqual(adapter.prepare({ input, reads: [result(liveMatch, { ...liveMatch, handle: 'another' })] }),
    { outcome: 'ambiguous', lookupIndex: 0, field: 'menuId' });
  assert.equal(adapter.prepare({ input, reads: [{ ...result(liveMatch), nextCursor: 'more' }] }).outcome, 'ambiguous');
});

test('menu edits stay out of the POS board', () => {
  const adapter = editAdapter('menu.setSaleStatus');
  const input = { ...draft('menu.setSaleStatus', { menuId: target, status: 'sold_out' }), layer: 'pos' };
  assert.deepEqual(adapter.lookups(input), []);
  assert.deepEqual(adapter.prepare({ input, reads: [] }), { outcome: 'refused', reason: 'out_of_scope' });
});

test('recipe preflight needs the scoped existing recipe and archive needs extra confirmation', () => {
  const recipe = editAdapter('menu.setRecipe');
  const args = { menuId: target, lines: { slot: 'recipeLines' } };
  const input = draft('menu.setRecipe', args, ['target', 'recipeLines']);
  assert.deepEqual(recipe.lookups(input), [lookup(), { name: 'get_recipe', args: { menuId: target } }]);
  assert.deepEqual(recipe.prepare({ input, reads: [result(liveMatch), { status: 'unavailable', facts: [] }] }),
    { outcome: 'refused', reason: 'unavailable' });
  assert.deepEqual(recipe.prepare({ input, reads: [result(liveMatch), { status: 'missing', facts: [] }] }),
    { outcome: 'ready', args });
  const archive = editAdapter('menu.delete');
  const deleteInput = draft('menu.delete', { menuId: target });
  assert.deepEqual(archive.prepare({ input: deleteInput, reads: [result(liveMatch)] }),
    { outcome: 'ready', args: { menuId: target }, tier: 'extra-confirm' });
});

test('local menu validators reject duplicate lines, sub-base quantities and misplaced options', () => {
  const valid = { menuId: 'menu-1', lines: [{ recipeLineId: 'recipe:menu-1:i-milk', itemId: 'i-milk', quantity: 0.25, unit: 'L' }] };
  assert.equal(schema.validateAgentMenuEditArgs?.('menu.setRecipe', valid), true);
  assert.equal(schema.validateAgentMenuEditArgs('menu.setRecipe', { ...valid, lines: [...valid.lines, ...valid.lines] }), false);
  assert.equal(schema.validateAgentMenuEditArgs('menu.setRecipe', { ...valid, lines: [{ ...valid.lines[0], quantity: 0.00000001 }] }), false);
  const option = { optionId: 'vanilla', groupId: 'shots', extraPrice: 0, extraCost: null, extraRecipe: [], name: 'Vanilla' };
  const group = { groupId: 'syrup', menuId: valid.menuId, name: 'Syrup', required: true, options: [option] };
  assert.equal(schema.validateAgentMenuEditArgs('menu.setOptions', { menuId: valid.menuId, groups: [group] }), false);
  const owned = { ...group, options: [{ ...option, groupId: group.groupId }] };
  assert.equal(schema.validateAgentMenuEditArgs('menu.setOptions', { menuId: valid.menuId, groups: [owned] }), true);
  assert.equal(schema.validateAgentMenuEditArgs('menu.setOptions', { menuId: valid.menuId, groups: [owned, owned] }), false);
});
