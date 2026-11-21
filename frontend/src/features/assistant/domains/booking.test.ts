// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { createAssistantProvider } from '../provider';
import type { ProposalSession } from '../navis-conversation';
import { createDomainRegistry } from './registry';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectCalendar } from '../../../data/derive/operations';
import { selectReservations } from '../../../data/derive/reservations';
import { NEEDED } from '../../../assets/fonts/dev/collect';
import { woff2Cmap } from '../../../assets/fonts/dev/woff2-cmap';
import { addDays } from '../../../data/db/time';
import { bookingBundle, bookingDetailSeed, bookingDomain } from './booking';
import { classifyNavigation, createNavisNavigation, prepareNavigationRequest } from '../../../screens/dashboard/navis-navigation';
import { createRunStore } from '../../../state';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { timePolicy } from '../../../ui';
import { beginDashboard } from '../../../app/test-session';

// @ts-expect-error The reviewed corpus loader is a JavaScript test utility.
import { readCafeScenarios, readTrace } from '../../../../server/navis/scenario-fixtures.mjs';

// The in-process bridge and its fixture transport are JavaScript modules.
// @ts-expect-error The server has no TypeScript declarations.
import { createBridge } from '../../../../server/bridge.mjs';
// @ts-expect-error The server fixture has no TypeScript declarations.
import { runNavisBookingFixture } from '../../../../server/fixtures/navis-eval-fake.mjs';

function pressConfirm(store: ReturnType<typeof createWidgetDataStore>, card?: ProposalSession) {
  if (!card) return undefined;
  const { proposal, feedback } = card.getSnapshot();
  return card.confirm(store, proposal.id, feedback?.requiresExtraConfirmation);
}

const signal = () => new AbortController().signal;
const fakeResponse = (done: unknown, proposal?: unknown) => new Response(
  'event: panels\ndata: {"panels":[]}\n\n' +
  (proposal ? `event: action_proposal\ndata: ${JSON.stringify(proposal)}\n\n` : '') +
  `event: done\ndata: ${JSON.stringify(done)}\n\n`,
  { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } },
);

describe('booking client contract', () => {
  it('uses registered utterance and widget projections before falling back to legacy text', async () => {
    const store = createWidgetDataStore();
    const domain = {
      commands: [], reads: [],
      route: () => ({ intent: { kind: 'read', featureId: 'voice-booking' } } as const),
      projectWidget: () => ({ facts: [{ key: 'booking.people', value: 19, unit: 'person', label: '예약 인원', display: '19명' }] }),
    };
    const requests: AgentRequest[] = [];
    const provider = createAssistantProvider({
      store, domains: createDomainRegistry([domain]),
      fetcher: async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        expect(validateAgentRequest(request)).toBe(true);
        requests.push(request);
        return fakeResponse({ outcome: 'reply' });
      },
    });
    const reply = await provider.ask({ text: '오늘 예약 손님 총 몇 명 와?', signal: signal() });
    expect(requests[0]?.snapshot).toEqual([{ featureId: 'voice-booking', condition: { kind: 'default' },
      facts: [{ key: 'booking.people', value: 19, unit: 'person', label: '예약 인원', display: '19명' }] }]);
    expect(reply.answer).toContain('19명');
  });

  it('keeps a capacity check read-only and uses the real business day', async () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const requests: AgentRequest[] = [];
    const provider = createAssistantProvider({ store, fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      expect(validateAgentRequest(request)).toBe(true);
      requests.push(request);
      return fakeResponse({ outcome: 'reply' });
    } });
    const reply = await provider.ask({ text: '17시에 4명 앉을 자리 있어?', signal: signal() });
    expect(requests[0]?.businessDate).toBe(TODAY);
    expect(reply.turn).toMatchObject({ kind: 'read', evidence: [{ tool: 'check_booking_capacity', status: 'ready' }] });
    expect(store.getSnapshot()).toBe(snapshot);
  });
});

