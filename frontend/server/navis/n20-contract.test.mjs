import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBridge } from '../bridge.mjs';
import { createNavisMenuHarness, navisAgentFakeFetch } from '../fixtures/navis-eval-fake.mjs';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest } from '../../shared/navis-agent-schema.mjs';
import { readCafeScenarios, readTrace } from './scenario-fixtures.mjs';

const trace = readTrace();
const assigned = trace.filter(row => row.slice_id === 'N20');
const required = trace.filter(row => row.required_slices.split('|').includes('N20'));
const vite = await createServer({
  root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false, envFile: false, envDir: false,
  logLevel: 'silent', server: { middlewareMode: true, watch: null, ws: false, hmr: false },
});
const load = path => vite.ssrLoadModule(`/src/${path}.ts`);
let corpus, data, provider, nav, state, catalog, presets, motion, session, messages;
try {
  ({ corpus } = await readCafeScenarios(vite));
  [data, provider, nav, state, catalog, presets, motion, session, messages] = await Promise.all([
    load('data/widget-data'), load('features/assistant/provider'), load('screens/dashboard/navis-navigation'),
    load('state/index'), load('catalog/index'), load('layout/presets'), load('ui/motion'), load('app/test-session'),
    load('features/assistant/messages'),
  ]);
} finally {
  await vite.close();
}

const tr = messages.navisTranslator('ko');
const cafe = data.createWidgetDataStore().getSnapshot();
const change = id => cafe.tables.localChange.find(row => row.changeId === id);
const opening = change('sample-local-3');
const event = change('sample-local-1');
const openingTitle = tr.t(opening.titleKey);
const traffic = data.readModel(cafe, 'trade-area');
const trends = data.readModel(cafe, 'local-trends');
const local = data.readModel(cafe, 'local-changes');
const people = n => tr.format.count(n, 'person');
const hourPeople = hour => people(traffic.hours.find(row => row.hour === hour).people);
const sum = rows => rows.reduce((total, row) => total + row.people, 0);
const top = [...traffic.hours].sort((a, b) => b.people - a.people || a.hour - b.hour).slice(0, 3);
const lowest = [...traffic.hours].sort((a, b) => a.people - b.people || a.hour - b.hour)[0];
const firstKeyword = trends.keywords[0];
const secondKeyword = trends.keywords[1];
const topKeyword = trends.notable[0];
const mentions = keyword => tr.format.number(keyword.mentions);
const percent = keyword => tr.format.percent(keyword.changePercent, 1);
// EXPECT-4. The overlay holds policy and seed errata. These IDs still have behavior gaps.
const gaps = {
  'S4-170': 'N20 R5 with Demand R5: the authored range can route to next-day demand on the marketing board.',
  'S4-178': 'N21 with N19/N20: the available traffic and visit samples lack comparable coverage.',
  'S4-200': 'N02 with N20 R5: the opening utterance needs a previously established trend metric.',
};
const changeTargets = { 'S4-146': event.changeId };
const totalIn = (start, end) => sum(traffic.hours.filter(row => row.hour >= start && row.hour < end));
const selectorCopy = {
  'S4-132': [openingTitle, `${opening.distanceM}m`],
  'S4-133': [openingTitle, '같은 업종 아님'],
  'S4-138': [`새로 확인할 변화 ${local.openChanges.length}개`, `접어 둔 변화 ${local.foldedCount}개`],
  'S4-146': [],
  'S4-166': [hourPeople(15)],
  'S4-167': [hourPeople(18)],
  'S4-168': [`${lowest.hour}시`, people(lowest.people)],
  'S4-169': top.flatMap(row => [`${row.hour}시`, people(row.people)]),
  'S4-170': ['점심은 12시~14시 기준이에요', people(totalIn(12, 14))],
  'S4-171': [people(sum(traffic.hours))],
  'S4-172': [people(totalIn(0, 12)), people(totalIn(12, 24))],
  'S4-173': [tr.t(traffic.periodKey), tr.t(traffic.sourceKey)],
  'S4-193': [tr.t(firstKeyword.keywordKey), mentions(firstKeyword), percent(firstKeyword)],
  'S4-194': [tr.t(secondKeyword.keywordKey), mentions(secondKeyword), percent(secondKeyword)],
  'S4-198': [tr.t(topKeyword.keywordKey), percent(topKeyword)],
  'S4-199': [tr.format.dateRange(trends.period.start, trends.period.end), tr.format.dateRange(trends.previousPeriod.start, trends.previousPeriod.end)],
  'S4-201': [tr.t(firstKeyword.categoryKey)],
};

