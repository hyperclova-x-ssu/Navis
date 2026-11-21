import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAssistantProvider } from '../../features/assistant';
import { createWidgetDataStore, dataBundles, readModel, resolveDataText, type WidgetDataStore } from '../../data/widget-data';
import { supportedConditions } from '../../data/conditions';
import { createTranslator } from '../../i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../../app/App';
import { sseFrame } from '../../features/assistant/stream-fixture';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../app/test-session';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { classifyNavigation, createNavisNavigation, NAVIS_RETURN_FOCUS, prepareNavigationRequest } from './navis-navigation';

const ko = createTranslator('ko', ...dataBundles);
function milkIn(snapshot: ReturnType<WidgetDataStore['getSnapshot']>) {
  const matches = readModel(snapshot, 'inventory-booking').ingredients.map(item => ({
    ...item, label: resolveDataText(ko.t, item.name ?? { key: item.nameKey }),
  })).filter(item => /(?:^|\s)우유$/u.test(item.label));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

const disposals: (() => void)[] = [];
const Pointer = window.PointerEvent;
beforeEach(() => vi.stubGlobal('PointerEvent', Pointer));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); disposals.splice(0).reverse().forEach(dispose => dispose()); });

function setup() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  const highlighted: string[] = [];
  const navigation = createNavisNavigation(run, { highlight: id => highlighted.push(id), closeChat: () => {} });
  disposals.push(run.dispose, navigation.attach());
  return { run, navigation, highlighted };
}

it('opens an off-board detail without placing it and retains the chat as the return target', async () => {
  const { run, navigation } = setup();
  expect(await navigation.execute('ui.openDetail', { featureId: 'coupon-status' })).toBe('opened');
  expect(run.getState().overlay).toEqual({ type: 'detail', featureId: 'coupon-status', returnFocusKey: NAVIS_RETURN_FOCUS });
  expect(run.getState().layer).toBe('management');
  expect(run.getState().panels).toEqual([]);
});

it('retains only allowable detail routing and expands a locally validated item and view', async () => {
  const { run, navigation } = setup();
  const { itemId } = milkIn(createWidgetDataStore().getSnapshot());
  expect(await navigation.execute('ui.openDetail', { featureId: 'inventory-booking', tab: 'history', view: 'products', itemId })).toBe('invalid');
  expect(await navigation.execute('ui.openDetail', { featureId: 'inventory-booking', tab: 'history', itemId })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'inventory-booking', view: 'history', itemId }] });
});

it('remembers page and layer visits and uses the shared linked-detail back path', async () => {
  const { run, navigation } = setup();
  run.actions.addPage();
  run.actions.goToPage(0);
  expect(await navigation.execute('ui.go_to_page', { page: 2 })).toBe('opened');
  expect(await navigation.execute('ui.switch_layer', { layer: 'pos' })).toBe('opened');
  expect(await navigation.execute('ui.go_back', {})).toBe('opened');
  expect(run.getState()).toMatchObject({ layer: 'management', boards: { management: { currentPage: 1 } } });
  expect(await navigation.execute('ui.go_back', {})).toBe('opened');
  expect(run.getState().boards.management.currentPage).toBe(0);
  await navigation.execute('ui.openDetail', { featureId: 'menu' });
  await navigation.execute('ui.openDetail', { featureId: 'ledger', tab: 'expenses' });
  expect(await navigation.execute('ui.go_back', {})).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'menu' });
});

it('uses the existing overlay exit boundary and abandons a cancelled navigation', async () => {
  const { run, navigation } = setup();
  await navigation.execute('ui.open_drawer', { group: 'stock' });
  const controller = new AbortController();
  const pending = navigation.execute('ui.openDetail', { featureId: 'menu' }, controller.signal);
  const token = run.getState().exitPendingToken!;
  expect(token).toBeTruthy();
  controller.abort();
  run.actions.finishOverlayExit(token);
  expect(await pending).toBe('stale');
  expect(run.getState().overlay.type).toBe('none');
});

