import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import {
  agentCommandPolicy, validateAgentFrame, validateAgentToolArgs,
} from '../../shared/navis-agent-schema.mjs';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';

const slot = slot => ({ slot });
const handle = handle => ({ handle });
const send = { noticeId: handle('draft'), draftRevision: slot('draftRevision') };
const search = { kind: 'noticeDraft', querySlot: 'noticeQuery' };
const draftFields = { revision: 1, businessTime: '15:45', sendAllowed: true, closureLink: 'current', alreadySent: false };
const sendIntent = { kind: 'command', command: 'notice.send', args: send, querySlot: search.querySlot };
const searchCall = { name: 'search_records', args: search };
const proposalCall = { name: 'propose_action', args: { command: 'notice.send', args: send } };
const request = (fields = draftFields, intent = sendIntent) => ({
  runId: 'n15-test', snapshotRevision: 1, businessDate: '2026-11-17',
  layer: 'marketing', locale: 'ko', intent,
  slots: ['noticeQuery', 'draftRevision', 'sendAt'],
  catalog: [{ id: 'notice-send', name: '공지 발송', layer: 'marketing', conditions: [{ kind: 'default' }] }],
  searches: [{ ...search, matches: [{ ...handle('draft'), match: 'exact', fields }] }],
  snapshot: [],
});

test('only an existing draft and its local revision may appear in a notice send proposal', () => {
  assert.equal(agentCommandPolicy('notice.send').policy, 'widget-only');
  assert.equal(validateAgentToolArgs('propose_action', proposalCall.args), true);
  for (const args of [{}, { ...send, draftRevision: 1 }, { ...send, previewId: slot('previewId') }, { ...send, body: slot('body') }]) {
    assert.equal(validateAgentToolArgs('propose_action', { command: 'notice.send', args }), false);
  }
});

test('the fake bridge prepares one send card after reading eligible, current and unsent draft evidence', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const result = await harness.run(request());
  assert.equal(result.terminal.outcome, 'proposal', result.raw);
  assert.deepEqual(result.calls, [searchCall, proposalCall]);
  assert.equal(result.proposal.tier, 'normal');
});

test('D-326 prepares a daytime notice schedule with a local time slot and blocks an ineligible schedule', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const args = { ...send, sendAt: slot('sendAt') };
  const intent = { ...sendIntent, args };
  const fields = { ...draftFields, sendAllowed: false, scheduleAllowed: true };
  const result = await harness.run(request(fields, intent));
  assert.equal(result.terminal?.outcome, 'proposal', result.raw);
  assert.deepEqual(result.calls, [searchCall, { name: 'propose_action', args: { command: 'notice.send', args } }]);
  const sameDay = await harness.run(request({ ...draftFields, scheduleAllowed: false }, intent));
  assert.equal(sameDay.terminal?.outcome, 'proposal', sameDay.raw);
  const blocked = await harness.run(request({ ...fields, scheduleAllowed: false }, intent));
  assert.equal(blocked.terminal?.refusal?.reason, 'invalid_target', blocked.raw);
  assert.deepEqual(blocked.calls, [searchCall]);
});

test('the server refuses an immediate send at 22:30 even if eligibility says it can send', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const result = await harness.run(request({ ...draftFields, businessTime: '22:30' }));
  assert.equal(result.terminal?.refusal?.reason, 'invalid_target', result.raw);
  assert.deepEqual(result.calls, [searchCall]);
});

test('the send adapter refuses stale, ineligible, unknown and already sent drafts', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  for (const fields of [{ closureLink: 'changed' }, { sendAllowed: false }, { alreadySent: true }, { revision: undefined }]) {
    const result = await harness.run(request({ ...draftFields, ...fields }));
    assert.equal(result.terminal.outcome, 'refused', result.raw);
    assert.deepEqual(result.calls, [searchCall]);
  }
  const wrongHandle = await harness.run(request(draftFields, { ...sendIntent, args: { ...send, noticeId: handle('unseen') } }));
  assert.equal(wrongHandle.terminal.outcome, 'refused', wrongHandle.raw);
});

test('closure import uses only an exact direct closure event', async t => {
  const harness = createNavisMenuHarness(createBridge, validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const intent = { kind: 'command', command: 'notice.importClosure', args: { eventId: handle('event') } };
  const query = { kind: 'event', querySlot: 'eventQuery' };
  const scoped = { ...request(), intent, slots: ['eventQuery'] };
  const run = fields => harness.run({ ...scoped,
    searches: [{ ...query, matches: [{ handle: 'event', match: 'exact', fields }] }],
  });
  for (const fields of [{ source: 'direct', closure: false }, { source: 'shift', closure: true }]) {
    const result = await run(fields);
    assert.equal(result.terminal.outcome, 'refused', result.raw);
    assert.deepEqual(result.calls, [{ name: 'search_records', args: query }]);
  }
  const result = await run({ source: 'direct', closure: true });
  assert.equal(result.terminal.outcome, 'proposal', result.raw);
  assert.deepEqual(result.calls.at(-1), { name: 'propose_action', args: { command: intent.command, args: intent.args } });
});

test('the pure notice preview classifies unsaved copy and returns no preview authority or recipient identities', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    envFile: false, envDir: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false } });
  try {
    const [data, guards] = await Promise.all([
      vite.ssrLoadModule('/src/data/widget-data.ts'),
      vite.ssrLoadModule('/src/data/commands/notice-guard.ts'),
    ]);
    const store = data.createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const draft = { kind: 'other', title: '쿠폰 행사', body: '10% 할인', startDate: data.TODAY, endDate: data.TODAY,
      audience: 'group', groupIds: ['regular'] };
    const result = guards.previewNotice(snapshot, { draft });
    assert.equal(result.ok, true);
    assert.equal(result.preview.contentClass, 'promotional');
    assert.match(result.preview.renderedBody, /^\(광고\)\n쿠폰 행사\n10% 할인/u);
    assert.equal(result.preview.adMarker, true);
    assert.equal(result.preview.recipientCount, 151);
    assert.equal(result.preview.excludedCount, 99);
    const night = guards.previewNotice(snapshot, { draft }, `${data.TODAY}T21:00`);
    assert.equal(night.ok, true);
    assert.equal(night.preview.sendAllowed, false);
    assert.deepEqual(night.preview.reasons, ['AD_NIGHT_RESTRICTED']);
    const noGroup = guards.previewNotice(snapshot, { draft: { ...draft, groupIds: [] } });
    assert.equal(noGroup.reason, 'INVALID_GROUP');
    assert.equal(result.closureLink, 'none');
    for (const field of ['previewId', 'signature', 'eligibleMemberIds']) assert.equal(Object.hasOwn(result.preview, field), false);
    assert.equal(store.getSnapshot(), snapshot);
  } finally {
    await vite.close();
  }
});