const localAnswers = new Set(['S4-141', 'S4-148', 'S4-170', 'S4-174', 'S4-176', 'S4-178', 'S4-187', 'S8-158']);

const evidenceValues = {
  'S4-166': ['tradeArea.hour.15', traffic.hours.find(row => row.hour === 15).people],
  'S4-167': ['tradeArea.hour.18', traffic.hours.find(row => row.hour === 18).people],
  'S4-171': ['tradeArea.total', sum(traffic.hours)],
  'S4-195': ['localTrends.declined.count', trends.keywords.filter(row => row.changePercent < 0).length],
  'S4-196': ['localTrends.noComparison.count', trends.keywords.filter(row => row.noComparison).length],
};

function context(t, id) {
  const clock = () => 0;
  const run = state.createRunStore({ screenPreset: presets.screenPresets.A, catalog: catalog.getRegistry('A'), time: motion.timePolicy,
    theme: 'light', clock, reducedMotion: true });
  session.beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  if (!['S4-158', 'S8-158'].includes(id)) run.actions.switchLayer('marketing');
  const folded = ['S4-148', 'S4-151', 'S4-157'].includes(id);
  // Start with a stored folded row and no receipt in the new run.
  const seed = folded ? { localChange: cafe.tables.localChange.map(row => row === opening ? { ...row, ackedAt: data.NOW } : row) } : undefined;
  const store = data.createWidgetDataStore(seed, { runId: run.getState().runId });
  const harness = createNavisMenuHarness(options => createBridge({ ...options, agentMode: 'fixture', onDiagnostics() {} }), validateAgentFrame, navisAgentFakeFetch);
  t.after(harness.close);
  const navigation = nav.createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const exchanges = [];
  const assistant = provider.createAssistantProvider({ store, run, clock, async fetcher(_url, init) {
    const request = JSON.parse(init.body);
    assert.equal(validateAgentRequest(request), true, JSON.stringify(request.intent));
    const result = await harness.run(request);
    exchanges.push({ request, result });
    return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL, 'content-type': 'text/event-stream' } });
  } });
  async function ask(text, continuation) {
    const start = exchanges.length;
    const before = store.getSnapshot();
    const plan = nav.classifyNavigation(text, run.getState(), before);
    const prepared = plan && nav.prepareNavigationRequest(plan, run.getState(), navigation);
    let detail;
    const reply = await assistant.ask({ text, continuation, locale: 'ko', layer: run.getState().activeBoard, signal: new AbortController().signal,
      ...(prepared && { agentTurn: prepared.agentTurn, onNavigation: action => { detail = prepared.resolve(action); } }),
    });
    assert.equal(store.getSnapshot(), before, 'typed input preserves the business snapshot');
    const observed = exchanges.slice(start);
    for (const { result } of observed) {
      assert.equal(result.status, 200, result.raw);
      assert.notEqual(result.terminal.code, 'invalid_output', result.raw);
    }
    if (detail && plan) assert.equal(await navigation.execute(plan.command, detail), 'opened');
    return { reply, detail, before, observed };
  }
  return { store, run, ask };
}

const outcome = ({ reply, detail }) => detail ? 'navigate' : reply.proposalSession?.isPending() ? 'proposal'
  : ['clarification', 'ambiguity'].includes(reply.turn?.kind) ? 'clarify'
    : reply.turn?.kind === 'refusal' ? 'refuse' : reply.answer ? 'answer' : 'unavailable';

function press(store, reply) {
  const card = reply.proposalSession;
  assert.ok(card?.isPending(), reply.answer);
  return card.confirm(store, card.getSnapshot().proposal.id);
}