interface Scenario {
  id: string;
  utterances: string[];
  expected: {
    kind: 'answer' | 'clarify' | 'proposal' | 'refuse' | 'navigate';
    ask: string[];
    tools: { name: string; args?: Record<string, unknown> }[];
    answer_must_contain: string[];
    allocation?: { status: string; tableId: string | null; warning: string | null };
  };
}
function fakeProvider(store = createWidgetDataStore()) {
  const requests: AgentRequest[] = [];
  const provider = createAssistantProvider({ store, fetcher: async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as AgentRequest;
    if (!validateAgentRequest(body)) throw new Error('Invalid N06 wire request');
    requests.push(body);
    const { intent } = body;
    if (intent.kind === 'read') return fakeResponse({ outcome: 'reply' });
    if (intent.kind !== 'command') return fakeResponse({ outcome: 'refused', refusal: { reason: 'unsupported' } });
    if (intent.command === 'ui.openDetail') return fakeResponse({ outcome: 'navigate', navigation: {
      command: intent.command, args: intent.args, runId: body.runId, layer: body.layer, page: body.page, snapshotRevision: body.snapshotRevision,
    } });
    const proposal = { command: intent.command, args: intent.args, proposalId: 'fake-booking', runId: body.runId, layer: body.layer,
      snapshotRevision: body.snapshotRevision, tier: intent.command === 'booking.cancel' ? 'extra-confirm' : 'normal' };
    return fakeResponse({ outcome: 'proposal' }, proposal);
  } });
  return { provider, requests, store };
}

async function evaluateScenario(text: string, expected: Scenario['expected']) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  const { provider, requests, store } = fakeProvider(createWidgetDataStore(undefined, { runId: run.getState().runId }));
  const before = store.getSnapshot();
  const navigation = createNavisNavigation(run, { highlight() {}, closeChat() {} });
  const plan = classifyNavigation(text, run.getState(), before);
  const prepared = plan && prepareNavigationRequest(plan, run.getState(), navigation);
  let resolved: Parameters<typeof bookingDetailSeed>[1] | undefined;
  try {
    const reply = await provider.ask({ text, signal: signal(), ...(prepared ? {
      agentTurn: prepared.agentTurn,
      onNavigation: value => { resolved = prepared.resolve(value) as typeof resolved; },
    } : {}) });
    expect(store.getSnapshot()).toBe(before);
    const actual = resolved ? 'navigate'
      : reply.turn?.kind === 'proposal' ? 'proposal'
        : reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? 'clarify'
          : reply.turn?.kind === 'refusal' ? 'refuse' : reply.answer ? 'answer' : 'unavailable';
    const field = reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity' ? reply.turn.field : undefined;
    if (actual !== expected.kind || expected.ask.length && !expected.ask.includes(field ?? '')) {
      return `expected ${expected.kind}${expected.ask.length ? ' ' + expected.ask.join('/') : ''}, saw ${actual}${field ? ' ' + field : ''}`;
    }
    const missingCopy = expected.answer_must_contain.filter(value => !reply.answer.includes(value));
    if (missingCopy.length) return `expected ${missingCopy.join(' / ')}, saw ${reply.answer.replaceAll('\n', ' / ')}`;
    const request = requests[0];
    const observed = request?.intent;
    for (const { name, args } of expected.tools) {
      if (name === 'get_widget') {
        if (observed?.kind !== 'read' || observed.featureId !== args?.featureId || JSON.stringify(observed.condition) !== JSON.stringify(args?.condition))
          return 'widget read had a different period or source';
      } else if (name === 'search_records') {
        if (!request?.searches.some(search => search.kind === args?.kind)) return `missing scoped ${String(args?.kind)} search`;
      } else if (name === 'check_booking_capacity') {
        if (!request?.readings?.some(read => read.tool === name)) return 'missing capacity dry run';
      } else if (name === 'open_detail' || name === 'ui.open_detail') {
        if (!resolved || resolved.featureId !== args?.featureId || args?.date && resolved.date !== args.date || args?.view && resolved.view !== args.view)
          return 'requested detail view or date did not open';
      } else if (name.startsWith('booking.') && expected.kind === 'proposal') {
        if (observed?.kind !== 'command' || observed.command !== name) return `expected ${name} wire command`;
        const card = reply.proposalSession;
        if (!card?.getSnapshot().preview?.fields.length) return 'confirmation card missing';
        let receipt = pressConfirm(store, card);
        if (name === 'booking.cancel') {
          if (typeof receipt === 'string' || !receipt?.requiresExtraConfirmation || store.getSnapshot() !== before)
            return 'cancel did not hold for a second confirmation';
          receipt = pressConfirm(store, card);
        }
        if (!receipt || typeof receipt === 'string' || receipt.frame.outcome !== 'applied' || !receipt.undoToken)
          return 'confirm did not produce an undoable receipt';
        const change = store.getSnapshot().tables.reservationChange.at(-1);
        if (store.getSnapshot().tables.reservationChange.length !== before.tables.reservationChange.length + 1 || !change)
          return 'confirmation did not add one history row';
        const visit = store.getSnapshot().tables.reservation.find(row => row.kind !== 'pickup' && row.reservationId === change.reservationId);
        if (!visit || visit.kind === 'pickup') return 'visit did not reflect';
        if (typeof args?.reservationId === 'string' && visit.reservationId !== args.reservationId) return 'a different visit changed';
        if (name === 'booking.cancel' && visit.status !== 'canceled' || name === 'booking.confirm' && visit.status !== 'confirmed') return 'visit status did not reflect';
        if (args?.patch && typeof args.patch === 'object') {
          if ('time' in args.patch && visit.time !== args.patch.time) return 'the revised time did not reflect';
          if ('request' in args.patch && args.patch.request === null && (visit.request !== null || visit.requestKey !== null))
            return 'the stored request or its legacy key was not cleared';
        }
        if (typeof args?.date === 'string' && visit.date !== args.date || typeof args?.time === 'string' && visit.time !== args.time ||
          typeof args?.partySize === 'number' && visit.partySize !== args.partySize) return 'saved visit did not match its requested date, time or party';
        const allocation = expected.allocation;
        if (allocation && (visit.status !== allocation.status || (visit.tableId ?? null) !== allocation.tableId ||
          (visit.allocationWarning ?? null) !== allocation.warning)) return 'allocation differed from the reviewed café selector';
        if (!store.undo(receipt.undoToken).ok || JSON.stringify(store.getSnapshot().tables.reservation) !== JSON.stringify(before.tables.reservation) ||
          JSON.stringify(store.getSnapshot().tables.reservationChange) !== JSON.stringify(before.tables.reservationChange))
          return 'undo did not restore the visits and history';
      }
    }
    return undefined;
  } finally {
    run.dispose();
  }
}

