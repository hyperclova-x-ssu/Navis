// @vitest-environment node
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../../../catalog';
import { createWidgetDataStore, NORMAL_VARIANT, selectWidget, TODAY } from '../../../data/widget-data';
import { selectStoreEnvironment } from '../../../data/iteration7/environment';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { createRunStore } from '../../../state';
import { beginDashboard } from '../../../app/test-session';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { getCctvMode, resetCctvModeForTest, setCctvMode } from '../../cctv/live/mode';
import { setLiveClientForTest } from '../../cctv/live/hooks';
import type { LiveClient } from '../../cctv/live/client';
import type { LiveConnection } from '../../../data/cctv';
import { assistantDomains } from '../snapshot';
import { createAssistantProvider } from '../provider';
import { applyAgentRunUndo } from '../agent-actions';
import type { AgentContinuation } from '../types';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error Shared scenario fixtures are JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';
// @ts-expect-error Server adapters are JavaScript.
import { operationAdapters } from '../../../../server/navis/operations.mjs';
// @ts-expect-error Server adapters are JavaScript.
import { navigationAdapters } from '../../../../server/navis/navigation.mjs';

type Kind = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate' | 'multi';
type Tool = { name: string; args?: { command?: string; featureId?: string; view?: string; hour?: number; args?: Record<string, unknown> } };
type Scenario = { id: string; utterances: string[]; expected: { kind: Kind; answer_must_contain?: string[]; tools?: Tool[] } };
type TraceRow = { scenario_id: string; slice_id: string; required_slices: string };
const trace = readTrace() as TraceRow[];
const corpus = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
const assigned = trace.filter(row => row.slice_id === 'N19').map(({ scenario_id }) => corpus.get(scenario_id)!);

// ───────────── café facts the expectations are derived from ─────────────
const cafe = createWidgetDataStore(undefined, { runId: 'n19-facts' }).getSnapshot();
const envModel = selectStoreEnvironment(cafe);
const cctvView = selectWidget(cafe, 'customer-analysis', { kind: 'default' }, NORMAL_VARIANT);
const briefingView = selectWidget(cafe, 'briefing', { kind: 'default' }, NORMAL_VARIANT);
if (cctvView.status !== 'ready' || briefingView.status !== 'ready') throw new Error('café fixtures are not ready');
const cctv = cctvView.model, briefing = briefingView.model;
const volume = envModel.music.volumePct;
const today = envModel.trend.filter(row => row.measuredAt.startsWith(TODAY));
const hottest = today.reduce((best, row) => row.temperatureC >= best.temperatureC ? row : best);
const money = (value: number) => `${(Math.round(value / 1000) / 10).toFixed(1)}만 원`;

function setup(id: string, store: ReturnType<typeof createWidgetDataStore>) {
  if (['S2-242', 'S2-244'].includes(id)) expect(store.dispatch({ type: 'cctv.markPeakForReview', date: TODAY, hour: cctv.peak!.hour }).ok).toBe(true);
  if (id === 'S3-014') expect(store.dispatch({ type: 'environment.setPlaying', playing: false }).ok).toBe(true);
}

