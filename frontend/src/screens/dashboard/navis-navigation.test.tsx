import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAssistantProvider } from '../../features/assistant';
import { createWidgetDataStore, dataBundles, readModel, resolveDataText, type WidgetDataStore } from '../../data/widget-data';
import { supportedConditions } from '../../data/conditions';
import { createTranslator } from '../../i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/App';
import { sseFrame } from '../../features/assistant/stream-fixture';
import { AGENT_PROTOCOL, AGENT_PROTOCOL_HEADER, validateAgentFrame, validateAgentRequest, type AgentRequest } from '../../../shared/navis-agent-schema.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../app/test-session';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { applyNavisDetailSelection, classifyNavigation, createNavisNavigation, isDataDisplayRequest, NAVIS_RETURN_FOCUS, prepareNavigationRequest, routeMenuForm, routeNavisNavigation } from './navis-navigation';
import { detailBoardPlacement, openedDetailText } from '../../features/assistant/destinations';
import { navisTranslator } from '../../features/assistant/messages';
import type { DetailRef } from '../../contracts';

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

it('takes a tax-evidence handoff to the scoped file chooser without prefilling example evidence', async () => {
  const { run, navigation } = setup();
  expect(await navigation.handoff({ featureId: 'tax', command: 'tax.setEvidence', draft: { taxPaymentId: 'sample-tax-1', evidence: 'example' } })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'tax', view: 'evidence', itemId: 'sample-tax-1', focus: 'action' }] });
  const overlay = run.getState().overlay;
  expect(overlay.type === 'detail' && overlay.stack?.at(-1)?.prefill).toBeUndefined();
});

it('opens the scoped NAVER cancellation detail with no cancellation fields passed to the widget', async () => {
  const { run, navigation } = setup();
  expect(await navigation.handoff({ featureId: 'voice-booking', command: 'booking.cancel', draft: { reservationId: 'naver-1002', cancelReason: '휴무' } })).toBe('invalid');
  expect(await navigation.handoff({ featureId: 'voice-booking', command: 'booking.cancel', draft: { reservationId: 'naver-1002' } })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'voice-booking', itemId: 'naver-1002', focus: 'action' }] });
});

it('retains only allowable detail routing and expands a locally validated item and view', async () => {
  const { run, navigation } = setup();
  const { itemId } = milkIn(createWidgetDataStore().getSnapshot());
  expect(await navigation.execute('ui.openDetail', { featureId: 'inventory-booking', tab: 'history', view: 'products', itemId })).toBe('invalid');
  expect(await navigation.execute('ui.openDetail', { featureId: 'inventory-booking', tab: 'history', itemId })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'inventory-booking', view: 'history', itemId }] });
});

it.each([
  ['카페라테 상세 열어줘', 'item'],
  ['카페라테 레시피 열어줘', 'recipe'],
  ['카페라떼 메뉴 편집 화면', 'item'],
])('opens the named café menu item for %s', async (text, view) => {
  const { run, navigation } = setup();
  const store = createWidgetDataStore();
  const snapshot = store.getSnapshot();
  const plan = classifyNavigation(text, run.getState(), snapshot);
  expect(plan).toMatchObject({ command: 'ui.openDetail', args: { featureId: 'menu', view, itemId: 'm-cafe-latte' } });
  expect(await navigation.execute(plan!.command, plan!.args)).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'menu', view, itemId: 'm-cafe-latte' }] });
  expect(store.getSnapshot()).toBe(snapshot);
});

it('leaves a partial menu name shared by several items for clarification', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(classifyNavigation('라떼 메뉴 편집 화면', run.getState(), snapshot)).toBeUndefined();
});

