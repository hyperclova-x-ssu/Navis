// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, agentCommandPolicy, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../../shared/navis-agent-schema.mjs';
import { getManagementTemplates, getRegistry } from '../../../catalog';
import type { FeatureId, Panel, RunState } from '../../../contracts';
import { addDays, TODAY } from '../../../data/db/time';
import { createWidgetDataStore } from '../../../data/widget-data';
import { samePanels, screenPresets } from '../../../layout';
import { testTime } from '../../../layout/test-policy';
import { classifyNavigation } from '../../../screens/dashboard/navis-navigation';
import { createRunStore, type ChatReceiptNoticeRequest } from '../../../state';
import { planNavisLayout } from '../../../state/navis-layout';
import { completeEmptyOnboarding } from '../../../state/test-fixtures';
import { agentReceiptStatus, applyAgentReceiptUndo } from '../agent-actions';
import { createAssistantProvider } from '../provider';
import type { ProposalSession } from '../navis-conversation';
import { createDomainRegistry } from './registry';
import { isNavisLayoutNavigationConflict, layoutDomain, projectNavisBoard } from './layout';
// @ts-expect-error The trace loader is shared with the server contract tests.
import { readTrace } from '../../../../server/navis/scenario-fixtures.mjs';

type Scenario = { id: string; utterances: string[]; expected: {
  kind: 'answer' | 'clarify' | 'proposal' | 'refuse'; ask?: string[]; answer_must_contain?: string[];
  tools: { name: string; args?: Record<string, unknown> }[];
} };
type Trace = { scenario_id: string; slice_id: string; required_slices: string };
const directory = new URL('../../../../../.evidence/navis-scenarios/', import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
const trace: Trace[] = readTrace();
const corpus: Scenario[] = readJson('MERGED.json');
const overlay: Record<string, { expected?: Partial<Scenario['expected']>; variants?: Record<string, { expected: Partial<Scenario['expected']> }> }> = readJson('CAFE-OVERLAY.json');
const scenarios = trace.filter(row => row.slice_id === 'N07').map(row => {
  const base = corpus.find(item => item.id === row.scenario_id)!;
  return { ...base, expected: { ...base.expected, ...overlay[base.id]?.expected } };
});

const template = getManagementTemplates({ businessType: 'cafe', paymentStyle: 'prepaid', presetId: 'A' })[0].panels;
const panel = (featureId: FeatureId, column: number, row: number, width = 1, height = 1): Panel => ({ featureId, column, row, width, height });
const full = [...template, ...(['tax', 'grants', 'manuals', 'members', 'staff-schedule', 'credit-receivable', 'store-environment', 'custom-order'] as const)
  .map((id, index) => panel(id, index < 2 ? index + 4 : index - 2, index < 2 ? 2 : 3))];
const nearFull = [
  panel('custom-order', 0, 0, 2, 2), panel('suppliers', 2, 0, 2, 2), panel('tax', 4, 0, 2, 2),
  panel('credit-receivable', 0, 2, 2), panel('members', 2, 2, 2), panel('customer-analysis', 4, 2, 2),
  ...(['store-environment', 'manuals', 'grants', 'staff-schedule', 'voice-booking'] as const).map((id, column) => panel(id, column, 3)),
];

function fixture(id: string, clock = () => 0) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, theme: 'light', clock });
  completeEmptyOnboarding(run);
  const empty = ['S5-079', 'S7-059', 'S7-060', 'S7-216'].includes(id);
  const first = id === 'S7-025' ? [panel('menu', 0, 0)] : ['S7-010', 'S7-049'].includes(id) ? full : template;
  if (!empty) expect(run.actions.applyLayoutIntent({ type: 'restore', panels: first }).status).toBe('accepted');
  const pages = ['S7-021', 'S7-036', 'S7-037', 'S7-038', 'S7-040', 'S7-183', 'S7-219'].includes(id) ? 2 : ['S7-039', 'S7-052'].includes(id) ? 5 : 1;
  for (let page = 1; page < pages; page++) expect(run.actions.addPage().ok).toBe(true);
  if (id === 'S7-040') expect(run.actions.applyLayoutIntent({ type: 'restore', panels: nearFull }).status).toBe('accepted');
  run.actions.goToPage(0);
  if (id === 'S7-021') {
    expect(run.actions.movePanelToPage('calendar', 1).status).toBe('accepted');
    run.actions.goToPage(0);
  }
  if (['S5-079', 'S7-009', 'S7-023', 'S7-024', 'S7-060'].includes(id)) {
    expect(run.actions.switchLayer('marketing')).toBe(true);
    if (!empty) {
      expect(run.actions.startWithPreset().status).toBe('accepted');
      if (id === 'S7-009') for (const featureId of ['slot-coupon', 'expiry-coupon', 'coupon-status'] as const) {
        expect(run.actions.applyLayoutIntent({ type: 'remove', featureId }).status).toBe('accepted');
      }
    }
  }
  run.actions.acknowledgeBriefing();
  return run;
}