function fixture(id: string, seed?: Parameters<typeof createWidgetDataStore>[0]) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = createWidgetDataStore(seed, { runId: run.getState().runId });
  setup(id, store);
  if (id === 'S2-222' || id === 'S2-253') setCctvMode('live');
  const requests: AgentRequest[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const provider = createAssistantProvider({ store, run, domains: assistantDomains, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) throw Error('Invalid fake request');
    requests.push(request);
    const harness = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
      createBridge({ ...options, agentMode: 'fake', onDiagnostics() {}, agentAdapters: [...operationAdapters, ...navigationAdapters] }),
    validateAgentFrame, navisAgentFakeFetch);
    try {
      const result = await harness.run(request);
      calls.push(...result.calls);
      return new Response(result.raw, { status: result.status, headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
    } finally {
      harness.close();
    }
  } });
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const ask = async (text: string, route = true, continuation?: AgentContinuation) => {
    const before = store.getSnapshot();
    const plan = route ? classifyNavigation(text, run.getState(), before) : undefined;
    const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
    let resolved: Record<string, unknown> | undefined;
    const reply = await provider.ask({ text, continuation, signal: new AbortController().signal, ...(prepared ? {
      agentTurn: prepared.agentTurn, onNavigation: action => { resolved = prepared.resolve(action); },
    } : {}) });
    const executed = resolved && plan && await navigation.execute(plan.command, resolved);
    expect(store.getSnapshot()).toBe(before);
    const overlay = run.getState().overlay;
    const detail = executed === 'opened' && overlay.type === 'detail' ? overlay.stack?.at(-1) ?? { featureId: overlay.featureId } : undefined;
    const actual: Kind = detail ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
        : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    const field = reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? reply.turn.field : undefined;
    return { actual, reply, detail, field, before };
  };
  return { run, store, ask, requests, calls };
}
type Env = ReturnType<typeof fixture>;

afterEach(() => resetCctvModeForTest());

// ───────────── expectations (café seed, business date 2026-11-17 15:45) ─────────────
/** Utterances whose kind differs from the authored one, each with the verified reason (errata ids are in the report). */
const kindOverride: Readonly<Record<string, Readonly<Record<number, Kind>> & { reason: string }>> = {
  // Not configured live server: Live is refused with a setup handoff (plan: setup/connection guard).
  'S2-252': { 0: 'refuse', 1: 'refuse', 2: 'refuse', reason: 'Live view needs the configured camera server; the owner is sent to the CCTV screen' },
  // D-324: switching the view mode is a card press, not a navigation.
  'S2-253': { 0: 'proposal', 1: 'proposal', 2: 'proposal', reason: 'D-324 card for the CCTV view mode' },
  // The café has no playlist named 잔잔한 로파이: the closest stored name is asked about instead of assumed.
  'S3-025': { 0: 'clarify', 1: 'clarify', reason: 'authored playlist name does not exist in the café' },
  // N21 owns compound turns: the readable part is answered and the rest is a stated limit.
  'S2-258': { 0: 'answer', 1: 'answer', 2: 'answer', reason: 'compound turn (N21)' },
  'S2-259': { 0: 'answer', 1: 'answer', 2: 'answer', reason: 'compound turn (N21)' },
  'S4-128': { 0: 'answer', 1: 'answer', 2: 'answer', 3: 'answer', reason: 'compound turn (N21)' },
};
/** Facts an answer must carry in this café (the authored numbers belong to the 2026-10-26 seed). */
const hourly = (h: { hour: number; visits: number | null; status: string }) => `${h.hour}시 ${h.visits}건`;
const expectedRead: Readonly<Record<string, readonly string[]>> = {
  'S2-224': ['정리할 테이블', '0개'],
  'S2-227': cctv.hours.map(hourly),
  'S2-228': [hourly(cctv.hours.find(h => h.hour === 12)!)],
  'S2-229': [`${cctv.hours.filter(h => h.status === 'ok').sort((a, b) => a.visits! - b.visits!)[0].hour}시`],
  'S2-230': ['오늘'],
  'S2-231': ['비교하지 않아요'],
  // D-362: the sample café has one camera (창가 좌석).
  'S2-232': ['1대', '연결'],
  'S2-233': ['1대', '연결됨'],
  'S2-234': ['15시', '일부만 집계'],
  'S3-003': [`${hottest.temperatureC === envModel.current!.temperatureC ? '' : ''}${envModel.current!.temperatureC.toFixed(1)}°C`, `${envModel.current!.humidityPct}%`, '적정 범위 안'],
  'S3-004': ['연결'],
  'S3-005': [`${hottest.temperatureC.toFixed(1)}°C`, hottest.measuredAt.slice(11, 16)],
  'S3-009': envModel.music.playlists.map(list => list.name),
  'S3-010': [envModel.music.playlists.find(list => list.id === envModel.music.playlistId)!.name],
  'S3-011': ['18~25', '40~60'],
  'S3-012': [`${envModel.current!.temperatureC.toFixed(1)}°C`],
  'S3-015': ['이미 재생 중'],
  'S3-022': [`이미 ${volume}%`],
  'S3-025': ['이미'],
  'S4-010': ['취소'],
  'S4-099': ['체크리스트'],
  'S4-100': ['오늘 일정'],
  'S4-103': [`${briefing.reservations.count}건`, `${briefing.reservations.partyTotal}명`],
  'S4-103#2': ['변경 및 취소'], 'S4-103#3': [`${briefing.reservations.partyTotal}명`],
  'S4-104': [money(briefing.closingSummary.salesSnapshot.net), money(briefing.closingSummary.netProfit), '마감 전'],
  'S4-105': [`${briefing.tomorrowReservations.count}건`],
  'S4-106': ['마감 전'],
  'S4-107': [money(briefing.yesterday.netSales)],
  'S8-161': ['자료는 없어요'],
};
/** An authored utterance that quotes a seed value is rewritten to the café value before it is replayed. */
const adapt = (id: string, text: string) => id === 'S3-022' ? text.replace('55', String(volume))
  : id === 'S2-242' || id === 'S2-244' ? text.replace('14시', `${cctv.peak!.hour}시`) : text;
