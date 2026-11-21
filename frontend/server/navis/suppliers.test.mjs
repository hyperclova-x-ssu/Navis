import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentDomainRegistry } from './registry.mjs';
import { validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';

const record = (handle, fields) => ({ handle, match: 'exact', fields });
const ready = (...matches) => ({ status: 'ready', matches });
const slot = name => ({ slot: name });
const handle = name => ({ handle: name });
const orderArgs = { purchaseItemId: handle('purchase'), qty: slot('qty') };
const item = record('purchase', { unit: 'L', minimumQty: 1, unitPrice: 2900, orderStep: 1, leadDays: 1 });
const order = record('order', { date: '2026-11-18', status: 'scheduled', open: true });
const line = record('line', { unit: 'L', status: 'scheduled', open: true, remaining: 12, unitPrice: 2900 });
const base = { runId: 'fixture', snapshotRevision: 1, businessDate: '2026-11-17', layer: 'management', slots: ['name', 'qty'], catalog: [], snapshot: [], searches: [] };
const input = (command, args, searches = []) => ({ ...base, searches, intent: { kind: 'command', command, args } });
const projection = (kind, querySlot, ...matches) => ({ kind, querySlot, matches });
const lookup = (kind, querySlot = 'name') => ({ name: 'search_records', args: { kind, querySlot } });

test('the default registry allows a scoped local schedule and excludes supplier transmission', async () => {
  const command = 'suppliers.createOrder';
  const existing = createAgentDomainRegistry().get(command);
  const { createSupplierAdapters } = await import('./suppliers.mjs');
  assert.equal(validateAgentToolArgs('propose_action', { command, args: orderArgs }), true);
  const ctx = { input: input(command, orderArgs), reads: [ready(item)] };
  assert.deepEqual(existing.lookups(ctx.input), [lookup('purchaseItem')]);
  assert.deepEqual(existing.prepare(ctx), { outcome: 'ready', args: orderArgs });
  const disabled = createSupplierAdapters({ allowLocalScheduling: false }).find(adapter => adapter.command === command);
  assert.deepEqual(disabled.prepare(ctx), { outcome: 'refused', reason: 'widget_only' });
  assert.equal(validateAgentRequest({ ...ctx.input, allowLocalScheduling: true }), false);
  assert.equal(createAgentDomainRegistry().get('supplier.sendOrder'), undefined);
});

test('purchase line projections carry only operational fields and require an open exact target', () => {
  const command = 'suppliers.recordReceipt';
  const args = { polId: handle('line'), qty: slot('qty') };
  const request = input(command, args, [projection('purchaseOrderLine', 'name', line)]);
  assert.equal(validateAgentRequest(request), true);
  const malicious = { ...line, fields: { ...line.fields, phone: '01012345678' } };
  assert.equal(validateAgentRequest(input(command, args, [projection('purchaseOrderLine', 'name', malicious)])), false);
  const adapter = createAgentDomainRegistry().get(command);
  assert.deepEqual(adapter.lookups(request), [lookup('purchaseOrderLine')]);
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(line)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(record('line', { ...line.fields, remaining: 0 }))] }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(record('wrong', line.fields))] }), { outcome: 'refused', reason: 'invalid_target' });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(line, record('other', line.fields))] }), { outcome: 'ambiguous', lookupIndex: 0, field: 'polId' });
});

test('supplier dates can change on open orders while a cancellation remains extra-confirm', () => {
  const registry = createAgentDomainRegistry();
  const args = { poId: handle('order') };
  const cancel = registry.get('suppliers.cancelOrder');
  assert.ok(cancel, 'the supplier cancel adapter must be registered');
  assert.deepEqual(cancel.prepare({ input: input(cancel.command, args), reads: [ready(order)] }), { outcome: 'ready', args });
  const change = registry.get('suppliers.changeDueDate');
  const draft = { ...args, date: slot('date') };
  assert.deepEqual(change.prepare({ input: input(change.command, draft), reads: [ready(record('order', { date: '2026-11-18', status: 'complete', open: false }))] }),
    { outcome: 'refused', reason: 'invalid_target' });
  assert.equal(validateAgentToolArgs('propose_action', { command: change.command, args: { ...draft, time: slot('time') } }), false);
});

