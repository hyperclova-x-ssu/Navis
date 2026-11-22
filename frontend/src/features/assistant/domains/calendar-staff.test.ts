// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, selectCalendar, selectStaffSchedule, TODAY } from '../../../data/widget-data';
import { assistantDomains } from '../snapshot';
import { addDays } from '../../../data/db/time';

describe('calendar and staff domain registration', () => {
  const store = createWidgetDataStore();
  const before = store.getSnapshot();

  it('grounds current staff attendance in the stored intervals', () => {
    expect(assistantDomains.projectWidget(before, 'staff-schedule', { kind: 'default' }, 'ko')).toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ key: 'staff.current.count', value: 2 })]),
    });
  });

  it('requests an ordinary dated event without writing during routing', () => {
    expect(assistantDomains.route('내일 오후 3시에 위생 점검 일정 추가해줘', before, 'ko')).toMatchObject({
      intent: { kind: 'command', command: 'calendar.addEvent', args: { date: { slot: 'date' }, time: { slot: 'time' }, title: { slot: 'title' } } },
      slots: { title: '위생 점검', date: addDays(TODAY, 1), time: '15:00' },
    });
    expect(store.getSnapshot()).toBe(before);
  });

  it('S3-164 asks about an overnight shift without creating either row', () => {
    expect(assistantDomains.route('김도현 내일 밤 10시부터 새벽 2시까지 근무 넣어줘', before, 'ko')).toMatchObject({
      kind: 'clarification', field: 'splitOvernight',
    });
    expect(store.getSnapshot()).toBe(before);
  });

  it('opens the staff week at the date derived from the café business clock', () => {
    expect(assistantDomains.navigation('다음 주 근무표 보여줘', before, 'ko')).toMatchObject({
      args: { featureId: 'staff-schedule', view: 'week', date: '2026-11-23' },
    });
  });
});

import { appendFileSync } from 'node:fs';
import { createAgentActions } from '../agent-actions';
import type { AgentContinuation } from '../types';
import { createAssistantProvider } from '../provider';
import { createDomainRegistry, registeredDomains } from './registry';
import { calendarDetailEntry, calendarStaffDomain, createCalendarStaffDomain, staffDetailEntry } from './calendar-staff';
import { selectDraftClosureLink } from '../../../data/iteration7/notices/selectors';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { createRunStore } from '../../../state';
import { beginDashboard } from '../../../app/test-session';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import type { DataSnapshot } from '../../../data/db/types';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
// @ts-expect-error Shared scenario fixtures are JavaScript.
import { evidence, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';
// @ts-expect-error The in-process bridge is JavaScript.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The native v3 fixture is JavaScript.
import { createNavisMenuHarness, navisAgentFakeFetch } from '../../../../server/fixtures/navis-eval-fake.mjs';
// @ts-expect-error Server adapters are JavaScript.
import { createCalendarStaffAdapters } from '../../../../server/navis/calendar-staff.mjs';
// @ts-expect-error Server adapters are JavaScript.
import { navigationAdapters } from '../../../../server/navis/navigation.mjs';

type Kind = 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate' | 'multi';
type ScenarioTool = { name: string; args?: { command?: string; featureId?: string; view?: string; focus?: string; args?: Record<string, unknown> } };
type Scenario = { id: string; utterances: string[]; expected: { kind: Kind; ask?: string[]; answer_must_contain?: string[]; confirmation?: { command: string };
  tools?: ScenarioTool[]; continuation?: { choice: string; kind: 'proposal'; tools: ScenarioTool[] } } };
type TraceRow = { scenario_id: string; slice_id: string; required_slices: string };
const trace = readTrace() as TraceRow[];
const corpus = new Map((JSON.parse(evidence('MERGED.json')) as Scenario[]).map(row => [row.id, row]));
const overlay = JSON.parse(evidence('CAFE-OVERLAY.json')) as Record<string, { expected?: Partial<Scenario['expected']>; utterances?: string[] }>;
const assigned = trace.filter(row => row.slice_id === 'N10').map(({ scenario_id }) => {
  const source = corpus.get(scenario_id)!;
  return { ...source, utterances: overlay[scenario_id]?.utterances ?? source.utterances,
    expected: { ...source.expected, ...overlay[scenario_id]?.expected } };
});
const tomorrow = addDays(TODAY, 1), later = addDays(TODAY, 2);
const offFlags = { allowClosureWrites: true, allowSingleDeletes: true };
const clientDomains = createDomainRegistry(registeredDomains.map(domain => domain === calendarStaffDomain ? createCalendarStaffDomain(offFlags) : domain));
const event = (eventId: string, title: string, date: string, time: string | null) =>
  ({ eventId, title: { raw: title }, date, time, categoryId: 'store-operations' as const, kind: 'event' as const, memo: null, revision: 1 });
const hygiene = event('n10-hygiene', '위생 점검', TODAY, '14:00');
const filter = event('n10-filter', '에어컨 필터 청소', addDays(TODAY, -3), '10:00');
const board = event('n10-menuboard', '메뉴판 교체', addDays(TODAY, -2), null);
const closure = { ...event('n10-closure', '임시 휴무', tomorrow, null), memo: { raw: '매장 정비로 하루 쉬어요' }, storeClosure: { kind: 'temporary' as const, endDate: tomorrow } };
const given = (id: string, list: string) => list.split(' ').includes(id);

function setup(id: string, runId: string) {
  const original = createWidgetDataStore(undefined, { runId }), { tables } = original.getSnapshot();
  const direct = given(id, 'S3-222 S3-226 S3-227 S3-230 S3-232 S3-255 S3-259 S8-054') ? hygiene
    : given(id, 'S3-229 S3-237') ? filter : id === 'S3-228' ? board : id === 'S3-239' ? closure : undefined;
  const store = direct ? createWidgetDataStore({ calendarEvent: [...tables.calendarEvent, direct] }, { runId })
    : id === 'S3-152' ? createWidgetDataStore({ staffSchedule: tables.staffSchedule.map(row => row.staffId === 'sample-staff-5' && row.date === TODAY
      ? { ...row, kind: 'off', start: null, end: null } : row) }, { runId }) : original;
  if (id === 'S3-239') expect(store.dispatch({ type: 'notice.importClosure', eventId: closure.eventId, idempotencyKey: 'n10-cafe-closure' }).ok).toBe(true);
  if (given(id, 'S3-235 S3-238')) {
    const milk = tables.purchaseItem.find(item => item.itemId === 'i-milk')!;
    expect(store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: milk.purchaseItemId, qty: milk.minimumQty,
      dueDate: tomorrow, idempotencyKey: 'n10-cafe-delivery' }).ok).toBe(true);
  }
  return store;
}

