import { completeEmptyOnboarding } from './test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusinessType, LayoutAdapter, Panel, RunStore } from '../contracts';
import { getMarketingPreset, getRegistry } from '../catalog';
import { preview, screenPresets } from '../layout';
import { testTime } from '../layout/test-policy';
import { createRunStore } from './index';

const solve = (request: Parameters<LayoutAdapter['submit']>[0]) => ({ ...request, result: preview(request.beforePanels, request.intent, screenPresets[request.presetId].grid, getRegistry(request.presetId)) });
const sync: LayoutAdapter = { ready: async () => {}, submit: (request, receive) => receive(solve(request)), cancel() {}, dispose() {} };
let now = 0;
let run: RunStore;
function setup(presetId: 'A' | 'B' = 'A'): RunStore {
  return createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: testTime, clock: () => now, theme: 'light', layoutAdapter: sync });
}
const advance = (ms: number) => { now += ms; run.actions.tick(); };
const enterMarketing = (type: BusinessType | null = 'cafe') => { completeEmptyOnboarding(run, type); run.actions.visualSettled(); advance(400); run.actions.dismissCoach(); run.actions.switchLayer('marketing'); run.actions.visualSettled(); advance(400); run.actions.dismissCoach(); };
const cells = (panels: readonly Panel[]) => panels.map(p => [p.featureId, p.column, p.row, p.width, p.height]);
beforeEach(() => { now = 0; run = setup(); });
afterEach(() => run.dispose());

describe('startWithPreset (API-03 v4.1, AC-309~312)', () => {
  it.each(['A', 'B'] as const)('places the seven widgets in one accepted change on %s, with the cafe table', presetId => {
    run.dispose(); run = setup(presetId); enterMarketing();
    const result = run.actions.startWithPreset();
    expect(result.status).toBe('accepted');
    expect(cells(run.getState().panels)).toEqual(cells(getMarketingPreset('cafe').map(c => ({ ...c, width: c.width, height: c.height }) as Panel)));
    expect(run.getState().panels).toHaveLength(7);
    expect(Math.max(...run.getState().panels.map(p => p.width))).toBeLessThanOrEqual(4);
    expect(run.getState().layoutRevision).toBe(1);
    expect(run.getState().boards.marketing.revision).toBe(1);
    expect(run.getState().undo!.kind).toBe('starter-add');
    expect(run.getState().notice).not.toBeNull();
  });
  it('is unchanged on the management board and never touches it', () => {
    completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled();
    expect(run.actions.startWithPreset().status).toBe('unchanged');
    expect(run.getState().panels).toEqual([]); expect(run.getState().layoutRevision).toBe(0);
  });
  it('works only while the whole marketing board is empty (AC-312)', () => {
    enterMarketing(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' });
    const before = run.getState().layoutRevision;
    expect(run.actions.startWithPreset().status).toBe('unchanged');
    expect(run.getState().layoutRevision).toBe(before);
    run.actions.undo(run.getState().undo!.token);
    expect(run.actions.startWithPreset().status).toBe('accepted');
    // a widget on another page also blocks it
    run.actions.undo(run.getState().undo!.token);
    run.actions.addPage(); run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'community' }); run.actions.goToPage(0);
    expect(run.actions.startWithPreset().status).toBe('unchanged');
  });
  it('undoes with one undo, brings the button back and can start again (AC-309)', () => {
    enterMarketing(); run.actions.startWithPreset(); run.actions.visualSettled();
    expect(run.getState().starter).toBe('completed');
    expect(run.actions.undo(run.getState().undo!.token).status).toBe('accepted');
    expect(run.getState().panels).toEqual([]); expect(run.getState().starter).toBe('ready');
    expect(run.actions.startWithPreset().status).toBe('accepted');
    expect(run.getState().panels).toHaveLength(7);
  });
  it('rejects a stale revision', () => {
    enterMarketing();
    expect(run.actions.startWithPreset(99).status).toBe('rejected');
    expect(run.getState().panels).toEqual([]);
  });
  it.each([['beauty', 'slot-coupon'], ['retail', 'expiry-coupon'], ['other', 'promo-video'], [null, 'ai-response'], ['cafe', 'ai-response']] as const)('%s: row 2 starts with %s (AC-311)', (type, first) => {
    enterMarketing(type); run.actions.startWithPreset();
    const second = run.getState().panels.find(p => p.column === 0 && p.row === 1)!;
    expect(second.featureId).toBe(first);
    expect(new Set(run.getState().panels.map(p => p.featureId)).size).toBe(7);
  });
  it('queues the F-03 steps and then the widget explanations in placement order (AC-312)', () => {
    enterMarketing(); run.actions.startWithPreset(); run.actions.visualSettled();
    const g = run.getState().guidance;
    expect(g.queue).toEqual(['move-panel', 'resize-panel']);
    expect(g.widgetQueue).toEqual(['marketing-today', 'ai-response', 'expiry-coupon', 'promo-video', 'slot-coupon', 'coupon-status', 'customer-groups']);
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      advance(testTime.coachGapMs);
      const s = run.getState().guidance; const v = s.active ?? s.activeWidget;
      if (v) seen.push(v); run.actions.dismissCoach();if(v==='move-panel')run.actions.enterEditing();if(v==='resize-panel')run.actions.finishEditing();
    }
    expect(seen).toEqual(['move-panel', 'resize-panel', 'marketing-today', 'ai-response', 'expiry-coupon', 'promo-video', 'slot-coupon', 'coupon-status', 'customer-groups']);
    advance(testTime.coachGapMs * 3); expect(run.getState().guidance.active ?? run.getState().guidance.activeWidget).toBeNull();
  });
});

