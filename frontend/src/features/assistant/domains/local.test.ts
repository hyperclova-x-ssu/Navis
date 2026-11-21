// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { localDomain } from './local';
import { createDomainRegistry, registeredDomains, type DomainAdapter } from './registry';
import { createAssistantProvider } from '../provider';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { createRunStore } from '../../../state';
import { beginDashboard } from '../../../app/test-session';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error Shared scenario fixtures are JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';

type Kind = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate' | 'multi';
type Scenario = { id: string; utterances: string[]; expected: { kind: Kind; ask?: string[]; answer_must_contain?: string[]; answer_must_not_contain?: string[] } };
type TraceRow = { scenario_id: string; slice_id: string; required_slices: string };
const trace = readTrace() as TraceRow[];
const corpus = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
const assigned = trace.filter(row => row.slice_id === 'N20').map(({ scenario_id }) => corpus.get(scenario_id)!);

/* The café week: the seed rows the widgets show (EXPECT-2 method, values read from the same selectors). */
const base = createWidgetDataStore().getSnapshot();
const changes = readModel(base, 'local-changes'), area = readModel(base, 'trade-area'), trends = readModel(base, 'local-trends');
const t = (key: string) => key.replace(/^seed:/u, '');
const byKind = (kind: string) => changes.changes.find(row => row.kind === kind)!;
const opening = byKind('opening'), event = byKind('event'), works = byKind('construction');
const hour = (value: number) => area.hours.find(item => item.hour === value)!;
const sum = (from: number, to: number) => area.hours.filter(item => item.hour >= from && item.hour < to).reduce((total, item) => total + item.people, 0);
const grouped = (value: number) => value.toLocaleString('en-US');
const ranked = [...area.hours].sort((a, b) => b.people - a.people || a.hour - b.hour);
const lowest = [...area.hours].sort((a, b) => a.people - b.people || a.hour - b.hour)[0];
const [kwA, kwB, kwC] = trends.keywords;
const pct = (value: number | null) => String(Math.abs(value ?? 0));