test('purchase registration reuses stock lookup and checks the purchase-item and supplier scopes', () => {
  const command = 'suppliers.createPurchaseItem';
  const args = { itemId: handle('stock'), supplierId: handle('supplier'), minimumQty: slot('minimumQty'),
    unitPrice: slot('unitPrice'), orderStep: slot('orderStep'), leadDays: slot('leadDays') };
  const request = { ...input(command, args), slots: [...base.slots, 'supplierId', 'minimumQty', 'unitPrice', 'orderStep', 'leadDays'] };
  const adapter = createAgentDomainRegistry().get(command);
  assert.ok(adapter, 'the supplier purchase item adapter must be registered');
  assert.deepEqual(adapter.lookups(request), [lookup('stock'), lookup('purchaseItem'), lookup('supplier', 'supplierId')]);
  const stock = record('stock', { kind: 'ingredient', unit: 'L', referenced: false });
  const supplier = record('supplier', { referenced: false });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(stock), ready(), ready(supplier)] }), { outcome: 'ready', args });
  assert.deepEqual(adapter.prepare({ input: request, reads: [ready(stock), ready(item), ready(supplier)] }), { outcome: 'refused', reason: 'duplicate' });
});

test('an estimate converts units, honors minimum and step and exposes an existing delivery', async () => {
  const { prepareSupplierEstimate } = await import('./suppliers.mjs');
  const args = { item: item.fields, qty: 10_000, sourceUnit: 'mL', businessDate: base.businessDate, hasOpenOrder: true };
  assert.deepEqual(prepareSupplierEstimate(args), {
    outcome: 'ready', qty: 10, unit: 'L', unitPrice: 2900, total: 29_000, dueDate: '2026-11-18', hasOpenOrder: true,
  });
  assert.deepEqual(prepareSupplierEstimate({ ...args, qty: 500 }), { outcome: 'clarify', field: 'minimumQty' });
  assert.deepEqual(prepareSupplierEstimate({ ...args, qty: 4500 }), { outcome: 'clarify', field: 'orderStep' });
  assert.deepEqual(prepareSupplierEstimate({ ...args, sourceUnit: 'kg' }), { outcome: 'clarify', field: 'unit' });
  assert.deepEqual(prepareSupplierEstimate({ ...args, dueDate: '2026-11-16' }), { outcome: 'refused', reason: 'invalid_target' });
});

test('a receipt uses purchase-unit conversion and keeps the recorded line price', async () => {
  const { prepareSupplierReceipt } = await import('./suppliers.mjs');
  const lineFields = { ...line.fields, unit: 'pcs', basePerUnit: 350, unitPrice: 550 };
  assert.deepEqual(prepareSupplierReceipt({ line: lineFields, qty: 4 }), {
    outcome: 'ready', qty: 4, addedBase: 1400, remaining: 8, expenseCandidate: 2200,
  });
  assert.deepEqual(prepareSupplierReceipt({ line: lineFields, qty: 0.5 }), { outcome: 'clarify', field: 'qty' });
  assert.deepEqual(prepareSupplierReceipt({ line: lineFields, qty: 13 }), { outcome: 'clarify', field: 'qty' });
});

test('order form prefill resolves private slots while order proposal targets stay opaque', async () => {
  const { validateAgentDetailRef, validateAgentNavigationWireArgs } = await import('../../shared/navis-agent-schema.mjs');
  const ref = { featureId: 'suppliers', view: 'register' };
  assert.equal(validateAgentDetailRef({ ...ref, prefill: { purchaseItemId: 'cafe-purchase-1', qty: 2 } }), true);
  assert.equal(validateAgentNavigationWireArgs('ui.openDetail', { ...ref, prefill: { purchaseItemId: slot('purchaseItemId'), qty: slot('qty') } }), true);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'suppliers.createOrder',
    args: { purchaseItemId: slot('purchaseItemId'), qty: slot('qty') } }), false);
});
