import { completeEmptyOnboarding } from './test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardLayerId, FeatureId, LayoutAdapter, LayoutWorkerRequest, LayoutWorkerResponse, Locale, Panel, RunState, RunStore } from '../contracts';
import { getCatalog, getRegistry } from '../catalog';
import { preview, screenPresets } from '../layout';
import { testTime } from '../layout/test-policy';
import { createRunStore, findPlacement, PAGE_LIMIT, selectBoardPanels, selectCommonNotice, type PresentationRunStore } from './index';
import stateSource from './index.ts?raw';

const preset = screenPresets.A;
let now = 0;
let run: PresentationRunStore;
let violations: string[] = [];
const solve = (request: LayoutWorkerRequest): LayoutWorkerResponse => ({ ...request, result: preview(request.beforePanels, request.intent, screenPresets[request.presetId].grid, getCatalog(request.presetId)) });
/** Worker stand-in: answers synchronously (sync) or on the next microtask (async). */
function adapter(mode: 'sync' | 'async'): LayoutAdapter & { readonly calls: number } {
  let calls = 0, cancelled = false;
  return {
    get calls() { return calls; },
    ready: async () => {},
    submit(request, receive) { calls++; cancelled = false; if (mode === 'sync') receive(solve(request)); else queueMicrotask(() => { if (!cancelled) receive(solve(request)); }); },
    cancel() { cancelled = true; },
    dispose() {},
  };
}
function checkMirror(s: RunState): void {
  const board = s.boards[s.activeBoard];
  const fail = (message: string) => violations.push(`${message} (layer ${s.layer}, board ${s.activeBoard})`);
  if (s.panels !== board.pages[board.currentPage]?.panels) fail('panels mirror');
  if (s.guidance !== board.guidance) fail('guidance mirror');
  if (s.starter !== board.starter) fail('starter mirror');
  if (s.undo !== board.undo) fail('undo mirror');
  if (s.notice !== board.notice) fail('notice mirror');
  for (const layer of ['management', 'marketing'] as const) {
    const b = s.boards[layer];
    if (b.layerId !== layer) fail('layer id');
    if (b.pages.length < 1 || b.pages.length > PAGE_LIMIT || b.currentPage < 0 || b.currentPage >= b.pages.length) fail(`pages ${b.pages.length}/${b.currentPage}`);
    const ids = b.pages.flatMap(page => page.panels.map(p => p.featureId));
    if (new Set(ids).size !== ids.length) fail(`duplicate widget in ${layer}`);
    if (new Set(b.pages.map(page => page.pageId)).size !== b.pages.length) fail('page ids');
  }
}
function setup(catalog: RunStore['catalog'] = getRegistry('A'), layoutAdapter: LayoutAdapter = adapter('sync')): PresentationRunStore {
  const store = createRunStore({ screenPreset: preset, catalog, time: testTime, clock: () => now, theme: 'light', layoutAdapter });
  checkMirror(store.getState());
  store.subscribe(checkMirror);
  return store;
}
const advance = (ms: number) => { now += ms; run.actions.tick(); };
const ids = (panels: readonly Panel[]) => panels.map(p => p.featureId);
const board = (layer: DashboardLayerId = run.getState().activeBoard) => run.getState().boards[layer];
const pagePanels = (index: number, layer?: DashboardLayerId) => board(layer).pages[index].panels;
function enter(type: Parameters<RunStore['actions']['chooseBusiness']>[0] = 'cafe') {
  completeEmptyOnboarding(run, type); run.actions.visualSettled(); advance(400); run.actions.dismissCoach();
}
const place = (panels: readonly Panel[]) => expect(run.actions.applyLayoutIntent({ type: 'restore', panels }).status).toBe('accepted');
beforeEach(() => { now = 0; violations = []; run = setup(); });
afterEach(() => { expect(violations).toEqual([]); run.dispose(); });

