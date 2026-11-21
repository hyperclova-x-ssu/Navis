import assert from 'node:assert/strict';
import test from 'node:test';
import { customAdapters } from './custom.mjs';
import { createAgentDomainRegistry } from './registry.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisNavigationHarness, navigationRequest } from '../fixtures/navis-eval-fake.mjs';
import { agentCommandPolicy, agentHandoffFields, validateAgentCommandArgs, validateAgentFrame, validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';

const order = { handle: 'order-token', match: 'exact', fields: { stage: 'approval_pending', quoteRevision: 2, approvalCurrent: false, paymentReversalRequired: false } };
const pickup = { handle: 'pickup-token', match: 'exact', fields: { kind: 'pickup', status: 'confirmed', paymentReversalRequired: false } };
const template = { handle: 'template-token', match: 'exact', fields: {} };
const member = { handle: 'member-token', match: 'exact', fields: {} };
const ref = ({ handle }) => ({ handle });
const slot = name => ({ slot: name });
const search = (...matches) => ({ status: 'ready', matches });
const propose = (command, args, reads = []) => customAdapters.find(adapter => adapter.command === command)
  .prepare({ input: { intent: { command, args } }, reads });
const refusal = reason => ({ outcome: 'refused', reason });

test('N13 registry scopes template and optional member handles separately', () => {
  const command = 'customOrder.create';
  const args = {
    templateId: ref(template), memberId: ref(member), productLabel: slot('productLabel'), quantity: slot('quantity'),
    answers: slot('answers'), channel: 'phone', desiredPickupAt: slot('desiredPickupAt'),
  };
  const input = { intent: { command, args }, slots: ['templateId', 'memberQuery'], searches: [
    { kind: 'customTemplate', querySlot: 'templateId', matches: [template] },
    { kind: 'member', querySlot: 'memberQuery', matches: [member] },
  ] };
  assert.deepEqual(createAgentDomainRegistry().get(command).lookups(input), [
    { name: 'search_records', args: { kind: 'customTemplate', querySlot: 'templateId' } },
    { name: 'search_records', args: { kind: 'member', querySlot: 'memberQuery' } },
  ]);
  assert.deepEqual(propose(command, args, [search(template), search(member)]), { outcome: 'ready', args });
  assert.deepEqual(propose(command, args, [search(template)]), refusal('unavailable'));
  assert.deepEqual(propose(command, args, [search(template), search({ ...member, handle: 'foreign' })]), refusal('invalid_target'));
  assert.deepEqual(propose(command, args, [search(template, { ...template, handle: 'other-template' }), search(member)]),
    { outcome: 'ambiguous', lookupIndex: 0, field: 'templateId' });
});

test('N13 stages use current approval and require full advance payment before production', () => {
  const args = { customOrderId: ref(order), nextStage: 'in_production' };
  const paid = { ...order, fields: { ...order.fields, stage: 'payment_pending', approvalCurrent: true, paymentTiming: 'advance', paymentComplete: true } };
  assert.deepEqual(propose('customOrder.setStage', args, [search(paid)]), { outcome: 'ready', args });
  assert.deepEqual(propose('customOrder.setStage', args, [search(order)]), refusal('invalid_target'));
  assert.deepEqual(propose('customOrder.setStage', args, [search({ ...paid, fields: { ...paid.fields, paymentComplete: false } })]), refusal('widget_only'));
  assert.deepEqual(propose('customOrder.setStage', args, [search({ ...paid, fields: { ...paid.fields, approvalCurrent: false } })]), refusal('invalid_target'));
});

test('N13 cancellation gates distinguish pickups, visits, paid orders and templates', () => {
  const args = { reservationId: ref(pickup) };
  assert.deepEqual(propose('pickup.cancel', args, [search(pickup)]), { outcome: 'ready', args, tier: 'extra-confirm' });
  assert.deepEqual(propose('pickup.cancel', args, [search({ ...pickup, fields: { ...pickup.fields, paymentReversalRequired: true } })]), refusal('widget_only'));
  assert.deepEqual(propose('pickup.cancel', args, [search({ ...pickup, fields: { ...pickup.fields, kind: 'visit' } })]), refusal('invalid_target'));
  assert.deepEqual(propose('pickup.cancel', args, [search({ ...pickup, fields: { kind: 'pickup', status: 'confirmed' } })]), refusal('unavailable'));
  assert.deepEqual(propose('pickup.reschedule', { ...args, date: slot('date'), time: slot('time') }, [search(pickup)]),
    { outcome: 'ready', args: { ...args, date: slot('date'), time: slot('time') } });
  const deleteArgs = { templateId: ref(template) };
  assert.deepEqual(propose('customTemplate.delete', deleteArgs, [search(template)]), { outcome: 'ready', args: deleteArgs, tier: 'extra-confirm' });
  assert.equal(agentCommandPolicy('pickup.cancel', { ...args, confirmedCorrectionQuoteId: slot('quote') }).policy, 'widget-only');
  assert.deepEqual(agentHandoffFields('pickup.cancel', { ...args, confirmedCorrectionQuoteId: slot('quote') }), args);
  assert.equal(agentCommandPolicy('customOrder.openPayment').policy, 'widget-only');
  assert.equal(agentCommandPolicy('customOrder.openRefund').policy, 'widget-only');
});

test('D-326 limits pickup completion to fully paid advance orders ready for handoff', () => {
  const command = 'customOrder.receive';
  const args = { customOrderId: ref(order) };
  const fields = { stage: 'production_complete', approvalCurrent: true, paymentComplete: true, paymentTiming: 'advance' };
  const check = changes => propose(command, args, [search({ ...order, fields: { ...fields, ...changes } })]);
  assert.equal(validateAgentToolArgs('propose_action', { command, args }), true);
  assert.deepEqual(check({}), { outcome: 'ready', args });
  assert.deepEqual(check({ paymentComplete: false }), refusal('widget_only'));
  assert.deepEqual(check({ paymentTiming: 'on_pickup' }), refusal('widget_only'));
  assert.deepEqual(check({ stage: 'in_production' }), refusal('invalid_target'));
});

test('N13 projection sends operational fields and keeps private receipt contents local', () => {
  const request = {
    runId: 'test-run', layer: 'management', snapshotRevision: 0, businessDate: '2026-11-17', slots: ['name'],
    catalog: [], snapshot: [], intent: { kind: 'command', command: 'customOrder.cancel', args: { customOrderId: ref(order) } },
    searches: [{ kind: 'customOrder', querySlot: 'name', matches: [order] }],
  };
  assert.equal(validateAgentRequest(request), true);
  for (const fields of [{ ...order.fields, phone: '01012345678' }, { ...order.fields, request: 'only local' }, { ...order.fields, quoteRevision: -1 }]) {
    assert.equal(validateAgentRequest({ ...request, searches: [{ ...request.searches[0], matches: [{ ...order, fields }] }] }), false);
  }
});

test('N13 generation accepts an empty keyword slot while keeping the product kind required', () => {
  const args = { productKind: slot('productKind'), keywords: slot('keywords') };
  assert.equal(validateAgentCommandArgs('customTemplate.generate', { productKind: '케이크', keywords: '' }), true);
  assert.equal(validateAgentCommandArgs('customTemplate.generate', { productKind: '', keywords: '' }), false);
  assert.deepEqual(propose('customTemplate.generate', args), { outcome: 'ready', args });
});

test('N13 finance refusals route to the widget before calling any model tools', async () => {
  const harness = createNavisNavigationHarness(options => createBridge({
    ...options, agentMode: 'fake', onDiagnostics() {},
  }), validateAgentFrame);
  try {
    const args = { customOrderId: ref(order) };
    for (const command of ['customOrder.openPayment', 'customOrder.openRefund']) {
      const input = navigationRequest(command, args, {
        slots: ['name'], searches: [{ kind: 'customOrder', querySlot: 'name', matches: [order] }],
      });
      const result = await harness.run(input);
      assert.equal(result.outcome, 'refused');
      assert.deepEqual(result.refusal, { reason: 'widget_only', alternative: {
        featureId: 'custom-order', command, draft: args, runId: input.runId, snapshotRevision: input.snapshotRevision,
      } });
    }
  } finally {
    harness.close();
  }
});
