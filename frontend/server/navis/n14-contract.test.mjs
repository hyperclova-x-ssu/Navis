import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame } from '../../shared/navis-agent-schema.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N14');
const dependencies = trace.filter(row => row.required_slices.split('|').includes('N14'));
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
let corpus, data, provider, nav, runs, catalog, presets, motion, session, translate;
try {
  ({ corpus } = await readCafeScenarios(vite));
  [data, provider, nav, runs, catalog, presets, motion, session, translate] = await Promise.all([
    load('data/widget-data'), load('features/assistant/provider'), load('screens/dashboard/navis-navigation'),
    load('state/index'), load('catalog/index'), load('layout/presets'), load('ui/motion'), load('app/test-session'),
    load('features/assistant/messages'),
  ]);
} finally {
  await vite.close();
}

const memo = '우유는 받자마자 냉장고에 넣고 먼저 온 것부터 쓴다';
const condition = { kind: 'default' };
const accept = result => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

function prepare(t, id = '') {
  const run = runs.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'),
    time: motion.timePolicy, theme: 'light', clock: () => 0, reducedMotion: true });
  session.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = data.createWidgetDataStore(undefined, { runId: run.getState().runId });
  let draftId;
  if (['S3-078', 'S3-080'].includes(id)) {
    ({ draftId } = accept(store.dispatch({ type: 'manuals.createDraftFromMemo', memo })));
  }
  if (id === 'S3-116') {
    for (const { noticeId } of store.getSnapshot().tables.grantNotice) {
      accept(store.dispatch({ type: 'grants.apply', noticeId, idempotencyKey: noticeId }));
    }
  }
  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }),
    validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const exchange = [];
  const assistant = provider.createAssistantProvider({ run, store, async fetcher(_url, init) {
    const input = JSON.parse(init.body);
    assert.equal(init.headers[AGENT_PROTOCOL_HEADER], AGENT_PROTOCOL);
    const result = await harness.run(input);
    exchange.push({ input, result });
    return new Response(result.raw, { status: result.status, headers: {
      [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream',
    } });
  } });
  const navigation = nav.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  async function ask(text) {
    const before = store.getSnapshot();
    const start = exchange.length;
    const plan = nav.classifyNavigation(text, run.getState(), before);
    const prepared = plan && nav.prepareNavigationRequest(plan, run.getState(), navigation);
    let routed;
    const reply = await assistant.ask({ text, signal: new AbortController().signal, ...(prepared && {
      agentTurn: prepared.agentTurn, onNavigation: action => { routed = prepared.resolve(action); },
    }) });
    assert.equal(store.getSnapshot(), before, 'text input must never change the data snapshot');
    const observed = exchange[start];
    if (observed) {
      assert.equal(observed.result.status, 200, observed.result.raw);
      assert.notEqual(observed.result.terminal.code, 'invalid_output', observed.result.raw);
    }
    return { reply, routed, observed, before };
  }
  return { run, store, ask, navigation, draftId };
}

const kindOf = ({ reply, routed }) => routed ? 'navigate'
  : reply.turn?.kind === 'proposal' ? 'proposal' : reply.turn?.kind === 'refusal' ? 'refuse'
    : ['clarification', 'ambiguity'].includes(reply.turn?.kind) ? 'clarify'
      : reply.turn?.kind === 'handoff' ? 'handoff' : reply.answer ? 'answer' : 'unavailable';
const tablesFor = {
  'manuals.create': 'manual', 'manuals.update': 'manual', 'manuals.delete': 'manual',
  'manuals.setPublished': 'manual', // D-326.
  'manuals.toggleStep': 'checklistLog', 'manuals.createDraftFromMemo': 'manualDraft',
  'manuals.saveDraft': 'manual', 'manuals.discardDraft': 'manualDraft',
  'grants.apply': 'grantApplication', 'grants.updateApplication': 'grantApplication',
  'grants.deleteApplication': 'grantApplication', 'grants.markReviewed': 'grantReview',
};

function verifyWireProposal(observed, command) {
  assert.equal(observed?.result.terminal.outcome, 'proposal', observed?.result.raw);
  const { calls, proposal } = observed.result;
  assert.equal(proposal.command, command);
  assert.deepEqual(calls.at(-1), { name: 'propose_action', args: { command, args: proposal.args } });
  const [target] = Object.entries(proposal.args).filter(([, ref]) => ref && typeof ref === 'object' && ref.handle);
  if (target) {
    assert.equal(calls[0].name, 'search_records');
    assert.equal(calls.length, 2);
    const search = observed.input.searches.find(row => row.kind === calls[0].args.kind && row.querySlot === calls[0].args.querySlot);
    assert.ok(search?.matches.some(row => row.handle === target[1].handle && row.match === 'exact'));
  }
  if (command === 'manuals.create') {
    assert.deepEqual(calls[0], { name: 'search_records', args: { kind: 'manual', querySlot: proposal.args.title.slot } });
    assert.equal(calls.length, 2);
  }
  if (command === 'manuals.createDraftFromMemo') {
    assert.equal(calls.length, 1);
    assert.deepEqual(proposal.args.memo, { slot: 'memo' });
    assert.ok(!JSON.stringify(observed.input).includes(memo), 'private memo must stay in browser slots');
  }
}