describe('v4 RunState shape and new run (DATA_MODEL 10.2, AC-195·216)', () => {
  it('starts on management with two one-page empty boards, Korean and normal examples', () => {
    const s = run.getState();
    expect(s).toMatchObject({ layer: 'management', activeBoard: 'management', locale: 'ko', preview: { family: 'normal', overrides: {} }, widgetHelp: null, layoutRevision: 0 });
    for (const layer of ['management', 'marketing'] as const) expect(s.boards[layer]).toMatchObject({ layerId: layer, currentPage: 0, revision: 0, starter: 'ready', undo: null, notice: null, pages: [{ panels: [] }] });
    expect(s.guidance).toMatchObject({ widgetCoach: {}, widgetQueue: [], activeWidget: null });
  });
  it('resets both boards, language, example state and help on a new run', () => {
    enter(); place([{ featureId: 'ledger', column: 0, row: 0, width: 1, height: 1 }]); run.actions.addPage();
    run.actions.setLocale('en'); run.actions.setPreviewFamily('empty'); run.actions.switchLayer('marketing');
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    run.actions.resetRun({ screenPreset: preset, catalog: getRegistry('A'), theme: 'light' });
    const s = run.getState();
    expect(s).toMatchObject({ layer: 'management', activeBoard: 'management', locale: 'ko', preview: { family: 'normal', overrides: {} }, widgetHelp: null, panels: [] });
    for (const layer of ['management', 'marketing'] as const) expect(s.boards[layer]).toMatchObject({ pages: [{ panels: [] }], currentPage: 0, revision: 0 });
  });
  it('keeps the state module free of React (typecheck:core boundary)', () => {
    expect(stateSource).toMatch(/from 'zustand\/vanilla'/);
    expect(stateSource).not.toMatch(/from ['"]react/);
  });
});

describe('pages and selection functions (F-20, AC-181~185)', () => {
  it.each([
    ['management', 'ledger', 'calendar'],
    ['marketing', 'community', 'ai-response'],
  ] as const)('removes the current %s page and restores its layout through Undo', (layer, removed, shifted) => {
    enter();
    if (layer === 'marketing') run.actions.switchLayer(layer);
    run.actions.addPage();
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: removed }).status).toBe('accepted');
    run.actions.addPage();
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: shifted }).status).toBe('accepted');
    run.actions.goToPage(1);
    run.actions.enterEditing();
    run.actions.selectPanel(removed);
    const before = run.getState();
    const pages = board().pages;
    const otherLayer = layer === 'management' ? 'marketing' : 'management';

    expect(run.actions.removePage(pages[1], before.layoutRevision)).toBe(true);

    expect(board()).toMatchObject({ pages: [pages[0], pages[2]], currentPage: 0, revision: before.boards[layer].revision + 1 });
    expect(run.getState().layoutRevision).toBe(before.layoutRevision + 1);
    expect(run.getState().edit.selectedFeatureId).toBeNull();
    expect(run.getState().boards[otherLayer]).toBe(before.boards[otherLayer]);
    expect(findPlacement(run.getState(), removed)).toBeNull();
    expect(findPlacement(run.getState(), shifted)?.pageIndex).toBe(1);

    const token = board().undo!.token;
    run.actions.finishEditing();
    expect(board().notice?.undoToken).toBe(token);
    expect(run.actions.addPage().ok).toBe(true);
    const appended = board().pages.at(-1);
    expect(run.actions.undo(token).status).toBe('accepted');
    expect(board()).toMatchObject({ pages: [...pages, appended], currentPage: 1 });
    expect(run.actions.undo(token).status).toBe('rejected');
  });
  it('rejects first-page, view-mode, and stale confirmation requests', () => {
    enter();
    run.actions.addPage();
    const viewed = run.getState();
    const second = board().pages[1];
    expect(run.actions.removePage(second, viewed.layoutRevision)).toBe(false);
    run.actions.enterEditing();
    run.actions.goToPage(0);
    expect(run.actions.removePage(board().pages[0], viewed.layoutRevision)).toBe(false);
    expect(run.actions.removePage(second, viewed.layoutRevision)).toBe(false);
    run.actions.goToPage(1);
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    expect(run.actions.removePage(second, viewed.layoutRevision)).toBe(false);
    expect(board().pages).toHaveLength(2);
    expect(run.actions.removePage(board().pages[1], run.getState().layoutRevision)).toBe(true);
    expect(board().pages).toHaveLength(1);
  });
  it('adds pages up to five without touching revisions or undo, then refuses with PAGE_LIMIT', () => {
    enter(); expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }).status).toBe('accepted');
    const before = run.getState();
    for (let i = 1; i < PAGE_LIMIT; i++) expect(run.actions.addPage()).toEqual({ ok: true, index: i });
    const s = run.getState();
    expect(board().pages).toHaveLength(5); expect(board().currentPage).toBe(4); expect(s.panels).toEqual([]);
    expect(s.layoutRevision).toBe(before.layoutRevision); expect(board().revision).toBe(before.boards.management.revision); expect(s.undo).toBe(before.undo);
    expect(run.actions.addPage()).toEqual({ ok: false, code: 'PAGE_LIMIT' });
    expect(board().pages).toHaveLength(5); expect(run.getState().notice).toMatchObject({ kind: 'error', messageKey: 'page-limit', layerId: 'management' });
    expect(run.getState().undo).toBe(before.undo);
  });
  it('moves the viewed page only when no drag, preview or modal is open (drawer allowed)', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); run.actions.addPage();
    const revision = run.getState().layoutRevision;
    expect(run.actions.goToPage(0)).toBe(true); expect(board().currentPage).toBe(0); expect(ids(run.getState().panels)).toEqual(['ledger']);
    expect(run.actions.goToPage(2)).toBe(false); expect(run.actions.goToPage(-1)).toBe(false); expect(run.actions.goToPage(0.5)).toBe(false);
    expect(run.actions.openDrawer('money')).toBe(true); expect(run.actions.goToPage(1)).toBe(true); expect(board().currentPage).toBe(1);
    run.actions.closeOverlay(); run.actions.finishOverlayExit(run.getState().exitPendingToken!);
    run.actions.goToPage(0); expect(run.actions.openDetail('ledger', 'panel-ledger')).toBe(true); expect(run.actions.goToPage(1)).toBe(false);
    run.actions.closeOverlay(); run.actions.finishOverlayExit(run.getState().exitPendingToken!);
    run.actions.enterEditing(); const token = run.actions.beginPreview({ source: 'panel', pointerId: 1, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    expect(run.actions.goToPage(1)).toBe(false); run.actions.cancelPreview(token);
    expect(run.getState().layoutRevision).toBe(revision);
  });
  it('sees every page of a layer through selectBoardPanels and findPlacement, memoized per board', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); run.actions.addPage();
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'calendar' });
    const s = run.getState();
    expect(selectBoardPanels(s).map(e => [e.pageIndex, e.panel.featureId])).toEqual([[0, 'ledger'], [1, 'calendar']]);
    expect(selectBoardPanels(s)).toBe(selectBoardPanels(s));
    expect(selectBoardPanels(s, 'marketing')).toEqual([]);
    expect(findPlacement(s, 'ledger')).toEqual({ layer: 'management', pageIndex: 0, panel: s.boards.management.pages[0].panels[0] });
    expect(findPlacement(s, 'grants')).toBeNull();
    run.actions.switchLayer('marketing'); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    expect(findPlacement(run.getState(), 'community')).toMatchObject({ layer: 'marketing', pageIndex: 0 });
    expect(findPlacement(run.getState(), 'calendar')).toMatchObject({ layer: 'management', pageIndex: 1 });
  });
});