function fixture(id: string, enable = true) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const store = setup(id, run.getState().runId);
  const requests: AgentRequest[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const provider = createAssistantProvider({ store, run, domains: enable ? clientDomains : undefined, fetcher: async (_url, options) => {
    const request: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(request)) throw Error('Invalid fake request');
    requests.push(request);
    const harness = createNavisMenuHarness((options: Parameters<typeof createBridge>[0]) =>
      createBridge({ ...options, agentMode: 'fake', onDiagnostics() {},
        ...(enable ? { agentAdapters: [...createCalendarStaffAdapters(offFlags), ...navigationAdapters] } : {}) }),
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
    const detail = executed === 'opened' && overlay.type === 'detail' ? overlay.stack?.at(-1) : undefined;
    const actual: Kind = detail ? 'navigate' : reply.turn?.kind === 'proposal' ? 'proposal'
      : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
        : reply.turn?.kind === 'refusal' || reply.turn?.kind === 'handoff' ? 'refuse' : 'answer';
    const field = reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? reply.turn.field : undefined;
    return { actual, reply, detail, field, before };
  };
  return { run, store, ask, requests, calls };
}

const exception: Readonly<Record<string, { kind: Kind; reason: string }>> = {
  'S3-259': { kind: 'clarify', reason: 'The shared conversation path has no previous-calendar-record binding for an unnamed target.' },
  'S8-043': { kind: 'answer', reason: 'The shared card session does not support typed date edits for generic action cards.' },
};

const expectedRead: Readonly<Record<string, string[]>> = {
  'S3-136': ['2명'],
  'S3-139': ['윤서진', '박도현', '한소은', '김주원', '정하린', '08:00~16:30', '17:00~22:00'],
  'S3-140': ['0명'],
  'S3-141': ['윤서진', '16:30'],
  'S3-142': ['박도현', '0분'],
  'S3-143': ['3명'],
  'S3-144': ['윤서진', '11/17', '11/22'],
  'S3-145': ['5명', '윤서진', '박도현', '한소은', '김주원', '정하린'],
  'S3-146': ['0건'],
  'S3-147': ['윤서진', '25시간', '30분'],
  'S3-168': ['이미'],
  'S3-172': ['교대 일정이 없어요'],
  'S3-205': ['일정 1건', '근무 일정 2건', '11월 23일', '윤서진'],
  'S3-206': ['일정 12건', '근무 일정 18건', '픽업 1건', '11월 12일', '냉장 쇼케이스 온도·고무패킹 정기 점검'],
  'S3-207': ['일정이 없어요'],
  'S3-208': ['17:00', '근무 교대'],
  'S3-212': ['할 일이 없어요'],
  'S3-232': ['이미'],
  'S3-234': ['일정이 없어요'],
  'S8-043': ['변경 카드를 열어 두었어요'],
};
const expectedNavigation: Readonly<Record<string, string>> = {
  'S3-188': 'month', 'S3-189': 'staff', 'S3-190': 'history', 'S3-191': 'week', 'S3-192': 'add-staff',
  'S3-247': 'month', 'S3-248': 'week', 'S3-249': 'day', 'S3-250': 'add', 'S7-093': 'add',
};
const expectedField: Readonly<Record<string, string>> = {
  'S3-164': 'splitOvernight', 'S3-169': 'updateExisting', 'S3-171': 'toTime', 'S3-174': 'name', 'S3-175': 'name',
  'S3-177': 'name', 'S3-180': 'scheduleId', 'S3-214': 'dateIntent', 'S3-222': 'duplicateChoice', 'S3-223': 'dateIntent',
  'S3-259': 'featureId', 'S8-113': 'date', 'S8-114': 'date', 'S8-115': 'date',
  'S8-117': 'date', 'S8-119': 'dateIntent', 'S8-121': 'time', 'S8-122': 'time',
};
const draftOverrides: Readonly<Record<string, Record<string, unknown>>> = {
  'S3-150': { staffId: 'sample-staff-4', date: tomorrow },
  'S3-151': { staffId: 'sample-staff-2', date: later },
  'S3-152': { staffId: 'sample-staff-5', date: TODAY },
  'S3-159': { staffId: 'sample-staff-3', date: tomorrow },
  'S3-160': { staffId: 'sample-staff-1', date: TODAY },
  'S3-161': { staffId: 'sample-staff-2', date: TODAY, start: '08:00', breakMinutes: 0 },
  'S3-162': { staffId: 'sample-staff-1', date: TODAY, end: '16:30' },
  'S3-167': { staffId: 'sample-staff-1', date: '2026-11-13' },
  'S3-170': { date: TODAY, fromTime: '17:00' },
  'S3-176': { staffId: 'sample-staff-1', name: '윤서진B' },
  'S3-178': { staffId: 'sample-staff-5' },
  'S3-213': { date: tomorrow },
  'S3-215': { date: '2026-11-20' },
  'S3-216': { date: later },
  'S3-221': { date: '2026-11-16' },
  'S3-224': { date: tomorrow },
  'S3-226': { eventId: hygiene.eventId },
  'S3-227': { eventId: hygiene.eventId, date: tomorrow },
  'S3-228': { eventId: board.eventId },
  'S3-229': { eventId: filter.eventId },
  'S3-230': { eventId: hygiene.eventId },
  'S3-236': { date: TODAY, fromTime: '17:00' },
  'S3-237': { eventId: filter.eventId },
  'S3-239': { eventId: closure.eventId },
  'S3-255': { eventId: hygiene.eventId, date: tomorrow },
  'S8-054': { eventId: hygiene.eventId },
  'S8-082': { date: tomorrow },
  'S8-109': { date: later },
  'S8-110': { date: '2026-11-24' },
  'S8-111': { date: '2026-11-30' },
  'S8-112': { date: '2026-11-20' },
  'S8-116': { date: '2026-11-10' },
  'S8-118': { date: '2026-12-03' },
  'S8-120': { date: tomorrow },
  'S8-123': { date: TODAY },
};
const mutationTables = ['calendarEvent', 'categoryVisibility', 'calendarSettings', 'staff', 'staffSchedule', 'noticeDraft'] as const;
type ScenarioFixture = ReturnType<typeof fixture>;
function checkMutation(row: Scenario, command: string, before: DataSnapshot, after: DataSnapshot) {
  const authored = row.expected.tools?.find(tool => tool.name === 'propose_action')?.args?.args;
  const expected = { ...authored, ...draftOverrides[row.id] };
  const { calendarEvent, staff, staffSchedule } = after.tables;
  const old = before.tables;
  if (command === 'calendar.addEvent' || command === 'calendar.addTodo' || command === 'calendar.updateEvent') {
    const row = expected.eventId ? calendarEvent.find(e => e.eventId === expected.eventId) : calendarEvent.at(-1);
    expect(row).toBeDefined();
    if (row) {
      for (const field of ['date', 'time', 'categoryId'] as const) if (expected[field] !== undefined) expect(row[field], field).toEqual(expected[field]);
      for (const field of ['title', 'memo'] as const) if (expected[field] !== undefined) expect(row[field], field).toEqual({ raw: expected[field] });
      expect(selectCalendar(after, { date: row.date }).todayEntries.some(entry => entry.sourceId === row.eventId)).toBe(true);
    }
    expect(calendarEvent.length).toBe(old.calendarEvent.length + (command === 'calendar.updateEvent' ? 0 : 1));
  } else if (command === 'calendar.deleteEvent') {
    expect(old.calendarEvent.some(row => row.eventId === expected.eventId)).toBe(true);
    expect(calendarEvent.some(row => row.eventId === expected.eventId)).toBe(false);
    const linked = old.noticeDraft.find(draft => draft.closureEventId === expected.eventId);
    if (row.id === 'S3-239') {
      expect(linked).toBeDefined();
      expect(selectDraftClosureLink(before, linked!)).toBe('current');
      expect(selectDraftClosureLink(after, linked!)).toBe('removed');
    }
  } else if (command === 'calendar.setCategoryVisible') {
    expect(after.tables.categoryVisibility.purchasing).toBe(false);
  } else if (command === 'calendar.setSourceVisible') {
    expect(after.tables.calendarSettings.reservation).toBe(true);
  } else if (command === 'staff.create' || command === 'staff.update') {
    const saved = command === 'staff.create' ? staff.at(-1) : staff.find(p => p.staffId === expected.staffId);
    expect(saved).toMatchObject({ name: expected.name });
  } else if (command === 'staff.delete') {
    expect(staff.some(person => person.staffId === expected.staffId)).toBe(false);
    expect(staffSchedule.some(shift => shift.staffId === expected.staffId)).toBe(false);
  } else if (command === 'staff.deleteSchedule') {
    const removed = old.staffSchedule.find(shift => shift.staffId === 'sample-staff-1' && shift.date === TODAY)!;
    expect(staffSchedule.some(shift => shift.scheduleId === removed.scheduleId)).toBe(false);
  } else if (command === 'staff.saveSchedule') {
    const date = expected.date as string, staffId = expected.staffId as string;
    const matching = selectStaffSchedule(after, { startDate: date, endDate: date, staffId }).rows;
    expect(matching).toContainEqual(expect.objectContaining({ kind: expected.kind, date, staffId,
      start: expected.start ?? null, end: expected.end ?? null, breakMinutes: expected.breakMinutes ?? 0 }));
    expect(selectCalendar(after, { date }).staffEntries.some(entry => matching.some(shift => shift.scheduleId === entry.sourceId))).toBe(true);
  } else if (command === 'staff.moveHandoff') {
    const generated = selectCalendar(after, { date: TODAY }).todayEntries.filter(entry => entry.source === 'shift');
    expect(generated.map(entry => entry.time)).toContain(expected.toTime);
    expect(generated.map(entry => entry.time)).not.toContain(expected.fromTime);
  } else throw Error(`Missing mutation assertion for ${command}`);
}

async function confirm(row: Scenario, env: ScenarioFixture, result: Awaited<ReturnType<ScenarioFixture['ask']>>) {
  const card = result.reply.proposalSession!;
  const proposal = card.getSnapshot().proposal;
  const expectedCommand = row.expected.confirmation?.command
    ?? row.expected.tools?.find(tool => tool.name === 'propose_action')?.args?.command;
  expect(proposal.command).toBe(expectedCommand);
  expect(env.calls.at(-1)?.name).toBe('propose_action');
  expect(env.requests.at(-1)?.searches.every(search => search.matches.every(match => match.label === undefined))).toBe(true);
  await env.ask('확인', false);
  expect(env.store.getSnapshot()).toBe(result.before);
  const first = card.confirm(env.store, proposal.id);
  if (!first || typeof first === 'string') throw Error('Card cannot be confirmed');
  const extra = given(row.id, 'S3-160 S3-178 S3-179 S3-237 S3-239 S8-054');
  expect(Boolean(first.requiresExtraConfirmation)).toBe(extra);
  if (extra) {
    expect(env.store.getSnapshot()).toBe(result.before);
    await env.ask('응', false);
    expect(env.store.getSnapshot()).toBe(result.before);
  }
  const receipt = extra ? card.confirm(env.store, proposal.id, true) : first;
  if (!receipt || typeof receipt === 'string') throw Error('Receipt missing');
  expect(receipt.frame.outcome).toBe('applied');
  const after = env.store.getSnapshot();
  expect(after.revision).toBe(result.before.revision + 1);
  expect(card.confirm(env.store, proposal.id, true)).toBeUndefined();
  await env.ask('되돌려 줘', false);
  expect(env.store.getSnapshot()).toBe(after);
  checkMutation(row, proposal.command, result.before, after);
  if (proposal.command === 'calendar.setSourceVisible') {
    expect(receipt.undoToken).toBeUndefined();
  } else {
    expect(receipt.notice?.undo).toMatchObject({ target: 'data', token: receipt.undoToken });
    expect(env.store.undo(receipt.undoToken!).ok).toBe(true);
    for (const table of mutationTables) expect(env.store.getSnapshot().tables[table]).toEqual(result.before.tables[table]);
  }
}

describe('N10 café contract', () => {
  it('enumerates all 91 assignments and 114 dependency rows', () => {
    expect(assigned).toHaveLength(91);
    expect(new Set(assigned.map(row => row.id)).size).toBe(91);
    expect(trace.filter(row => row.required_slices.split('|').includes('N10'))).toHaveLength(114);
  });

  it.each(assigned)('$id checks its outcome in the café', async row => {
    const env = fixture(row.id);
    if (row.id === 'S3-259') await env.ask('위생 점검 일정 알려줘', false);
    if (row.id === 'S8-043') {
      const pending = await env.ask('내일 오후 3시에 위생 점검 일정 추가해줘', false);
      expect(pending.actual).toBe('proposal');
    }
    if (row.id === 'S8-054') await env.ask('위생 점검 일정 지워줘', false);
    const utterance = row.utterances[0];
    const result = await env.ask(utterance);
    if (process.env.N10_OBSERVATIONS) appendFileSync(process.env.N10_OBSERVATIONS, JSON.stringify({
      id: row.id, utterance, authored: row.expected.kind, observed: result.actual, field: result.field,
      copy: result.reply.answer, args: env.requests.at(-1)?.intent, calls: env.calls.map(call => call.name),
      exception: exception[row.id]?.reason,
    }) + '\n');
    expect(result.actual, `${utterance}\n${result.reply.answer}`).toBe(exception[row.id]?.kind ?? row.expected.kind);
    if (result.actual === 'clarify') expect(result.field).toBe(expectedField[row.id] ?? row.expected.ask?.[0]);
    if (result.actual === 'answer') {
      // These two calendar reports show the same rows with labeled event, shift and pickup counts.
      const hasCalendarBreakdown = row.id === 'S3-205' || row.id === 'S3-206';
      const copy = (exception[row.id] || hasCalendarBreakdown ? expectedRead[row.id] : overlay[row.id]?.expected?.answer_must_contain) ?? expectedRead[row.id] ?? [];
      for (const part of copy) expect(result.reply.answer).toContain(part);
    }
    if (result.actual === 'refuse') expect(result.reply.turn).toMatchObject({
      kind: 'refusal', alternative: { featureId: row.id === 'S5-081' ? 'community' : row.id === 'S3-178' ? 'staff-schedule' : 'suppliers' },
    });
    if (result.detail) {
      expect(result.detail.view).toBe(expectedNavigation[row.id]);
      if (row.id === 'S3-191') expect(result.detail.date).toBe('2026-11-23');
      if (row.id === 'S3-249') expect(result.detail.date).toBe('2026-10-30');
    }
    if (result.actual === 'proposal') await confirm(row, env, result);
    if (row.expected.continuation) {
      const { continuation } = row.expected;
      const { turn } = result.reply;
      if (turn?.kind !== 'clarification') throw Error(result.reply.answer);
      for (const part of row.expected.answer_must_contain ?? []) expect(result.reply.answer).toContain(part);
      expect(turn.choices).toContainEqual({ id: continuation.choice, label: '지난 기록으로 남기기' });
      expect(env.calls).toHaveLength(0);
      const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: continuation.choice });
      expect(selected.actual).toBe(continuation.kind);
      await confirm({ ...row, expected: { ...row.expected, tools: continuation.tools } }, env, selected);
    }
    if (row.id === 'S8-054') {
      expect(result.reply.answer).toContain('카드');
      const deleteResult = await env.ask('위생 점검 일정 지워줘', false);
      await confirm(row, env, deleteResult);
    }
  });
});