describe('skipWidgetCoaches (API-03 v4.1, AC-312)', () => {
  it('records visible and queued steps and explanations as dismissed and never shows them again; help still opens', () => {
    enterMarketing(); run.actions.startWithPreset(); run.actions.visualSettled();
    advance(testTime.coachGapMs); advance(testTime.coachGapMs);
    expect(run.getState().guidance.active ?? run.getState().guidance.activeWidget).not.toBeNull();
    run.actions.skipWidgetCoaches();
    const g = run.getState().guidance;
    expect(g.active).toBeNull(); expect(g.activeWidget).toBeNull(); expect(g.queue).toEqual([]); expect(g.widgetQueue).toEqual([]);
    expect(Object.values(g.widgetCoach)).toHaveLength(7); expect(new Set(Object.values(g.widgetCoach))).toEqual(new Set(['dismissed']));
    expect(g.coach['resize-panel']).toBe('dismissed'); expect(g.coach['move-panel']).toBe('dismissed');
    advance(testTime.coachGapMs * 5);
    expect(run.getState().guidance.active ?? run.getState().guidance.activeWidget).toBeNull();
    expect(run.actions.openWidgetHelp('slot-coupon', 'panel', 'k')).toBe(true);
    expect(run.getState().widgetHelp?.featureId).toBe('slot-coupon');
  });
  it('only changes the active board and is a no-op with nothing to skip', () => {
    enterMarketing(); run.actions.startWithPreset(); run.actions.visualSettled();
    run.actions.switchLayer('management'); const before = run.getState();
    run.actions.skipWidgetCoaches();
    expect(run.getState().boards.marketing.guidance.widgetQueue).toHaveLength(7);
    expect(run.getState().boards.management.guidance).toBe(before.boards.management.guidance);
    run.actions.skipWidgetCoaches(); expect(run.getState()).toBe(run.getState());
  });
});

describe('openDetailRef (API-03 v4.1)', () => {
  beforeEach(() => { enterMarketing(); });
  it('opens an unplaced widget of this and the other layer as a root detail and keeps focus', () => {
    expect(run.actions.openDetailRef({ featureId: 'slot-coupon', focus: 'action' }, 'btn')).toBe(true);
    expect(run.getState().overlay).toEqual({ type: 'detail', featureId: 'slot-coupon', returnFocusKey: 'btn', stack: [{ featureId: 'slot-coupon', focus: 'action' }] });
    run.actions.closeOverlay(); run.actions.finishOverlayExit(run.getState().exitPendingToken!);
    expect(run.actions.openDetailRef({ featureId: 'ledger' }, 'k2')).toBe(true);
    expect(run.getState().overlay).toEqual({ type: 'detail', featureId: 'ledger', returnFocusKey: 'k2' });
  });
  it('keeps view and itemId and links on top of it', () => {
    run.actions.openDetailRef({ featureId: 'promo-video', view: 'create', focus: 'action' }, 'k');
    expect(run.getState().overlay).toMatchObject({ stack: [{ featureId: 'promo-video', view: 'create', focus: 'action' }] });
    expect(run.actions.openLinkedDetail({ featureId: 'coupon-status', focus: 'action' })).toBe(true);
    expect(run.getState().overlay).toMatchObject({ featureId: 'coupon-status', stack: [{ featureId: 'promo-video' }, { featureId: 'coupon-status', focus: 'action' }] });
    expect(run.actions.detailBack()).toBe(true);
  });
  it('refuses unknown widgets, editing, another overlay, a running gesture and a pending close', () => {
    expect(run.actions.openDetailRef({ featureId: 'nope' as never }, 'k')).toBe(false);
    run.actions.enterEditing(); expect(run.actions.openDetailRef({ featureId: 'slot-coupon' }, 'k')).toBe(false); run.actions.finishEditing();
    run.actions.openSettings(); expect(run.actions.openDetailRef({ featureId: 'slot-coupon' }, 'k')).toBe(false);
    run.actions.closeOverlay(); expect(run.actions.openDetailRef({ featureId: 'slot-coupon' }, 'k')).toBe(false);
    run.actions.finishOverlayExit(run.getState().exitPendingToken!);
    expect(run.actions.openDetailRef({ featureId: 'slot-coupon' }, 'k')).toBe(true);
  });
  it('closes with the return focus key', () => {
    run.actions.openDetailRef({ featureId: 'slot-coupon', focus: 'action' }, 'panel:marketing-today:3');
    run.actions.closeOverlay(); expect(run.getState().exitingOverlay).toMatchObject({ returnFocusKey: 'panel:marketing-today:3' });
  });
});
