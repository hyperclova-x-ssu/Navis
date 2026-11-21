import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { agentCommandPolicy, validateAgentRequest, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { widgetFixtures } from '../fixtures/widget-drafts.mjs';
import { createAgentDomainRegistry } from './registry.mjs';

const thread = { handle: 'reply-current', match: 'exact', fields: {
  status: 'draft_ready', type: 'message', isPublic: false, revision: 1,
  connected: true, hasDraft: true, canDraft: true, canSend: true,
} };
const offer = { handle: 'offer-current', match: 'exact', fields: {
  status: 'pending', visibility: 'direct', eligible: true, interestSent: false,
} };

function prepare(command, kind, match, args, overrides = {}) {
  const field = kind === 'thread' ? 'threadId' : 'offerId';
  const querySlot = kind === 'thread' ? 'threadQuery' : 'offerQuery';
  const search = { kind, querySlot, matches: [match] };
  const intent = { kind: 'command', command, querySlot, args: { [field]: { handle: match.handle }, ...args } };
  const input = { intent, slots: [querySlot, 'body', 'revision'], searches: [search], ...overrides };
  const adapter = createAgentDomainRegistry().get(command);
  assert.ok(adapter, command);
  assert.deepEqual(adapter.lookups(input), [{ name: 'search_records', args: { kind, querySlot } }]);
  return adapter.prepare({ input, reads: [{ status: 'ready', matches: search.matches }] });
}

const draftBody = { body: { slot: 'body' } };

test('reply proposals require the scoped exact waiting thread and operational evidence', () => {
  assert.equal(prepare('reply.draft', 'thread', thread).outcome, 'ready');
  assert.equal(prepare('inquiry.saveDraft', 'thread', thread, { ...draftBody, revision: { slot: 'revision' } }).outcome, 'ready');
  assert.equal(prepare('inquiry.send', 'thread', thread, draftBody).outcome, 'ready');
  assert.equal(prepare('inquiry.post', 'thread', { ...thread, fields: { ...thread.fields, type: 'review', isPublic: true } }, draftBody).outcome, 'ready');
  for (const fields of [
    { status: 'done' }, { type: 'call' }, { connected: false }, { canSend: false },
    { revision: 0 }, { hasDraft: false }, { canDraft: false },
  ]) {
    const row = { ...thread, fields: { ...thread.fields, ...fields } };
    const command = Object.hasOwn(fields, 'canDraft') ? 'reply.draft' : 'inquiry.send';
    assert.equal(prepare(command, 'thread', row, command === 'reply.draft' ? {} : draftBody).outcome, 'refused');
  }
  assert.equal(prepare('inquiry.post', 'thread', thread, draftBody).outcome, 'refused');
  assert.equal(prepare('inquiry.send', 'thread', thread, { ...draftBody, threadId: { handle: 'another' } }).outcome, 'refused');
});

test('community proposals preserve offer type, expiry and a single response', () => {
  assert.equal(prepare('community.accept', 'offer', offer).outcome, 'ready');
  assert.equal(prepare('community.decline', 'offer', offer).outcome, 'ready');
  const publicOffer = { ...offer, fields: { ...offer.fields, visibility: 'public' } };
  assert.equal(prepare('community.sendInterest', 'offer', publicOffer).outcome, 'ready');
  assert.equal(prepare('community.sendInterest', 'offer', offer).outcome, 'refused');
  assert.equal(prepare('community.accept', 'offer', publicOffer).outcome, 'refused');
  assert.equal(prepare('community.accept', 'offer', { ...offer, fields: { ...offer.fields, eligible: false } }).outcome, 'refused');
  assert.equal(prepare('community.accept', 'offer', { ...offer, fields: { ...offer.fields, status: 'accepted' } }).reason, 'duplicate');
  assert.equal(prepare('community.sendInterest', 'offer', { ...publicOffer, fields: { ...publicOffer.fields, interestSent: true } }).reason, 'duplicate');
});

test('N17 outbound schema accepts one exact target and keeps copy in an opaque slot', () => {
  const args = { threadId: { handle: thread.handle }, ...draftBody };
  assert.equal(agentCommandPolicy('inquiry.send', args).policy, 'propose');
  assert.equal(agentCommandPolicy('inquiry.send').policy, 'widget-only');
  assert.ok(validateAgentToolArgs('propose_action', { command: 'inquiry.send', args }));
  assert.equal(validateAgentToolArgs('propose_action', { command: 'inquiry.send', args: { ...args, body: '원문' } }), false);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'inquiry.send', args: { threadId: args.threadId } }), false);
  assert.equal(validateAgentToolArgs('propose_action', { command: 'community.accept', args: { offerId: [{ handle: offer.handle }] } }), false);
  const request = {
    runId: 'n17-test', snapshotRevision: 0, locale: 'ko', layer: 'marketing', businessDate: '2026-11-17',
    intent: { kind: 'command', command: 'inquiry.send', args, querySlot: 'threadQuery' },
    catalog: [], snapshot: [], slots: ['threadQuery', 'body'],
    searches: [{ kind: 'thread', querySlot: 'threadQuery', matches: [thread] }],
  };
  assert.ok(validateAgentRequest(request));
  const poisoned = { ...thread, fields: { ...thread.fields, sourceText: '손님이 보낸 원문' } };
  assert.equal(validateAgentRequest({ ...request, searches: [{ ...request.searches[0], matches: [poisoned] }] }), false);
});