it('opens a named margin simulation without applying any price changes', async () => {
  const { run, navigation } = setup();
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const plan = classifyNavigation('라떼 가격 원가 바꿔보기 열어줘 (카페라테)', run.getState(), before);
  expect(plan).toMatchObject({ command: 'ui.openDetail', args: { featureId: 'margin', view: 'simulator', itemId: 'm-cafe-latte' } });
  expect(await navigation.execute(plan!.command, plan!.args)).toBe('opened');
  expect(store.getSnapshot()).toBe(before);
});

it('opens the products tab for a packaged-item view without inventing an item selection', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(classifyNavigation('원두 200g 재고 열어줘', run.getState(), snapshot)).toMatchObject({
    command: 'ui.openDetail', args: { featureId: 'inventory-booking', view: 'products' },
  });
  expect(classifyNavigation('원두 200g 재고 몇 개 있어?', run.getState(), snapshot)).toBeUndefined();
});

it.each([
  '우유 일주일 동안 재고 변화 보여줘',
  '참깨 재고 품목 SES-01 단위 kg 재고 2로 추가하고 보충 알림은 필요 없어',
  '재고에 참깨 SES-01 2kg 보충알림 끔',
])('defers stock reads and new items to their typed domain for %s', text => {
  const { run } = setup();
  expect(classifyNavigation(text, run.getState(), createWidgetDataStore().getSnapshot())).toBeUndefined();
});

it.each([
  ['끝난 쿠폰 2장 보여줘', 'coupon-status'],
  ['지난달 손익 좀 보여 줄래?', 'ledger'],
  ['11월 23일 주 근무표 보여줘', 'staff-schedule'],
  ['원두 200g 재고 화면 보여주세요', 'inventory-booking'],
  ['카페라테 레시피 보여주라', 'menu'],
  ['그거 다시 보여줘', 'ai-response'],
] as const)('leaves %s on the data path across both navigation entry points', (text, feature) => {
  const { run } = setup();
  const state = run.getState(), snapshot = createWidgetDataStore().getSnapshot();
  expect(classifyNavigation(text, state, snapshot, feature)).toBeUndefined();
  expect(routeNavisNavigation(text, { state, feature, reference: feature })).toBeUndefined();
});

it('keeps an explicit open even when the owner also uses a display verb', () => {
  const { run } = setup();
  const state = run.getState(), snapshot = createWidgetDataStore().getSnapshot();
  const text = '손익 위젯 열어서 자료 보여줘';
  expect(classifyNavigation(text, state, snapshot)).toMatchObject({ command: 'ui.openDetail', args: { featureId: 'ledger' } });
  expect(routeNavisNavigation(text, { state, feature: 'ledger' })).toMatchObject({ command: 'ui.openDetail' });
});

it('uses the vendor read for a supplier list question and locates explicitly named panels', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(classifyNavigation('발주사 어디어디 있어?', run.getState(), snapshot)).toBeUndefined();
  expect(classifyNavigation('발주 패널 보드에서 찾아줘', run.getState(), snapshot)).toMatchObject({
    command: 'ui.show_panel', args: { featureId: 'suppliers' },
  });
});

it.each(['재고 위젯 위치 알려줘', '손익 패널 위치 알려줘', '진행 중인 쿠폰 대시보드 어디에 있어?', '마감 정산 에러 상태 보여줘'])(
  'defers dashboard reads and display cards to their domains for %s', text => {
    const { run } = setup();
    expect(classifyNavigation(text, run.getState(), createWidgetDataStore().getSnapshot())).toBeUndefined();
  },
);

it.each(['메뉴 추가하는 화면 열어줘', '메뉴 추가 폼 띄워줘', '새 메뉴 입력창', '새 메뉴 등록 폼 열어줘', '메뉴 새로 등록하는 창 열어'])('opens a blank menu form for %s', async text => {
  const { run, navigation } = setup();
  const store = createWidgetDataStore();
  const snapshot = store.getSnapshot();
  const plan = classifyNavigation(text, run.getState(), snapshot);
  expect(plan).toMatchObject({ command: 'ui.openDetail', args: { featureId: 'menu', view: 'register' } });
  expect(routeMenuForm(text)).toBeUndefined();
  expect(await navigation.execute(plan!.command, plan!.args)).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'menu', view: 'register' }] });
  expect(store.getSnapshot()).toBe(snapshot);
});

