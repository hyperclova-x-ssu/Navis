import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navigationRequest } from '../fixtures/navis-eval-fake.mjs';
import { validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { createMoneyAdapters } from './money.mjs';

const lookup = (kind, querySlot) => ({ name: 'search_records', args: { kind, querySlot } });
const target = { handle: 'target' };
const slot = name => ({ slot: name });
const search = (kind, querySlot, fields, handle = target.handle) => ({
  kind, querySlot, matches: [{ handle, match: 'exact', fields }],
});

async function withBridge(command, args, { searches = [], slots = [], querySlot, options } = {}) {
  const harness = createNavisMenuHarness(options
    ? input => createBridge({ ...input, agentAdapters: createMoneyAdapters(options) })
    : createBridge, validateAgentFrame);
  try {
    return await harness.run(navigationRequest(command, args, {
      searches, slots, intent: { kind: 'command', command, args, ...(querySlot && { querySlot }) },
    }));
  } finally {
    harness.close();
  }
}

test('N11 confirms only the exact scoped open expense candidate', async () => {
  const args = { expenseId: target };
  const options = { slots: ['candidate'], querySlot: 'candidate' };
  const evidence = status => search('candidate', 'candidate', { status, amount: 28_000, date: '2026-11-17' });
  const ready = await withBridge('ledger.confirmCandidate', args, { ...options, searches: [evidence('candidate')] });
  assert.equal(ready.status, 200, ready.raw);
  assert.equal(ready.terminal.outcome, 'proposal', ready.raw);
  assert.deepEqual(ready.calls, [lookup('candidate', 'candidate'), { name: 'propose_action', args: { command: 'ledger.confirmCandidate', args } }]);
  assert.equal(ready.proposal.tier, 'normal');
  const closed = await withBridge('ledger.confirmCandidate', args, { ...options, searches: [evidence('confirmed')] });
  assert.equal(closed.terminal?.refusal?.reason, 'invalid_target', closed.raw);
  assert.equal(closed.proposal, undefined);
});

test('D-326 proposes an edit for one open expense and hands closed days to the ledger', async () => {
  const command = 'ledger.updateExpense';
  const args = { expenseId: target, amount: slot('amount') };
  const run = closed => withBridge(command, args, {
    querySlot: 'name', slots: ['name', 'amount'],
    searches: [search('expense', 'name', { date: '2026-11-16', status: 'confirmed', closed })],
  });
  const open = await run(false);
  assert.equal(open.terminal?.outcome, 'proposal', open.raw);
  assert.deepEqual(open.calls, [lookup('expense', 'name'), { name: 'propose_action', args: { command, args } }]);
  const closed = await run(true);
  assert.equal(closed.terminal?.refusal?.reason, 'widget_only', closed.raw);
  assert.deepEqual(closed.calls, [lookup('expense', 'name')]);
});

test('N11 rejects substituted and ambiguous tax targets before requesting a proposal', async () => {
  const args = { taxPaymentId: target, patch: { amount: slot('amount') } };
  const options = { slots: ['taxPayment', 'amount'], querySlot: 'taxPayment' };
  const fields = { status: 'paid', amount: 2000, evidence: 'example', date: '2026-11-10', paidOn: '2026-11-09' };
  const records = search('taxPayment', 'taxPayment', fields, 'different');
  const bad = await withBridge('tax.updatePayment', args, { ...options, searches: [records] });
  assert.equal(bad.terminal?.refusal?.reason, 'invalid_target', bad.raw);
  assert.deepEqual(bad.calls, [lookup('taxPayment', 'taxPayment')]);

  const ambiguous = await withBridge('tax.updatePayment', args, {
    ...options, searches: [{ ...records, matches: [...records.matches, { handle: target.handle, match: 'exact', fields }] }],
  });
  assert.equal(ambiguous.terminal.outcome, 'ambiguous', ambiguous.raw);
  assert.deepEqual(ambiguous.terminal.clarification.choices.map(choice => choice.handle), ['different', 'target']);
  assert.equal(ambiguous.proposal, undefined);
});

test('N11 tax evidence removal emits neither a proposal nor prefill', async () => {
  const result = await withBridge('tax.setEvidence', { taxPaymentId: target, evidence: 'none' }, {
    slots: ['taxPayment'], querySlot: 'taxPayment', searches: [search('taxPayment', 'taxPayment', { evidence: 'example' })],
  });
  assert.deepEqual(result.terminal?.refusal, { reason: 'widget_only' });
  assert.deepEqual(result.calls, []);
  assert.equal(result.proposal, undefined);
});

test('N11 checks exact tax review eligibility and keeps paid corrections widget-only', async () => {
  const options = { slots: ['taxItem'], querySlot: 'taxItem', searches: [
    search('taxItem', 'taxItem', { status: 'needs-check', date: '2026-11-17', amount: 30_000 }),
  ] };
  const review = await withBridge('tax.markChecked', { refId: target }, options);
  assert.equal(review.terminal?.outcome, 'proposal', review.raw);
  const checked = await withBridge('tax.markChecked', { refId: target }, {
    ...options, searches: [search('taxItem', 'taxItem', { status: 'checked' })],
  });
  assert.equal(checked.terminal?.refusal?.reason, 'invalid_target', checked.raw);
  assert.equal(checked.proposal, undefined);

  const paid = await withBridge('tax.updatePayment', { taxPaymentId: target, patch: { status: 'paid', paidOn: slot('paidOn') } }, { slots: ['paidOn'] });
  assert.equal(paid.terminal?.refusal?.reason, 'widget_only', paid.raw);
  assert.equal(paid.terminal.refusal.alternative.featureId, 'tax');
  assert.deepEqual(paid.calls, []);

  const mark = await withBridge('tax.markPaid', { taxPaymentId: target }, {
    slots: ['taxPayment'], searches: [search('taxPayment', 'taxPayment', { status: 'unpaid' })],
  });
  assert.equal(mark.terminal?.refusal?.reason, 'widget_only', mark.raw);
  assert.equal(mark.terminal.refusal.alternative.featureId, 'tax');
  assert.deepEqual(mark.terminal.refusal.alternative.draft, { taxPaymentId: target });
  assert.equal(mark.proposal, undefined);
  assert.deepEqual(mark.calls, []);
});

test('N11 asks the scoped tax-type lookup before proposing a planned payment', async () => {
  const args = { taxType: slot('taxType'), amount: slot('amount'), dueOn: slot('dueOn') };
  const slots = ['taxType', 'amount', 'dueOn'];
  const ready = await withBridge('tax.createPayment', args, { slots, searches: [{ kind: 'taxPayment', querySlot: 'taxType', matches: [], status: 'missing' }] });
  assert.equal(ready.terminal?.outcome, 'proposal', ready.raw);
  assert.deepEqual(ready.calls, [lookup('taxPayment', 'taxType'), { name: 'propose_action', args: { command: 'tax.createPayment', args } }]);
  const missingScope = await withBridge('tax.createPayment', args, { slots });
  assert.equal(missingScope.terminal?.refusal?.reason, 'unavailable', missingScope.raw);
  assert.equal(missingScope.proposal, undefined);
});

test('N11 explicit opt-outs offer the ledger or tax widget without a card', async () => {
  for (const [command, args, slots, featureId] of [
    ['ledger.recordExpense', { date: slot('date'), category: 'supplies', amount: slot('amount') }, ['date', 'amount'], 'ledger'],
    ['tax.deletePayment', { taxPaymentId: target }, [], 'tax'],
  ]) {
    const result = await withBridge(command, args, { slots, options: { allowExpenseEntry: false, allowTaxDelete: false } });
    assert.equal(result.terminal?.refusal?.reason, 'widget_only', result.raw);
    assert.equal(result.terminal.refusal.alternative.featureId, featureId);
    assert.equal(result.proposal, undefined);
    assert.deepEqual(result.calls, []);
  }
});

test('N11 opens existing ledger and tax forms with scoped draft values', async () => {
  for (const [featureId, view, prefill] of [
    ['ledger', 'expenses', { category: 'supplies', amount: slot('amount') }],
    ['tax', 'payments', { taxType: slot('taxType'), dueOn: slot('dueOn') }],
  ]) {
    const args = { featureId, view, focus: 'action', prefill };
    const response = await withBridge('ui.openDetail', args, { slots: ['amount', 'taxType', 'dueOn'] });
    assert.equal(response.terminal.outcome, 'navigate', response.raw);
    assert.deepEqual(response.terminal.navigation.args, args);
    assert.deepEqual(response.calls, []);
    assert.equal(response.proposal, undefined);
  }
});

test('N11 permits only an unpaid tax deletion and demands the extra card confirmation', async () => {
  const args = { taxPaymentId: target };
  for (const status of ['unpaid', 'paid']) {
    const result = await withBridge('tax.deletePayment', args, {
      slots: ['taxPayment'], searches: [search('taxPayment', 'taxPayment', { status })],
    });
    if (status === 'unpaid') {
      assert.equal(result.terminal.outcome, 'proposal', result.raw);
      assert.equal(result.proposal.tier, 'extra-confirm');
    } else {
      assert.equal(result.terminal.refusal.reason, 'widget_only', result.raw);
      assert.equal(result.proposal, undefined);
    }
  }
});

test('N11 expense entry cannot bind a supplier outside its projected search', async () => {
  const args = { date: slot('date'), amount: slot('amount'), category: 'ingredients', evidence: 'tax-invoice', supplierId: target };
  const slots = ['date', 'amount', 'supplier'];
  const reply = await withBridge('ledger.recordExpense', args, {
    slots, searches: [search('supplier', 'supplier', {})],
  });
  assert.equal(reply.terminal.outcome, 'proposal', reply.raw);
  assert.deepEqual(reply.proposal.args, args);
  const unscoped = await withBridge('ledger.recordExpense', args, { slots });
  assert.equal(unscoped.terminal.refusal.reason, 'unavailable', unscoped.raw);
  assert.equal(unscoped.proposal, undefined);
});

test('N11 asks for expense evidence when the client leaves it unset', async () => {
  const args = { date: slot('date'), amount: slot('amount'), category: 'supplies' };
  const slots = ['date', 'amount'];
  const missing = await withBridge('ledger.recordExpense', args, { slots });
  assert.equal(missing.terminal?.clarification?.field, 'evidence', missing.raw);
  assert.equal(missing.proposal, undefined);
  const knownNone = await withBridge('ledger.recordExpense', { ...args, evidence: 'none' }, { slots });
  assert.equal(knownNone.proposal?.args.evidence, 'none', knownNone.raw);
});

test('N11 tax creation cannot smuggle the direct-app duplicate override through the model', async () => {
  const result = await withBridge('tax.createPayment', {
    taxType: slot('taxType'), amount: slot('amount'), dueOn: slot('dueOn'), confirmDuplicate: true,
  }, { slots: ['taxType', 'amount', 'dueOn'] });
  assert.equal(result.status, 400);
  assert.deepEqual(result.calls, []);
});