async function loadData(t) {
  const vite = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    envFile: false, envDir: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
  });
  t.after(() => vite.close());
  return Promise.all([vite.ssrLoadModule('/src/data/widget-data.ts'), vite.ssrLoadModule('/src/data/db/legacy-seed.ts')]);
}

test('draft generation and edited save persist fixture provenance at the current revision', async t => {
  const [{ createWidgetDataStore }, { createLegacySeedTables }] = await loadData(t);
  const inquiryThread = createLegacySeedTables().inquiryThread.filter(row => row.threadId === 'th-2');
  const store = createWidgetDataStore({ inquiryThread });
  const before = store.getSnapshot();
  const generate = { type: 'reply.draft', threadId: 'th-2', idempotencyKey: 'n17-generate' };
  const generated = store.dispatch(generate);
  assert.equal(generated.noticeKey, 'data.notice.replyDraftSaved');
  const fixture = widgetFixtures['ai-response']['th-2'].facts;
  const generatedRow = store.getSnapshot().tables.inquiryThread[0];
  assert.equal(generatedRow.status, 'draft-ready');
  assert.deepEqual(generatedRow.replyDraft, {
    body: fixture.approved[0], sourceText: fixture.original, grounding: [fixture.guidance], revision: 2, origin: 'generated',
  });
  assert.equal(store.dispatch(generate).duplicate, true);
  const edit = { type: 'inquiry.saveDraft', threadId: 'th-2', revision: 2, body: '건물 뒤 2대까지 주차돼요', idempotencyKey: 'n17-edit' };
  assert.equal(store.dispatch({ ...edit, revision: 1, idempotencyKey: 'stale' }).code, 'CONFLICT');
  const edited = store.dispatch(edit);
  assert.ok(edited.ok && edited.undoToken);
  assert.deepEqual(store.getSnapshot().tables.inquiryThread[0].replyDraft, {
    ...generatedRow.replyDraft, body: edit.body, revision: 3, origin: 'edited',
  });
  assert.ok(store.undo(edited.undoToken).ok);
  assert.deepEqual(store.getSnapshot().tables.inquiryThread[0], generatedRow);
  assert.equal(before.tables.inquiryThread[0].replyDraft, undefined);
});

test('the local reply command publishes the exact body and its original fake receipt once', async t => {
  const [{ createWidgetDataStore }, { createLegacySeedTables }] = await loadData(t);
  const { inquiryThread } = createLegacySeedTables();
  const store = createWidgetDataStore({ inquiryThread });
  const snapshot = store.getSnapshot();
  const post = { type: 'inquiry.post', threadId: 'th-4', idempotencyKey: 'n17-post', body: '오래 기다리시게 해서 죄송해요.' };
  assert.equal(store.dispatch(post).ok, false, 'cannot substitute unstored wording');
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(store.dispatch({ type: 'reply.draft', threadId: post.threadId, idempotencyKey: 'n17-review' }).ok, true);
  const receipt = store.dispatch(post);
  assert.equal(receipt.noticeKey, 'data.notice.posted');
  assert.equal(receipt.undoToken, undefined);
  const after = store.getSnapshot();
  assert.equal(after.tables.inquiryThread.find(row => row.threadId === post.threadId).sentReplyBody, post.body);
  assert.equal(store.dispatch(post).duplicate, true);
  assert.equal(store.dispatch({ ...post, idempotencyKey: 'new-key' }).ok, false);
  assert.equal(store.getSnapshot(), after);
});

test('community refuses elapsed pending offers and records one public interest receipt', async t => {
  const [{ createWidgetDataStore, NOW }, { createLegacySeedTables }] = await loadData(t);
  const { partnershipOffer } = createLegacySeedTables();
  const elapsed = { ...partnershipOffer[0], status: 'pending', respondBy: '2026-11-16T18:00' };
  const publicOffer = { ...elapsed, offerId: 'n17-public', visibility: 'public', respondBy: NOW };
  const store = createWidgetDataStore({ partnershipOffer: [elapsed, publicOffer] });
  const snapshot = store.getSnapshot();
  assert.equal(store.dispatch({ type: 'community.accept', offerId: elapsed.offerId }).messageKey, 'data.error.offerExpired');
  assert.equal(store.getSnapshot(), snapshot);
  const command = { type: 'community.sendInterest', offerId: publicOffer.offerId, idempotencyKey: 'n17-interest' };
  assert.equal(store.dispatch(command).noticeKey, 'data.notice.interestSent');
  assert.equal(store.dispatch(command).duplicate, true);
  assert.equal(store.dispatch({ ...command, idempotencyKey: 'another-attempt' }).ok, false);
  assert.deepEqual(store.getSnapshot().tables.offerInterest, [{ offerId: publicOffer.offerId, sentAt: NOW }]);
});