it.each([
  'https://example.invalid/menu 열어줘',
  'example.invalid/menu 화면 열어줘',
  '네이버 사이트에서 메뉴 화면 열어줘',
  '카페라테 상세 화면 열지 마',
  '손님이 "카페라테 상세 열어줘"라고 했어',
  '「메뉴 추가하는 화면 열어줘」라는 내용을 검토해줘',
  '영수증에 『메뉴 위젯 열어줘』가 인쇄됐어',
])('leaves out-of-scope or non-command text to the conversation path for %s', text => {
  const { run } = setup();
  expect(classifyNavigation(text, run.getState(), createWidgetDataStore().getSnapshot())).toBeUndefined();
  expect(routeMenuForm(text)).toBeUndefined();
});

it.each([
  ['쿠폰 위젯 보드에서 찾아줘', 'ui.show_panel', { featureId: 'coupon-status' }],
  ['손익 위젯이 2페이지에 있어?', 'ui.show_panel', { featureId: 'ledger' }],
  ['카페 영상 틀어줘', 'ui.openDetail', { featureId: 'customer-analysis' }],
  ['분석한 영상 재생해줘', 'ui.openDetail', { featureId: 'customer-analysis' }],
  ['세금 알림 자세히 열어줘', 'ui.openDetail', { featureId: 'tax', view: 'payments', itemId: 'sample-tax-1' }],
  ['브리핑에서 세금 쪽 열어줘', 'ui.openDetail', { featureId: 'tax', view: 'payments', itemId: 'sample-tax-1' }],
  ['12월 10일 세금 항목 어디서 봐?', 'ui.openDetail', { featureId: 'tax', view: 'payments', itemId: 'sample-tax-1' }],
  ['11월 23일 주 근무표', 'ui.openDetail', { featureId: 'staff-schedule', view: 'week', date: '2026-11-23' }],
  ['화요일 한산한 시간 쿠폰 화면으로 가줘', 'ui.openDetail', { featureId: 'slot-coupon', view: 'send', focus: 'action' }],
  ['단골 쿠폰 보내기 화면으로 가줘', 'ui.openDetail', { featureId: 'slot-coupon', view: 'send', focus: 'action' }],
  ['끝난 쿠폰 화면 열어줘', 'ui.openDetail', { featureId: 'coupon-status', view: 'ended' }],
])('routes %s to its read-only destination', (text, command, args) => {
  const { run } = setup();
  const store = createWidgetDataStore();
  expect(classifyNavigation(text, run.getState(), store.getSnapshot())).toMatchObject({ command, args });
});

it('marks an explicitly requested reporting month unavailable when the widget lacks it', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  expect(classifyNavigation('9월 원가 화면 열어줘', run.getState(), snapshot)).toMatchObject({ unsupportedPeriod: true });
});

it('opens nothing for the removed 마케팅 성과 screen (D-365)', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  for (const text of ['9월 성과 화면으로 보여줘', '지난달 마케팅 성과 화면 열어줘', '마케팅 성과 쿠폰 탭 열어줘']) {
    expect(JSON.stringify(classifyNavigation(text, run.getState(), snapshot) ?? null), text).not.toContain('marketing-performance');
  }
});

it('opens a blank form when the current register view holds a previous draft', async () => {
  const { run, navigation } = setup();
  await navigation.handoff({ featureId: 'menu', command: 'menu.create', draft: { name: '소금 라테', price: 5500 } });
  expect(await navigation.execute('ui.openDetail', { featureId: 'menu', view: 'register' })).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'menu' });
  const { overlay } = run.getState();
  expect(overlay.type === 'detail' && overlay.stack?.at(-1)?.prefill).toBeUndefined();
});