it.each(assigned.find(row => row.id === 'S3-164')!.utterances)('S3-164 clarifies both dates for %s', async text => {
  const env = fixture('S3-164');
  const result = await env.ask(text);
  expect(result.field).toBe('splitOvernight');
  expect(result.reply.answer).toContain('22:00~23:59');
  expect(result.reply.answer).toContain('00:00~02:00');
  expect(result.reply.proposalSession).toBeUndefined();
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it.each(assigned.find(row => row.id === 'S3-171')!.utterances)('S3-171 rejects an invalid handoff for %s', async text => {
  const env = fixture('S3-171');
  const result = await env.ask(text);
  expect(result.field).toBe('toTime');
  expect(result.reply.answer).toContain('퇴근 시각은 출근 시각보다 뒤여야 해요');
  expect(result.reply.proposalSession).toBeUndefined();
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('offers a valid afternoon alternative without applying an ambiguous handoff by text', async () => {
  const env = fixture('S3-236');
  const result = await env.ask('오늘 교대 시간 6시로 바꿔줘 캘린더에서');
  const { turn } = result.reply;
  if (turn?.kind !== 'clarification') throw Error(result.reply.answer);
  expect(turn.field).toBe('toTime');
  expect(turn.choices).toEqual([{ id: 'afternoon', label: '18:00으로 바꾸기' }]);
  expect(env.calls).toHaveLength(0);
  const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: 'afternoon' });
  expect(selected.actual).toBe('proposal');
  await confirm(assigned.find(row => row.id === 'S3-236')!, env, selected);
});

it('does not suggest an empty second shift when a proposed overnight range ends at midnight', async () => {
  const env = fixture('S3-164');
  const result = await env.ask('윤서진 내일 22:00부터 다음 날 00:00까지 근무 넣어줘');
  expect(result.field).toBe('splitOvernight');
  expect(result.reply.answer).not.toContain('00:00~00:00');
  expect(result.reply.proposalSession).toBeUndefined();
  expect(env.store.getSnapshot()).toBe(result.before);
});

it.each(assigned.find(row => row.id === 'S3-222')!.utterances)('S3-222 shows the stored duplicate for %s', async text => {
  const env = fixture('S3-222');
  const result = await env.ask(text);
  expect(result.reply.answer).toContain('14:00 위생 점검');
  const { turn } = result.reply;
  if (turn?.kind !== 'clarification') throw Error('Duplicate clarification missing');
  expect(turn.field).toBe('duplicateChoice');
  expect(turn.choices).toEqual([
    { id: 'keep', label: '그대로 두기' }, { id: 'add', label: '하나 더 추가' },
  ]);
  const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: 'keep' });
  expect(selected.reply.proposalSession).toBeUndefined();
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('S3-222 requires a historical choice and card press to add an elapsed duplicate', async () => {
  const env = fixture('S3-222');
  const first = await env.ask('오늘 오후 2시 위생점검 등록');
  const { turn } = first.reply;
  if (turn?.kind !== 'clarification') throw Error('Duplicate clarification missing');
  const duplicate = await env.ask('', false, { clarificationId: turn.id, choiceId: 'add' });
  if (duplicate.reply.turn?.kind !== 'clarification') throw Error('Historical clarification missing');
  expect(duplicate.field).toBe('dateIntent');
  const ready = await env.ask('', false, { clarificationId: duplicate.reply.turn.id, choiceId: 'historical' });
  const card = ready.reply.proposalSession!;
  const id = card.getSnapshot().proposal.id;
  await env.ask('네, 추가해 줘', false);
  expect(env.store.getSnapshot()).toBe(first.before);
  const receipt = card.confirm(env.store, id);
  if (!receipt || typeof receipt === 'string') throw Error('Duplicate receipt missing');
  expect(receipt.frame.outcome).toBe('applied');
  const after = env.store.getSnapshot();
  expect(after.revision).toBe(first.before.revision + 1);
  expect(after.tables.calendarEvent).toHaveLength(first.before.tables.calendarEvent.length + 1);
  expect(after.tables.calendarEvent).toContainEqual(expect.objectContaining({ date: TODAY, time: '14:00', title: { raw: '위생점검' } }));
  expect(card.confirm(env.store, id)).toBeUndefined();
  expect(env.store.undo(receipt.undoToken!).ok).toBe(true);
  expect(env.store.getSnapshot().tables.calendarEvent).toEqual(first.before.tables.calendarEvent);
});

const hygieneMove = assigned.find(row => row.id === 'S3-226')!;
it.each(hygieneMove.utterances)('S3-226 moves the seeded event and undoes the exact change for %s', async text => {
  const env = fixture('S3-226');
  const result = await env.ask(text);
  expect(result.actual).toBe('proposal');
  expect(env.calls.map(call => call.name)).toEqual(['search_records', 'propose_action']);
  await confirm(hygieneMove, env, result);
});

it.each([
  ['S3-227', '오늘 위생 점검 내일로 옮겨줘'],
  ['S3-228', '메뉴판 교체 일정 제목 메뉴판 인쇄로'],
  ['S3-229', '필터 청소 일정에 2층 포함 메모 추가'],
  ['S3-230', '위생 점검 세금 행정으로 옮겨줘'],
  ['S3-237', '필터 청소 일정 삭제해줘'],
  ['S3-255', "오늘 위생 점검 내일로 옮기고 메모에 '정수기 포함'이라고 적어줘"],
] as const)('%s resolves the seeded event for %s', async (id, text) => {
  const env = fixture(id);
  const result = await env.ask(text);
  expect(result.actual, result.reply.answer).toBe('proposal');
  expect(env.calls.map(call => call.name)).toEqual(['search_records', 'propose_action']);
  await confirm(assigned.find(row => row.id === id)!, env, result);
});

it('asks for a date match before moving an event identified by its original date', async () => {
  const env = fixture('S3-227');
  const result = await env.ask('어제 위생 점검 내일로 옮겨줘');
  expect(result.reply.answer).toContain('일정이 없어요');
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it.each([
  { id: 'S8-121', text: '내일 9시에 거래처 미팅 일정 넣어줘', titles: ['오전 9:00', '오후 9:00 (21:00)'], choice: 'pm', time: '21:00' },
  { id: 'S8-122', text: '내일 저녁에 직원 회식 일정 넣어줘', titles: ['시간 정하기', '시간 없이 넣기'], choice: 'skip-time', time: null },
])('$id creates a card only after a time choice', async ({ id, text, titles, choice, time }) => {
  const env = fixture(id);
  const first = await env.ask(text);
  const { turn } = first.reply;
  if (turn?.kind !== 'clarification') throw Error(first.reply.answer);
  expect(turn.choices.map(item => item.label)).toEqual(titles);
  expect(env.calls).toHaveLength(0);
  const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: choice });
  const card = selected.reply.proposalSession;
  if (!card) throw Error(selected.reply.answer);
  const proposalId = card.getSnapshot().proposal.id;
  await env.ask('응', false);
  expect(env.store.getSnapshot()).toBe(first.before);
  const receipt = card.confirm(env.store, proposalId);
  if (!receipt || typeof receipt === 'string') throw Error('Missing receipt');
  expect(receipt.frame.outcome).toBe('applied');
  expect(env.store.getSnapshot().tables.calendarEvent.at(-1)).toMatchObject({ date: tomorrow, time });
  expect(card.confirm(env.store, proposalId)).toBeUndefined();
  expect(env.store.undo(receipt.undoToken!).ok).toBe(true);
  expect(env.store.getSnapshot().tables.calendarEvent).toEqual(first.before.tables.calendarEvent);
});

it('S8-122 accepts a specific time after the owner chooses to set it', async () => {
  const env = fixture('S8-122');
  const first = await env.ask('내일 저녁에 직원 회식 일정 넣어줘');
  const { turn } = first.reply;
  if (turn?.kind !== 'clarification') throw Error(first.reply.answer);
  const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: 'set-time' });
  if (selected.reply.turn?.kind !== 'clarification') throw Error(selected.reply.answer);
  expect(selected.field).toBe('time');
  const ready = await env.ask('저녁 7시', false);
  expect(ready.actual).toBe('proposal');
  expect(env.store.getSnapshot()).toBe(first.before);
});