/** Reviewed café errata. Each authored value that contradicts the café seed is replaced by the value the selector returns. */
const cafeContains: Readonly<Record<string, readonly (readonly string[] | undefined)[]>> = {
  'S4-132': [[`${opening.distanceM}m`], [`${opening.distanceM}m`], [`${opening.distanceM}m`], [`${event.distanceM}m`]],
  'S4-133': [[t(opening.titleKey), '같은 업종'], [t(opening.titleKey), '같은 업종'], ['같은 업종'], ['같은 업종']],
  'S4-137': [[t(works.titleKey)], undefined, [t(works.titleKey)], ['숭실대 2학기 중간고사 집중 주간']],
  'S4-138': [[`${changes.openChanges.length}개`, '0개'], [`${changes.openChanges.length}개`, '0개'], [`${changes.openChanges.length}개`, '0개'], ['0개']],
  'S4-139': [['500m'], undefined, undefined, undefined],
  'S4-141': [[t(opening.titleKey), '주소 자료는 없어요'], [t(opening.titleKey), '주소 자료는 없어요'], undefined, [t(opening.titleKey), '주소 자료는 없어요']],
  'S4-166': [[`${hour(15).people}명`], [`${hour(15).people}명`], [`${hour(15).people}명`], [`${hour(15).people}명`]],
  'S4-167': [[`${hour(18).people}명`], [`${hour(18).people}명`], [`${hour(18).people}명`], [`${hour(18).people}명`]],
  'S4-168': [[`${lowest.hour}시`, `${lowest.people}명`], [`${lowest.hour}시`, `${lowest.people}명`], [`${lowest.hour}시`, `${lowest.people}명`], [`${lowest.hour}시`, `${lowest.people}명`]],
  'S4-169': Array.from({ length: 4 }, () => ranked.slice(0, 3).flatMap(item => [`${item.hour}시`, `${item.people}명`])),
  'S4-170': Array.from({ length: 4 }, () => [`${grouped(sum(12, 14))}명`]),
  'S4-171': Array.from({ length: 4 }, () => [`${grouped(sum(0, 24))}명`]),
  'S4-172': Array.from({ length: 4 }, () => ['오전', '오후']),
  'S4-173': [['최근 4주', '추정'], ['최근 4주', '추정'], ['최근 4주', '추정'], ['최근 4주', '추정']],
  'S4-174': [['요일별'], ['요일별'], ['요일별'], ['요일별']],
  'S4-176': Array.from({ length: 4 }, () => ['비교한 자료는 없어요']),
  'S4-178': [['비교한 자료는 없어요'], ['비교한 자료는 없어요'], undefined, ['비교한 자료는 없어요']],
  'S4-187': [['마케팅', '동네'], ['마케팅', '동네'], ['마케팅', '동네'], ['마케팅', '동네']],
  'S4-193': [[`${kwC.mentions}`, `${pct(kwC.changePercent)}%`], undefined, undefined, undefined],
  'S4-195': [['0개'], ['0개'], ['0개'], undefined],
  'S4-196': [['0개'], ['0개'], undefined, ['0개']],
  'S4-198': Array.from({ length: 4 }, () => [t(kwC.keywordKey), `${pct(kwC.changePercent)}%`]),
  'S4-201': [undefined, [t(kwA.categoryKey), t(kwB.categoryKey), t(kwC.categoryKey)], [t(kwC.categoryKey)], [t(kwA.categoryKey), t(kwB.categoryKey), t(kwC.categoryKey)]],
  'S4-202': Array.from({ length: 4 }, () => ['제공되지 않아요']),
  'S4-199': [[`${trends.period.start.slice(5, 7).replace(/^0/u, '')}월`], [`${trends.period.start.slice(5, 7).replace(/^0/u, '')}월`], undefined, undefined],
  'S4-200': [['게시글', '리뷰'], ['게시글', '리뷰'], ['게시글', '리뷰'], ['게시글', '리뷰']],
  'S8-158': [['자료는 없어요'], ['자료는 없어요'], ['자료는 없어요']],
};

/** The local domain with a flag that tells when its own wording rule produced the turn. */
function spiedDomains() {
  const state = { claimed: false };
  const spied: DomainAdapter = { ...localDomain,
    route(...args) { const route = localDomain.route?.(...args); if (route) state.claimed = true; return route; },
    routePresentation(...args) { const route = localDomain.routePresentation?.(...args); if (route) state.claimed = true; return route; } };
  return { state, domains: createDomainRegistry(registeredDomains.map(domain => domain === localDomain ? spied : domain)) };
}

