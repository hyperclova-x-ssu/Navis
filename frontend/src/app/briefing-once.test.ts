import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { briefingDayStorageKey } from '../state/briefing-day';
import { createBrowserRun } from './run';
import { beginDashboard } from './test-session';

/** D-327: the browser run remembers the business day of the last automatic briefing in this browser's localStorage. */
const KEY = briefingDayStorageKey();
const prefs = { theme: 'light', reducedMotion: true } as const;
let t = 0;
function fakeWindow(search = '', storage: () => Storage = () => window.localStorage): Window {
  return { innerWidth: 1920, innerHeight: 1080, location: { search }, performance: { now: () => t }, get localStorage() { return storage(); } } as unknown as Window;
}
/** One page load: a fresh run, the F-03/F-21 steps finished, then a long safe wait on the management board. */
function pageLoad(win: Window) {
  t = 0;
  const run = createBrowserRun(prefs, win)!;
  const advance = (ms: number) => { t += ms; run.actions.tick(); };
  beginDashboard(run, 'cafe'); run.actions.visualSettled(); advance(400);
  run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); advance(200);
  run.actions.skipWidgetCoaches(); advance(200); run.actions.clearNotice(); run.actions.finishEditing();
  advance(1200); advance(100000);
  return run;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('browser run: arrival briefing once per business day (D-327)', () => {
  it('the first load shows it and stores the business day; a reload in the same day does not show it', () => {
    const first = pageLoad(fakeWindow());
    expect(first.getState()).toMatchObject({ briefing: 'visible', overlay: { type: 'briefing' } });
    expect(window.localStorage.getItem(KEY)).toBe('2026-11-17'); // the demo's business clock, not the device's
    first.dispose();
    const reload = pageLoad(fakeWindow());
    expect(reload.getState()).toMatchObject({ briefing: 'pending', overlay: { type: 'none' } });
    reload.dispose();
  });
  it('writes nothing to storage until the briefing actually opens', () => {
    const run = createBrowserRun(prefs, fakeWindow())!;
    expect(window.localStorage.length).toBe(0);
    run.dispose();
  });
  it('dev-only ?briefing=always skips the memory so verification scripts see the card on every load', () => {
    window.localStorage.setItem(KEY, '2026-11-17');
    const run = pageLoad(fakeWindow('?briefing=always'));
    expect(run.getState().overlay.type).toBe('briefing');
    expect(window.localStorage.getItem(KEY)).toBe('2026-11-17');
    run.dispose();
  });
  it('a browser that blocks storage still gets one briefing per run and never throws', () => {
    const blocked = () => { throw new DOMException('denied', 'SecurityError'); };
    const first = pageLoad(fakeWindow('', blocked));
    expect(first.getState().overlay.type).toBe('briefing');
    first.dispose();
    const second = pageLoad(fakeWindow('', blocked));
    expect(second.getState().overlay.type).toBe('briefing');
    second.dispose();
  });
});