it('runs the 67 reviewed café contracts and traces every assigned utterance', async () => {
  const trace: { scenario_id: string; required_slices: string; slice_id: string }[] = readTrace();
  const assigned = trace.filter(row => row.slice_id === 'N06');
  const requiresBooking = trace.filter(row => row.required_slices.split('|').includes('N06'));
  expect(assigned).toHaveLength(67);
  expect(requiresBooking).toHaveLength(83);
  const { corpus, overlay }: { corpus: Map<string, Scenario>; overlay: Record<string, { reason: string }> } = await readCafeScenarios();
  const archived = new Map((JSON.parse(readFileSync(resolve(process.cwd(), '../.evidence/navis-scenarios/MERGED.json'), 'utf8')) as Scenario[])
    .map(row => [row.id, row]));
  const representativeExceptions: string[] = [], alternateExceptions: string[] = [];
  const archivedResults: string[] = [];
  let utterances = 0;
  for (const { scenario_id: id } of assigned) {
    const row = corpus.get(id);
    if (!row) throw new Error(`Missing scenario ${id}`);
    for (const [index, text] of row.utterances.entries()) {
      const failure = await evaluateScenario(text, row.expected);
      utterances++;
      if (failure) (index === 0 ? representativeExceptions : alternateExceptions).push(`${id}/${index + 1}: ${failure}`);
    }
    const superseded = archived.get(id)?.utterances.filter(text => !row.utterances.includes(text)) ?? [];
    for (const [index, text] of superseded.entries()) {
      const failure = await evaluateScenario(text, { kind: 'answer', ask: [], answer_must_contain: ['확인할 수 있는 매장 자료가 없어요.'],
        tools: [{ name: 'search_records', args: { kind: 'reservation' } }] });
      archivedResults.push(`${id}/original-${index + 1}: ${failure ?? 'stored target is absent'}`);
    }
  }
  expect(utterances).toBe(assigned.reduce((count, row) => count + corpus.get(row.scenario_id)!.utterances.length, 0));
  const dependencyOnly = requiresBooking.filter(row => row.slice_id !== 'N06');
  const reviewed = assigned.filter(row => overlay[row.scenario_id]);
  process.stdout.write([
    `${assigned.length - representativeExceptions.length} of 67 pass, ${representativeExceptions.length} listed exceptions with reasons`,
    ...representativeExceptions,
    `${utterances - assigned.length - alternateExceptions.length} of ${utterances - assigned.length} alternate utterances pass, ${alternateExceptions.length} listed exceptions`,
    ...alternateExceptions,
    `${archivedResults.length} superseded utterances traced against the current café seed`,
    ...archivedResults,
    `${reviewed.length} reviewed café corrections: ${reviewed.map(row => row.scenario_id).join(', ')}`,
    `83 scenarios require N06, including ${dependencyOnly.length} assigned to other slices: ${dependencyOnly.map(row => row.scenario_id).join(', ')}`,
  ].join('\n') + '\n');
  expect(representativeExceptions).toEqual([]);
}, 90_000);

