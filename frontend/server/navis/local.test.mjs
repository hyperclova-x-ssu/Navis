import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentNavigationItemKinds, agentNavigationRefs, validateAgentDetailRef, validateAgentFrame, validateAgentNavigationWireArgs,
} from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness } from '../fixtures/navis-eval-fake.mjs';
import { createAgentDomainRegistry } from './registry.mjs';

const lookup = { name: 'search_records', args: { kind: 'localChange', querySlot: 'changeId' } };
const changeId = { handle: 'record-a' };
const inputFor = (command, args = { changeId }) => ({
  intent: { kind: 'command', command, args },
  slots: ['changeId'],
  searches: [{ ...lookup.args, matches: [] }],
});
const match = (folded, handle = changeId.handle, quality = 'exact') => ({ handle, match: quality, fields: { folded } });
const ready = (...matches) => ({ status: 'ready', matches });

for (const [command, folded] of [['localChanges.acknowledge', false], ['localChanges.unacknowledge', true]]) {
  test(`${command} prepares only the exact scoped target in its eligible state`, () => {
    const adapter = createAgentDomainRegistry().get(command);
    assert.ok(adapter);
    const input = inputFor(command);
    assert.deepEqual(adapter.lookups(input), [lookup]);
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(folded))] }), { outcome: 'ready', args: input.intent.args });
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(!folded))] }), { outcome: 'refused', reason: 'duplicate' });
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(undefined))] }), { outcome: 'refused', reason: 'unavailable' });
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(folded, 'another-change'))] }), { outcome: 'refused', reason: 'invalid_target' });
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(folded), match(folded, 'another-change'))] }), {
      outcome: 'ambiguous', lookupIndex: 0, field: 'changeId',
    });
    assert.deepEqual(adapter.prepare({ input, reads: [ready(match(folded, changeId.handle, 'prefix'))] }), {
      outcome: 'ambiguous', lookupIndex: 0, field: 'changeId',
    });
    assert.deepEqual(adapter.prepare({ input, reads: [{ status: 'missing', matches: [] }] }), { outcome: 'refused', reason: 'invalid_target' });
    assert.deepEqual(adapter.prepare({ input, reads: [] }), { outcome: 'refused', reason: 'unavailable' });
    assert.deepEqual(adapter.prepare({ input: inputFor(command, { changeId: 'raw-id' }), reads: [] }), { outcome: 'refused', reason: 'invalid_target' });
    assert.deepEqual(adapter.lookups({ ...input, searches: [{ ...lookup.args, cursor: 'page-2' }] }), []);
  });
}

test('the native fake reads an eligible folded record before preparing a reopen card', async t => {
  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }), validateAgentFrame);
  t.after(harness.close);
  const command = 'localChanges.unacknowledge';
  const input = inputFor(command);
  const base = {
    ...input, runId: 'local-run', snapshotRevision: 7, businessDate: '2026-11-17', layer: 'marketing', snapshot: [],
    catalog: [{ id: 'local-changes', layer: 'marketing', name: '동네 변화', conditions: [{ kind: 'default' }] }],
  };
  for (const folded of [false, true]) {
    const result = await harness.run({ ...base, searches: [{ ...lookup.args, matches: [match(folded)] }] });
    assert.equal(result.terminal.outcome, folded ? 'proposal' : 'refused', result.raw);
    const proposalCall = { name: 'propose_action', args: { command, args: { changeId } } };
    assert.deepEqual(result.calls, folded ? [lookup, proposalCall] : [lookup]);
    if (folded) assert.deepEqual(result.proposal, {
      command, args: { changeId }, tier: 'normal', layer: 'marketing', runId: base.runId,
      snapshotRevision: base.snapshotRevision, proposalId: result.proposal.proposalId,
    });
    else assert.equal(result.proposal, undefined);
  }
});

test('local trend details can carry a scoped handle and preserve the browser-local slot format', () => {
  const command = 'ui.openDetail';
  const ref = { featureId: 'local-trends', view: 'keywords' };
  const wire = { ...ref, itemId: { handle: 'navis-detail-selection' } };
  assert.deepEqual(agentNavigationItemKinds(wire), ['localTrend']);
  assert.deepEqual(agentNavigationRefs(command, wire, 'itemId'), [{ handle: wire.itemId.handle, kinds: ['localTrend'] }]);
  assert.equal(validateAgentNavigationWireArgs(command, { ...ref, itemId: { slot: 'keyword' } }), true);
  assert.equal(validateAgentNavigationWireArgs(command, { ...ref, itemId: 'sample-trend-1' }), false);
  assert.equal(validateAgentDetailRef({ ...ref, itemId: 'sample-trend-1' }), true);
});