it('does not open a handoff aborted as the prior overlay finishes closing', async () => {
  const { run, navigation } = setup();
  await navigation.execute('ui.openDetail', { featureId: 'ledger' });
  const closing = run.actions.closeOverlay('button')!;
  const controller = new AbortController();
  const navigationResult = navigation.handoff({ featureId: 'menu', command: 'menu.create', draft: { name: '소금 라테' } }, controller.signal);
  run.actions.finishOverlayExit(closing);
  controller.abort();
  expect(await navigationResult).toBe('stale');
  expect(run.getState().overlay.type).toBe('none');
});

it('leaves the owner’s more recent board in view when a queued page navigation becomes stale', async () => {
  const { run, navigation } = setup();
  run.actions.addPage();
  run.actions.goToPage(0);
  await navigation.execute('ui.open_drawer', { group: 'stock' });
  const pending = navigation.execute('ui.go_to_page', { page: 2 });
  run.actions.finishOverlayExit(run.getState().exitPendingToken!);
  expect(run.actions.switchLayer('marketing')).toBe(true);
  expect(await pending).toBe('stale');
  expect(run.getState().layer).toBe('marketing');
});

it('opens the available named coupon slot as an unsaved local form', async () => {
  const { run, navigation } = setup();
  const store = createWidgetDataStore();
  const before = store.getSnapshot();
  const plan = classifyNavigation('금요일 오전 9시 빈 시간 쿠폰 화면 열어줘', run.getState(), before);
  expect(plan).toMatchObject({ command: 'ui.openDetail', local: true, args: {
    featureId: 'slot-coupon', view: 'send', focus: 'action', prefill: { slotId: 'slot-2026-11-20-9' },
  } });
  expect(await navigation.execute(plan!.command, plan!.args)).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ prefill: { fields: { slotId: 'slot-2026-11-20-9' } } }] });
  expect(store.getSnapshot()).toBe(before);
});

it('keeps the same mounted detail and its return target when revisiting an item', async () => {
  const { run, navigation } = setup();
  await navigation.execute('ui.openDetail', { featureId: 'ledger' });
  const item = { featureId: 'menu', itemId: 'm-cafe-latte' };
  await navigation.execute('ui.openDetail', { ...item, view: 'item' });
  const mounted = run.getState().overlay;
  expect(await navigation.execute('ui.openDetail', { ...item, tab: 'item', condition: { kind: 'default' } })).toBe('already');
  expect(run.getState().overlay).toBe(mounted);
  expect(await navigation.execute('ui.go_back', {})).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'ledger', returnFocusKey: NAVIS_RETURN_FOCUS });
});