const expectedField: Readonly<Record<string, string>> = {
  'S2-241': 'hour', 'S3-020': 'volumePct', 'S3-021': 'volumePct', 'S3-024': 'playlistId', 'S3-026': 'playlistId',
};
/** The authored hour wording that is a clarification in the old seed but a real, markable hour in the café. */
const variantKind = (row: Scenario, index: number): Kind => {
  if (row.id === 'S2-240') return index === 0 ? 'clarify' : 'proposal';
  return (kindOverride[row.id] as Partial<Record<number, Kind>> | undefined)?.[index] ?? row.expected.kind;
};

async function confirm(row: Scenario, env: Env, result: Awaited<ReturnType<Env['ask']>>, undoable: boolean) {
  const card = result.reply.proposalSession!;
  const proposal = card.getSnapshot().proposal;
  expect(card.getSnapshot().preview?.fields.length).toBeGreaterThan(0);
  const before = result.before;
  await env.ask('확인', false);
  expect(env.store.getSnapshot()).toBe(before);
  const modeBefore = getCctvMode(), briefingBefore = env.run.getState().briefing;
  const receipt = card.confirm(env.store, proposal.id);
  if (!receipt || typeof receipt === 'string') throw Error('Receipt missing');
  expect(receipt.frame.outcome, row.id).toBe('applied');
  if (proposal.command === 'ui.setCctvMode') {
    expect(getCctvMode()).not.toBe(modeBefore);
    expect(receipt.notice?.undo?.target).toBe('run');
  } else if (proposal.command === 'ui.acknowledgeBriefing') {
    expect(briefingBefore).toBe('pending');
    expect(env.run.getState().briefing).toBe('dismissed');
  } else expect(env.store.getSnapshot().revision).toBe(before.revision + 1);
  expect(card.confirm(env.store, proposal.id)).toBeUndefined();
  if (undoable && proposal.command === 'cctv.markPeakForReview') {
    expect(receipt.notice?.undo).toMatchObject({ target: 'data', token: receipt.undoToken });
    expect(env.store.undo(receipt.undoToken!).ok).toBe(true);
    expect(env.store.getSnapshot().tables.cctvHourly).toEqual(before.tables.cctvHourly);
  } else if (proposal.command.startsWith('environment.')) {
    expect(receipt.undoToken).toBeUndefined();
  }
}

