import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { navigationRequest } from '../fixtures/navis-eval-fake.mjs';

const request = navigationRequest('inventory.deleteItem', { itemId: { handle: 'stock-1' } }, {
  slots: ['name'], searches: [{
    kind: 'stock', querySlot: 'name', matches: [{ handle: 'stock-1', match: 'exact', fields: {
      kind: 'ingredient', unit: 'L', referenced: true, sku: 'RM-004',
    } }],
  }],
});

test('N05 projection accepts only scoped inventory record fields', () => {
  assert.ok(validateAgentRequest(request));
  const bad = structuredClone(request);
  bad.searches[0].matches[0].fields.referenced = 'true';
  assert.equal(validateAgentRequest(bad), false);
  bad.searches[0].matches[0].fields = { online: -1 };
  assert.equal(validateAgentRequest(bad), false);
  assert.equal(validateAgentToolArgs('propose_action', {
    command: 'inventory.updateItem', args: { itemId: { handle: 'stock-1' }, stock: 3 },
  }), false);
});

test('N05 default registry prepares only exact, eligible and unreferenced inventory targets', async () => {
  const { createAgentDomainRegistry } = await import('./registry.mjs');
  const registry = createAgentDomainRegistry();
  const adapter = registry.get('inventory.deleteItem');
  assert.ok(adapter);
  assert.deepEqual(adapter.lookups(request), [{ name: 'search_records', args: { kind: 'stock', querySlot: 'name' } }]);
  function prepare(matches, status = 'ready', nextCursor) {
    return adapter.prepare({ input: request, reads: [{ status, matches, nextCursor }] });
  }
  const [item] = request.searches[0].matches;
  assert.deepEqual(prepare([item]), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(prepare([{ ...item, fields: { kind: 'ingredient', unit: 'L' } }]), { outcome: 'refused', reason: 'unavailable' });
  const eligible = { ...item, fields: { ...item.fields, referenced: false } };
  assert.deepEqual(prepare([eligible]), { outcome: 'ready', args: request.intent.args });
  assert.deepEqual(prepare([{ ...eligible, handle: 'another' }]), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(prepare([eligible], 'unavailable'), { outcome: 'refused', reason: 'unavailable' });
  assert.deepEqual(prepare([eligible], 'ready', 'next'), { outcome: 'ambiguous', lookupIndex: 0, field: 'itemId' });
});

test('N05 expanded local drafts preserve precision, units, balances and tracking calculations', async () => {
  const { inventoryQuantityInUnit, prepareInventoryPreview } = await import('./inventory.mjs');
  assert.deepEqual(inventoryQuantityInUnit(2500, 'g', 'kg'), { value: 2.5 });
  assert.deepEqual(inventoryQuantityInUnit(500, 'mL', 'L'), { value: 0.5 });
  assert.deepEqual(inventoryQuantityInUnit(3, 'kg', 'L'), { field: 'unit' });
  assert.deepEqual(inventoryQuantityInUnit(2, 'box', 'pcs'), { field: 'packSize' });
  for (const value of [-1, 2.0005, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(inventoryQuantityInUnit(value, 'kg', 'kg'), { field: 'quantity' });
  }
  assert.deepEqual(inventoryQuantityInUnit(12.5, 'pcs', 'pcs'), { field: 'quantity' });
  const retail = { kind: 'retail', unit: 'pcs', store: 120, online: 40 };
  const move = { itemId: 'stock-1', from: 'store', to: 'online', qty: 20 };
  assert.deepEqual(prepareInventoryPreview('inventory.moveChannel', move, { target: retail }), {
    outcome: 'ready', before: { store: 120, online: 40 }, after: { store: 100, online: 60 },
  });
  assert.deepEqual(prepareInventoryPreview('inventory.moveChannel', { ...move, qty: 121 }, { target: retail }),
    { outcome: 'clarify', field: 'qty' });
  assert.deepEqual(prepareInventoryPreview('inventory.moveChannel', { ...move, to: 'store' }, { target: retail }),
    { outcome: 'clarify', field: 'direction' });
  const milk = { kind: 'ingredient', unit: 'L', stock: 0, rawStock: -2, threshold: 4, trackRestock: true, trackExpiry: false };
  assert.deepEqual(prepareInventoryPreview('inventory.setTracking', { itemId: 'stock-1', trackRestock: false }, { target: milk }), {
    outcome: 'ready',
    before: { trackRestock: true, trackExpiry: false, needsRestock: true, outOfStock: true, status: 'out-of-stock' },
    after: { trackRestock: false, trackExpiry: false, needsRestock: false, outOfStock: false, status: 'sufficient' },
  });
  assert.deepEqual(prepareInventoryPreview('inventory.updateItem', { itemId: 'stock-1', stock: 0 }, { target: milk }), { outcome: 'ready' });
  assert.deepEqual(prepareInventoryPreview('inventory.updateItem', { itemId: 'stock-1', stock: 0 }, { target: { ...milk, rawStock: 0 } }),
    { outcome: 'unchanged' });
});

test('N05 proposals keep channel quantities and tracking changes behind confirmation', async () => {
  const { createAgentDomainRegistry } = await import('./registry.mjs');
  const registry = createAgentDomainRegistry();
  const itemId = { handle: 'stock-1' };
  const exact = fields => ({ status: 'ready', matches: [{ handle: itemId.handle, match: 'exact', fields }] });
  const move = { itemId, from: 'store', to: 'online', qty: { slot: 'qty' } };
  const moveInput = navigationRequest('inventory.moveChannel', move, { slots: ['name', 'qty'] });
  const moveAdapter = registry.get('inventory.moveChannel');
  assert.deepEqual(moveAdapter.prepare({ input: moveInput, reads: [exact({ kind: 'retail', unit: 'pcs', store: 20, online: 0 })] }),
    { outcome: 'ready', args: move });
  assert.deepEqual(moveAdapter.prepare({ input: moveInput, reads: [exact({ kind: 'retail', unit: 'pcs', store: 0, online: 20 })] }),
    { outcome: 'clarify', field: 'qty' });
  assert.deepEqual(moveAdapter.prepare({ input: moveInput, reads: [exact({ kind: 'retail', unit: 'pcs', store: 20 })] }),
    { outcome: 'refused', reason: 'unavailable' });
  const tracking = { itemId, trackExpiry: true };
  const trackingInput = navigationRequest('inventory.setTracking', tracking, { slots: ['name'] });
  const trackingAdapter = registry.get('inventory.setTracking');
  assert.deepEqual(trackingAdapter.prepare({ input: trackingInput, reads: [exact({ kind: 'ingredient', unit: 'pcs' })] }),
    { outcome: 'ready', args: tracking });
  assert.deepEqual(trackingAdapter.prepare({ input: trackingInput, reads: [exact({ kind: 'retail', unit: 'pcs' })] }),
    { outcome: 'refused', reason: 'invalid_target' });
});