it('waits for a just-closed detail to finish leaving instead of refusing the next hand-off', async () => {
  const { run, navigation } = setup();
  expect(await navigation.execute('ui.openDetail', { featureId: 'menu' })).toBe('opened');
  const token = run.actions.closeOverlay('button')!;
  expect(run.getState()).toMatchObject({ overlay: { type: 'none' }, exitPendingToken: token });
  // The server is told the app is free: only the exit animation is left, and the app waits for it.
  expect(navigation.busy()).toBe(false);
  const pending = navigation.execute('ui.openDetail', { featureId: 'customer-analysis', hour: 14 });
  expect(run.getState().overlay.type).toBe('none');
  run.actions.finishOverlayExit(token);
  expect(await pending).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'customer-analysis' });
  const second = run.actions.closeOverlay('button')!;
  const aborted = new AbortController();
  const stale = navigation.execute('ui.openDetail', { featureId: 'ledger' }, aborted.signal);
  aborted.abort();
  run.actions.finishOverlayExit(second);
  expect(await stale).toBe('stale');
  expect(run.getState().overlay.type).toBe('none');
});

it('opens closing with the requested read tab and a handoff without dispatching a write', async () => {
  const { run, navigation } = setup();
  expect(await navigation.execute('ui.open_closing', { tab: 'history' })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ type: 'closing', tab: 'history', readOnly: true });
  run.actions.closeOverlay();
  run.actions.finishOverlayExit(run.getState().exitPendingToken!);
  expect(await navigation.handoff({ featureId: 'menu', command: 'menu.create', draft: { name: '소금 라테', price: 5500 } })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ view: 'register', prefill: { kind: 'menu.create', name: '소금 라테', price: 5500 } }] });
});

function fakeAgentResponse(input: AgentRequest) {
  expect(validateAgentRequest(input)).toBe(true);
  if (input.intent.kind !== 'command') throw new Error('Expected a scoped UI command');
  const frame = { outcome: 'navigate', navigation: {
    command: input.intent.command, args: input.intent.args ?? {}, runId: input.runId,
    snapshotRevision: input.snapshotRevision, layer: input.layer, ...(input.page === undefined ? {} : { page: input.page }),
  } };
  expect(validateAgentFrame('done', frame)).toBe(true);
  return new Response(sseFrame('panels', { panels: [] }) + sseFrame('done', frame), { headers: { 'Content-Type': 'text/event-stream', [AGENT_PROTOCOL_HEADER]: AGENT_PROTOCOL } });
}

it('opens the real stock history row from chat, returns to the composer and keeps the draft in edit and POS', async () => {
  const requests: AgentRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as AgentRequest;
    requests.push(request);
    return fakeAgentResponse(request);
  }));
  const { run } = setup();
  run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' });
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
  const send = (text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };
  const milk = milkIn(createWidgetDataStore().getSnapshot());
  send('우유 입고 내역 보여줘');
  await waitFor(() => expect(screen.getByRole('button', { name: `${milk.label} 재고 변동 기록` })).toHaveAttribute('aria-expanded', 'true'));
  expect(JSON.stringify(requests[0])).not.toContain(milk.itemId);
  expect(requests[0].intent).toMatchObject({ kind: 'command', command: 'ui.openDetail', args: { view: 'history', itemId: { handle: 'navis-detail-selection' } } });
  expect(screen.getByRole('dialog')).toContainElement(input);
  fireEvent.click(screen.getByRole('dialog').querySelector('[data-ui-close]')!);
  await waitFor(() => { expect(input).toHaveFocus(); expect(run.getState().exitPendingToken).toBeNull(); });
  send('배치 편집 들어가줘');
  await waitFor(() => expect(run.getState().edit.mode).toBe('edit'));
  expect(screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' })).toBe(input);
  send('배치 편집 끝내줘');
  await waitFor(() => expect(run.getState().edit.mode).toBe('view'));
  send('주문 화면으로 가줘');
  await waitFor(() => expect(run.getState().layer).toBe('orders-payment'));
  expect(screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' })).toBe(input);
  send('관리로 돌아가줘');
  await waitFor(() => expect(run.getState().layer).toBe('management'));
  expect(requests.at(-1)?.layer).toBe('pos');
  expect(screen.getByText('우유 입고 내역 보여줘')).toBeInTheDocument();
});