it('locates a placed panel on page two and returns to the prior board in one back action', async () => {
  const { run, navigation, highlighted } = setup();
  run.actions.addPage();
  expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' }).status).toBe('accepted');
  run.actions.goToPage(0);
  run.actions.switchLayer('marketing');
  const state = run.getState();
  const plan = classifyNavigation('재고 패널 보드에서 찾아줘', state, createWidgetDataStore().getSnapshot());
  expect(plan).toMatchObject({ command: 'ui.show_panel', args: { featureId: 'inventory-booking' } });
  const prepared = prepareNavigationRequest(plan!, state, navigation)!;
  expect(prepared.agentTurn.intent.args).toMatchObject({ layer: 'management', page: 2 });
  expect(await navigation.execute('ui.show_panel', prepared.agentTurn.intent.args)).toBe('opened');
  expect(run.getState()).toMatchObject({ layer: 'management', boards: { management: { currentPage: 1 } } });
  expect(highlighted).toEqual(['inventory-booking']);
  expect(await navigation.execute('ui.go_back', {})).toBe('opened');
  expect(run.getState().layer).toBe('marketing');
  expect(run.getState().layoutRevision).toBe(state.layoutRevision);
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

  await navigation.execute('ui.open_drawer', { group: 'stock' });
  const releasing = new AbortController();
  const next = navigation.execute('ui.switch_layer', { layer: 'marketing' }, releasing.signal);
  run.actions.finishOverlayExit(run.getState().exitPendingToken!);
  releasing.abort();
  expect(await next).toBe('stale');
  expect(run.getState().layer).toBe('management');
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

it('highlights the named panel on the actual second dashboard page after a chat turn', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => fakeAgentResponse(JSON.parse(String(init.body)) as AgentRequest)));
  const { run } = setup();
  run.actions.addPage();
  expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }).status).toBe('accepted');
  run.actions.goToPage(0);
  const before = run.getState();
  const { container } = render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  fireEvent.change(input, { target: { value: '손익 패널 보드에서 찾아줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(container.querySelector('[data-feature-id="ledger"]')).toHaveAttribute('data-highlighted', 'true'));
  expect(run.getState().boards.management.currentPage).toBe(1);
  expect(run.getState().layoutRevision).toBe(before.layoutRevision);
}, 45000);


it('returns from stock history, closes chat for editing, and hides Navis on the POS layer', async () => {
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
  const composer = () => screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  const input = composer();
  const send = (text: string) => {
    fireEvent.change(composer(), { target: { value: text } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
  };
  const milk = milkIn(createWidgetDataStore().getSnapshot());
  send('우유 재고 변동 기록 열어줘');
  await waitFor(() => expect(screen.getByRole('button', { name: `${milk.label} 재고 변동 기록` })).toHaveAttribute('aria-expanded', 'true'));
  expect(JSON.stringify(requests[0])).not.toContain(milk.itemId);
  expect(requests[0].intent).toMatchObject({ kind: 'command', command: 'ui.openDetail', args: { view: 'history', itemId: { handle: 'navis-detail-selection' } } });
  expect(screen.queryByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBeNull();
  fireEvent.click(screen.getByRole('dialog').querySelector('[data-ui-close]')!);
  await waitFor(() => { expect(input).toHaveFocus(); expect(run.getState().exitPendingToken).toBeNull(); }, { timeout: 4000 });
  send('배치 편집 들어가줘');
  await waitFor(() => expect(run.getState().edit.mode).toBe('edit'));
  // SCR-23 (C-19) closes chat and hides the launcher while editing.
  expect(screen.queryByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Navis 열기' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  await waitFor(() => expect(run.getState().edit.mode).toBe('view'));
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const reopenedInput = composer();
  await waitFor(() => expect(reopenedInput).toHaveFocus());
  send('주문 화면으로 가줘');
  await waitFor(() => expect(run.getState().layer).toBe('orders-payment'));
  expect(screen.queryByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Navis (?:열기|닫기)$/u })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '관리' }));
  await waitFor(() => expect(run.getState().layer).toBe('management'));
  fireEvent.click(await screen.findByRole('button', { name: 'Navis 열기' }));
  expect(await screen.findByText('우유 재고 변동 기록 열어줘', {}, { timeout: 4000 })).toBeInTheDocument();
}, 60000);

it('keeps the chat for the widget it opened: presses in that widget do not close it and it returns with its history (D-369, C-04)', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => fakeAgentResponse(JSON.parse(String(init.body)) as AgentRequest)));
  const { run } = setup();
  run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' });
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  const milk = milkIn(createWidgetDataStore().getSnapshot());
  fireEvent.change(input, { target: { value: '우유 재고 변동 기록 열어줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('button', { name: `${milk.label} 재고 변동 기록` })).toHaveAttribute('aria-expanded', 'true'));
  expect(screen.queryByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBeNull();
  // The owner works in the widget the chat opened: any press there, or on the page around it, leaves the hidden chat alone.
  const dialog = screen.getByRole('dialog');
  for (const target of [dialog, dialog.querySelector('[data-ui-close]')!.parentElement!, document.body]) {
    fireEvent.pointerDown(target);
    fireEvent.click(target, { detail: 1 });
  }
  fireEvent.click(dialog.querySelector('[data-ui-close]')!);
  await waitFor(() => { expect(input).toHaveFocus(); expect(run.getState().exitPendingToken).toBeNull(); }, { timeout: 4000 });
  expect(screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBe(input);
  expect(screen.getByText('우유 재고 변동 기록 열어줘')).toBeInTheDocument();
  // Back in view, the chat is an ordinary chat again: a press elsewhere closes it.
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('region', { name: 'Navis' })).toBeNull();
}, 60000);

it.each([
  ['message', '답변 초안', '톡톡으로 답변 보내기', 'message-draft'],
  ['review', '답글 초안', '답글 올리기', 'review-draft'],
  ['message', '답변 초안', '톡톡으로 답변 보내기', undefined],
] as const)('opens a scoped Navis %s reply at the draft editor (%s, %s, %s)', async (view, label, reply, step) => {
  const transport = vi.fn(() => { throw new Error('Unexpected transport request'); });
  vi.stubGlobal('fetch', transport);
  const { run, navigation } = setup();
  const thread = createWidgetDataStore().getSnapshot().tables.inquiryThread.find(row => row.type === view && row.status === 'waiting')!;
  const suggested = '안녕하세요. 문의해 주셔서 감사합니다.';
  const destination = step
    ? await navigation.handoff({ featureId: 'ai-response', step, itemId: thread.threadId })
    : await navigation.execute('ui.openDetail', { featureId: 'ai-response', view, itemId: thread.threadId, focus: 'action', prefill: { body: suggested } });
  expect(destination).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'ai-response', view, itemId: thread.threadId, focus: 'action' }] });
  render(<App run={run} manageLifecycle={false}/>);
  const dialog = await screen.findByRole('dialog', { name: '메시지·리뷰 응대' });
  const field = within(dialog).getByRole('textbox', { name: label });
  const send = within(dialog).getByRole('button', { name: reply });
  await waitFor(() => expect(field).toHaveFocus());
  expect(field).toHaveValue(step ? '' : suggested);
  expect(within(dialog).getByRole('button', { current: true })).toHaveTextContent(resolveDataText(ko.t, { key: thread.bodyKey }));
  expect(within(dialog).queryByRole('button', { name: '테스트 문자 보내기' })).not.toBeInTheDocument();
  const body = '안녕하세요. 찾아 주셔서 감사합니다.';
  fireEvent.change(field, { target: { value: body } });
  if (view === 'review') {
    expect(send).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '초안 저장하기' }));
    await waitFor(() => expect(send).toBeEnabled());
  } else {
    expect(send).toBeEnabled();
  }
  const sentHeading = view === 'review' ? '내 답글' : '보낸 답변';
  expect(within(dialog).queryByRole('heading', { name: sentHeading })).not.toBeInTheDocument();
  fireEvent.click(send);
  expect(await within(dialog).findByRole('heading', { name: sentHeading })).toBeInTheDocument();
  expect(within(dialog).getByText(body)).toBeInTheDocument();
  expect(transport).not.toHaveBeenCalled();
});