it('does not use the destination date to pick one of two same-title events', async () => {
  const env = fixture('S3-227');
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '위생 점검', date: tomorrow }).ok).toBe(true);
  const result = await env.ask('위생 점검 내일로 옮기고 메모: 정수기 포함');
  expect(result.field).toBe('eventId');
  expect(result.reply.proposalSession).toBeUndefined();
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('uses a day-of-month destination without filtering out the original event', async () => {
  const env = fixture('S3-227');
  const result = await env.ask('위생 점검 30일로 옮겨줘');
  const card = result.reply.proposalSession;
  if (!card) throw Error(result.reply.answer);
  const { id } = card.getSnapshot().proposal;
  expect(env.store.getSnapshot()).toBe(result.before);
  expect(card.confirm(env.store, id)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(env.store.getSnapshot().tables.calendarEvent).toContainEqual(expect.objectContaining({ eventId: hygiene.eventId, date: '2026-11-30' }));
});

it('asks which event to delete when a short title matches multiple direct records', async () => {
  const env = fixture('S3-237');
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '정수기 필터 청소', date: tomorrow }).ok).toBe(true);
  const result = await env.ask('필터 청소 일정 삭제해줘');
  expect(result.field).toBe('eventId');
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it.each(assigned.find(row => row.id === 'S7-093')!.utterances)('S7-093 opens a blank calendar form for %s', async text => {
  const env = fixture('S7-093');
  const result = await env.ask(text);
  expect(result.detail).toEqual({ featureId: 'calendar', view: 'add', focus: 'action' });
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('S3-140 answers staff time off from the roster', async () => {
  const env = fixture('S3-140');
  const result = await env.ask('오늘 휴무자 누구야?');
  expect(result.reply.answer).toContain('휴무 0명');
  expect(env.calls.at(-1)?.args.featureId).toBe('staff-schedule');
});

it.each(['필터 청소 마지막으로 한 날 알려줘', '에어컨 필터 언제 청소했어?'])('S3-207 reads the last completed event for %s', async text => {
  const env = fixture('S3-229');
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '에어컨 필터 청소', date: tomorrow, time: '16:00' }).ok).toBe(true);
  const result = await env.ask(text);
  expect(result.reply.answer).toContain('10:00 에어컨 필터 청소');
  expect(result.reply.answer).not.toContain('16:00');
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('S3-214 drafts the explicit future appointment in the requested category', async () => {
  const env = fixture('S3-214');
  const result = await env.ask('모레 오후 3시 세무사 상담 일정 세금 행정 분류로');
  expect(result.actual).toBe('proposal');
  expect(env.requests.at(-1)?.intent).toMatchObject({ command: 'calendar.addEvent', args: { categoryId: 'tax-admin' } });
  expect(env.store.getSnapshot()).toBe(result.before);
});

it.each([
  ['오늘 아침 10시 거래처 미팅 추가해줘', 'dateIntent', '지난 기록'],
  ['내일 아홉 시에 거래처 미팅 추가해줘', 'time', '오전과 오후'],
  ['내일 점심때 거래처 미팅 일정 추가해줘', 'time', '시간'],
] as const)('clarifies calendar meeting timing for %s', async (text, field, copy) => {
  const env = fixture('S8-121');
  const result = await env.ask(text);
  expect(result.reply.turn).toMatchObject({ kind: 'clarification', field });
  expect(result.reply.answer).toContain(copy);
  expect(env.calls).toHaveLength(0);
  expect(env.store.getSnapshot()).toBe(result.before);
});

it('S8-115 asks for the weekday when a colloquial next-week request omits it', async () => {
  const env = fixture('S8-115');
  const result = await env.ask('담주에 위생 점검 하나 잡아줘');
  expect(result.field).toBe('date');
  expect(result.reply.answer).toContain('무슨 요일');
  expect(env.calls).toHaveLength(0);
  const { turn } = result.reply;
  if (turn?.kind !== 'clarification') throw Error(result.reply.answer);
  expect(turn.choices.map(choice => choice.label)).toEqual(['월 11/23', '화 11/24', '수 11/25', '목 11/26', '금 11/27']);
  const selected = await env.ask('', false, { clarificationId: turn.id, choiceId: '2026-11-25' });
  const card = selected.reply.proposalSession;
  if (!card) throw Error(selected.reply.answer);
  expect(env.store.getSnapshot()).toBe(result.before);
  expect(card.confirm(env.store, card.getSnapshot().proposal.id)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(env.store.getSnapshot().tables.calendarEvent.at(-1)).toMatchObject({ date: '2026-11-25', title: { raw: '위생 점검' } });
});

// The optional replay records authored wording against the café store, including legacy targets.
const variantTrace = process.env.N10_VARIANT_TRACE;
if (variantTrace) describe('N10 authored utterances', () => {
  it.each(assigned)('$id traces each original utterance without changing the store', async row => {
    for (const [index, utterance] of row.utterances.entries()) {
      const env = fixture(row.id);
      if (row.id === 'S3-259') await env.ask('위생 점검 일정 알려줘', false);
      if (row.id === 'S8-043') await env.ask('내일 오후 3시에 위생 점검 일정 추가해줘', false);
      if (row.id === 'S8-054') await env.ask('위생 점검 일정 지워줘', false);
      const result = await env.ask(utterance);
      appendFileSync(variantTrace, JSON.stringify({
        id: row.id, variant: index + 1, utterance, authored: row.expected.kind, observed: result.actual,
        field: result.field, copy: result.reply.answer, detail: result.detail, calls: env.calls.map(call => call.name),
      }) + '\n');
      expect(result.reply.answer || result.reply.proposalSession || result.detail).toBeTruthy();
    }
  });
});

it.each([
  ['S3-237', '에어컨 필터 청소 일정 지워줘', 'calendar.deleteEvent', 'calendarEvent', 'eventId', 'n10-filter'],
  ['S3-228', '메뉴판 교체 할 일 지워줘', 'calendar.deleteEvent', 'calendarEvent', 'eventId', 'n10-menuboard'],
  ['S3-179', '윤서진 오늘 근무 지워줘', 'staff.deleteSchedule', 'staffSchedule', 'staffId', 'sample-staff-1'],
] as const)('D-325 %s deletes one row on the second press and restores it from its receipt', async (id, text, command, table, field, key) => {
  const env = fixture(id, false);
  if (id === 'S3-228') {
    expect(env.store.dispatch({ type: 'calendar.deleteEvent', eventId: board.eventId }).ok).toBe(true);
    expect(env.store.dispatch({ type: 'calendar.addTodo', title: '메뉴판 교체', date: board.date, dateIntent: 'historical' }).ok).toBe(true);
  }
  const proposed = await env.ask(text, false);
  const card = proposed.reply.proposalSession;
  if (!card) throw Error(proposed.reply.answer);
  const { id: proposalId, command: proposedCommand } = card.getSnapshot().proposal;
  expect(proposedCommand).toBe(command);
  const before = env.store.getSnapshot();
  const expectedRows = before.tables[table].filter(row => (field === 'staffId' && 'staffId' in row ? row.staffId === key && row.date === TODAY
    : 'eventId' in row && (row.eventId === key || id === 'S3-228' && row.kind === 'todo' && row.date === board.date)));
  expect(expectedRows).toHaveLength(1);
  await env.ask('확인', false);
  expect(card.confirm(env.store, proposalId)).toMatchObject({ requiresExtraConfirmation: true });
  await env.ask('응', false);
  expect(env.store.getSnapshot()).toBe(before);
  const receipt = card.confirm(env.store, proposalId, true);
  if (!receipt || typeof receipt === 'string') throw Error('Receipt missing');
  expect(receipt.frame.outcome).toBe('applied');
  const after = env.store.getSnapshot();
  expect(after.tables[table]).toHaveLength(before.tables[table].length - 1);
  expect(after.tables[table]).not.toContainEqual(expectedRows[0]);
  await env.ask('되돌려 줘', false);
  expect(env.store.getSnapshot()).toBe(after);
  expect(receipt.undoToken && env.store.undo(receipt.undoToken).ok).toBe(true);
  expect(env.store.getSnapshot().tables[table]).toEqual(before.tables[table]);
});

it.each([
  ['내일 임시 휴무 일정 넣어줘', 'calendar.addEvent'],
  ['임시 휴무 일정을 모레로 옮겨줘', 'calendar.updateEvent'],
] as const)('D-325 previews %s with overlaps and saves on the card press', async (text, command) => {
  const env = fixture(command === 'calendar.updateEvent' ? 'S3-239' : 'D325', false);
  const date = command === 'calendar.addEvent' ? tomorrow : later;
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '점검', date, time: '15:00' }).ok).toBe(true);
  const { reply, before } = await env.ask(text, false);
  if (reply.turn?.kind !== 'proposal') throw Error(reply.answer);
  const { proposal } = reply.turn;
  expect(proposal.command).toBe(command);
  expect(proposal.preview).toMatchObject({ fields: expect.arrayContaining([
    expect.objectContaining({ label: '겹치는 일정', after: expect.stringContaining('점검') }),
    ...(command === 'calendar.updateEvent' ? [expect.objectContaining({ label: '연결된 공지 초안', after: '다시 가져와 주세요' })] : []),
  ]) });
  await env.ask('응', false);
  expect(env.store.getSnapshot()).toBe(before);
  const receipt = proposal.confirm(env.store);
  expect(receipt.frame.outcome).toBe('applied');
  const after = env.store.getSnapshot();
  expect(after.tables.calendarEvent).toContainEqual(expect.objectContaining({ date, storeClosure: { kind: 'temporary', endDate: date } }));
  const draft = after.tables.noticeDraft.find(row => row.closureEventId === closure.eventId);
  if (command === 'calendar.updateEvent') expect(draft && selectDraftClosureLink(after, draft)).toBe('changed');
  await env.ask('되돌려 줘', false);
  expect(env.store.getSnapshot()).toBe(after);
  expect(receipt.undoToken && env.store.undo(receipt.undoToken).ok).toBe(true);
  expect(env.store.getSnapshot().tables.calendarEvent).toEqual(before.tables.calendarEvent);
});