it('shows a warning before applying a booking and reflects a confirmed booking in the calendar until undo', async () => {
  const { provider, store, requests } = fakeProvider();
  expect(store.dispatch({ type: 'calendar.setSourceVisible', source: 'reservation', visible: true }).ok).toBe(true);
  const before = store.getSnapshot();
  const calendar = () => selectCalendar(store.getSnapshot(), { date: TODAY });
  const initialCalendar = calendar();
  const over = await provider.ask({ text: '오늘 저녁 7시에 김서연 31명 예약해줘', signal: signal() });
  expect(over.turn?.kind).toBe('proposal');
  expect(over.proposalSession?.getSnapshot().preview?.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ after: expect.stringContaining('30석') }),
  ]));
  expect(store.getSnapshot()).toBe(before);
  expect(over.proposalSession?.cancel()?.frame.outcome).toBe('cancelled');
  const reply = await provider.ask({ text: '오늘 저녁 7시에 김서연 이름으로 4명 예약 잡아줘', signal: signal() });
  expect(reply.turn?.kind).toBe('proposal');
  expect(reply.proposalSession?.getSnapshot().preview?.target).toBe('김○연');
  expect(JSON.stringify(requests.at(-1))).not.toContain('김서연');
  expect(store.getSnapshot()).toBe(before);
  const receipt = pressConfirm(store, reply.proposalSession);
  expect(receipt).toMatchObject({ frame: { outcome: 'applied' } });
  const created = selectReservations(store.getSnapshot(), { date: TODAY }).rows.find(row => row.guestName && 'raw' in row.guestName && row.guestName.raw === '김○연');
  expect(created).toMatchObject({ date: TODAY, time: '19:00', partySize: 4, status: 'confirmed' });
  expect(calendar().entries.filter(entry => entry.sourceId === created?.reservationId)).toMatchObject([
    { source: 'reservation', date: TODAY, time: '19:00', ref: { featureId: 'voice-booking', itemId: created?.reservationId } },
  ]);
  expect(store.getSnapshot().tables.reservationChange.at(-1)).toMatchObject({ kind: 'created', before: null, after: { reservationId: created?.reservationId } });
  const applied = store.getSnapshot();
  expect((await provider.ask({ text: '되돌려 줘', signal: signal() })).answer).toBe('알림에서 되돌리기를 눌러 주세요');
  expect(store.getSnapshot()).toBe(applied);
  if (!receipt || typeof receipt === 'string' || !receipt.undoToken) throw new Error('No booking undo receipt');
  expect(store.undo(receipt.undoToken).ok).toBe(true);
  expect(calendar()).toEqual(initialCalendar);
  expect(store.getSnapshot().tables.reservationChange).toEqual(before.tables.reservationChange);
}, 20_000);