it('opens a populated menu form and leaves the owner to save it', async () => {
  const { run } = setup();
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  fireEvent.change(input, { target: { value: '소금 라테 5,500원 메뉴 등록 폼 열어줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByDisplayValue('소금 라테')).toBeInTheDocument());
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'menu', stack: [
    { view: 'register', prefill: { kind: 'menu.create', name: '소금 라테', price: 5500 } },
  ] });
  expect(screen.queryByRole('textbox', { name: '질문하거나 요청해 주세요' })).toBeNull();
}, 45000);

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
        // Older scenarios assumed a display request would open their linked view.
        if (isDataDisplayRequest(text)) {
          expect(plan).toBeUndefined();
          expect(run.getState()).toBe(before);
          checkedUtterances++;
          continue;
        }
        if ((id === 'S7-097' || id === 'S7-098') && index === 2) {
          // These variants use their domain's board-location replies.
          expect(plan).toBeUndefined();
          checkedUtterances++;
          continue;
        }
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
}, 120000);

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
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  fireEvent.change(input, { target: { value: '마감 기록 열어줘' } });
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
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  const period = supportedConditions('ledger').find(condition => condition.kind === 'dateRange')!;
  const {start,end} = period;
  fireEvent.change(input, { target: { value: `손익 ${start}부터 ${end}까지 열어줘` } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const selected = await screen.findByRole('radio', { name: '최근 7일' }, { timeout: 4000 });
  await waitFor(() => expect(selected).toHaveAttribute('aria-checked', 'true'), { timeout: 4000 });
}, 10000);