it('D-325 blocks bulk calendar/shift deletes and keeps staff profiles widget-only', async () => {
  const env = fixture('S3-237', false);
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '홀 점검', date: tomorrow, time: '15:00' }).ok).toBe(true);
  for (const text of [
    '에어컨 필터 청소 일정 전부 지워줘', '에어컨 필터 청소랑 홀 점검 일정 지워줘',
    '윤서진 오늘 근무 두 건 지워줘', '윤서진이랑 박도현 오늘 근무 지워줘',
  ]) {
    expect((await env.ask(text, false)).reply.turn).toMatchObject({ kind: 'refusal', reason: 'unsupported' });
  }
  expect((await env.ask('정하린 직원 삭제해줘', false)).reply.turn).toMatchObject({
    kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'staff-schedule' },
  });
  expect(env.requests).toHaveLength(0);
});

it('D-325 requires the second press when an update clears a saved closure', () => {
  const store = setup('S3-239', 'd325-clear-closure');
  const before = store.getSnapshot();
  const prepared = createAgentActions(store).prepare({
    proposalId: 'clear-closure', command: 'calendar.updateEvent',
    args: { eventId: { handle: 'selected' }, storeClosure: null }, layer: 'management',
    runId: before.runId!, snapshotRevision: before.revision, tier: 'normal',
  }, {}, before, undefined, new Map([['selected', { kind: 'event', id: closure.eventId }]]));
  if (prepared.kind !== 'proposal') throw Error(prepared.kind);
  const { proposal } = prepared;
  expect(proposal.confirm(store).requiresExtraConfirmation).toBe(true);
  expect(store.getSnapshot()).toBe(before);
  const receipt = proposal.confirm(store, proposal.id);
  expect(receipt.frame.outcome).toBe('applied');
  expect(store.getSnapshot().tables.calendarEvent.find(row => row.eventId === closure.eventId)?.storeClosure).toBeNull();
  expect(receipt.undoToken && store.undo(receipt.undoToken).ok).toBe(true);
  expect(store.getSnapshot().tables.calendarEvent).toEqual(before.tables.calendarEvent);
});

