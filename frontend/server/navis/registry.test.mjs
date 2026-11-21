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