describe('layer-wide duplicates and layer membership (AC-176·190, API-02 v4)', () => {
  it('refuses a widget that is on another page of the layer and reports that page', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); run.actions.addPage();
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'calendar' });
    const before = run.getState();
    const tapped = run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    expect(tapped).toMatchObject({ status: 'unchanged', code: 'DUPLICATE', existingFeatureId: 'ledger', existingPage: 0, highlightFeatureId: 'ledger' });
    expect(run.getState().panels).toBe(before.panels); expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    expect(run.getState().notice).toMatchObject({ kind: 'duplicate', messageKey: 'duplicate-other-page', featureId: 'ledger', params: { n: 1 } });
    expect(run.actions.beginPreview({ source: 'drawer', pointerId: 1, intent: { type: 'add-drop', featureId: 'ledger', column: 3, row: 0 } })).toBeNull();
    expect(run.actions.beginPreview({ source: 'candidate', pointerId: 2, intent: { type: 'add-ai', featureId: 'ledger', column: 3, row: 0, width: 1, height: 1, condition: { kind: 'default' } } })).toBeNull();
    const s = run.getState();
    const batch = run.actions.commitAssistantBatch([...s.panels, { featureId: 'ledger', column: 3, row: 0, width: 1, height: 1, condition: { kind: 'default' } }], s.layoutRevision, s.runId);
    expect(batch).toMatchObject({ status: 'rejected', code: 'DUPLICATE', existingFeatureId: 'ledger', existingPage: 0 });
    expect(run.getState().boards).toEqual(s.boards); expect(run.getState().layoutRevision).toBe(s.layoutRevision);
    const same = run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'calendar' });
    expect(same).toMatchObject({ status: 'unchanged', code: 'DUPLICATE', existingFeatureId: 'calendar' }); expect(same.existingPage).toBeUndefined();
  });
  it('writes an assistant batch to the viewed page only', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); run.actions.addPage();
    const s = run.getState();
    const result = run.actions.commitAssistantBatch([{ featureId: 'tax', column: 1, row: 1, width: 2, height: 1, condition: { kind: 'default' } }], s.layoutRevision, s.runId);
    expect(result.status).toBe('accepted');
    expect(ids(pagePanels(0))).toEqual(['ledger']); expect(ids(pagePanels(1))).toEqual(['tax']);
  });
  it('rejects another layer\'s widget with OTHER_LAYER on both boards', () => {
    enter();
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ai-response' })).toMatchObject({ status: 'rejected', code: 'OTHER_LAYER' });
    expect(run.getState().panels).toEqual([]);
    expect(run.getState().notice).toMatchObject({ kind: 'error', messageKey: 'other-layer', featureId: 'ai-response', params: { layer: 'marketing' } });
    expect(run.actions.beginPreview({ source: 'drawer', pointerId: 1, intent: { type: 'add-drop', featureId: 'community', column: 0, row: 0 } })).toBeNull();
    expect(run.actions.switchLayer('marketing')).toBe(true);
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' })).toMatchObject({ status: 'rejected', code: 'OTHER_LAYER' });
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' }).status).toBe('accepted');
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'stock-sync' as FeatureId })).toMatchObject({ status: 'rejected', code: 'UNKNOWN_FEATURE' });
  });
  it('applies the same layer rules to a run made with getCatalog: the iteration-3 compatibility branch is gone (T-055)', () => {
    run = setup(getCatalog('A')); enter();
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ai-response' })).toMatchObject({ status: 'rejected', code: 'OTHER_LAYER' });
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'stock-sync' as FeatureId })).toMatchObject({ status: 'rejected', code: 'UNKNOWN_FEATURE' });
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }).status).toBe('accepted');
    run.actions.switchLayer('marketing');
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' })).toMatchObject({ status: 'rejected', code: 'OTHER_LAYER' });
    expect(run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' }).status).toBe('accepted');
  });
});