it('GD-2 previews the lost draft link and deletes a closure only after both card presses', async () => {
  const env = fixture('S3-239', false);
  const { reply, before } = await env.ask('내일 임시 휴무 일정 지워줘', false);
  const card = reply.proposalSession;
  if (!card) throw Error(reply.answer);
  const { proposal } = card.getSnapshot();
  expect(proposal.command).toBe('calendar.deleteEvent');
  expect(proposal.preview).toMatchObject({
    fields: expect.arrayContaining([
      { label: '안내', before: '—', after: '연결된 공지 초안에서 휴무 연결이 끊겨요' },
    ]),
  });
  await env.ask('확인', false);
  expect(card.confirm(env.store, proposal.id)).toMatchObject({ requiresExtraConfirmation: true });
  await env.ask('응', false);
  expect(env.store.getSnapshot()).toBe(before);
  const receipt = card.confirm(env.store, proposal.id, true);
  expect(receipt).toMatchObject({ frame: { outcome: 'applied' } });
  const draft = before.tables.noticeDraft.find(row => row.closureEventId === closure.eventId)!;
  expect(selectDraftClosureLink(env.store.getSnapshot(), draft)).toBe('removed');
  if (!receipt || typeof receipt === 'string') throw Error('Receipt missing');
  expect(receipt.undoToken && env.store.undo(receipt.undoToken).ok).toBe(true);
  expect(selectDraftClosureLink(env.store.getSnapshot(), draft)).toBe('current');
});