function fixture(id: string) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
  // S4-148, S4-151 and S4-157 start with the opening already folded.
  if (['S4-148', 'S4-151', 'S4-157'].includes(id)) expect(store.dispatch({ type: 'localChanges.acknowledge', changeId: opening.changeId }).ok).toBe(true);
  const requests: AgentRequest[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const spy = spiedDomains();
  const provider = createAssistantProvider({ store, run, domains: spy.domains, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) throw Error('Invalid fake request');
    requests.push(request);
    const harness = createNavisMenuHarness((bridgeOptions: Parameters<typeof createBridge>[0]) =>
      createBridge({ ...bridgeOptions, agentMode: 'fake', onDiagnostics() {}, agentAdapters: undefined }), validateAgentFrame, navisAgentFakeFetch);
    try {
      const result = await harness.run(request);
      calls.push(...result.calls);
      return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
    } finally {
      harness.close();
    }
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const ask = async (text: string, route = true, continuation?: { clarificationId: string; choiceId: string }) => {
    const before = store.getSnapshot();
    const plan = route ? classifyNavigation(text, run.getState(), before) : undefined;
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let resolved: Record<string, unknown> | undefined;
    const reply = await provider.ask({ text, ...(continuation ? { continuation } : {}), layer: run.getState().layer === 'marketing' ? 'marketing' : 'management', signal: new AbortController().signal, ...(prepared ? {
      agentTurn: prepared.agentTurn, onNavigation: action => { resolved = prepared.resolve(action); },
    } : {}) });
    const executed = resolved && plan && await navigation.execute(plan.command, resolved);
    expect(store.getSnapshot()).toBe(before);
    const { overlay } = run.getState();
    const detail = executed === 'opened' && overlay.type === 'detail' ? overlay.stack?.at(-1) ?? { featureId: overlay.featureId } : undefined;
    const turn = reply.turn;
    const actual: Kind = detail ? 'navigate' : turn?.kind === 'proposal' ? 'proposal'
      : turn?.kind === 'clarification' || turn?.kind === 'ambiguity' ? 'clarify'
        : turn?.kind === 'refusal' || turn?.kind === 'handoff' ? 'refuse' : 'answer';
    const field = turn?.kind === 'clarification' || turn?.kind === 'ambiguity' ? turn.field : undefined;
    return { actual, reply, detail, field, before, planned: Boolean(plan), executed, overlay: overlay.type };
  };
  return { run, store, ask, requests, calls, spy };
}
type Env = ReturnType<typeof fixture>;

/** Authored kinds that differ in the café, with the reviewed reason. */
const kindErrata: Readonly<Record<string, { kind: Kind; reason: string }>> = {
  'S4-151': { kind: 'proposal', reason: 'G-104 adds localChanges.unacknowledge, so a folded row now reopens from a card instead of being refused.' },
};
/** Variants a stored-row or keyword name is needed to route, or another widget owns. Their kind is still asserted when listed. */
const exceptions: Readonly<Record<string, { kind?: Kind; reason: string }>> = {
  'S4-147/4': { kind: 'answer', reason: '“다 봤어 확인” names no change, alert or row, so no domain can claim it from one turn.' },
  ...Object.fromEntries([1, 2, 3, 4].map(variant => [`S4-145/${variant}`, { kind: 'clarify' as Kind, reason: 'D-327 Q3: “새 카페” names a shop type no open opening title contains, so the app asks which opening first.' }])),
  ...Object.fromEntries([1, 4].map(variant => [`S4-151/${variant}`, { kind: 'clarify' as Kind, reason: 'D-327 Q3: “새 카페” names a shop type no folded opening title contains, so the app asks which opening first.' }])),
  'S4-212/1': { kind: 'answer', reason: 'The authored keyword is not in the café week, so there is no row to open.' },
  'S4-212/2': { kind: 'answer', reason: 'The authored keyword is not in the café week, so there is no row to open.' },
  'S4-212/3': { kind: 'answer', reason: 'The authored keyword is not in the café week, so there is no row to open.' },
  'S4-212/4': { kind: 'answer', reason: 'The authored keyword is not in the café week, so there is no row to open.' },
};

async function confirm(id: string, env: Env, result: Awaited<ReturnType<Env['ask']>>, target: typeof opening) {
  const card = result.reply.proposalSession!;
  const proposal = card.getSnapshot().proposal;
  const reopen = id === 'S4-151';
  expect(proposal.command).toBe(reopen ? 'localChanges.unacknowledge' : 'localChanges.acknowledge');
  expect(env.calls.at(-1)?.name).toBe('propose_action');
  expect(env.requests.at(-1)?.searches.every(search => search.matches.every(match => match.label === undefined))).toBe(true);
  // Typed words never commit the write.
  for (const word of ['확인', '응', '네', '진행해']) {
    await env.ask(word, false);
    expect(env.store.getSnapshot()).toBe(result.before);
  }
  const first = card.confirm(env.store, proposal.id);
  if (!first || typeof first === 'string') throw Error('Card cannot be confirmed');
  expect(first.requiresExtraConfirmation).toBeUndefined();
  expect(first.frame.outcome).toBe('applied');
  const after = env.store.getSnapshot();
  expect(after.revision).toBe(result.before.revision + 1);
  expect(after.tables.localChange.find(row => row.changeId === target.changeId)?.ackedAt !== null).toBe(!reopen);
  expect(first.notice?.messageKey).toBe(reopen ? 'data.notice.changeReopened' : 'data.notice.changeAcked');
  expect(card.confirm(env.store, proposal.id, true)).toBeUndefined(); // a second press is consumed
  expect(env.store.getSnapshot()).toBe(after);
  await env.ask('되돌려 줘', false);
  expect(env.store.getSnapshot()).toBe(after);
  expect(first.notice?.undo).toMatchObject({ target: 'data', token: first.undoToken });
  expect(first.undoToken && env.store.undo(first.undoToken).ok).toBe(true);
  expect(env.store.getSnapshot().tables.localChange).toEqual(result.before.tables.localChange);
}

const proposalTarget: Readonly<Record<string, typeof opening>> = {
  'S4-145': opening, 'S4-146': event, 'S4-151': opening,
};

describe('N20 local intelligence café contract', () => {
  it('enumerates the 42 assignments and the dependency rows', () => {
    expect(assigned).toHaveLength(42);
    expect(new Set(assigned.map(row => row.id)).size).toBe(42);
    expect(trace.filter(row => row.required_slices.split('|').includes('N20'))).toHaveLength(45);
    expect(changes.changes.map(row => row.kind).sort()).toEqual(['construction', 'event', 'opening']);
  });

  it.each(assigned)('$id replays every authored utterance in the café', async row => {
    for (const [index, utterance] of row.utterances.entries()) {
      const env = fixture(row.id);
      const result = await env.ask(utterance);
      const owner = env.spy.state.claimed || localDomain.navigation?.(utterance, env.store.getSnapshot(), 'ko') !== undefined ? 'local' : 'other';
      const wanted = exceptions[`${row.id}/${index + 1}`]?.kind ?? kindErrata[row.id]?.kind ?? row.expected.kind;
      if (process.env.N20_OBSERVATIONS) appendFileSync(process.env.N20_OBSERVATIONS, JSON.stringify({
        id: row.id, variant: index + 1, utterance, authored: row.expected.kind, observed: result.actual, field: result.field,
        copy: result.reply.answer, owner, calls: env.calls.map(call => call.name), detail: result.detail, planned: result.planned, executed: result.executed, overlay: result.overlay,
      }) + '\n');
      if (process.env.N20_OBSERVATIONS) continue;
      expect(result.actual, `${row.id}/${index + 1} ${utterance}\n${result.reply.answer}`).toBe(wanted);
      if (owner === 'local') for (const part of cafeContains[row.id]?.[index] ?? []) expect(result.reply.answer, `${row.id}/${index + 1} ${utterance}`).toContain(part);
      for (const part of row.expected.answer_must_not_contain ?? []) expect(result.reply.answer).not.toContain(part);
      if (result.actual === 'clarify' && row.expected.ask?.[0]) expect(result.field).toBe(row.expected.ask[0]);
      if (result.actual === 'proposal' && proposalTarget[row.id]) await confirm(row.id, env, result, proposalTarget[row.id]);
    }
  }, 180_000);
});

describe('N20 café analogs of the authored targets that are not in the café week', () => {
  it('opens the keyword row, the hour and the folded list the wording names', async () => {
    const env = fixture('S4-157');
    env.run.actions.switchLayer('marketing');
    const keyword = await env.ask(`${t(kwC.keywordKey)} 근거 보여줘`);
    expect(keyword.actual, keyword.reply.answer).toBe('navigate');
    expect(keyword.detail).toMatchObject({ featureId: 'local-trends', itemId: kwC.keywordId });
    const hourly = await env.ask('15시 유동인구 상세');
    expect(hourly.detail).toMatchObject({ featureId: 'trade-area', view: 'hour', hour: 15 });
    const folded = await env.ask('접어둔 변화 보여줘');
    expect(folded.detail).toMatchObject({ featureId: 'local-changes', view: 'folded' });
  });

  it('answers a stored keyword by its name', async () => {
    const env = fixture('analog');
    for (const text of [`${t(kwC.keywordKey)} 얼마나 늘었어?`, `${t(kwA.keywordKey)} 키워드 어때?`]) {
      const result = await env.ask(text);
      expect(result.actual, `${text}\n${result.reply.answer}`).toBe('answer');
    }
    const reply = (await env.ask(`${t(kwC.keywordKey)} 얼마나 늘었어?`)).reply.answer;
    expect(reply).toContain(`${kwC.mentions}`);
    expect(reply).toContain(`${pct(kwC.changePercent)}%`);
  });
});

describe('D-327 decisions', () => {
  it('counts 점심 as 12~14시 without asking and says which hours it used (Q1)', async () => {
    for (const text of ['점심때 사람 얼마나 다녀', '점심 두 시간 동안 지나가는 사람 수', '점심 유동인구 알려줘']) {
      const env = fixture('analog');
      const result = await env.ask(text);
      expect(result.actual, `${text}\n${result.reply.answer}`).toBe('answer');
      expect(result.reply.answer).toContain('점심은 12시~14시 기준이에요');
      expect(result.reply.answer).toContain(`${grouped(sum(12, 14))}명`);
    }
    // Hours the owner names win over the lunch default; a bare span still asks for the range.
    const named = await fixture('analog').ask('점심시간 11시부터 13시까지 유동인구 합쳐서 몇 명이야');
    expect(named.reply.answer).toContain(`${grouped(sum(11, 13))}명`);
    expect(named.reply.answer).not.toContain('점심은');
    expect((await fixture('analog').ask('두 시간 동안 지나가는 사람 수')).actual).toBe('clarify');
  });

  it('asks which opening first when no open opening title holds the shop type said, and proposes only after the pick (Q3)', async () => {
    const env = fixture('S4-145');
    const asked = await env.ask('새 카페 확인했어');
    expect(asked.actual, asked.reply.answer).toBe('clarify');
    expect(asked.field).toBe('changeId');
    expect(asked.reply.answer).toContain('카페');
    const turn = asked.reply.turn!;
    if (turn.kind !== 'clarification') throw Error('Expected a clarification');
    expect(turn.choices).toEqual([{ id: opening.changeId, label: t(opening.titleKey) }]);
    expect(env.store.getSnapshot()).toBe(asked.before); // nothing was proposed or written
    expect(env.calls.map(call => call.name)).not.toContain('propose_action');
    const picked = await env.ask('', false, { clarificationId: turn.id, choiceId: opening.changeId });
    expect(picked.actual, picked.reply.answer).toBe('proposal');
    await confirm('S4-145', env, picked, opening);
  });

  it('does not ask when the title holds the type, the wording names no type, or the row is already checked (Q3)', async () => {
    const titled = await fixture('S4-145').ask('서점 개점 확인했어');
    expect(titled.actual, titled.reply.answer).toBe('proposal');
    const generic = await fixture('S4-145').ask('새 가게 확인했어');
    expect(generic.actual, generic.reply.answer).toBe('proposal');
    const folded = await fixture('S4-148').ask('새 카페 확인했어');
    expect(folded.actual, folded.reply.answer).toBe('answer');
  });

  it('asks the same way before reopening a folded opening (Q3)', async () => {
    const env = fixture('S4-151');
    const asked = await env.ask('새 카페 알림 다시 살려줘');
    expect(asked.actual, asked.reply.answer).toBe('clarify');
    const turn = asked.reply.turn!;
    if (turn.kind !== 'clarification') throw Error('Expected a clarification');
    expect(turn.choices.map(choice => choice.id)).toEqual([opening.changeId]);
    const picked = await env.ask('', false, { clarificationId: turn.id, choiceId: opening.changeId });
    expect(picked.actual, picked.reply.answer).toBe('proposal');
    await confirm('S4-151', env, picked, opening);
  });
});
