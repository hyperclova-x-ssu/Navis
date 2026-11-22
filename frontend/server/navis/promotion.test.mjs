import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../bridge.mjs';
import {
  createNavisMenuHarness, navisAgentFakeFetch, navigationRequest, reading,
} from '../fixtures/navis-eval-fake.mjs';
import {
  agentCommandPolicy, validateAgentCommandArgs, validateAgentFrame, validateAgentToolArgs,
} from '../../shared/navis-agent-schema.mjs';

const fields = ['menuIds', 'photoIds', 'moods', 'concepts', 'memo'];
const makeArgs = {
  ...Object.fromEntries(fields.map(field => [field, { slot: field }])),
  referenceId: 'ref-2', lengthSec: 15, locale: 'ko',
};
const markArgs = { videoId: { handle: 'video-handle' }, route: 'clip' };
const reachArgs = { groupId: 'churn-risk', body: { slot: 'body' } };

function harness(t) {
  const bridge = createNavisMenuHarness(
    options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch,
  );
  t.after(bridge.close);
  return bridge;
}

function makeInput(busy) {
  return navigationRequest('video.make', makeArgs, {
    slots: fields,
    readings: busy === undefined ? [] : [reading('get_promotion_preflight', { action: 'make' }, { 'promo.video.busy': busy })],
  });
}

function reachInput(count) {
  return navigationRequest('coupon.sendReachOut', reachArgs, {
    slots: ['body'],
    readings: count === undefined ? [] : [reading('get_promotion_preflight', { action: 'reach-out' }, { 'groups.reachOut.eligibleCount': count })],
  });
}

function markInput(status, handle = markArgs.videoId.handle) {
  return navigationRequest('video.markPosted', markArgs, {
    slots: ['videoId'],
    searches: [{ kind: 'promoVideo', querySlot: 'videoId', matches: [{ handle, match: 'exact', fields: { status } }] }],
  });
}

test('N18 approval schemas bind full widget inputs and preserve legacy handoffs', () => {
  for (const [command, args, tier] of [
    ['video.markPosted', markArgs, 'extra-confirm'],
    ['coupon.sendReachOut', reachArgs, 'normal'],
    ['promo.draft.set', { memo: { slot: 'memo' } }, 'normal'],
    ['video.make', makeArgs, 'normal'],
  ]) {
    assert.equal(agentCommandPolicy(command, args).policy, 'propose');
    assert.equal(agentCommandPolicy(command, args).confirmation, tier);
    assert.equal(validateAgentToolArgs('propose_action', { command, args }), true);
  }
  for (const [command, args] of [
    ['video.make', {}], ['video.make', { lengthSec: 15 }], ['video.retry', {}], ['video.markPosted', { route: 'clip' }],
    ['coupon.sendReachOut', {}], ['coupon.sendReachOut', { groupId: 'regular' }],
    ['coupon.sendReachOut', { groupId: 'churn-risk', sendAt: { slot: 'sendAt' } }],
  ]) assert.equal(agentCommandPolicy(command, args).policy, 'widget-only');
  for (const [command, args] of [
    ['video.make', { ...makeArgs, memo: 'Raw memo' }], ['video.make', { ...makeArgs, lengthSec: 20 }],
    ['video.markPosted', { videoId: 'raw-video-id', route: 'tiktok' }],
    ['coupon.sendReachOut', { ...reachArgs, recipientIds: { slot: 'recipientIds' } }],
  ]) assert.equal(validateAgentToolArgs('propose_action', { command, args }), false);
  assert.equal(validateAgentCommandArgs('promo.draft.set', { memo: '' }), true);
  assert.equal(validateAgentCommandArgs('promo.draft.set', { memo: '가'.repeat(101) }), false);
});