async function confirm(env, result, command, extra = /delete|discard/iu.test(command)) {
  const { reply, observed, before } = result;
  verifyWireProposal(observed, command);
  const card = reply.proposalSession;
  assert.ok(card?.isPending(), `invalid or missing card preview: ${JSON.stringify(card?.getSnapshot().proposal.preview)}`);
  const { id, tier, command: cardCommand } = card.getSnapshot().proposal;
  assert.equal(cardCommand, command);
  assert.equal(tier, extra ? 'extra-confirm' : 'normal');
  await env.ask('확인');
  assert.ok(card.isPending(), 'typed confirmation must leave the card pending');
  if (extra) {
    assert.equal(card.confirm(env.store, id)?.requiresExtraConfirmation, true);
    assert.equal(env.store.getSnapshot(), before);
  }
  const receipt = card.confirm(env.store, id, extra);
  assert.equal(receipt?.frame.outcome, 'applied');
  const after = env.store.getSnapshot();
  assert.equal(after.revision, before.revision + 1);
  const table = tablesFor[command];
  assert.notDeepEqual(command === 'manuals.update' ? [after.tables.manual, after.tables.manualStep] : after.tables[table],
    command === 'manuals.update' ? [before.tables.manual, before.tables.manualStep] : before.tables[table]);
  card.confirm(env.store, id, extra);
  assert.equal(env.store.getSnapshot(), after, 'a replay cannot write again');
  await env.ask('되돌려줘');
  assert.equal(env.store.getSnapshot(), after, 'typed undo must leave the confirmed revision intact');
  return { after, card, receipt };
}

function currentId(previous, snapshot) {
  const category = { 'mn-open': 'opening', 'mn-close': 'closing' }[previous];
  if (category) return snapshot.tables.manual.find(row => row.category === category)?.manualId;
  if (previous === 'info-1') return snapshot.tables.manual.find(row => row.section === 'store-info')?.manualId;
  return previous;
}

async function verifyNavigation(env, result, expected) {
  const { routed, observed, before } = result;
  const requested = expected.tools.find(tool => /^ui\.open_?detail$/iu.test(tool.name))?.args;
  assert.ok(requested);
  assert.equal(routed.featureId, requested.featureId);
  if (requested.view) assert.equal(routed.view, requested.view);
  if (requested.itemId === 'info-1' && !routed.itemId) assert.equal(routed.view, 'store-info');
  else if (requested.itemId) assert.equal(routed.itemId, currentId(requested.itemId, before));
  if (requested.focus) assert.equal(routed.focus, requested.focus);
  assert.deepEqual(observed?.result.calls, [], 'navigation bypasses model inference');
  assert.equal(await env.navigation.execute('ui.openDetail', routed), 'opened');
  const overlay = env.run.getState().overlay;
  assert.equal(overlay.type, 'detail');
  const entry = overlay.stack.at(-1);
  assert.equal(entry.view, routed.view);
  assert.equal(entry.itemId, routed.itemId);
  assert.equal(env.store.getSnapshot(), before);
}

function verifyMutation(id, before, after) {
  const openingId = currentId('mn-open', before);
  const closingId = currentId('mn-close', before);
  const row = after.tables.manual.find(item => !before.tables.manual.some(old => old.manualId === item.manualId));
  if (id === 'S3-059' || id === 'S3-062') {
    const storeInfo = id === 'S3-062';
    assert.equal(after.tables.manual.length, before.tables.manual.length + 1);
    assert.equal(row?.section, storeInfo ? 'store-info' : 'handover');
    assert.equal(row.category, storeInfo ? 'store-info' : 'hygiene');
    const steps = after.tables.manualStep.filter(item => item.manualId === row.manualId);
    assert.deepEqual(steps.map(step => step.body.raw), storeInfo
      ? ['포장 용기는 반드시 뚜껑을 닫아 전달해요']
      : ['용기 꺼내기', '음식 담기', '영수증 넣기']);
  }
  if (id === 'S3-065') assert.equal(after.tables.manual.find(item => item.manualId === openingId)?.title.raw, '오픈 점검');
  if (id === 'S3-070') assert.equal(after.tables.manual.find(item => item.manualId === closingId)?.cautions.raw, '가스 밸브 꼭 잠그기');
  if (id === 'S3-071') assert.equal(after.tables.manualStep.find(item => item.manualId === currentId('info-1', before))?.body.raw,
    '평일 08:00~21:00 · 주말 10:00~21:00 · 연중무휴');
}