describe('N19 café contract', () => {
  it('enumerates all 62 assignments', () => {
    expect(assigned).toHaveLength(62);
    expect(new Set(assigned.map(row => row.id)).size).toBe(62);
    expect(cctv.hours.length).toBeGreaterThan(0);
  });

  describe.each(assigned)('$id', row => {
    it.each(row.utterances.map((utterance, index) => ({ utterance, index })))('variant $index replays "$utterance"', async ({ utterance, index }) => {
      const env = fixture(row.id);
      const text = adapt(row.id, utterance);
      const result = await env.ask(text);
      if (process.env.N19_OBSERVATIONS) appendFileSync(process.env.N19_OBSERVATIONS, JSON.stringify({
        id: row.id, variant: index, utterance: text, authored: row.expected.kind, observed: result.actual, field: result.field,
        copy: result.reply.answer, detail: result.detail, calls: env.calls.map(call => call.name),
        command: result.reply.proposalSession?.getSnapshot().proposal.command,
      }) + '\n');
      const kind = variantKind(row, index);
      expect(result.actual, `${text}\n${result.reply.answer}`).toBe(kind);
      if (row.id === 'S4-121') {
        expect(result.detail).toEqual({ featureId: 'inventory-booking' });
        expect(env.calls).toEqual([]);
      }
      if (result.actual === 'answer') {
        const parts = expectedRead[`${row.id}#${index}`] ?? expectedRead[row.id] ?? [];
        for (const part of parts) expect(result.reply.answer, `${text}\n${result.reply.answer}`).toContain(part);
      }
      if (result.actual === 'clarify' && expectedField[row.id]) expect(result.field).toBe(expectedField[row.id]);
      if (result.actual === 'refuse') expect(result.reply.turn).toMatchObject({ kind: expect.stringMatching(/refusal|handoff/u) });
      if (result.actual === 'proposal') await confirm(row, env, result, true);
    });
  });

  it.each(['재고 부족 알림 몇 개야?', '재고 부족 알림 자세히 알려줘'])('answers "%s" without opening inventory', async text => {
    const env = fixture('S4-121');
    const result = await env.ask(text);
    expect(result.actual).toBe('answer');
    expect(result.reply.answer).toContain('보충 필요 0개');
    expect(env.calls.map(call => call.name)).toEqual(['get_widget']);
  });
});

// ───────────── cards and guards (D-323 ⑧, D-324) ─────────────
const press = (env: Env, reply: Awaited<ReturnType<Env['ask']>>['reply']) => {
  const card = reply.proposalSession!;
  const receipt = card.confirm(env.store, card.getSnapshot().proposal.id);
  if (!receipt || typeof receipt === 'string') throw Error('Card did not return a receipt');
  return { card, receipt, fields: card.getSnapshot().preview!.fields };
};
const music = (env: Env) => selectStoreEnvironment(env.store.getSnapshot()).music;

