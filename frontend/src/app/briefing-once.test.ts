import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { briefingDayStorageKey } from '../state/briefing-day';
import { createBrowserRun } from './run';
import { beginDashboard } from './test-session';

// The browser's opening-boundary checks exercise the hosted clock, with its wall time controlled by the test.
vi.hoisted(() => {
  vi.stubEnv('VITE_NAVIS_CLOCK', 'real');
  vi.stubEnv('VITE_NAVIS_PREVIEW_HOSTS', 'staging.example.test, , preview.example.test ');
});

/** D-327: the browser run remembers the business day of the last automatic briefing in this browser's localStorage. */
const KEY = briefingDayStorageKey();
const prefs = { theme: 'light', reducedMotion: true } as const;
let t = 0;
function fakeWindow(search = '', storage: () => Storage = () => window.localStorage, hostname = '127.0.0.1'): Window {
  return { innerWidth: 1920, innerHeight: 1080, location: { search, hostname }, performance: { now: () => t }, get localStorage() { return storage(); } } as unknown as Window;
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

beforeEach(() => {
  window.localStorage.clear();
  vi.setSystemTime(new Date('2026-11-20T22:29:00Z')); // Saturday 07:29 in Seoul, one minute before the business day starts.
});
afterEach(() => { window.localStorage.clear(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('browser run: arrival briefing once per business day (D-327)', () => {
  it('stores the current Seoul business day and shows again at the next opening boundary', () => {
    const first = pageLoad(fakeWindow());
    expect(first.getState()).toMatchObject({ briefing: 'visible', overlay: { type: 'briefing' } });
    expect(window.localStorage.getItem(KEY)).toBe('2026-11-20');
    first.dispose();
    const reload = pageLoad(fakeWindow());
    expect(reload.getState()).toMatchObject({ briefing: 'pending', overlay: { type: 'none' } });
    reload.dispose();
    vi.setSystemTime(new Date('2026-11-20T22:30:00Z'));
    const nextDay = pageLoad(fakeWindow());
    expect(nextDay.getState().overlay.type).toBe('briefing');
    expect(window.localStorage.getItem(KEY)).toBe('2026-11-21');
    nextDay.dispose();
  });
  it('writes nothing to storage until the briefing actually opens', () => {
    const run = createBrowserRun(prefs, fakeWindow())!;
    expect(window.localStorage.length).toBe(0);
    run.dispose();
  });
  it.each([
    { dev: true, hostname: 'app.example.test' },
    { dev: false, hostname: 'preview.example.test' },
    { dev: false, hostname: 'moa' },
    { dev: false, hostname: 'localhost' },
    { dev: false, hostname: '127.0.0.1' },
    { dev: false, hostname: '[::1]' },
  ])('honors the verification override on $hostname without writing storage (DEV=$dev)', ({ dev, hostname }) => {
    vi.stubEnv('DEV', dev);
    window.localStorage.setItem(KEY, '2026-11-20');
    const win = fakeWindow('?briefing=always', undefined, hostname);
    for (let reload = 0; reload < 2; reload++) {
      const run = pageLoad(win);
      expect(run.getState().overlay.type).toBe('briefing');
      run.dispose();
    }
    expect(window.localStorage.getItem(KEY)).toBe('2026-11-20');
    window.localStorage.clear();
    const fresh = pageLoad(win);
    expect(fresh.getState().overlay.type).toBe('briefing');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    fresh.dispose();
  });
  it('keeps the daily limit on other production hosts even with the verification query', () => {
    vi.stubEnv('DEV', false);
    window.localStorage.setItem(KEY, '2026-11-20');
    const run = pageLoad(fakeWindow('?briefing=always', undefined, 'app.example.test'));
    expect(run.getState().overlay.type).toBe('none');
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