it('RV-M5 asks for the historical card choice even when the title says 기록', async () => {
  const env = fixture('D325', false);
  const { reply, before } = await env.ask("어제 오후 3시 '매출 기록 점검' 일정 추가해줘", false);
  expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'dateIntent',
    choices: [{ id: 'historical', label: '지난 기록으로 남기기' }] });
  expect(env.requests).toHaveLength(0);
  if (reply.turn?.kind !== 'clarification') throw Error(reply.answer);
  expect((await env.ask('기록으로 남기지 마', false)).actual).not.toBe('proposal');
  expect((await env.ask('지난 기록으로 남기기', false)).actual).not.toBe('proposal');
  expect(env.requests).toHaveLength(0);
  const selected = await env.ask('', false, { clarificationId: reply.turn.id, choiceId: 'historical' });
  expect(selected.reply.turn).toMatchObject({ kind: 'proposal', proposal: { command: 'calendar.addEvent' } });
  expect(env.store.getSnapshot()).toBe(before);
});

it('RV-M5 leaves the store untouched when the first sentence is negated', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const route = assistantDomains.route('오늘 오전 10시 회의 일정 기록으로 남기지 마', snapshot, 'ko', 'calendar');
  expect(route && 'intent' in route && route.intent.kind).not.toBe('command');
});