// A3-B28 · G-011: a named member opens the member's own row, through the browser-held handle.
function storeWithNamedMember() {
  const store = createWidgetDataStore();
  // The authored S2-210 roster names the first member; the default seed keeps it masked.
  expect(store.dispatch({ type: 'members.update', memberId: 'M-0012', name: '김도현', phone: '01000002481' })).toMatchObject({ ok: true });
  return store;
}

it.each([
  '김도현 회원 열어줘',
  '도현이 회원 정보 열어줘',
  '2481 회원 상세 열어봐',
])('opens the named member row for %s', async text => {
  const { run, navigation } = setup();
  const store = storeWithNamedMember();
  const snapshot = store.getSnapshot();
  const plan = classifyNavigation(text, run.getState(), snapshot);
  expect(plan).toMatchObject({ command: 'ui.openDetail', args: { featureId: 'members', itemId: 'M-0012' }, target: { kind: 'member', id: 'M-0012' } });
  const prepared = prepareNavigationRequest(plan!, run.getState(), navigation)!;
  expect(prepared.agentTurn.intent.args).toMatchObject({ featureId: 'members', itemId: { handle: 'navis-detail-selection' } });
  expect(await navigation.execute(plan!.command, plan!.args)).toBe('opened');
  expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'members', itemId: 'M-0012' }] });
  expect(store.getSnapshot()).toBe(snapshot);
});

it('opens the named menu item in the mounted detail and gives the composer its focus back on close', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => fakeAgentResponse(JSON.parse(String(init.body)) as AgentRequest)));
  const { run } = setup();
  render(<App run={run} manageLifecycle={false}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Navis 열기' }));
  const input = screen.getByRole('textbox', { name: '질문하거나 요청해 주세요' });
  fireEvent.change(input, { target: { value: '카페라테 상세 열어줘' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getAllByText(/카페라떼/u).length).toBeGreaterThan(0));
  expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'menu', stack: [{ view: 'item', itemId: 'm-cafe-latte' }] });
  expect(run.getState().panels).toEqual([]);
  fireEvent.click(dialog.querySelector('[data-ui-close]')!);
  await waitFor(() => { expect(input).toHaveFocus(); expect(run.getState().exitPendingToken).toBeNull(); }, { timeout: 4000 });
}, 60000);

it('tells a widget that is not on the board from one that is, without placing or moving a panel', () => {
  const { run } = setup();
  expect(detailBoardPlacement(run.getState(), 'tax')).toBe('off-board');
  expect(detailBoardPlacement(run.getState(), 'voice-booking')).toBe('off-board');
  expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' }).status).toBe('accepted');
  expect(detailBoardPlacement(run.getState(), 'inventory-booking')).toBe('placed');
  expect(detailBoardPlacement(run.getState(), 'tax')).toBe('off-board');
});