it('opens a populated menu form and leaves the owner to save it', async () => {
  const { run } = setup();
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
  fireEvent.change(input, { target: { value: '소금 라테 5,500원 메뉴 등록 폼 열어줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByDisplayValue('소금 라테')).toBeInTheDocument());
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'menu', stack: [
    { view: 'register', prefill: { kind: 'menu.create', name: '소금 라테', price: 5500 } },
  ] });
  expect(screen.getByRole('dialog')).toContainElement(input);
});

type Scenario = {
  id: string;
  utterances: string[];
  precondition: string;
  expected: { kind: string; tools: { name: string; args: Record<string, unknown> }[] };
};

const unsupported = new Map<string, string>([
  ['S2-126', 'N12 must resolve the member and supply settlement clarification.'],
  ['S3-127', 'External link refusal needs an explicit grants or out-of-scope turn.'],
  ['S3-186', 'Hiring is outside the dashboard and needs a verified refusal turn.'],
  ['S3-260', 'The ambiguous closing question needs a conversation clarification.'],
  ['S3-261', 'The ambiguous scheduling question needs a conversation clarification.'],
  ['S5-046', 'The fixture asks for an actual panel highlight but declares only a read and gives no board placement.'],
  ['S5-065', 'The community adapter must report the already-resolved offer.'],
  ['S5-067', 'The community adapter must resolve offer state and offer the correct continuation.'],
  ['S5-070', 'A refusal requires a verified community offer path in N17.'],
  ['S5-071', 'A refusal requires a verified community offer path in N17.'],
  ['S5-072', 'A refusal requires a verified community offer path in N17.'],
  ['S5-073', 'A refusal requires a verified community offer path in N17.'],
  ['S5-124', 'The coupon adapter must clarify an invalid schedule date.'],
  ['S5-125', 'The coupon adapter must ask which coupon and target slot.'],
  ['S5-130', 'N16 owns the coupon-form consumer and audience draft reflection.'],
  ['S5-131', 'The authored follow-up needs a prior coupon draft and the N16 scheduler hand-off consumer.'],
  ['S5-132', 'N16 owns the coupon-form consumer and multiple-slot policy outcome.'],
  ['S5-134', 'The authored follow-up requires the coupon disclosure guard and a pending draft.'],
  ['S5-154', 'The coupon adapter must read applicable inventory and show an expiry draft.'],
  ['S5-158', 'The coupon hand-off needs a verified audience and offered draft.'],
  ['S5-159', 'The publication refusal needs a verified expiry-coupon route.'],
  ['S6-155', 'Typed draft contract is available. The customer-groups editor consumer belongs to its domain slice.'],
  ['S7-063', 'No panel color setting exists. A fixed chat refusal for this wording remains unverified.'],
  ['S7-100', 'The panel-help guard works, but the authored answer requires tax coach copy.'],
  ['S7-106', 'The retained conversation is covered by integration tests. The authored erase request needs a fixed refusal turn.'],
  ['S7-115', 'The generic coupon name needs typed, verified choice chips.'],
  ['S7-116', 'The multiple-menu lookup needs a verified ambiguity continuation.'],
  ['S7-117', 'No weather detail exists. A fixed answer on the conversation path remains unverified.'],
  ['S7-148', 'The settings guard works, but the authored answer requires supported table configuration guidance.'],
  ['S7-151', 'Settings has no chat mutation. The authored offered route needs an explicit settings policy reply.'],
  ['S7-154', 'Settings has no chat mutation. The authored tables offer needs an explicit settings policy reply.'],
  ['S7-200', 'The authored question expects guidance and an offered settings entry without opening it.'],
  ['S7-204', 'The missing recent widget needs a verified clarification through N02 conversation.'],
]);

const fixtureRoot = resolve(import.meta.dirname, '../../../../.evidence/navis-scenarios');
const tracePath = resolve(fixtureRoot, 'TRACE.csv'), corpusPath = resolve(fixtureRoot, 'MERGED.json');
const hasCorpus = existsSync(tracePath) && existsSync(corpusPath);
const traceIds = new Set((hasCorpus ? readFileSync(tracePath, 'utf8') : '').split('\n').map(row => row.split(','))
  .filter(columns => columns[9] === 'N03').map(columns => columns[0]));
const corpus = (JSON.parse(hasCorpus ? readFileSync(corpusPath, 'utf8') : '[]') as Scenario[])
  .filter(scenario => traceIds.has(scenario.id));
const canonicalTool = (name: string) => ['open_detail', 'ui.open_detail'].includes(name) ? 'ui.openDetail' : name;

function scenarioSetup(scenario: Scenario) {
  const { run } = setup();
  const highlighted: string[] = [];
  let closed = false;
  const navigation = createNavisNavigation(run, { highlight: id => highlighted.push(id), closeChat: () => { closed = true; } });
  const detach = navigation.attach();
  const { id } = scenario, { actions } = run;
  if (scenario.precondition.startsWith('T0') || scenario.precondition.startsWith('P2') || scenario.precondition.startsWith('M0')) {
    expect(actions.applyLayoutIntent({ type: 'restore', panels: [
      { featureId: 'briefing', column: 0, row: 0, width: 2, height: 2 },
      { featureId: 'ledger', column: 2, row: 0, width: 2, height: 1 },
      { featureId: 'margin', column: 2, row: 1, width: 2, height: 1 },
      { featureId: 'calendar', column: 4, row: 0, width: 2, height: 2 },
      { featureId: 'inventory-booking', column: 0, row: 2, width: 2, height: 1 },
      { featureId: 'menu', column: 2, row: 2, width: 2, height: 1 },
    ] }).status).toBe('accepted');
  }
  if (scenario.precondition.startsWith('P2') || id === 'S7-074') {
    if (id === 'S7-097') {
      actions.addPage();
      actions.applyLayoutIntent({ type: 'add-tap', featureId: 'tax' });
      actions.goToPage(0);
      actions.movePanelToPage('ledger', 1);
    } else actions.addPage();
    if (id === 'S7-074') actions.addPage();
    if (id !== 'S7-071') actions.goToPage(0);
  }
  if (scenario.precondition.startsWith('M0') || id === 'S7-112') actions.switchLayer('marketing');
  if (id === 'S7-102') actions.openDrawer('stock');
  if (id === 'S7-109') actions.openDetailRef({ featureId: 'inventory-booking' }, 'panel:inventory-booking');
  if (id === 'S7-113') actions.enterEditing();
  if (id === 'S7-221') actions.startWithThree();
  return { run, navigation, highlighted, closed: () => closed, detach };
}

it.skipIf(!hasCorpus)('replays each assigned N03 client scenario against the fake agent boundary and records exceptions', async () => {
  expect(corpus).toHaveLength(87);
  let passed = 0, checkedUtterances = 0;
  const exceptions: string[] = [];
  for (const caseData of corpus) {
    const { id, expected } = caseData;
    const reason = unsupported.get(id);
    if (reason) { exceptions.push(`${id} — ${reason}`); continue; }
    let failure: unknown;
    for (const [index, text] of caseData.utterances.entries()) {
      const { run, navigation, highlighted, closed, detach } = scenarioSetup(caseData);
      const store = createWidgetDataStore(undefined, { runId: run.getState().runId });
      const before = run.getState(), snapshot = store.getSnapshot();
      const plan = classifyNavigation(text, before, snapshot, id === 'S7-203' ? 'inventory-booking' : undefined);
      const expectedTool = expected.tools[0];
      const tool = id === 'S7-109' || id === 'S7-108' ? 'ui.go_back' : id === 'S7-072' ? 'ui.go_to_page'
        : id === 'S7-111' || id === 'S7-112' ? 'ui.enter_layout_edit' : canonicalTool(expectedTool?.name ?? '');
      const noMove = ['S7-067', 'S7-072', 'S7-073', 'S7-098', 'S7-108', 'S7-111', 'S7-112'].includes(id);
      try {
        expect(plan?.command).toBe(tool);
        if (!plan) throw new Error('The utterance produced no navigation route');
        const expectedArgs = { ...expectedTool?.args };
        if (expectedArgs.layer === 'orders-payment') expectedArgs.layer = 'pos';
        if (id === 'S7-092') Object.assign(expectedArgs, { itemId: milkIn(snapshot).itemId, view: 'history' });
        if (Object.keys(expectedArgs).length) expect(plan.args).toMatchObject(expectedArgs);

        let args: Record<string, unknown> | undefined = plan.args;
        if (!plan.local) {
          const prepared = prepareNavigationRequest(plan, before, navigation);
          expect(prepared).toBeDefined();
          if (!prepared) throw new Error('The classified action failed wire validation');
          const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => fakeAgentResponse(JSON.parse(String(init?.body)) as AgentRequest));
          const provider = createAssistantProvider({ store, run, fetcher: fetchImpl });
          args = undefined;
          await provider.ask({ text, signal: new AbortController().signal, layer: before.activeBoard, agentTurn: prepared.agentTurn,
            onNavigation: action => { args = prepared.resolve(action); } });
          expect(fetchImpl).toHaveBeenCalledTimes(1);
          expect(args).toBeDefined();
        }
        const result = await navigation.execute(tool, args ?? {});
        if (noMove) {
          expect(result).toBe(id === 'S7-067' ? 'already' : id === 'S7-108' ? 'noHistory' : 'unavailable');
          expect(run.getState()).toBe(before);
        } else {
          expect(result).toBe('opened');
          const after = run.getState();
          if (tool === 'ui.openDetail') {
            expect(after.overlay).toMatchObject({ type: 'detail', featureId: expectedArgs.featureId, returnFocusKey: NAVIS_RETURN_FOCUS });
            if (id === 'S7-092') expect(after.overlay).toMatchObject({ stack: [{ view: 'history', itemId: expectedArgs.itemId }] });
          }
          if (tool === 'ui.switch_layer') expect(after.layer).toBe(expectedArgs.layer === 'pos' ? 'orders-payment' : expectedArgs.layer);
          if (tool === 'ui.go_to_page') expect(after.boards[after.activeBoard].currentPage + 1).toBe(expectedArgs.page);
          if (tool === 'ui.show_panel') expect(highlighted).toEqual([expectedArgs.featureId]);
          if (tool === 'ui.open_widget_help') expect(after.widgetHelp?.featureId).toBe(expectedArgs.featureId);
          if (tool === 'ui.open_drawer') expect(after.overlay).toMatchObject({ type: 'drawer', ...expectedArgs });
          if (tool === 'ui.open_settings') expect(after.overlay.type).toBe('settings');
          if (tool === 'ui.go_back') expect([after.layer, after.overlay.type]).toEqual(['management', 'none']);
          if (tool === 'ui.close_chat') expect(closed()).toBe(true);
          if (tool === 'ui.close_overlay') expect(after.overlay.type).toBe('none');
          if (tool === 'ui.enter_layout_edit') expect(after.edit.mode).toBe('edit');
          if (tool === 'ui.exit_layout_edit') expect(after.edit.mode).toBe('view');
          if (tool === 'ui.skip_coaches') expect(after.guidance.queue).toHaveLength(0);
        }
        expect(store.getSnapshot()).toBe(snapshot);
        expect(run.getState().layoutRevision).toBe(before.layoutRevision);
        checkedUtterances++;
      } catch (error) {
        failure ??= `variant ${index + 1} (${text}): ${String(error).split('\n')[0]}`;
      } finally {
        detach();
        run.dispose();
      }
    }
    if (failure) exceptions.push(`${id} — ${failure}`);
    else passed++;
  }
  console.info(`${passed} of 87 pass, ${exceptions.length} listed exceptions with reasons. ${checkedUtterances} utterance variants passed.\n${exceptions.join('\n')}`);
  expect(passed + exceptions.length).toBe(87);
  expect(exceptions).toEqual([...unsupported].map(([id, reason]) => `${id} — ${reason}`));
}, 20000);