it('RV-M5 asks before moving a future event to an elapsed time today', async () => {
  const env = fixture('D325', false);
  expect(env.store.dispatch({ type: 'calendar.addEvent', title: '현장 회의', date: tomorrow, time: '10:00' }).ok).toBe(true);
  const { reply, before } = await env.ask('현장 회의 일정을 오늘로 옮겨줘', false);
  expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'dateIntent',
    choices: [{ id: 'historical', label: '지난 기록으로 남기기' }] });
  if (reply.turn?.kind !== 'clarification') throw Error(reply.answer);
  const { reply: selected } = await env.ask('', false, { clarificationId: reply.turn.id, choiceId: 'historical' });
  if (selected.turn?.kind !== 'proposal') throw Error(selected.answer);
  expect(selected.turn.proposal.command).toBe('calendar.updateEvent');
  expect(env.store.getSnapshot()).toBe(before);
  expect(selected.turn.proposal.confirm(env.store).frame.outcome).toBe('applied');
  expect(env.store.getSnapshot().tables.calendarEvent.at(-1)).toMatchObject({ date: TODAY, time: '10:00' });
});

it('opens validated typed forms and linked staff rows without writing', () => {
  const { store } = fixture('S3-226'), snapshot = store.getSnapshot();
  expect(calendarDetailEntry({ featureId: 'calendar', view: 'add', prefill: { kind: 'widget-draft', command: 'ui.openDetail',
    fields: { title: '위생 점검', date: tomorrow, time: '15:00' } } }, snapshot)).toMatchObject({
    date: tomorrow, prefill: { title: '위생 점검', time: '15:00' }, entry: null,
  });
  expect(calendarDetailEntry({ featureId: 'calendar', itemId: hygiene.eventId }, snapshot)).toMatchObject({
    date: TODAY, mode: 'day', entry: { sourceId: hygiene.eventId },
  });
  const staff = snapshot.tables.staffSchedule[0];
  expect(staffDetailEntry({ featureId: 'staff-schedule', view: 'schedule', itemId: staff.scheduleId }, snapshot)).toMatchObject({
    orientation: 'date', date: staff.date, row: staff, tab: 'week',
  });
  expect(store.getSnapshot()).toBe(snapshot);
});
