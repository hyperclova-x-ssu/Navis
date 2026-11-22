import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentConversation, normalizeConversationTurn } from './conversation.mjs';
import { validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';

const scope = { runId: 'run-a', layer: 'management', page: 1, snapshotRevision: 8, slots: [], searches: [] };
const proposal = {
  ...scope, proposalId: 'proposal-a', command: 'menu.create', tier: 'normal',
  args: { name: { slot: 'name' }, category: 'drink', price: { slot: 'price' } },
};
const read = { kind: 'read', featureId: 'menu' };
const control = (action, args = {}) => ({ kind: 'conversation', action, ...args });

test('typed agreement and a read preserve the card for a single card confirmation', () => {
  const conversation = createAgentConversation();
  conversation.remember(scope, { proposal });
  conversation.remember(scope, { read });
  const typed = normalizeConversationTurn('응', { pending: true });
  assert.deepEqual(typed, { kind: 'hold' });
  assert.deepEqual(conversation.resolve(scope, control(typed.kind)), { type: 'hold' });
  const click = control('confirm', { pendingId: proposal.proposalId });
  assert.deepEqual(conversation.resolve(scope, click), { type: 'confirm', pendingId: proposal.proposalId });
  assert.deepEqual(conversation.resolve(scope, click), { type: 'unavailable', reason: 'pending_missing' });
});

test('a period follow-up retains ordered compiled reads and the unrelated pending card', () => {
  const conversation = createAgentConversation();
  const input = { ...scope, businessDate: '2026-10-26' };
  const compiled = { kind: 'read', reads: [
    { name: 'get_widget', args: { featureId: 'ledger' } },
    { name: 'get_source', args: { sourceId: 'pos' } },
  ] };
  conversation.remember(input, { proposal });
  conversation.remember(input, { read: compiled });
  const expected = { kind: 'dateRange', start: '2026-10-25', end: '2026-10-25' };
  assert.deepEqual(conversation.resolve(input, control('repeat_read', { period: 'yesterday' })), {
    type: 'read', intent: { kind: 'read', reads: [
      { name: 'get_widget', args: { featureId: 'ledger', condition: expected } },
      { name: 'get_source', args: { sourceId: 'pos', condition: expected } },
    ] },
  });
  assert.deepEqual(conversation.resolve(input, control('confirm', { pendingId: proposal.proposalId })),
    { type: 'confirm', pendingId: proposal.proposalId });
});

test('stale confirmation requires a new proposal and discards the old authorization', () => {
  const conversation = createAgentConversation();
  conversation.remember(scope, { proposal });
  const yes = control('confirm', { pendingId: proposal.proposalId });
  assert.deepEqual(conversation.resolve({ ...scope, snapshotRevision: 9 }, yes), {
    type: 'reprepare', pendingId: proposal.proposalId, command: 'menu.create',
  });
  assert.equal(conversation.resolve(scope, yes).reason, 'pending_missing');
});

test('a delete needs a bound target and a separate confirmation challenge', () => {
  const conversation = createAgentConversation({ makeId: () => 'extra-a' });
  conversation.remember(scope, {
    proposal: { ...proposal, command: 'menu.delete', tier: 'extra-confirm', args: { menuId: { handle: 'chosen-menu' } } },
  });
  const yes = control('confirm', { pendingId: proposal.proposalId });
  assert.equal(conversation.resolve(scope, yes).reason, 'target_required');
  const named = { ...yes, target: 'chosen-menu' };
  assert.deepEqual(conversation.resolve(scope, named), { type: 'extra_confirm', pendingId: proposal.proposalId, challengeId: 'extra-a' });
  assert.equal(conversation.resolve(scope, named).type, 'extra_confirm');
  const second = control('confirm_extra', { pendingId: proposal.proposalId, challengeId: 'extra-a' });
  assert.equal(conversation.resolve({ ...scope, runId: 'other' }, second).reason, 'pending_missing');
  assert.equal(conversation.resolve(scope, { ...second, challengeId: 'wrong' }).reason, 'target_required');
  assert.equal(conversation.resolve(scope, second).type, 'confirm');
  assert.equal(conversation.resolve(scope, second).reason, 'pending_missing');
});

test('clarification survives reads, undo prefers the pending cancel action, and expiration offers a widget', () => {
  let now = 100;
  const receipt = {
    id: 'receipt-a', target: 'data', command: 'menu.create', runId: scope.runId, revision: 8, expiresAt: 6100,
  };
  const conversation = createAgentConversation({ clock: { now: () => now }, getUndoReceipts: () => [receipt] });
  conversation.remember(scope, { clarification: { id: 'question', field: 'price', command: 'menu.create' } });
  conversation.remember(scope, { read });
  assert.deepEqual(conversation.resolve(scope, control('continue', { pendingId: 'question' })), {
    type: 'continue', pendingId: 'question', field: 'price',
  });
  assert.deepEqual(conversation.resolve(scope, control('undo', { pendingId: 'question' })), {
    type: 'cancel', pendingId: 'question',
  });
  assert.deepEqual(conversation.resolve(scope, control('undo')), { type: 'undo', receiptId: 'receipt-a', target: 'data' });
  now = receipt.expiresAt;
  assert.deepEqual(conversation.resolve(scope, control('undo')), {
    type: 'unavailable', reason: 'undo_expired', featureId: 'menu',
  });
});

test('record choices use stated order and require current projection scope', () => {
  const record = (handle, label) => ({ handle, label, match: 'exact' });
  const search = { kind: 'menu', querySlot: 'name', matches: [record('first', 'Sample A'), record('second', 'Sample B')] };
  const input = { ...scope, searches: [search] };
  const conversation = createAgentConversation();
  conversation.remember(input, { read, searches: [search] });
  assert.deepEqual(conversation.resolve(input, control('refer', { recordKind: 'menu', ordinal: 2 })), {
    type: 'record', recordKind: 'menu', querySlot: 'name', handle: 'second',
  });
  assert.equal(conversation.resolve(input, control('refer', { recordKind: 'menu' })).type, 'choose');
  assert.equal(conversation.resolve({ ...input, snapshotRevision: 9 }, control('refer', { ordinal: 2 })).reason, 'reference_missing');
  assert.equal(conversation.resolve({ ...input, searches: [{ ...search, matches: [search.matches[1]] }] },
    control('refer', { ordinal: 1 })).reason, 'reference_missing');
});

test('the latest matching store receipt supersedes older or prohibited undo', () => {
  const current = {
    runId: scope.runId, target: 'data', command: 'menu.create', id: 'active', revision: 8, expiresAt: 6_000,
  };
  const receipts = [
    { ...current, id: 'older', revision: 7 },
    { ...current, id: 'foreign', runId: 'other' },
    { ...current, id: 'closing', command: 'closing.closeDay' },
    { ...current, id: 'payment', command: 'pos.payment' },
    current,
  ];
  const conversation = createAgentConversation({ clock: { now: () => 10 }, getUndoReceipts: () => receipts });
  assert.deepEqual(conversation.resolve(scope, control('undo')), { type: 'undo', receiptId: 'active', target: 'data' });
  current.consumed = true;
  assert.equal(conversation.resolve(scope, control('undo')).reason, 'undo_unavailable');
  assert.equal(conversation.resolve({ ...scope, snapshotRevision: 7 }, control('undo')).reason, 'undo_unavailable');
});

test('the wire rejects local authorization tokens and unbounded control fields', () => {
  const request = { ...scope, businessDate: '2026-10-26', catalog: [], snapshot: [] };
  const undo = control('undo');
  assert.equal(validateAgentRequest({ ...request, intent: undo }), true);
  assert.equal(validateAgentRequest({ ...request, intent: { ...undo, token: 'local-only' } }), false);
  assert.equal(validateAgentRequest({ ...request, intent: control('confirm') }), false);
  assert.equal(validateAgentRequest({ ...request, intent: control('refer', { ordinal: 6 }) }), false);
  const resolution = { type: 'undo', receiptId: 'current', target: 'data' };
  assert.equal(validateAgentFrame('done', { outcome: 'conversation', resolution }), true);
  assert.equal(validateAgentFrame('done', { outcome: 'conversation', resolution: { ...resolution, token: 'local-only' } }), false);
});

test('control parser handles ASR, punctuation and mixed edits without inferring consent', () => {
  const classify = text => normalizeConversationTurn(text, { pending: true });
  assert.equal(classify('ㅇㅋ').kind, 'hold');
  assert.equal(classify('확인 확인').kind, 'hold');
  assert.equal(classify('네 삭제해').kind, 'hold');
  assert.equal(classify('응? 아니 잠깐').kind, 'hold');
  assert.equal(classify('응 근데 5천원으로').kind, 'edit');
  assert.equal(classify('응! 오늘 매출은?').kind, 'read');
  assert.equal(classify('방금 거 다시').kind, 'repeat_command');
  assert.equal(classify('두 번째 거').ordinal, 2);
  assert.equal(classify('a'.repeat(4001)).reason, 'too_long');
  assert.equal(classify('오늘 장사 얼마나 됐드래요?').featureId, 'ledger');
});