it('clears both request storage paths and uses an extra confirmation to cancel a stored visit', async () => {
  const { provider, store, requests } = fakeProvider();
  expect(store.dispatch({ type: 'calendar.setSourceVisible', source: 'reservation', visible: true }).ok).toBe(true);
  const before = store.getSnapshot();
  const id = 'sample-booking-1';
  const read = () => selectReservations(store.getSnapshot(), { date: TODAY }).rows.find(row => row.reservationId === id);
  const old = read();
  expect(old).toMatchObject({ request: { raw: '창가 쪽 자리' }, status: 'confirmed' });
  const edit = await provider.ask({ text: '가○손님0008 예약 요청사항 지워줘', signal: signal() });
  expect(edit.turn?.kind).toBe('proposal');
  expect(JSON.stringify(requests.at(-1))).not.toMatch(/가○손님|창가 쪽 자리/u);
  expect(pressConfirm(store, edit.proposalSession)).toMatchObject({ frame: { outcome: 'applied' } });
  expect(read()).toMatchObject({ request: null, requestKey: null, memberId: old?.memberId, time: old?.time });
  const cancel = await provider.ask({ text: '가○손님0008 예약 취소해줘', signal: signal() });
  expect(cancel.turn?.kind).toBe('proposal');
  expect(pressConfirm(store, cancel.proposalSession)).toMatchObject({ requiresExtraConfirmation: true });
  expect(read()?.status).toBe('confirmed');
  const receipt = pressConfirm(store, cancel.proposalSession);
  expect(receipt).toMatchObject({ frame: { outcome: 'applied' } });
  expect(read()).toMatchObject({ status: 'canceled', request: null, tableId: null });
  expect(selectCalendar(store.getSnapshot(), { date: TODAY }).entries.some(entry => entry.sourceId === id)).toBe(false);
  expect(store.getSnapshot().tables.reservationChange.slice(before.tables.reservationChange.length).map(change => change.kind)).toEqual(['updated', 'canceled']);
  if (!receipt || typeof receipt === 'string' || !receipt.undoToken) throw new Error('No booking undo receipt');
  expect(store.undo(receipt.undoToken).ok).toBe(true);
  expect(read()).toMatchObject({ status: 'confirmed', request: null });
}, 20_000);

it('keeps ambiguous targets read-only until an owner chooses an exact visit', async () => {
  const { provider, store, requests } = fakeProvider();
  for (const time of ['17:00', '19:00']) {
    expect(store.dispatch({ type: 'booking.create', date: TODAY, time, partySize: 2,
      guest: { name: '박수현' }, tableChoice: 'auto', idempotencyKey: `choice-${time}` }).ok).toBe(true);
  }
  const before = store.getSnapshot();
  const reply = await provider.ask({ text: '박○현 예약 취소해줘', signal: signal() });
  const turn = reply.turn;
  if (turn?.kind !== 'ambiguity') throw new Error('Expected scoped target choices');
  expect(turn.choices.map(choice => choice.detail)).toEqual([
    expect.stringContaining('17:00'), expect.stringContaining('19:00'),
  ]);
  expect(requests).toEqual([]);
  const result = await provider.ask({ text: '박○현 예약 취소해줘', signal: signal(),
    continuation: { clarificationId: turn.id, choiceId: turn.choices[1].id } });
  expect(requests[0]?.searches[0]?.matches).toEqual([
    expect.objectContaining({ match: 'exact', fields: expect.objectContaining({ time: '19:00' }) }),
  ]);
  expect(result.turn).toMatchObject({ kind: 'proposal', proposal: { tier: 'extra-confirm' } });
  expect(store.getSnapshot()).toBe(before);
});

it('offers an outbound suggestion as a local widget draft and does not dispatch it', async () => {
  const { provider, store, requests } = fakeProvider();
  const before = store.getSnapshot();
  const reply = await provider.ask({ text: '가○손님0052 예약 20시로 제안 보내줘', signal: signal() });
  expect(reply.turn).toMatchObject({ kind: 'handoff', destination: { featureId: 'voice-booking', command: 'booking.propose',
    draft: { reservationId: 'sample-booking-3', time: '20:00' } } });
  expect(requests).toEqual([]);
  expect(store.getSnapshot()).toBe(before);
  const ref = bookingDomain.handoff?.('booking.propose', { reservationId: 'sample-booking-3', time: '20:00' });
  expect(ref && bookingDetailSeed(before, ref)).toMatchObject({ suggestion: '20:00', row: { reservationId: 'sample-booking-3' } });
});