async function verifyAuthored(env, id, result, expected) {
  const actual = kindOf(result);
  assert.equal(actual, expected.kind, result.reply.answer);
  if (actual === 'proposal') {
    const command = expected.tools.find(tool => tool.name === 'propose_action')?.args.command;
    const { after } = await confirm(env, result, command, id === 'S3-068' || /delete|discard/iu.test(command));
    verifyMutation(id, result.before, after);
    verifyReviewedMutation(id, env, result.before, after);
  } else if (actual === 'navigate') {
    await verifyNavigation(env, result, expected);
  } else {
    assert.ok(!result.observed?.result.calls.some(call => call.name === 'propose_action'));
    for (const part of expected.answer_must_contain ?? []) assert.ok(result.reply.answer.includes(part), `expected ${part} | ${result.reply.answer}`);
    if (actual === 'clarify' && expected.ask?.length) assert.ok(expected.ask.includes(result.reply.turn.field), result.reply.turn.field);
  }
}

function verifyReviewedMutation(id, env, before, after) {
  if (id === 'S3-052' || id === 'S3-053') {
    assert.equal(after.tables.checklistLog.length, before.tables.checklistLog.length + 1);
    assert.deepEqual(after.tables.checklistLog.at(-1), { date: data.TODAY, manualId: currentId('mn-open', before), stepNo: id === 'S3-052' ? 4 : 1 });
  }
  if (id === 'S3-066' || id === 'S3-067' || id === 'S3-068') {
    const target = currentId(id === 'S3-066' ? 'mn-close' : 'mn-open', before);
    const bodies = snapshot => snapshot.tables.manualStep.filter(row => row.manualId === target).map(row => row.body);
    const steps = bodies(before);
    if (id === 'S3-066') steps[2] = { raw: '바닥 청소하고 음식물 쓰레기 버리기' };
    if (id === 'S3-067') steps.push({ raw: '간판 불 켜기' });
    if (id === 'S3-068') steps.splice(3, 1);
    assert.deepEqual(bodies(after), steps);
  }
  if (id === 'S3-075') assert.ok(!after.tables.manual.some(row => row.manualId === currentId('mn-open', before)));
  if (id === 'S3-077') {
    assert.deepEqual(after.tables.manual, before.tables.manual);
    assert.deepEqual(after.tables.manualDraft.at(-1).steps, [{ raw: memo }]);
  }
  if (id === 'S3-078') {
    const added = after.tables.manual.at(-1);
    assert.equal(added.isPublished, true);
    assert.equal(after.tables.manualDraft.find(row => row.draftId === env.draftId)?.status, 'saved');
    assert.deepEqual(after.tables.manualStep.filter(row => row.manualId === added.manualId).map(row => row.body), [{ raw: memo }]);
  }
  if (id === 'S3-080') {
    assert.deepEqual(after.tables.manual, before.tables.manual);
    assert.ok(!after.tables.manualDraft.some(row => row.draftId === env.draftId));
  }
}

test('N14 scenario contracts on the current café seed', async t => {
  assert.equal(assigned.length, 73);
  assert.equal(dependencies.length, 80);
  assert.deepEqual(dependencies.filter(row => row.slice_id !== 'N14').map(row => row.scenario_id),
    ['S3-055', 'S3-087', 'S3-088', 'S3-089', 'S3-130', 'S3-131', 'S3-132']);
  assert.ok(assigned.every(row => corpus.has(row.scenario_id) && dependencies.includes(row)));
  let passed = 0;
  for (const { scenario_id: id } of assigned) {
    await t.test(id, async sub => {
      const { utterances, expected } = corpus.get(id);
      const env = prepare(sub, id);
      const result = await env.ask(utterances[0]);
      if (id === 'S3-072') {
        // D-326 replaces the earlier widget-only publication decision.
        const target = currentId('mn-close', result.before);
        const { after, receipt } = await confirm(env, result, 'manuals.setPublished', true);
        assert.equal(after.tables.manual.find(row => row.manualId === target).isPublished, false);
        assert.ok(receipt.undoToken);
        accept(env.store.undo(receipt.undoToken));
        assert.deepEqual(env.store.getSnapshot().tables.manual, result.before.tables.manual);
      } else await verifyAuthored(env, id, result, expected);
      passed++;
    });
  }
  t.diagnostic(`${passed} of 73 pass; 80 required_slices references (73 assigned, 7 N21)`);
});