describe('N19 cards and guards', () => {
  it('S2-240 offers only hours with reviewable observations on the selected day', async () => {
    const observed = [10, 12, 14];
    const cctvHourly = cafe.tables.cctvHourly.filter(row => row.businessDate === TODAY && observed.includes(row.hour));
    const env = fixture('S2-240', { cctvHourly });
    for (const text of ['20시 구간 검토 표시해줘', '15시 구간 표시해줘', '아침 9시 붐빈 시간 표시']) {
      const result = await env.ask(text);
      expect(result.reply.turn).toMatchObject({ kind: 'clarification', field: 'hour', choices: observed.map(hour => ({ id: String(hour) })) });
      expect(result.reply.answer).toContain('10시, 12시, 14시');
      expect(result.reply.proposalSession).toBeUndefined();
    }
    expect(env.calls).toEqual([]);
    const result = await env.ask('20시 구간 검토 표시해줘');
    const turn = result.reply.turn;
    if (turn?.kind !== 'clarification') throw Error('Expected a review-hour question');
    const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: '12' });
    const { receipt } = press(env, selected.reply);
    expect(receipt.frame.outcome).toBe('applied');
    expect(env.store.getSnapshot().tables.cctvHourly.filter(row => row.reviewMarked).map(row => row.hour)).toEqual([12]);
    expect(receipt.undoToken && env.store.undo(receipt.undoToken).ok).toBe(true);
    expect(env.store.getSnapshot().tables.cctvHourly).toEqual(result.before.tables.cctvHourly);
  });

  it('S2-242 reads the marked review hour with no second proposal', async () => {
    const env = fixture('S2-242');
    const result = await env.ask(`${cctv.peak!.hour}시 구간 또 검토 표시해줘`);
    expect(result.reply.answer).toContain('이미');
    expect(result.reply.proposalSession).toBeUndefined();
    expect(env.calls.map(call => call.name)).toEqual(['get_widget']);
    expect(env.store.getSnapshot()).toBe(result.before);
  });

  it('S3-025 gives the same playlist question for either unavailable lo-fi wording', async () => {
    for (const text of ['오후 잔잔한 로파이로 바꿔줘', '로파이 틀어줘']) {
      const env = fixture('S3-025');
      const result = await env.ask(text);
      expect(result.reply.turn).toMatchObject({ kind: 'clarification', field: 'playlistId' });
      expect(result.reply.answer).toContain('어느 재생목록으로 할까요?');
      expect(result.reply.proposalSession).toBeUndefined();
      expect(env.store.getSnapshot()).toBe(result.before);
    }
  });
  it('never commits typed approval: yes, ok and repeat requests leave the store and the card untouched', async () => {
    const env = fixture('S3-013');
    const asked = await env.ask('음악 멈춰줘');
    expect(asked.actual).toBe('proposal');
    for (const typed of ['응', '확인', '네 해줘', '다시 한번 멈춰줘']) {
      await env.ask(typed, false);
      expect(env.store.getSnapshot()).toBe(asked.before);
    }
    expect(music(env).playing).toBe(true);
    press(env, asked.reply);
    expect(music(env).playing).toBe(false);
  });

  it('shows where Previous lands when the first track wraps to the last one (S3-017)', async () => {
    const env = fixture('S3-017');
    const asked = await env.ask('이전 곡으로');
    expect(asked.actual).toBe('proposal');
    const fields = asked.reply.proposalSession!.getSnapshot().preview!.fields;
    const last = envModel.music.playlists.find(list => list.id === envModel.music.playlistId)!.tracks.at(-1)!;
    expect(fields[0]).toMatchObject({ after: last.title });
    expect(fields.some(field => field.after.includes('마지막 곡으로'))).toBe(true);
    const { receipt } = press(env, asked.reply);
    expect(music(env).track?.id).toBe(last.id);
    expect(receipt.undoToken).toBeUndefined();
  });

  it('keeps the music playing when the owner mutes (S3-019) and says so on the card', async () => {
    const env = fixture('S3-019');
    const asked = await env.ask('음소거 해줘');
    const { fields } = press(env, asked.reply);
    expect(fields.map(field => field.after).join(' ')).toContain('재생은 계속돼요');
    expect(music(env)).toMatchObject({ volumePct: 0, playing: true });
  });

  it('applies a spoken volume only on the press and offers no undo for the simulated player (S3-018)', async () => {
    const env = fixture('S3-018');
    const asked = await env.ask('소리 칠십으로');
    expect(asked.actual).toBe('proposal');
    expect(music(env).volumePct).toBe(volume);
    const { receipt } = press(env, asked.reply);
    expect(music(env).volumePct).toBe(70);
    expect(receipt.undoToken).toBeUndefined();
    expect(receipt.frame.outcome).toBe('applied');
  });

  it('asks one question with chips around the current volume for a relative request, then proposes the chosen value (S3-020)', async () => {
    const env = fixture('S3-020');
    const asked = await env.ask('소리 좀 키워줘');
    expect(asked.actual).toBe('clarify');
    expect(asked.reply.answer).toContain(`${volume}%`);
    const turn = asked.reply.turn;
    if (turn?.kind !== 'clarification') throw Error(asked.reply.answer);
    expect(turn.choices.map(choice => choice.label)).toContain(`${volume + 10}%`);
    expect(env.calls).toHaveLength(0);
    const chosen = await env.ask('', false, { clarificationId: turn.id, choiceId: String(volume + 10) });
    expect(chosen.actual).toBe('proposal');
    press(env, chosen.reply);
    expect(music(env).volumePct).toBe(volume + 10);
  });

  it('refuses an out-of-range volume with the allowed range and never reaches the model (S3-021)', async () => {
    const env = fixture('S3-021');
    const asked = await env.ask('볼륨 150으로');
    expect(asked.actual).toBe('clarify');
    expect(asked.reply.answer).toContain('0~100');
    expect(env.calls).toHaveLength(0);
    expect(music(env).volumePct).toBe(volume);
  });

  it('answers a request for a genre that is not stored with the real playlist names (S3-026)', async () => {
    const env = fixture('S3-026');
    const asked = await env.ask('발라드 틀어줘');
    const turn = asked.reply.turn;
    if (turn?.kind !== 'clarification') throw Error(asked.reply.answer);
    expect(turn.choices.map(choice => choice.label)).toEqual(envModel.music.playlists.map(list => list.name));
  });

  it('refuses a past or unmark request without any model call and leaves the flag alone (S2-243, S2-244)', async () => {
    for (const [id, text] of [['S2-243', '어제 14시 구간 검토 표시해줘'], ['S2-244', '14시 검토 표시 풀어줘']] as const) {
      const env = fixture(id);
      const asked = await env.ask(text);
      expect(asked.actual).toBe('refuse');
      expect(env.calls).toHaveLength(0);
      // S2-244 starts with the peak hour already marked: the refusal keeps exactly that one flag.
      expect(env.store.getSnapshot().tables.cctvHourly.filter(row => row.reviewMarked).length).toBe(id === 'S2-244' ? 1 : 0);
    }
  });

  it('marks one observed hour of today after the press and restores it from the receipt (S2-239)', async () => {
    const env = fixture('S2-239');
    const asked = await env.ask('14시 피크 구간 검토 표시해줘');
    expect(asked.actual).toBe('proposal');
    expect(env.calls.map(call => call.name)).toContain('propose_action');
    const { receipt } = press(env, asked.reply);
    expect(env.store.getSnapshot().tables.cctvHourly.find(row => row.businessDate === TODAY && row.hour === 14)?.reviewMarked).toBe(true);
    expect(env.store.undo(receipt.undoToken!).ok).toBe(true);
    expect(env.store.getSnapshot().tables.cctvHourly.some(row => row.reviewMarked)).toBe(false);
  });

  it('refuses Live while the camera server is not configured and changes nothing (S2-252)', async () => {
    const env = fixture('S2-252');
    const asked = await env.ask('CCTV 실시간으로 바꿔줘');
    expect(asked.actual).toBe('refuse');
    expect(getCctvMode()).toBe('mock');
  });

  it('switches the CCTV view back to the sample on the press and the receipt undo restores Live (S2-253)', async () => {
    const env = fixture('S2-253');
    expect(getCctvMode()).toBe('live');
    const asked = await env.ask('CCTV 예시 모드로 돌려줘');
    expect(asked.actual).toBe('proposal');
    expect(getCctvMode()).toBe('live');
    const { receipt } = press(env, asked.reply);
    expect(getCctvMode()).toBe('mock');
    expect(receipt.notice).toMatchObject({ messageKey: 'data.notice.cctvModeMock', undo: { target: 'run' } });
    env.run.actions.showNotice(receipt.notice!);
    expect(applyAgentRunUndo(env.run, env.store, receipt.notice!.undo!.token)).toBe(true);
    expect(getCctvMode()).toBe('live');
  });

  it('marks the briefing as read only on the press, once (S4-114)', async () => {
    const env = fixture('S4-114');
    const asked = await env.ask('브리핑 다 읽었어');
    expect(asked.actual).toBe('proposal');
    expect(env.run.getState().briefing).toBe('pending');
    const { receipt } = press(env, asked.reply);
    expect(env.run.getState().briefing).toBe('dismissed');
    expect(receipt.notice).toMatchObject({ messageKey: 'data.notice.briefingAcknowledged' });
    const again = await env.ask('브리핑 다 읽었어');
    expect(again.actual).toBe('answer');
    expect(again.reply.answer).toContain('이미');
  });
});