const openSignal = () => new AbortController().signal;
function press(session: ProposalSession, store: ReturnType<typeof createWidgetDataStore>, id: string, extra?: true) {
  const result = session.confirm(store, id, extra);
  if (!result || typeof result === 'string') throw new Error(`Expected a receipt, got ${result}`);
  return result;
}
function transport(requests: AgentRequest[]) {
  return async (_url: RequestInfo | URL, options?: RequestInit) => {
    const body: unknown = JSON.parse(String(options?.body));
    if (!validateAgentRequest(body)) throw new Error('Invalid N07 browser request');
    requests.push(body);
    const frame = (event: 'panels' | 'action_proposal' | 'done', data: unknown) => {
      if (!validateAgentFrame(event, data)) throw new Error(`Invalid N07 fake frame ${event}`);
      return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    };
    let response = frame('panels', { panels: [] });
    if (body.intent.kind === 'command' && body.intent.command.startsWith('layout.')) {
      response += frame('action_proposal', { command: body.intent.command, args: body.intent.args,
        runId: body.runId, layer: body.layer, page: body.page, snapshotRevision: body.snapshotRevision, proposalId: 'layout-test',
        tier: agentCommandPolicy(body.intent.command, body.intent.args).confirmation });
      response += frame('done', { outcome: 'proposal' });
    } else response += frame('done', { outcome: 'reply' });
    return new Response(response, { headers: { [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
  };
}

function assertApplied(id: string, state: RunState) {
  const board = state.boards[state.activeBoard];
  const current = board.pages[board.currentPage].panels;
  const lookup = (featureId: FeatureId) => current.find(panel => panel.featureId === featureId);
  switch (id) {
    case 'S5-079': expect(lookup('community')).toMatchObject(panel('community', 0, 0)); break;
    case 'S7-001': expect(lookup('tax')).toMatchObject(panel('tax', 4, 2)); break;
    case 'S7-002': expect(lookup('tax')).toMatchObject(panel('tax', 4, 2, 2, 2)); break;
    case 'S7-003': expect(lookup('tax')).toMatchObject(panel('tax', 0, 3)); break;
    case 'S7-004':
      expect(lookup('tax')).toMatchObject(panel('tax', 0, 2));
      expect(lookup('inventory-booking')).not.toMatchObject({ column: 0, row: 2 });
      break;
    case 'S7-016':
      expect(lookup('suppliers')).toMatchObject(panel('suppliers', 4, 2));
      expect(lookup('tax')).toMatchObject(panel('tax', 5, 2));
      break;
    case 'S7-019': expect(lookup('ledger')).toMatchObject({ ...panel('ledger', 2, 0, 2), condition: { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } }); break;
    case 'S7-020': expect(lookup('margin')).toBeUndefined(); break;
    case 'S7-021': expect(board.currentPage).toBe(0); expect(board.pages.every(page => page.panels.every(panel => panel.featureId !== 'calendar'))).toBe(true); break;
    case 'S7-025': expect(current).toEqual([]); expect(board.starter).toBe('ready'); break;
    case 'S7-028': expect(lookup('margin')).toBeUndefined(); expect(lookup('calendar')).toBeUndefined(); break;
    case 'S7-029': expect(lookup('menu')).toMatchObject(panel('menu', 0, 3, 2)); break;
    case 'S7-030': expect(lookup('inventory-booking')).toMatchObject(panel('inventory-booking', 1, 2, 2)); expect(lookup('menu')).not.toMatchObject({ column: 2, row: 2 }); break;
    case 'S7-031': expect(lookup('margin')).toMatchObject(panel('margin', 2, 2, 2)); expect(lookup('menu')).toMatchObject(panel('menu', 2, 1, 2)); break;
    case 'S7-036': case 'S7-039':
      expect(board.currentPage).toBe(id === 'S7-036' ? 1 : 4);
      expect(lookup('inventory-booking')).toMatchObject(panel('inventory-booking', 0, 2, 2));
      expect(board.pages[0].panels.some(panel => panel.featureId === 'inventory-booking')).toBe(false);
      break;
    case 'S7-042': expect(lookup('inventory-booking')).toMatchObject(panel('inventory-booking', 0, 2, 2, 2)); break;
    case 'S7-048': expect(lookup('briefing')).toMatchObject(panel('briefing', 0, 0)); break;
    case 'S7-050': expect(lookup('inventory-booking')).toMatchObject(panel('inventory-booking', 0, 2, 3)); expect(lookup('menu')).not.toMatchObject({ column: 2, row: 2 }); break;
    case 'S7-051': expect(board.currentPage).toBe(1); expect(current).toEqual([]); expect(board.undo).toBeNull(); break;
    case 'S7-059': expect(current).toMatchObject([panel('ledger', 0, 0), panel('margin', 1, 0), panel('calendar', 2, 0)]); break;
    case 'S7-060': expect(current).toHaveLength(7); // D-365: the starting marketing board lost 마케팅 성과 (8 -> 7)
       expect(lookup('marketing-today')).toMatchObject(panel('marketing-today', 0, 0, 4)); break;
    case 'S7-218': expect(lookup('briefing')).toMatchObject(panel('briefing', 0, 0, 3, 3));
      for (const id of ['ledger', 'margin', 'inventory-booking', 'menu'] as const) {
        const old = template.find(panel => panel.featureId === id)!;
        expect(lookup(id)).not.toMatchObject({ column: old.column, row: old.row });
      }
      break;
    default: throw new Error(`No applied-state assertion for ${id}`);
  }
}

async function evaluate(scenario: Scenario, fullRegistry = false) {
  const run = fixture(scenario.id), before = run.getState();
  const store = createWidgetDataStore(undefined, { runId: before.runId });
  const requests: AgentRequest[] = [];
  const provider = createAssistantProvider({ run, store, domains: fullRegistry ? undefined : createDomainRegistry([layoutDomain]), fetcher: transport(requests) });
  const ask = (text: string) => provider.ask({ text, layer: before.activeBoard, locale: 'ko', signal: openSignal() });
  const beforeData = store.getSnapshot();
  try {
    if (fullRegistry && !isNavisLayoutNavigationConflict(scenario.utterances[0])) {
      expect(classifyNavigation(scenario.utterances[0], before, beforeData)).toBeUndefined();
    }
    const reply = await ask(scenario.utterances[0]);
    const session = reply.proposalSession;
    expect(run.getState()).toBe(before);
    expect(store.getSnapshot()).toBe(beforeData);
    if (scenario.id === 'S7-180') {
      expect(session).toBeDefined();
      expect(run.actions.applyLayoutIntent({ type: 'move', featureId: 'calendar', column: 4, row: 2 }).status).toBe('accepted');
      const changed = run.getState(), card = session!.getSnapshot().proposal;
      expect(press(session!, store, card.id).requiresExtraConfirmation).toBe(true);
      expect(press(session!, store, card.id, true).frame.outcome).toBe('conflict');
      expect(run.getState()).toBe(changed);
      expect(session!.getSnapshot().reproposed).toBe(true);
      expect(changed.panels.some(panel => panel.featureId === 'margin')).toBe(true);
      return;
    }
    const kind = session ? 'proposal' : reply.turn?.kind === 'clarification' ? 'clarify' : reply.turn?.kind === 'refusal' ? 'refuse' : 'answer';
    const expected = scenario.expected;
    expect(kind, `${reply.answer} ${JSON.stringify(requests[0]?.intent)}`).toBe(expected.kind);
    if (reply.turn?.kind === 'clarification' && expected.ask?.length) expect(expected.ask).toContain(reply.turn.field);
    const preview = session?.getSnapshot().preview;
    const copy = [reply.answer, preview?.title, ...preview?.fields.flatMap(field => [field.label, field.before, field.after]) ?? []].join('\n');
    const isAddition = session?.getSnapshot().proposal.command === 'layout.add_widget' || session?.getSnapshot().proposal.command === 'layout.add_widgets';
    for (const value of expected.answer_must_contain ?? []) {
      // D-365: the corpus row S7-060 still says 8개; the marketing start layout has seven widgets now (corpus patch for B17: S7-060 -> 7개).
      const wording = value === '어느 위젯' ? '어느 패널' : scenario.id === 'S7-060' && value === '8개' ? '7개' : isAddition ? value.replace(/^(\d+)x(\d+)$/u, '가로 $1칸, 세로 $2칸') : value;
      expect(copy).toContain(wording);
    }
    if (expected.tools.some(tool => tool.name === 'get_board')) {
      const request = requests[0];
      expect(request.intent).toMatchObject({ kind: 'read', tool: 'get_board' });
      expect(request.readings).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'get_board' })]));
    }
    if (!session) return;
    const request = requests[0];
    const intended = expected.tools.filter(tool => tool.name.startsWith('layout.'));
    if (scenario.id === 'S7-028') expect(request.intent).toMatchObject({ kind: 'command', command: 'layout.remove_widgets', args: { featureIds: ['margin', 'calendar'] } });
    else expect(request.intent).toMatchObject({ kind: 'command', command: intended[0].name, args: intended[0].args ?? {} });
    expect(request.readings?.[0]).toMatchObject({ tool: 'get_board' });
    if (scenario.id === 'S7-036' || scenario.id === 'S7-039') {
      expect(request.readings?.[1]).toMatchObject({ tool: 'get_board', args: { page: scenario.id === 'S7-036' ? 2 : 5 } });
    }
    const card = session.getSnapshot().proposal;
    expect(session.confirm(store, 'another-card')).toBeUndefined();
    await ask('응, 실행해');
    await ask('네');
    expect(run.getState()).toBe(before);
    const first = press(session, store, card.id);
    const removing = ['S7-020', 'S7-021', 'S7-025', 'S7-028'].includes(scenario.id);
    let receipt = first;
    if (removing) {
      expect(first.requiresExtraConfirmation).toBe(true);
      expect(run.getState()).toBe(before);
      receipt = press(session, store, card.id, true);
    }
    expect(receipt.frame.outcome).toBe('applied');
    const applied = run.getState();
    expect(applied.layoutRevision).toBe(before.layoutRevision + Number(scenario.id !== 'S7-051'));
    assertApplied(scenario.id, applied);
    session.confirm(store, card.id, true);
    expect(run.getState()).toBe(applied);
    if (scenario.id !== 'S7-051') {
      const identity = session.getSnapshot().receiptIdentity;
      if (!identity || !receipt.notice || !receipt.undoToken) throw new Error('Expected a reversible chat receipt');
      const notice: ChatReceiptNoticeRequest = { ...receipt.notice, chatReceipt: identity };
      run.actions.showNotice(notice);
      run.actions.setChatReceiptVisible(identity, true);
      const beforeUndo = run.getState();
      expect((await ask('되돌려줘')).answer).toContain('영수증');
      expect(run.getState()).toBe(beforeUndo);
      expect(applyAgentReceiptUndo(run, store, identity, receipt.undoToken)).toBe(true);
      expect(applyAgentReceiptUndo(run, store, identity, receipt.undoToken)).toBe(false);
      const original = before.boards[before.activeBoard];
      expect(run.getState().boards[before.activeBoard].pages.every((page, index) => samePanels(page.panels, original.pages[index].panels))).toBe(true);
    }
    expect(store.getSnapshot()).toBe(beforeData);
  } finally { run.dispose(); }
}