it('ignores an otherwise valid transport result after a layer round trip', () => {
  const { run, navigation } = setup();
  const s = run.getState();
  const prepared = prepareNavigationRequest({ command: 'ui.openDetail', args: { featureId: 'menu' } }, s, navigation)!;
  const frame = { command: 'ui.openDetail', args: { featureId: 'menu' }, runId: s.runId, snapshotRevision: 0, layer: 'management', page: 1 } as const;
  expect(prepared.resolve(frame)).toEqual({ featureId: 'menu' });
  run.actions.switchLayer('marketing');
  run.actions.switchLayer('management');
  expect(prepared.resolve(frame)).toBeUndefined();
});

it('opens the closing history tab in the real read-only dialog', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => fakeAgentResponse(JSON.parse(String(init.body)) as AgentRequest)));
  const { run } = setup();
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
  fireEvent.change(input, { target: { value: '마감 기록 보여줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const history = await screen.findByRole('tab', { name: '정산 이력' });
  expect(history).toHaveAttribute('aria-selected', 'true');
  expect(run.getState().overlay).toMatchObject({ type: 'closing', readOnly: true, tab: 'history' });
  expect(screen.getByRole('button', { name: /^마감 (?:정산하기|되돌리기)$/u })).toBeDisabled();
});

it('uses the existing period control for a spoken ledger range', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => fakeAgentResponse(JSON.parse(String(init.body)) as AgentRequest)));
  const { run } = setup();
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
  const period = supportedConditions('ledger').find(condition => condition.kind === 'dateRange')!;
  const {start,end} = period;
  fireEvent.change(input, { target: { value: `손익 ${start}부터 ${end}까지 열어줘` } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const selected = await screen.findByRole('radio', { name: '최근 7일' });
  await waitFor(() => expect(selected).toHaveAttribute('aria-checked', 'true'));
});
