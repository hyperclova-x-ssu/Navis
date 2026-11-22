import assert from 'node:assert/strict';
import test from 'node:test';
import * as registry from './registry.mjs';

test('registry binds injected adapters to a unique allowed command and blocks widget-only commands', () => {
  const adapter = { command: 'menu.update', prepare: () => ({ outcome: 'ready', args: {} }) };
  const domains = registry.createAgentDomainRegistry([adapter]);
  assert.equal(domains.get('menu.update').prepare, adapter.prepare);
  assert.equal(domains.get('menu.delete'), undefined);
  assert.throws(() => registry.createAgentDomainRegistry([adapter, adapter]), /Duplicate/);
  assert.throws(() => registry.createAgentDomainRegistry([{ ...adapter, command: 'tax.markPaid' }]), /Invalid/);
  assert.throws(() => registry.createAgentDomainRegistry([{ command: 'menu.create' }]), /Invalid/);
});

test('target resolution prefers exact results and does not auto-select a similar match', () => {
  const exact = { handle: 'one', match: 'exact' };
  const similar = { handle: 'two', match: 'similar' };
  assert.deepEqual(registry.resolveAgentTarget({ status: 'ready', matches: [similar, exact] }), { match: exact });
  assert.deepEqual(registry.resolveAgentTarget({ status: 'ready', matches: [similar] }), { choices: [similar] });
  assert.deepEqual(registry.resolveAgentTarget({ status: 'ready', matches: [exact], nextCursor: 'page2' }), { choices: [exact] });
  assert.deepEqual(registry.resolveAgentTarget({ status: 'missing', matches: [] }), { choices: [] });
});
test('resolves card policies to the widget HTTP command without changing confirmation', async () => {
  const { realCommandFor } = await import('./registry.mjs');
  assert.deepEqual(realCommandFor('promo.draft.set'), { domain: 'promo', command: 'promo.saveDraft' });
  assert.deepEqual(realCommandFor('customOrder.cancel', { customOrderId: 'order-1' }), { domain: 'custom', command: 'customOrder.cancel' });
  assert.deepEqual(realCommandFor('coupon.endEarly'), { domain: 'coupons', command: 'coupon.endEarly' });
  assert.deepEqual(realCommandFor('inquiry.post'), { domain: 'inbox', command: 'inquiry.post' });
  assert.equal(realCommandFor('customOrder.cancel', { confirmedCorrectionQuoteId: 'quote-1' }), undefined);
  assert.equal(realCommandFor('tax.setEvidence', { evidence: 'example' }), undefined);
  assert.equal(realCommandFor('members.toString'), undefined);
});