describe('position-only previews and edge flips (API-03 v4, ARCHITECTURE 11.4-6·7)', () => {
  const ranged = { kind: 'dateRange', start: '2026-10-20', end: '2026-10-26' } as const;
  it('lets the store pick the intent from the gesture source and the viewed page', () => {
    enter(); place([{ featureId: 'ledger', column: 0, row: 0, width: 2, height: 1, condition: ranged }]); run.actions.addPage(); run.actions.goToPage(0);
    run.actions.enterEditing();
    const token = run.actions.beginPreview({ source: 'panel', pointerId: 1, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    expect(run.getState().gesturePreview).toMatchObject({ layerId: 'management', sourcePage: 0, targetPage: 0, position: null });
    run.actions.updatePreview(token, { column: 2, row: 1, inside: true });
    expect(run.getState().gesturePreview).toMatchObject({ intent: { type: 'move', featureId: 'ledger', column: 2, row: 1 }, position: { column: 2, row: 1, inside: true }, status: 'accepted' });
    const requestId = run.getState().gesturePreview!.requestId;
    const flipped = run.actions.flipPageDuringGesture(token, 1);
    expect(flipped).toMatchObject({ ok: true, pageIndex: 1 });
    const p = run.getState().gesturePreview!;
    expect(board().currentPage).toBe(1);
    expect(p).toMatchObject({ sourcePage: 0, targetPage: 1, beforePanels: [], requestId: requestId + 1, status: 'accepted', intent: { type: 'add-ai', featureId: 'ledger', column: 2, row: 1, width: 2, height: 1, condition: ranged } });
    const unchanged = run.getState();
    expect(run.actions.flipPageDuringGesture(token, 1)).toEqual({ ok: false, code: 'NO_NEIGHBOR_PAGE' });
    expect(run.getState()).toBe(unchanged);
    expect(run.actions.flipPageDuringGesture(token, -1)).toMatchObject({ ok: true, pageIndex: 0 });
    expect(run.getState().gesturePreview!.intent).toEqual({ type: 'move', featureId: 'ledger', column: 2, row: 1 });
    run.actions.cancelPreview(token);
    const drawer = run.actions.beginPreview({ source: 'drawer', pointerId: 2, intent: { type: 'add-drop', featureId: 'grants', column: 0, row: 3 } })!;
    run.actions.updatePreview(drawer, { column: 4, row: 2, inside: true });
    expect(run.getState().gesturePreview!.intent).toEqual({ type: 'add-drop', featureId: 'grants', column: 4, row: 2 });
    run.actions.flipPageDuringGesture(drawer, 1);
    expect(run.getState().gesturePreview!.intent).toEqual({ type: 'add-drop', featureId: 'grants', column: 4, row: 2 });
    run.actions.cancelPreview(drawer); expect(board().currentPage).toBe(0);
    const candidate = run.actions.beginPreview({ source: 'candidate', pointerId: 3, intent: { type: 'add-ai', featureId: 'tax', column: 0, row: 2, width: 2, height: 2, condition: { kind: 'default' } } })!;
    run.actions.updatePreview(candidate, { column: 1, row: 1, inside: true });
    expect(run.getState().gesturePreview!.intent).toEqual({ type: 'add-ai', featureId: 'tax', column: 1, row: 1, width: 2, height: 2, condition: { kind: 'default' } });
    run.actions.cancelPreview(candidate);
    const resize = run.actions.beginPreview({ source: 'resize', pointerId: 4, intent: { type: 'resize', featureId: 'ledger', width: 2, height: 1 } })!;
    run.actions.updatePreview(resize, { width: 3, height: 2 });
    expect(run.getState().gesturePreview!.intent).toEqual({ type: 'resize', featureId: 'ledger', width: 3, height: 2 });
    expect(run.actions.flipPageDuringGesture(resize, 1)).toEqual({ ok: false, code: 'CANCELLED' });
    expect(run.actions.updatePreview(resize, { type: 'resize', featureId: 'ledger', width: 4, height: 1 }, false)).toMatchObject({ status: 'rejected', code: 'OUTSIDE_GRID' });
    run.actions.cancelPreview(resize);
  });
  it('commits a cross-page move atomically and undoes both pages and the viewed page exactly', () => {
    enter(); place([{ featureId: 'ledger', column: 0, row: 0, width: 2, height: 1, condition: ranged }, { featureId: 'calendar', column: 2, row: 0, width: 1, height: 1 }]);
    run.actions.addPage(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'grants' }); run.actions.goToPage(0);
    const before = run.getState();
    run.actions.enterEditing();
    const token = run.actions.beginPreview({ source: 'panel', pointerId: 1, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    run.actions.updatePreview(token, { column: 0, row: 1, inside: true });
    run.actions.flipPageDuringGesture(token, 1);
    run.actions.updatePreview(token, { column: 2, row: 2, inside: true });
    const states: RunState[] = []; const stop = run.subscribe(s => states.push(s));
    expect(run.actions.commitPreview(token).status).toBe('accepted'); stop();
    expect(states).toHaveLength(1);
    const s = run.getState();
    expect(ids(pagePanels(0))).toEqual(['calendar']);
    expect(pagePanels(1)).toEqual([{ featureId: 'grants', column: 0, row: 0, width: 1, height: 1, condition: { kind: 'default' } }, { featureId: 'ledger', column: 2, row: 2, width: 2, height: 1, condition: ranged }]);
    expect(board().currentPage).toBe(1);
    expect(s.layoutRevision).toBe(before.layoutRevision + 1); expect(board().revision).toBe(before.boards.management.revision + 1);
    expect(s.undo).toMatchObject({ kind: 'move-page', layerId: 'management', pageIndex: 0, appliedRevision: board().revision, beforePages: before.boards.management.pages.map(p => p.panels) });
    expect(s.undo!.beforePanels).toEqual(before.boards.management.pages[0].panels);
    expect(s.notice).toMatchObject({ kind: 'success', messageKey: 'move-page', featureId: 'ledger', params: { n: 2 }, undoToken: s.undo!.token });
    expect(run.actions.undo(s.undo!.token).status).toBe('accepted');
    const undone = run.getState();
    expect(undone.boards.management.pages.map(p => p.panels)).toEqual(before.boards.management.pages.map(p => p.panels));
    expect(board().currentPage).toBe(0);
    expect(undone.layoutRevision).toBe(before.layoutRevision + 2); expect(board().revision).toBe(before.boards.management.revision + 2);
    expect(undone.notice).toMatchObject({ kind: 'complete', messageKey: 'undo-complete' });
  });
  it('returns to the starting page on a rejected drop, outside the grid and on cancel', () => {
    enter(); place([{ featureId: 'ledger', column: 0, row: 0, width: 1, height: 1 }]); run.actions.addPage();
    place([{ featureId: 'grants', column: 0, row: 0, width: 4, height: 4 }, { featureId: 'tax', column: 4, row: 0, width: 2, height: 4 }]);
    run.actions.goToPage(0); const before = run.getState();
    run.actions.enterEditing();
    let token = run.actions.beginPreview({ source: 'panel', pointerId: 1, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    run.actions.flipPageDuringGesture(token, 1); run.actions.updatePreview(token, { column: 0, row: 0, inside: true });
    expect(run.getState().gesturePreview).toMatchObject({ status: 'rejected', reason: 'NO_CAPACITY' });
    expect(run.actions.commitPreview(token)).toMatchObject({ status: 'rejected', code: 'NO_CAPACITY' });
    expect(board().currentPage).toBe(0); expect(run.getState().boards.management.pages).toEqual(before.boards.management.pages);
    expect(run.getState().notice).toMatchObject({ kind: 'error', messageKey: 'no-room-next-page' }); expect(run.getState().undo).toBe(before.undo);
    token = run.actions.beginPreview({ source: 'panel', pointerId: 2, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    run.actions.flipPageDuringGesture(token, 1); run.actions.updatePreview(token, { column: 6, row: 1, inside: false });
    expect(run.actions.commitPreview(token)).toMatchObject({ status: 'rejected', code: 'OUTSIDE_GRID' });
    expect(board().currentPage).toBe(0); expect(run.getState().notice).toMatchObject({ messageKey: 'OUTSIDE_GRID' });
    token = run.actions.beginPreview({ source: 'panel', pointerId: 3, intent: { type: 'move', featureId: 'ledger', column: 0, row: 0 } })!;
    run.actions.flipPageDuringGesture(token, 1); run.actions.cancelPreview(token);
    expect(board().currentPage).toBe(0); expect(run.getState().layoutRevision).toBe(before.layoutRevision);
  });
});

describe('send to a neighbor page without dragging (movePanelToPage, ARCHITECTURE 11.4-9)', () => {
  it('uses the nearest fully empty rectangle, follows to that page and undoes as move-page', () => {
    enter(); place([{ featureId: 'ledger', column: 2, row: 1, width: 2, height: 1 }]); run.actions.addPage();
    place([{ featureId: 'grants', column: 2, row: 1, width: 1, height: 1 }]); run.actions.goToPage(0);
    run.actions.enterEditing(); run.actions.selectPanel('ledger');
    const result = run.actions.movePanelToPage('ledger', 1);
    expect(result.status).toBe('accepted');
    expect(pagePanels(1).find(p => p.featureId === 'ledger')).toMatchObject({ column: 2, row: 0, width: 2, height: 1 });
    expect(pagePanels(0)).toEqual([]); expect(board().currentPage).toBe(1);
    expect(run.getState().undo).toMatchObject({ kind: 'move-page', pageIndex: 0 }); expect(run.getState().notice).toMatchObject({ messageKey: 'move-page', params: { n: 2 } });
    expect(run.actions.movePanelToPage('ledger', 1)).toMatchObject({ status: 'rejected', code: 'NO_NEIGHBOR_PAGE' });
    expect(run.actions.undo(run.getState().undo!.token).status).toBe('accepted');
    expect(ids(pagePanels(0))).toEqual(['ledger']); expect(ids(pagePanels(1))).toEqual(['grants']); expect(board().currentPage).toBe(0);
  });
  const checkerboard: readonly FeatureId[] = ['briefing','margin','tax','grants','customer-analysis','menu','members','voice-booking','calendar','inventory-booking','manuals','suppliers'];
  const cells = Array.from({ length: 24 }, (_, i) => ({ column: i % 6, row: Math.floor(i / 6) })).filter(c => (c.column + c.row) % 2 === 0);
  it.each(['sync', 'async'] as const)('falls back to the same cell with push-aside through the Worker (%s)', async mode => {
    run = setup(getRegistry('A'), adapter(mode));
    enter(); place([{ featureId: 'ledger', column: 2, row: 1, width: 2, height: 1 }]); run.actions.addPage();
    place(checkerboard.map((featureId, i) => ({ featureId, ...cells[i], width: 1, height: 1 }))); run.actions.goToPage(0);
    run.actions.enterEditing();
    const result = run.actions.movePanelToPage('ledger', 1);
    if (mode === 'async') { expect(result.status).toBe('pending'); expect(board().currentPage).toBe(0); await Promise.resolve(); await Promise.resolve(); }
    expect(pagePanels(1).find(p => p.featureId === 'ledger')).toMatchObject({ column: 2, row: 1, width: 2, height: 1 });
    expect(pagePanels(1)).toHaveLength(13); expect(pagePanels(0)).toEqual([]); expect(board().currentPage).toBe(1);
    expect(run.getState().undo).toMatchObject({ kind: 'move-page' }); expect(run.getState().gesturePreview).toBeNull();
  });
  it('refuses with no-room-next-page and keeps the panel when the neighbor page is full', () => {
    enter(); place([{ featureId: 'ledger', column: 0, row: 0, width: 1, height: 1 }]); run.actions.addPage();
    place([{ featureId: 'grants', column: 0, row: 0, width: 4, height: 4 }, { featureId: 'tax', column: 4, row: 0, width: 2, height: 4 }]); run.actions.goToPage(0);
    const before = run.getState();
    expect(run.actions.movePanelToPage('ledger', 1)).toMatchObject({ status: 'rejected', code: 'NO_CAPACITY' });
    expect(run.getState().boards.management.pages).toEqual(before.boards.management.pages); expect(board().currentPage).toBe(0);
    expect(run.getState().notice).toMatchObject({ messageKey: 'no-room-next-page' }); expect(run.getState().undo).toBe(before.undo);
  });
});

describe('layer switching, revisions and per-board undo (AC-174·189, SCR-35)', () => {
  it('preserves each board and lets a marketing change leave the management undo valid', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    const managementUndo = run.getState().undo!;
    expect(run.getState().layoutRevision).toBe(1); expect(board('management').revision).toBe(1);
    expect(run.actions.switchLayer('marketing')).toBe(true);
    expect(run.getState()).toMatchObject({ layer: 'marketing', activeBoard: 'marketing', panels: [], undo: null });
    expect(run.getState().guidance.queue).toEqual(['choose-feature']);
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    expect(run.getState().layoutRevision).toBe(2); expect(board('marketing').revision).toBe(1); expect(board('management').revision).toBe(1);
    expect(board('management').undo).toBe(managementUndo);
    expect(run.actions.switchLayer('orders-payment')).toBe(true);
    expect(run.getState()).toMatchObject({ layer: 'orders-payment', activeBoard: 'marketing' });
    expect(run.actions.switchLayer('management')).toBe(true);
    expect(run.getState().undo).toBe(managementUndo);
    expect(run.actions.undo(managementUndo.token).status).toBe('accepted');
    expect(run.getState().panels).toEqual([]); expect(ids(pagePanels(0, 'marketing'))).toEqual(['community']);
    expect(run.getState().layoutRevision).toBe(3); expect(board('management').revision).toBe(2); expect(board('marketing').revision).toBe(1);
  });
  it('keeps pages, the viewed page, notices and coaching records across switches', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); run.actions.addPage();
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'grants' });
    const before = board('management');
    run.actions.switchLayer('marketing'); run.actions.switchLayer('orders-payment'); run.actions.switchLayer('management');
    const after = board('management');
    expect(after.pages).toBe(before.pages); expect(after.currentPage).toBe(1); expect(after.undo).toBe(before.undo); expect(after.notice).toBeNull();
    expect(after.revision).toBe(before.revision); expect(after.guidance.coach).toEqual(before.guidance.coach);
  });
  it('switches only under the SCR-21 conditions, closes the drawer and records a visible F-03 coach', () => {
    completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled(); advance(400);
    expect(run.getState().guidance.active).toBe('choose-feature');
    expect(run.actions.switchLayer('management')).toBe(false);
    expect(run.actions.switchLayer('marketing')).toBe(true);
    expect(board('management').guidance.coach['choose-feature']).toBe('dismissed'); expect(board('management').guidance.active).toBeNull();
    run.actions.switchLayer('management');
    run.actions.enterEditing(); expect(run.actions.switchLayer('marketing')).toBe(false); run.actions.finishEditing();
    run.actions.inputStarted({ kind: 'pointer', id: 9 }); expect(run.actions.switchLayer('marketing')).toBe(false); run.actions.inputEnded({ kind: 'pointer', id: 9 });
    run.actions.openSettings(); expect(run.actions.switchLayer('marketing')).toBe(false);
    run.actions.closeOverlay(); expect(run.actions.switchLayer('marketing')).toBe(false);
    run.actions.finishOverlayExit(run.getState().exitPendingToken!);
    run.actions.openDrawer('money'); expect(run.actions.switchLayer('marketing')).toBe(true);
    expect(run.getState().overlay).toEqual({ type: 'none' }); expect(run.getState().exitPendingToken).toBeNull();
    expect(run.actions.switchLayer('bogus' as never)).toBe(false);
  });
  it('starts with three only on the management board; marketing uses startWithPreset (v4.1)', () => {
    enter(); run.actions.switchLayer('marketing');
    expect(run.actions.startWithThree().status).toBe('unchanged'); expect(run.getState().panels).toEqual([]); expect(run.getState().layoutRevision).toBe(0);
    run.actions.switchLayer('management');
    expect(run.actions.startWithThree().status).toBe('accepted');
    expect(run.getState().panels.map(p => [p.featureId, p.column, p.row])).toEqual([['ledger', 0, 0], ['margin', 1, 0], ['calendar', 2, 0]]);
    run.actions.addPage();
    expect(run.actions.startWithThree().status).toBe('unchanged'); expect(run.getState().panels).toEqual([]);
  });
});

describe('coaching queues and widget help (F-21, AC-196~205, ARCHITECTURE 11.5)', () => {
  const visible = () => { const g = run.getState().guidance; return g.active ?? g.activeWidget; };
  it('shows F-03 steps first, then one explanation per placed widget in order, each once with the 200ms gap', () => {
    enter(); run.actions.startWithThree(); run.actions.visualSettled();
    expect(run.getState().guidance.widgetQueue).toEqual(['ledger', 'margin', 'calendar']);
    expect(run.getState().guidance.widgetCoach).toEqual({ ledger: 'queued', margin: 'queued', calendar: 'queued' });
    advance(200); expect(visible()).toBe('move-panel'); run.actions.dismissCoach();run.actions.enterEditing();
    advance(200); expect(visible()).toBe('resize-panel'); run.actions.dismissCoach();run.actions.finishEditing();
    advance(200); expect(visible()).toBe('ledger'); expect(run.getState().guidance.widgetCoach.ledger).toBe('visible');
    expect(run.getState().idle.blockedReasons).toContain('coaching');
    run.actions.dismissCoach(); expect(run.getState().guidance.widgetCoach.ledger).toBe('dismissed');
    advance(199); expect(visible()).toBeNull(); advance(1); expect(visible()).toBe('margin');
    run.actions.dismissCoach(); advance(200); expect(visible()).toBe('calendar'); run.actions.dismissCoach();
    run.actions.applyLayoutIntent({ type: 'remove', featureId: 'ledger' }); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    expect(run.getState().guidance.widgetQueue).toEqual([]);
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'calendar' }); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    expect(run.getState().guidance.widgetQueue).toEqual([]);
  });
  it('drops a removed target to unseen, returns a hidden one to the queue, and help keeps the records', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'grants' }); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'tax' });
    run.actions.visualSettled(); advance(200); run.actions.dismissCoach();
    run.actions.applyLayoutIntent({ type: 'remove', featureId: 'tax' }); run.actions.visualSettled();
    expect(run.getState().guidance.widgetQueue).toEqual(['grants']); expect(run.getState().guidance.widgetCoach.tax).toBeUndefined();
    advance(200); expect(visible()).toBe('grants');
    run.actions.addPage();
    expect(run.getState().guidance).toMatchObject({ activeWidget: null, widgetQueue: ['grants'], widgetCoach: { grants: 'queued' } });
    run.actions.goToPage(0); advance(199); expect(visible()).toBeNull(); advance(1); expect(visible()).toBe('grants');
    run.actions.switchLayer('marketing'); expect(board('management').guidance).toMatchObject({ activeWidget: null, widgetCoach: { grants: 'queued' } });
    run.actions.switchLayer('management'); advance(200); expect(visible()).toBe('grants');
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'tax' });
    expect(run.actions.openWidgetHelp('tax', 'panel', 'help-tax')).toBe(true);
    expect(run.getState().widgetHelp).toEqual({ featureId: 'tax', origin: 'panel', returnFocusKey: 'help-tax' });
    expect(run.getState().guidance.widgetCoach).toEqual({ grants: 'dismissed', tax: 'queued' });
    expect(run.getState().idle.blockedReasons).toContain('coaching');
    run.actions.visualSettled(); advance(1000); expect(visible()).toBeNull();
    expect(run.actions.closeWidgetHelp()).toBe(true); expect(run.actions.closeWidgetHelp()).toBe(false);
    advance(200); expect(visible()).toBe('tax');
    run.actions.enterEditing(); expect(run.actions.openWidgetHelp('tax', 'panel', 'help-tax')).toBe(false);
  });
  it('does not queue an explanation for a failed or cancelled placement', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'trade-area' });
    const token = run.actions.beginPreview({ source: 'drawer', pointerId: 1, intent: { type: 'add-drop', featureId: 'grants', column: 3, row: 3 } })!;
    run.actions.cancelPreview(token);
    expect(run.getState().guidance.widgetQueue).toEqual(['ledger']);
  });
  it('queues widget explanations for every run, including one made with getCatalog (no legacy run without them, T-055)', () => {
    run = setup(getCatalog('A')); enter(); run.actions.startWithThree();
    expect(run.getState().guidance.widgetQueue).toEqual(['ledger', 'margin', 'calendar']);
  });
});