async function confirm(env, turn, command, changeId) {
  const { store, run, ask } = env;
  const { reply, observed, before } = turn;
  const { result } = observed[0];
  const card = reply.proposalSession;
  const pending = card.getSnapshot();
  assert.equal(pending.proposal.command, command);
  assert.equal(pending.proposal.tier, 'normal');
  assert.equal(result.proposal.command, command);
  assert.deepEqual(result.calls.map(call => call.name), ['search_records', 'propose_action']);
  assert.equal(result.calls[0].args.kind, 'localChange');
  assert.equal(Object.keys(result.proposal.args.changeId).join(), 'handle');
  assert.ok(!JSON.stringify(observed[0].request.searches).includes(changeId));
  await ask('네');
  assert.equal(store.getSnapshot(), before);
  assert.equal(card.isPending(), true);

  const foreign = data.createWidgetDataStore(undefined, { runId: before.runId });
  assert.equal(card.confirm(store, 'different-proposal'), undefined);
  assert.equal(card.confirm(foreign, pending.proposal.id).frame.outcome, 'conflict');
  assert.equal(store.getSnapshot(), before);
  const receipt = press(store, reply);
  const reopening = command === 'localChanges.unacknowledge';
  const noticeKey = reopening ? 'data.notice.changeReopened' : 'data.notice.changeAcked';
  assert.equal(receipt.frame.outcome, 'applied');
  assert.equal(receipt.frame.messageKey, noticeKey);
  assert.equal(receipt.notice.messageKey, noticeKey);
  assert.equal(tr.has(noticeKey), true);
  assert.deepEqual(receipt.notice.undo, { target: 'data', token: receipt.undoToken });
  const after = store.getSnapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.tables.localChange, before.tables.localChange.map(row => row.changeId === changeId
    ? { ...row, ackedAt: reopening ? null : data.NOW } : row));
  const previousModel = data.readModel(before, 'local-changes');
  const nextModel = data.readModel(after, 'local-changes');
  assert.equal(nextModel.count, previousModel.count);
  assert.equal(nextModel.openChanges.length, previousModel.openChanges.length + (reopening ? 1 : -1));
  assert.equal(nextModel.foldedCount, previousModel.foldedCount + (reopening ? -1 : 1));
  card.confirm(store, pending.proposal.id);
  assert.equal(store.getSnapshot(), after);
  run.actions.showNotice(receipt.notice);
  return receipt;
}

test('N20 replays its TRACE assignments against the café snapshot and native fake transport', async t => {
  assert.equal(data.NOW, '2026-11-17T15:45');
  assert.equal(assigned.length, 42);
  assert.equal(required.length, 45);
  assert.deepEqual(required.filter(row => row.slice_id !== 'N20').map(row => row.scenario_id), ['S4-161', 'S4-162', 'S4-188']);
  const listed = [];
  let passed = 0;
  for (const { scenario_id: id } of assigned) {
    await t.test(id, async sub => {
      const scenario = corpus.get(id);
      const expected = scenario.expected;
      const env = context(sub, id);
      const turn = await env.ask(scenario.n20CafeText ?? scenario.utterances[0]);
      const actual = outcome(turn);
      assert.equal(actual, expected.kind, turn.reply.answer);
      for (const part of [...new Set([...(selectorCopy[id] ?? []), ...(expected.answer_must_contain ?? [])])]) assert.ok(turn.reply.answer.includes(part), `${part} missing from ${turn.reply.answer}`);
      for (const part of expected.answer_must_not_contain ?? []) assert.ok(!turn.reply.answer.includes(part), turn.reply.answer);
      if (actual === 'proposal') {
        const receipt = await confirm(env, turn, 'localChanges.acknowledge', changeTargets[id]);
        assert.equal(env.store.undo(receipt.undoToken).ok, true);
        assert.deepEqual(env.store.getSnapshot().tables.localChange, turn.before.tables.localChange);
      }
      if (actual === 'clarify') {
        const clarification = turn.reply.turn;
        assert.equal(clarification.field, expected.ask[0]);
        assert.deepEqual(turn.observed, []);
        if (scenario.n20Followup) {
          const { choiceId, command } = scenario.n20Followup;
          assert.deepEqual(clarification.choices, [{ id: choiceId, label: openingTitle }]);
          assert.equal(state.selectCommonNotice(env.run.getState())?.undo, undefined);
          const picked = await env.ask('', { clarificationId: clarification.id, choiceId });
          assert.equal(outcome(picked), 'proposal');
          const receipt = await confirm(env, picked, command, choiceId);
          assert.equal(env.store.undo(receipt.undoToken).ok, true);
          assert.deepEqual(env.store.getSnapshot().tables.localChange, turn.before.tables.localChange);
        }
      }
      if (actual === 'navigate') {
        const args = expected.tools[0].args;
        assert.equal(turn.detail.featureId, args.featureId);
        if (args.view) assert.equal(turn.detail.view, args.view);
        if (args.hour !== undefined) assert.equal(turn.detail.hour, args.hour);
        if (args.itemId) assert.equal(turn.detail.itemId, args.itemId);
      }
      if (actual === 'answer') {
        if (id === 'S4-178') assert.equal(turn.reply.answer, expected.answer_must_contain[0]);
        assert.ok(turn.observed.every(({ result }) => !result.proposal));
        const calls = turn.observed.flatMap(({ result }) => result.calls);
        if (localAnswers.has(id)) {
          assert.deepEqual(calls, []);
        } else {
          const expectedTool = expected.tools[0];
          assert.equal(calls[0]?.name, expectedTool.name, JSON.stringify(calls));
          assert.equal(calls[0]?.args.featureId, expectedTool.args.featureId, JSON.stringify(calls));
          if (['S4-137', 'S4-202'].includes(id)) assert.deepEqual(calls[0].args.condition, expectedTool.args.condition);
        }
        const expectedFact = evidenceValues[id];
        if (expectedFact) {
          const [key, value] = expectedFact;
          const facts = turn.observed.flatMap(({ request }) => request.snapshot.flatMap(row => row.facts ?? []));
          assert.ok(facts.some(fact => fact.key === key && fact.value === value), JSON.stringify(facts));
        }
      }
      if (gaps[id]) {
        listed.push(id);
        sub.diagnostic(gaps[id]);
      } else {
        passed++;
      }
    });
  }
  t.diagnostic(`${passed} of 42 pass, ${listed.length} listed exceptions with reasons; 45 required_slices references (42 assigned, 3 N21)`);
  assert.equal(passed + listed.length, assigned.length);
});