describe('N07 TRACE client contracts', () => {
  it('contains 54 primary rows and 12 additional rows listing N07 as required', () => {
    expect(scenarios).toHaveLength(54);
    expect(trace.filter(row => row.required_slices.split('|').includes('N07'))).toHaveLength(66);
  });
  it.each(scenarios)('$id follows the reviewed contract', async scenario => {
    await evaluate(scenario);
    for (const [position, variant] of Object.entries(overlay[scenario.id]?.variants ?? {})) {
      await evaluate({ ...scenario, utterances: [scenario.utterances[Number(position) - 1]],
        expected: { ...scenario.expected, ...variant.expected } });
    }
  });
  it('replays the S7-001 dependent placement anchor', () => evaluate(corpus.find(scenario => scenario.id === 'S7-001')!));
  it.each(scenarios.filter(s => ['S7-016', 'S7-019', 'S7-020'].includes(s.id)).flatMap(s =>
    s.utterances.map(text => [s.id, text, s] as const)))('%s routes %s through one bound card', (_id, text, s) =>
    evaluate({ ...s, utterances: [text] }, true));

  it('keeps an explicit detail open and supplier order on their own routes', async () => {
    const run = fixture('S7-019'), before = run.getState();
    const store = createWidgetDataStore(undefined, { runId: before.runId });
    const provider = createAssistantProvider({ run, store, fetcher: transport([]) });
    try {
      const text = '최근 7일 기준으로 손익 자세히 보기 열어줘';
      expect(isNavisLayoutNavigationConflict(text)).toBe(false);
      expect(classifyNavigation(text, before, store.getSnapshot())).toMatchObject({ command: 'ui.openDetail' });
      const order = await provider.ask({ text: '우유 5개 발주해줘', signal: openSignal() });
      expect(order.proposalSession).toBeUndefined();
      expect(run.getState()).toBe(before);
    } finally { run.dispose(); }
  });

  it('keeps the S7-096 panel-finding request as navigation', () => {
    const run = fixture('S7-096'), before = run.getState();
    const store = createWidgetDataStore(undefined, { runId: before.runId });
    const text = '재고 패널 어디야';
    try {
      expect(isNavisLayoutNavigationConflict(text)).toBe(false);
      expect(classifyNavigation(text, before, store.getSnapshot())).toMatchObject({ command: 'ui.show_panel', args: { featureId: 'inventory-booking' } });
    } finally { run.dispose(); }
  });

  it('expires the layout chat receipt at the original deadline', async () => {
    let now = 0;
    const run = fixture('S7-016', () => now), before = run.getState();
    const store = createWidgetDataStore(undefined, { runId: before.runId });
    const provider = createAssistantProvider({ run, store, fetcher: transport([]), clock: () => now });
    const ask = (text: string) => provider.ask({ text, signal: openSignal() });
    try {
      const card = (await ask('발주랑 세무관리 둘 다 추가해줘')).proposalSession!;
      const receipt = press(card, store, card.getSnapshot().proposal.id);
      const identity = card.getSnapshot().receiptIdentity!;
      const token = run.getState().boards.management.undo?.token;
      if (!token) throw new Error('Expected the underlying layout undo token');
      const notice: ChatReceiptNoticeRequest = {
        ...receipt.notice!, chatReceipt: identity, layoutUndo: { layer: 'management', token },
      };
      run.actions.showNotice(notice);
      run.actions.setChatReceiptVisible(identity, true);
      const applied = run.getState();
      expect(agentReceiptStatus(run, receipt, identity)).toBe('applied');
      now += testTime.undoMs + 1;
      expect((await ask('되돌려줘')).answer).toContain('시간이 지났어요');
      expect(applyAgentReceiptUndo(run, store, identity, receipt.undoToken!)).toBe(false);
      expect(agentReceiptStatus(run, receipt, identity)).toBe('expired');
      const board = run.getState().boards.management;
      expect(board.pages).toEqual(applied.boards.management.pages);
      expect(board.undo).toBeNull();
    } finally { run.dispose(); }
  });

  it.each([false, true])('rechecks whether page 3 still needs to be created (created meanwhile: %s)', async existing => {
    const run = fixture('S7-038');
    const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
    const requests: AgentRequest[] = [];
    const provider = createAssistantProvider({ run, store, fetcher: transport(requests) });
    const text = '재고를 3페이지로 보내줘';
    const ask = () => provider.ask({ text, signal: openSignal() });
    try {
      const { turn } = await ask();
      expect(turn).toMatchObject({ kind: 'clarification', field: 'confirmAddPage',
        choices: [{ id: 'add-page', label: '페이지 추가하기' }] });
      if (turn?.kind !== 'clarification') throw new Error('Expected a page clarification');
      if (existing) expect(run.actions.addPage().ok).toBe(true);
      const before = run.getState();
      expect((await provider.ask({ text: '응', signal: openSignal() })).proposalSession).toBeUndefined();
      const reply = await provider.ask({ text, signal: openSignal(), continuation: { clarificationId: turn.id, choiceId: 'add-page' } });
      const command = existing ? 'layout.move_to_page' : 'layout.add_page';
      expect(reply.proposalSession?.getSnapshot().proposal.command).toBe(command);
      expect(requests.at(-1)?.intent).toMatchObject({ kind: 'command', command, args: existing
        ? { featureId: 'inventory-booking', page: 1, destinationPage: 3 } : { layer: 'management' } });
      expect(run.getState()).toBe(before);
    } finally { run.dispose(); }
  });

  it('keeps the requested size when the owner names a missing widget', async () => {
    const run = fixture('S7-220'), before = run.getState();
    const store = createWidgetDataStore(undefined, { runId: before.runId });
    const requests: AgentRequest[] = [];
    const provider = createAssistantProvider({ run, store, fetcher: transport(requests) });
    try {
      const reply = await provider.ask({ text: '새 위젯 올리고 2x2로', signal: openSignal() });
      expect(reply.turn).toMatchObject({ kind: 'clarification', field: 'featureId' });
      if (reply.turn?.kind !== 'clarification') throw new Error('Expected a widget question');
      const next = await provider.ask({ text: '세무관리', signal: openSignal(),
        continuation: { clarificationId: reply.turn.id, value: '세무관리' } });
      expect(next.proposalSession?.getSnapshot().proposal.command).toBe('layout.add_widget');
      expect(requests[0]?.intent).toMatchObject({ args: { featureId: 'tax', width: 2, height: 2 } });
      expect(run.getState()).toBe(before);
    } finally { run.dispose(); }
  });
  const boardVariants = ['S7-002', 'S7-003', 'S7-004', 'S7-005', 'S7-021', 'S7-022', 'S7-025', 'S7-028',
    'S7-029', 'S7-030', 'S7-031', 'S7-032', 'S7-033', 'S7-034', 'S7-035', 'S7-036', 'S7-037', 'S7-038',
    'S7-039', 'S7-040', 'S7-042', 'S7-043', 'S7-044', 'S7-045', 'S7-046', 'S7-047', 'S7-048', 'S7-050', 'S7-051', 'S7-052',
    'S7-059', 'S7-060', 'S7-061', 'S7-182', 'S7-183', 'S7-184', 'S7-185', 'S7-186', 'S7-187', 'S7-216', 'S7-218', 'S7-219', 'S7-220'];
  const variantCases = scenarios.filter(s => boardVariants.includes(s.id)).flatMap(s => s.utterances.slice(1).map(text => [s.id, text, s] as const));
  it.each(variantCases)('%s resolves the board wording %s', (_id, text, s) => evaluate({ ...s, utterances: [text] }, true));
  it('projects occupied and open cells from the actual active preset', () => {
    const run = fixture('S7-184');
    const projection = projectNavisBoard(run.getState(), { layer: 'management', page: 1 }, 'ko');
    expect(projection).toMatchObject({ facts: expect.arrayContaining([
      expect.objectContaining({ key: 'board.cells.free', value: 8 }),
      expect.objectContaining({ key: 'board.panel.inventory-booking.column', value: 0 }),
      expect.objectContaining({ key: 'board.panel.inventory-booking.page', value: 1 }),
    ]) });
    run.dispose();
  });
});

it('can hold the layout success notice until the account write settles while retaining undo', () => {
  const run = fixture('S7-001');
  const prepared = planNavisLayout(run.getState(), 'management', [
    { kind: 'layout', page: 0, intent: { type: 'add-tap', featureId: 'tax' } },
  ]);
  if (prepared.kind !== 'ready') throw new Error('Expected a layout plan');
  expect(run.actions.commitNavisLayout(prepared.plan, { deferNotice: true }).status).toBe('accepted');
  const board = run.getState().boards.management;
  expect(board.notice).toBeNull();
  expect(board.undo?.token).toBeTruthy();
  expect(run.actions.undo(board.undo!.token).status).toBe('accepted');
  expect(run.getState().boards.management.pages[0].panels.some(item => item.featureId === 'tax')).toBe(false);
});