describe('D-327 Q5: Live is available only while a camera is connected now', () => {
  afterEach(() => { vi.unstubAllEnvs(); setLiveClientForTest(null); });
  const camera = (connection: LiveConnection) => setLiveClientForTest({ getSnapshot: () => ({ connection }) } as unknown as LiveClient);
  const liveFact = (env: Env) => env.requests.flatMap(request => request.readings ?? [])
    .flatMap(reading => 'facts' in reading ? reading.facts : []).filter(fact => fact.key === 'cctv.mode.liveAvailable').at(-1)?.value;

  it('says the camera is not connected when the server address is set but no camera is, and offers no card', async () => {
    vi.stubEnv('VITE_CNN_SERVER_URL', 'http://cnn.test:8080');
    for (const connection of ['none', 'waiting', 'phone-opened', 'lost', 'server-down'] as const) {
      camera(connection);
      const env = fixture('S2-252');
      const asked = await env.ask('CCTV 실시간으로 바꿔줘');
      expect(asked.actual, connection).toBe('refuse');
      expect(asked.reply.answer, connection).toContain('연결된 카메라가 없어요');
      expect(getCctvMode()).toBe('mock');
      expect(asked.reply.proposalSession).toBeUndefined();
    }
  });

  it('keeps the server-not-configured wording when there is no address at all', async () => {
    vi.stubEnv('VITE_CNN_SERVER_URL', '');
    camera('live');
    const asked = await fixture('S2-252').ask('CCTV 실시간으로 바꿔줘');
    expect(asked.actual).toBe('refuse');
    expect(asked.reply.answer).toContain('카메라 서버');
  });

  it('keeps sample mode when the camera drops after the card was prepared', async () => {
    vi.stubEnv('VITE_CNN_SERVER_URL', 'http://cnn.test:8080');
    camera('live');
    const env = fixture('S2-252');
    const asked = await env.ask('CCTV 실시간으로 바꿔줘');
    expect(asked.actual).toBe('proposal');
    camera('lost');
    // The press prepares the card again against the camera as it is now (D-324): a card that no longer holds is stale, so nothing switches,
    // the refresh cannot offer Live again, and the card falls back to the manual route.
    const { card, receipt } = press(env, asked.reply);
    expect(receipt.frame.outcome).toBe('conflict');
    expect(getCctvMode()).toBe('mock');
    expect(card.getSnapshot().refreshFailed).toBe(true);
    expect(card.isPending()).toBe(false);
    expect(card.confirm(env.store, card.getSnapshot().proposal.id)).toBeUndefined();
    expect(getCctvMode()).toBe('mock');
  });

  it('offers the Live card while the camera is connected now, and Live switches only on the press', async () => {
    vi.stubEnv('VITE_CNN_SERVER_URL', 'http://cnn.test:8080');
    camera('live');
    const env = fixture('S2-252');
    const asked = await env.ask('CCTV 실시간으로 바꿔줘');
    expect(asked.actual, asked.reply.answer).toBe('proposal');
    expect(liveFact(env)).toBe(1);
    expect(getCctvMode()).toBe('mock');
    press(env, asked.reply);
    expect(getCctvMode()).toBe('live');
  });
});