test('N20 S4-170 authored lunch range stays on Trade Area', { todo: gaps['S4-170'] }, async t => {
  const env = context(t, 'S4-170');
  const turn = await env.ask(corpus.get('S4-170').utterances[0]);
  assert.ok(turn.reply.answer.includes(people(totalIn(12, 14))), turn.reply.answer);
});

test('S4-150 requires a receipt press to restore the prior local change state', async t => {
  const env = context(t, 'S4-150');
  const folded = await env.ask(`${openingTitle} 확인했어`);
  const receipt = await confirm(env, folded, 'localChanges.acknowledge', opening.changeId);
  const applied = env.store.getSnapshot();
  const typed = await env.ask(corpus.get('S4-150').utterances[0]);
  assert.match(typed.reply.answer, /되돌리기/u);
  assert.equal(env.store.getSnapshot(), applied);
  assert.deepEqual(state.selectCommonNotice(env.run.getState()).undo, receipt.notice.undo);
  assert.equal(env.store.undo(receipt.undoToken).ok, true);
  assert.deepEqual(env.store.getSnapshot().tables.localChange, folded.before.tables.localChange);
  assert.equal(env.store.undo(receipt.undoToken).ok, false);
});

test('S4-175 distinguishes the historical hourly sample from a new observation', async t => {
  const env = context(t, 'S4-175');
  const turn = await env.ask(corpus.get('S4-175').utterances[0]);
  assert.equal(outcome(turn), 'answer');
  assert.match(turn.reply.answer, /예시|추정/u);
  assert.match(turn.reply.answer, /관측|실시간/u);
  assert.ok(turn.reply.answer.includes(hourPeople(Number(data.NOW.slice(11, 13)))));
  assert.doesNotMatch(turn.reply.answer, /지금은 사람이/u);
  assert.deepEqual(turn.observed, []);
});

test('N20 guards reject missing targets, duplicate transitions and stale cards', async t => {
  const env = context(t, 'S4-151');
  const { store } = env;
  const before = store.getSnapshot();
  assert.equal(store.dispatch({ type: 'localChanges.unacknowledge', changeId: 'unknown-change' }).code, 'NOT_FOUND');
  assert.equal(store.dispatch({ type: 'localChanges.acknowledge', changeId: opening.changeId }).code, 'CONFLICT');
  assert.equal(store.dispatch({ type: 'localChanges.unacknowledge', changeId: event.changeId }).code, 'CONFLICT');
  assert.equal(store.getSnapshot(), before);
  const turn = await env.ask(`접어둔 ${openingTitle} 다시 새 소식으로 돌려줘`);
  assert.equal(outcome(turn), 'proposal');
  assert.equal(store.dispatch({ type: 'localChanges.unacknowledge', changeId: opening.changeId }).ok, true);
  const reopened = store.getSnapshot();
  const card = turn.reply.proposalSession;
  assert.equal(card.confirm(store, card.getSnapshot().proposal.id).frame.outcome, 'conflict');
  assert.equal(store.getSnapshot(), reopened);
});