test('D-329 bridge proposes a complete draft only with a clear make preflight', async t => {
  const { run } = harness(t);
  const ready = await run(makeInput(0));
  assert.equal(ready.terminal.outcome, 'proposal', ready.raw);
  assert.deepEqual(ready.calls.map(call => call.name), ['get_promotion_preflight', 'propose_action']);
  assert.deepEqual(ready.calls.at(-1).args, { command: 'video.make', args: makeArgs });
  for (const busy of [1, undefined, -1, 1.5]) {
    const { terminal, calls, raw } = await run(makeInput(busy));
    assert.equal(terminal.outcome, 'refused', raw);
    assert.ok(calls.every(call => call.name !== 'propose_action'));
  }
  const incomplete = await run(navigationRequest('video.make', { lengthSec: 15 }));
  assert.equal(incomplete.terminal.refusal.reason, 'widget_only');
  assert.equal(incomplete.terminal.refusal.alternative.featureId, 'promo-video');
  assert.deepEqual(incomplete.calls, []);
});

test('N18 marking needs an exact finished video and emits an extra-confirm card', async t => {
  const { run } = harness(t);
  const { terminal, calls, raw } = await run(markInput('done'));
  assert.equal(terminal.outcome, 'proposal', raw);
  assert.deepEqual(calls.map(({ name }) => name), ['search_records', 'propose_action']);
  assert.match(raw, /"tier":"extra-confirm"/u);
  for (const input of [markInput('making'), markInput('posted'), markInput('done', 'different-handle')]) {
    const blocked = await run(input);
    assert.equal(blocked.terminal.outcome, 'refused', blocked.raw);
    assert.ok(blocked.calls.every(call => call.name !== 'propose_action'));
  }
  const ambiguous = markInput('done');
  ambiguous.searches[0].matches.push({ handle: 'other-video', match: 'exact', fields: { status: 'done' } });
  const other = await run(ambiguous);
  assert.equal(other.terminal.outcome, 'ambiguous');
  assert.equal(other.terminal.clarification.field, 'videoId');
  assert.ok(other.calls.every(call => call.name !== 'propose_action'));
});

test('N18 reach-out requires at least one eligible recipient and leaves message text local', async t => {
  const { run } = harness(t);
  const { terminal, calls, raw } = await run(reachInput(3));
  assert.equal(terminal.outcome, 'proposal', raw);
  assert.deepEqual(calls.map(({ name }) => name), ['get_promotion_preflight', 'propose_action']);
  assert.deepEqual(calls.at(-1).args, { command: 'coupon.sendReachOut', args: reachArgs });
  for (const count of [0, undefined, -1, 1.5]) {
    const blocked = await run(reachInput(count));
    assert.equal(blocked.terminal.outcome, 'refused', blocked.raw);
    assert.ok(blocked.calls.every(call => call.name !== 'propose_action'));
  }
});

test('D-328 retry proposes only a scoped failed video with no active job', async t => {
  const { run } = harness(t);
  const args = { videoId: { handle: 'video-handle' } };
  assert.equal(validateAgentToolArgs('propose_action', { command: 'video.retry', args }), true);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'video.retry', args: { ...args, lengthSec: 15 } }), false);
  const request = (status, busy, handle = args.videoId.handle) => navigationRequest('video.retry', args, {
    slots: ['videoId'],
    searches: [{ kind: 'promoVideo', querySlot: 'videoId', matches: [{ handle, match: 'exact', fields: { status } }] }],
    readings: busy === undefined ? [] : [reading('get_promotion_preflight', { action: 'make' }, { 'promo.video.busy': busy })],
  });
  const accepted = await run(request('failed', 0));
  assert.equal(accepted.terminal.outcome, 'proposal', accepted.raw);
  assert.deepEqual(accepted.calls.map(call => call.name), ['search_records', 'get_promotion_preflight', 'propose_action']);
  for (const input of [request('failed', 1), request('failed', undefined), request('making', 0), request('done', 0), request('posted', 0), request('failed', 0, 'other')]) {
    const blocked = await run(input);
    assert.equal(blocked.terminal.outcome, 'refused', blocked.raw);
    assert.ok(blocked.calls.every(call => call.name !== 'propose_action'));
  }
});