it('uses the row date when opened by ID and seeds a registration form without saving', () => {
  const store = createWidgetDataStore();
  const tomorrow = addDays(TODAY, 1);
  expect(store.dispatch({ type: 'booking.create', date: tomorrow, time: '12:00', partySize: 2,
    guest: { name: '박수현' }, tableChoice: 'auto', idempotencyKey: 'date-witness' }).ok).toBe(true);
  const snapshot = store.getSnapshot();
  const id = selectReservations(snapshot, { date: tomorrow }).rows[0].reservationId;
  expect(bookingDetailSeed(snapshot, { featureId: 'voice-booking', itemId: id }).row?.date).toBe(tomorrow);
  const ref = bookingDomain.navigation?.('내일 오후 3시 김서연 이름으로 4명 예약 등록 창 열어줘', snapshot, 'ko')?.args;
  expect(ref).toMatchObject({ featureId: 'voice-booking', view: 'register', prefill: { date: tomorrow, time: '15:00', partySize: 4, guest: { name: '김서연' } } });
  expect(store.getSnapshot()).toBe(snapshot);
});

it('covers the booking translations in both bundled weights of each Chinese font', () => {
  for (const [locale, target] of [['zh-Hans', 'NavisHans'], ['zh-Hant', 'NavisHant']] as const) {
    const chars = new Set(Object.values(bookingBundle[locale]).join('').split('').filter(character => NEEDED.test(character)));
    for (const weight of [500, 700]) {
      const path = resolve(process.cwd(), `src/assets/fonts/${target}-${weight}.woff2`);
      const cmap = woff2Cmap(new Uint8Array(readFileSync(path)));
      expect([...chars].filter(character => !cmap.has(character.codePointAt(0)!)), `${locale} ${weight}`).toEqual([]);
    }
  }
});

it('keeps the routed menu-price simulator inside the bridge first-turn budget', async () => {
  const store = createWidgetDataStore();
  const domain = {
    commands: [], reads: [], featureIds: ['menu', 'margin'] as const,
    tools: [{ tool: 'simulate_menu_price' as const, read: () => ({
      facts: [
        { key: 'margin.simulation.price', value: 5000, label: '판매가', display: '5,000원', unit: 'KRW' },
        { key: 'margin.simulation.unitCost', value: 1000, label: '원가', display: '1,000원', unit: 'KRW' },
        { key: 'margin.simulation.unitMargin', value: 4000, label: '잔당 이익', display: '4,000원', unit: 'KRW' },
        { key: 'margin.simulation.rate', value: 80, label: '이익률', display: '80%', unit: 'percent' },
      ],
    }) }],
    route: () => ({
      intent: { kind: 'read', tool: 'simulate_menu_price' },
      slots: { name: '아메리카노', price: 5000 },
      lookups: [{ kind: 'menu', querySlot: 'name', bind: ['menu'] }],
      reading: { tool: 'simulate_menu_price', args: { menu: { handle: 'picked-menu' }, price: { slot: 'price' } } },
    } as const),
  };
  const reader = {
    kind: 'menu' as const,
    search: () => [{ handle: 'picked-menu', match: 'exact' as const }],
    resolve: () => 'm-americano',
  };
  let modelRequests: readonly { tools?: readonly { function: { name: string } }[] }[] = [];
  let catalogIds: string[] = [];
  let bridgeError: unknown;
  const provider = createAssistantProvider({
    store, domains: createDomainRegistry([domain, { commands: [], reads: [reader] }]),
    async fetcher(_url, options) {
      const request = JSON.parse(String(options?.body)) as AgentRequest;
      catalogIds = request.catalog.map(entry => entry.id).sort();
      try {
        const { requests, done } = await runNavisBookingFixture(createBridge, validateAgentFrame, request, [
          { name: 'search_records', args: { kind: 'menu', querySlot: 'name' } },
          { name: 'simulate_menu_price', args: { menu: { handle: 'picked-menu' }, price: { slot: 'price' } } },
        ], { outcome: 'reply', facts: ['f2'] });
        modelRequests = requests;
        return fakeResponse(done);
      } catch (error) {
        bridgeError = error;
        throw error;
      }
    },
  });
  const reply = await provider.ask({ text: '아메리카노 가격을 5,000원으로 바꾸면 이익은?', signal: signal() });
  expect(catalogIds).toEqual(['margin', 'menu']);
  expect(bridgeError).toBeUndefined();
  expect(modelRequests).toHaveLength(3);
  expect(modelRequests[0]?.tools?.map(tool => tool.function.name).sort()).toEqual(['search_records', 'simulate_menu_price']);
  expect(reply.answer).toContain('4,000원');
});