test('D-326 unpublishes one manual after two presses and receipt undo republishes it', async t => {
  const env = prepare(t);
  const before = env.store.getSnapshot();
  const original = before.tables.manual.find(row => row.category === 'opening' && row.isPublished);
  assert.ok(original);
  const bulk = await env.ask('매뉴얼 전부 게시 취소해줘');
  assert.equal(bulk.reply.proposalSession, undefined);
  const result = await env.ask('오픈 체크리스트 매뉴얼 게시 취소해줘');
  const { after, receipt } = await confirm(env, result, 'manuals.setPublished', true);
  assert.equal(after.tables.manual.find(row => row.manualId === original.manualId).isPublished, false);
  assert.deepEqual(after.tables.manualStep, before.tables.manualStep);
  assert.deepEqual(after.tables.checklistLog, before.tables.checklistLog);
  assert.ok(receipt.undoToken);
  accept(env.store.undo(receipt.undoToken));
  assert.deepEqual(env.store.getSnapshot().tables.manual, before.tables.manual);
});

test('a current café grant records one local application and keeps eligibility unavailable', async t => {
  const env = prepare(t);
  const before = env.store.getSnapshot();
  const notice = before.tables.grantNotice[0];
  const title = translate.navisTranslator('ko').t(notice.titleKey);
  const candidateCount = snapshot => data.selectWidget(snapshot, 'grants', condition, 'normal').model.candidateCount;
  const eligibility = await env.ask(`우리 가게 ${title} 받을 수 있어?`);
  assert.equal(kindOf(eligibility), 'answer');
  assert.match(eligibility.reply.answer, /공식 공고/u);
  assert.ok(eligibility.observed?.input.snapshot.some(entry => entry.featureId === 'grants'
    && entry.facts.some(fact => fact.key === 'grants.eligibility' && fact.value === 'unverified')));
  const result = await env.ask(`${title} 신청 완료로 표시해줘`);
  const { after } = await confirm(env, result, 'grants.apply');
  assert.deepEqual(after.tables.grantApplication.map(({ noticeId, status, resultMemo, appliedOn }) => ({ noticeId, status, resultMemo, appliedOn })),
    [{ noticeId: notice.noticeId, status: 'applied', appliedOn: data.TODAY, resultMemo: null }]);
  assert.equal(candidateCount(after), candidateCount(before) - 1);
  const noticeDay = notice.applyEnd.slice(0, 10);
  const calendarHasDeadline = snapshot => data.selectCalendar(snapshot, { date: noticeDay }).entries.some(row => row.id === `deadline:${notice.noticeId}`);
  assert.equal(calendarHasDeadline(before), true);
  assert.equal(calendarHasDeadline(after), false);
  const application = await env.ask('내가 신청한 거 어떻게 됐어?');
  assert.match(application.reply.answer, /신청함/u);
  assert.ok(application.reply.answer.includes(title));
  const duplicate = await env.ask(`${title} 신청 완료로 표시해줘`);
  assert.equal(kindOf(duplicate), 'answer');
  assert.equal(env.store.getSnapshot(), after);
});

test('grant review, result edits and deletion use the same scoped snapshot and card boundary', async t => {
  const env = prepare(t);
  const notice = env.store.getSnapshot().tables.grantNotice[0];
  const title = translate.navisTranslator('ko').t(notice.titleKey);
  const review = await env.ask(`${title} 검토 완료로 표시해줘`);
  const reviewed = await confirm(env, review, 'grants.markReviewed');
  assert.deepEqual(reviewed.after.tables.grantReview, [{ noticeId: notice.noticeId, reviewStatus: 'reviewed' }]);
  const { applicationId } = accept(env.store.dispatch({ type: 'grants.apply', noticeId: notice.noticeId, idempotencyKey: 'reviewed-application' }));
  const result = await env.ask(`${title} 선정됐고 메모에 '결과는 다음 주에 확인' 적어줘`);
  const revised = await confirm(env, result, 'grants.updateApplication');
  const item = revised.after.tables.grantApplication.find(row => row.applicationId === applicationId);
  assert.equal(item.status, 'selected');
  assert.deepEqual(item.resultMemo, { raw: '결과는 다음 주에 확인' });
  const deletion = await env.ask(`${title} 신청 기록 지워줘`);
  const deleted = await confirm(env, deletion, 'grants.deleteApplication');
  assert.equal(deleted.after.tables.grantApplication.length, 0);
  assert.deepEqual(deleted.after.tables.grantReview, reviewed.after.tables.grantReview);
});

test('a current café grant opens the selected copy-only template without changing data', async t => {
  const env = prepare(t);
  const notice = env.store.getSnapshot().tables.grantNotice[0];
  const title = translate.navisTranslator('ko').t(notice.titleKey);
  const result = await env.ask(`${title} 신청서 초안 써줘`);
  assert.equal(kindOf(result), 'navigate', result.reply.answer);
  await verifyNavigation(env, result, { tools: [{ name: 'ui.openDetail', args: {
    featureId: 'grants', itemId: notice.noticeId, view: 'template',
  } }] });
});