describe('detail stack, language, example states, notices and briefing (API-03·05·06 v4)', () => {
  it('opens one linked detail over the first and goes back', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    expect(run.actions.openLinkedDetail({ featureId: 'suppliers' })).toBe(false);
    run.actions.openDetail('ledger', 'panel-ledger');
    expect(run.actions.openLinkedDetail({ featureId: 'suppliers', view: 'order', itemId: 'po-1' })).toBe(true);
    expect(run.getState().overlay).toEqual({ type: 'detail', featureId: 'suppliers', returnFocusKey: 'panel-ledger', stack: [{ featureId: 'ledger' }, { featureId: 'suppliers', view: 'order', itemId: 'po-1' }] });
    expect(run.actions.openLinkedDetail({ featureId: 'community' })).toBe(true);
    expect(run.getState().overlay).toMatchObject({ featureId: 'community', stack: [{ featureId: 'ledger' }, { featureId: 'community' }] });
    expect(run.actions.openLinkedDetail({ featureId: 'nope' as FeatureId })).toBe(false);
    expect(run.actions.openWidgetHelp('community', 'detail', 'detail-help')).toBe(true);
    expect(run.actions.detailBack()).toBe(true);
    expect(run.getState().overlay).toEqual({ type: 'detail', featureId: 'ledger', returnFocusKey: 'panel-ledger', stack: [{ featureId: 'ledger' }] });
    expect(run.getState().widgetHelp).toBeNull();
    expect(run.actions.detailBack()).toBe(false);
    run.actions.openWidgetHelp('ledger', 'detail', 'detail-help'); run.actions.closeOverlay();
    expect(run.getState().widgetHelp).toBeNull();
  });
  it('changes language and example state without touching layout, coaching or notices', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' });
    const before = run.getState();
    expect(run.actions.setLocale('zh-Hant')).toBe(true); expect(run.actions.setLocale('fr' as Locale)).toBe(false);
    run.actions.setPreviewFamily('error'); run.actions.setPreviewVariant('margin', 'zero-net');
    const s = run.getState();
    expect(s.locale).toBe('zh-Hant'); expect(s.preview).toEqual({ family: 'error', overrides: { margin: 'zero-net' } });
    expect(s.boards).toBe(before.boards); expect(s.layoutRevision).toBe(before.layoutRevision); expect(s.notice).toBe(before.notice);
    run.actions.setPreviewVariant('margin', null); expect(run.getState().preview.overrides).toEqual({});
    run.actions.setPreviewVariant('voice-booking', 'phone-disconnected'); run.actions.setPreviewFamily('empty');
    expect(run.getState().preview).toEqual({ family: 'empty', overrides: {} });
    run.actions.resetWidgetPreview('ledger'); expect(run.getState().preview.overrides).toEqual({ ledger: 'normal' });
    run.actions.setPreviewFamily('normal'); run.actions.setPreviewVariant('ledger', 'no-sales'); run.actions.resetWidgetPreview('ledger');
    expect(run.getState().preview).toEqual({ family: 'normal', overrides: {} });
    const unchanged = run.getState(); run.actions.resetWidgetPreview('ledger'); run.actions.setPreviewFamily('bogus' as never); expect(run.getState()).toBe(unchanged);
  });
  it('shows data notices with their own pausable timer and keeps the layout undo', () => {
    enter(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ledger' }); const layoutUndo = run.getState().undo;
    run.actions.showNotice({ kind: 'success', messageKey: 'data.notice.restocked', params: { n: 8 }, undo: { target: 'data', token: 'data-1' }, featureId: 'inventory-booking' });
    expect(selectCommonNotice(run.getState())).toMatchObject({ kind: 'success', messageKey: 'data.notice.restocked', params: { n: 8 }, undo: { target: 'data', token: 'data-1' }, layerId: 'management', expiresAt: now + testTime.undoMs });
    expect(selectCommonNotice(run.getState())!.undoToken).toBeUndefined(); expect(run.getState().undo).toBe(layoutUndo);
    advance(1000); run.actions.pauseUndo('toast-focus'); expect(selectCommonNotice(run.getState())!.expiresAt).toBe(Infinity);
    advance(20000); expect(selectCommonNotice(run.getState())).not.toBeNull();
    run.actions.resumeUndo('toast-focus'); expect(selectCommonNotice(run.getState())!.expiresAt).toBe(now + 5000);
    advance(5000); expect(selectCommonNotice(run.getState())).toBeNull();
    run.actions.showNotice({ kind: 'complete', messageKey: 'data.notice.saved' }); expect(selectCommonNotice(run.getState())!.expiresAt).toBe(now + testTime.undoMs);
  });
  it('lets the briefing be acknowledged once and counts both boards\' deadlines', () => {
    enter(); run.actions.switchLayer('marketing'); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    const marketingUndo = run.getState().undo!; run.actions.switchLayer('management');
    expect(run.nextDeadline()).toBeLessThanOrEqual(testTime.undoMs);
    advance(testTime.undoMs); expect(board('marketing').undo).toBeNull(); expect(run.actions.undo(marketingUndo.token).status).toBe('rejected');
    run.actions.acknowledgeBriefing(); expect(run.getState().briefing).toBe('dismissed');
  });
});