// S1-019 v3 ("라떼 메뉴 편집 화면") expects the one café latte, but the seed holds several lattes: the bare partial name stays a clarification.
it('keeps the bare 라떼 ambiguous because more than one seeded menu carries it', () => {
  const snapshot = createWidgetDataStore().getSnapshot();
  const lattes = snapshot.tables.menuItem.filter(item => !item.deletedAt && item.kind !== 'retail'
    && resolveDataText(ko.t, item.name ?? { key: item.nameKey }).includes('라떼'));
  expect(lattes.length).toBeGreaterThan(1);
});

// A3-B28 · S7-076/092/205: the reply after a detail opens names the widget and the row, and says when the widget is not on the owner's board.
it('says which widget and row opened, and that an off-board widget is not on the board', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  const say = (ref: DetailRef) => openedDetailText(run.getState(), ref, snapshot, navisTranslator('ko'));
  expect(say({ featureId: 'tax' })).toBe('세무관리를 열었어요. 보드에 없지만 상세는 볼 수 있어요');
  expect(say({ featureId: 'voice-booking' })).toMatch(/^예약을 열었어요/u);
  const { itemId } = milkIn(snapshot);
  expect(say({ featureId: 'inventory-booking', view: 'history', itemId }))
    .toBe('재고에서 목장 1등급 우유 상세를 열었어요. 보드에 없지만 상세는 볼 수 있어요');
  expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'inventory-booking' }).status).toBe('accepted');
  expect(say({ featureId: 'inventory-booking', view: 'history', itemId })).toBe('재고에서 목장 1등급 우유 상세를 열었어요');
  expect(say({ featureId: 'menu', itemId: 'm-cafe-latte' })).toBe('메뉴에서 카페라떼 상세를 열었어요. 보드에 없지만 상세는 볼 수 있어요');
});

it('never puts a member or an unknown row id into the opened reply', () => {
  const { run } = setup();
  const snapshot = createWidgetDataStore().getSnapshot();
  const say = (ref: DetailRef) => openedDetailText(run.getState(), ref, snapshot, navisTranslator('ko'));
  expect(say({ featureId: 'members', itemId: 'M-0012' })).not.toMatch(/M-0012|김|0000/u);
  expect(say({ featureId: 'menu', itemId: 'm-does-not-exist' })).not.toContain('m-does-not-exist');
  expect(say({ featureId: 'menu', itemId: 'm-does-not-exist' })).toMatch(/^메뉴를 열었어요/u);
});

// A3-B28 · S1-151/S7-092: the expanded stock history, not just the row's toggle, has to be in view when the row opens.
function stockGrid(expanded: boolean) {
  const root = document.createElement('div');
  root.innerHTML = '<div data-widget="inventory-booking"><table><tbody><tr id="row"><td><button data-grid-target=\'["i-milk","$expand"]\' aria-expanded="'
    + String(expanded) + '"></button></td></tr></tbody></table></div>';
  const row = root.querySelector('#row')!;
  const button = root.querySelector('button')!;
  const expansion = document.createElement('tr');
  if (expanded) row.after(expansion);
  button.addEventListener('click', () => { button.setAttribute('aria-expanded', 'true'); row.after(expansion); });
  document.body.append(root);
  disposals.push(() => root.remove());
  return { root, button, expansion };
}

it.each([false, true])('scrolls the stock history under the milk row into view (already expanded: %s)', expanded => {
  const { root, button, expansion } = stockGrid(expanded);
  const scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  try {
    expect(applyNavisDetailSelection(root, { featureId: 'inventory-booking', view: 'history', itemId: 'i-milk' })).toBe(true);
  } finally { Element.prototype.scrollIntoView = original; }
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(scrolled).toEqual([expansion]);
});

it('does not touch the stock grid when the requested item has no row', () => {
  const { root, button } = stockGrid(false);
  expect(applyNavisDetailSelection(root, { featureId: 'inventory-booking', view: 'history', itemId: 'i-absent' })).toBe(false);
  expect(button).toHaveAttribute('aria-expanded', 'false');
});
