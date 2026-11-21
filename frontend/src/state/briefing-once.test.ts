import { describe, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';
import { STORE_HOURS } from '../data/store-hours';
import manifest from '../data/db/generated/manifest.json';
import { briefingBusinessDay, briefingDayStorageKey, BRIEFING_LEAD_MINUTES, type BriefingDayStorage } from './briefing-day';
import { createRunStore } from './index';
import { completeEmptyOnboarding } from './test-fixtures';

/** D-327 (2026-11-21): the arrival briefing opens by itself at most once per business day. */
const preset = screenPresets.A;
const KEY = briefingDayStorageKey();

class MemoryStorage implements BriefingDayStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const brokenStorage = (what: 'read' | 'write' | 'both'): BriefingDayStorage => ({
  getItem() { if (what !== 'write') throw new DOMException('denied', 'SecurityError'); return null; },
  setItem() { if (what !== 'read') throw new DOMException('quota', 'QuotaExceededError'); },
});

interface Harness { run: ReturnType<typeof createRunStore>; advance: (ms: number) => void; finishCoaching: () => void }
/** One page load: a fresh store (and clock) sharing `storage` and the settable business clock. */
function load(storage: BriefingDayStorage | null | undefined, clock: { now: string }): Harness {
  let t = 0;
  const run = createRunStore({ screenPreset: preset, catalog: getRegistry('A'), time: testTime, clock: () => t, theme: 'light', businessNow: () => clock.now, ...(storage === undefined ? {} : { briefingStorage: storage }) });
  const advance = (ms: number) => { t += ms; run.actions.tick(); };
  // Same path as the state tests: onboarding, three starter widgets, every F-03/F-21 step, then the safe wait.
  const finishCoaching = () => {
    completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled(); advance(400);
    run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); advance(200);
    run.actions.skipWidgetCoaches(); advance(200); run.actions.clearNotice(); run.actions.finishEditing();
  };
  return { run, advance, finishCoaching };
}
const reset = (h: Harness) => h.run.actions.resetRun({ screenPreset: preset, catalog: getRegistry('A'), theme: 'light' });
/** Finishes the coach steps, waits well past the safe time, and reports whether the briefing card opened (and was not early). */
function opens(h: Harness): boolean {
  h.finishCoaching(); h.advance(testTime.briefingSafeMs - 1);
  if (h.run.getState().overlay.type === 'briefing') return false;
  h.advance(1); h.advance(100000);
  return h.run.getState().briefing === 'visible' && h.run.getState().overlay.type === 'briefing';
}
const closeBriefing = (h: Harness) => { const exit = h.run.actions.closeOverlay()!; h.run.actions.finishOverlayExit(exit); };

describe('briefingBusinessDay: opening time minus 2 hours, Asia/Seoul wall clock', () => {
  it('uses a two-hour lead', () => { expect(BRIEFING_LEAD_MINUTES).toBe(120); });
  it('starts each weekday at its own opening minus 2 h and ends at the next weekday start', () => {
    // 2026-11-21 is Saturday: opening 09:30 -> starts 07:30; Sunday 10:00 -> 08:00; Monday 08:00 -> 06:00.
    expect(STORE_HOURS.sat[0]).toBe('09:30'); expect(STORE_HOURS.sun[0]).toBe('10:00'); expect(STORE_HOURS.mon[0]).toBe('08:00');
    expect(briefingBusinessDay('2026-11-21T07:29')).toBe('2026-11-20');
    expect(briefingBusinessDay('2026-11-21T07:30')).toBe('2026-11-21');
    expect(briefingBusinessDay('2026-11-22T07:59')).toBe('2026-11-21');
    expect(briefingBusinessDay('2026-11-22T08:00')).toBe('2026-11-22');
    expect(briefingBusinessDay('2026-11-23T05:59')).toBe('2026-11-22');
    expect(briefingBusinessDay('2026-11-23T06:00')).toBe('2026-11-23');
  });
  it('keeps late-night and after-midnight times in the day that began the evening before', () => {
    expect(briefingBusinessDay('2026-11-17T22:30')).toBe('2026-11-17');
    expect(briefingBusinessDay('2026-11-17T23:59')).toBe('2026-11-17');
    expect(briefingBusinessDay('2026-11-18T00:00')).toBe('2026-11-17');
    expect(briefingBusinessDay('2026-11-18T05:59')).toBe('2026-11-17');
    expect(briefingBusinessDay('2026-11-18T06:00')).toBe('2026-11-18');
  });
  it('crosses month and year ends', () => {
    expect(briefingBusinessDay('2026-12-01T05:00')).toBe('2026-11-30');
    expect(briefingBusinessDay('2027-01-01T03:00')).toBe('2026-12-31');
    expect(briefingBusinessDay('2027-01-01T06:00')).toBe('2027-01-01');
  });
  it('accepts a seconds suffix and rejects anything that is not a local date-time', () => {
    expect(briefingBusinessDay('2026-11-17T15:45:00')).toBe('2026-11-17');
    expect(briefingBusinessDay('not a date')).toBeNull();
    expect(briefingBusinessDay('2026-13-40T99:99')).toBeNull();
  });
  it('is stored per store', () => { expect(KEY).toContain(manifest.store.storeId); });
});

describe('arrival briefing: at most once per business day (D-327)', () => {
  it('the first visit in a business day opens it and remembers that day for this store', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock);
    h.finishCoaching(); h.advance(testTime.briefingSafeMs - 1);
    expect(h.run.getState().overlay.type).toBe('none'); // the existing safe wait is kept
    h.advance(1);
    expect(h.run.getState()).toMatchObject({ briefing: 'visible', overlay: { type: 'briefing' } });
    expect(storage.data.get(KEY)).toBe('2026-11-17');
    expect(storage.data.size).toBe(1);
  });
  it('a reload in the same business day (new store, same storage) does not open it again', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const first = load(storage, clock); expect(opens(first)).toBe(true); closeBriefing(first);
    const second = load(storage, clock);
    second.finishCoaching(); second.advance(100000);
    expect(second.run.getState().overlay.type).toBe('none');
    expect(second.run.getState().briefing).toBe('pending');
    expect(second.run.getState().briefingSafeSince).toBeNull();
  });
  it('shows once even when the first one was never closed or acknowledged', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const first = load(storage, clock); expect(opens(first)).toBe(true); // left open
    const second = load(storage, clock); second.finishCoaching(); second.advance(100000);
    expect(second.run.getState().overlay.type).toBe('none');
  });
  it('data reset, example state or business change (resetRun) in the same day does not open it again', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    for (let i = 0; i < 3; i++) {
      reset(h); h.finishCoaching(); h.advance(100000);
      expect(h.run.getState().overlay.type).toBe('none');
      expect(h.run.getState().briefing).toBe('pending');
    }
    expect(storage.data.get(KEY)).toBe('2026-11-17');
  });
  it('stays quiet for the rest of the business day, past midnight, until opening minus 2 h', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    for (const now of ['2026-11-17T23:59', '2026-11-18T00:00', '2026-11-18T05:59']) {
      clock.now = now; reset(h); h.finishCoaching(); h.advance(100000);
      expect(h.run.getState().overlay.type, now).toBe('none');
    }
  });
  it('opens again on the first visit of the next business day (opening minus 2 h boundary)', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    clock.now = '2026-11-18T05:59'; reset(h); h.finishCoaching(); h.advance(100000);
    expect(h.run.getState().overlay.type).toBe('none'); // Wednesday opens 08:00 -> its day starts 06:00
    clock.now = '2026-11-18T06:00'; reset(h); h.finishCoaching(); h.advance(testTime.briefingSafeMs);
    expect(h.run.getState()).toMatchObject({ briefing: 'visible', overlay: { type: 'briefing' } });
    expect(storage.data.get(KEY)).toBe('2026-11-18');
    closeBriefing(h);
    reset(h); h.finishCoaching(); h.advance(100000);
    expect(h.run.getState().overlay.type).toBe('none');
  });
  it('uses each weekday\'s own opening time (Saturday starts 07:30, Sunday 08:00)', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-20T15:00' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    clock.now = '2026-11-21T07:29'; reset(h); h.finishCoaching(); h.advance(100000);
    expect(h.run.getState().overlay.type).toBe('none'); // still Friday's business day
    clock.now = '2026-11-21T07:30'; reset(h); h.finishCoaching(); h.advance(testTime.briefingSafeMs);
    expect(h.run.getState().overlay.type).toBe('briefing');
    expect(storage.data.get(KEY)).toBe('2026-11-21');
  });
  it('a business day rolling over inside one run opens it once at the new day\'s first safe moment', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    reset(h); h.finishCoaching(); h.advance(100000);
    expect(h.run.getState().overlay.type).toBe('none');
    clock.now = '2026-11-18T06:00'; h.advance(testTime.briefingSafeMs); h.advance(testTime.briefingSafeMs);
    expect(h.run.getState()).toMatchObject({ briefing: 'visible', overlay: { type: 'briefing' } });
  });
  it('a stored day from another store does not suppress this store', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    storage.setItem('navis.briefing.lastShownDay.other-store', '2026-11-17');
    expect(opens(load(storage, clock))).toBe(true);
  });
  it('ignores a malformed stored value', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    storage.setItem(KEY, '{"oops":true}');
    expect(opens(load(storage, clock))).toBe(true);
    expect(storage.data.get(KEY)).toBe('2026-11-17');
  });
  it('a stored later day (device moved back) is not treated as shown today', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    storage.setItem(KEY, '2026-11-20');
    expect(opens(load(storage, clock))).toBe(true);
  });
  it('keeps waiting for the F-03 coach steps and records nothing until it actually opens', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock);
    completeEmptyOnboarding(h.run, 'cafe'); h.run.actions.visualSettled(); h.advance(400);
    h.advance(100000); // F-03 steps have not been dismissed yet
    expect(h.run.getState().overlay.type).not.toBe('briefing');
    expect(storage.data.size).toBe(0); // nothing is recorded until it actually opens
  });
});

describe('arrival briefing: the manual and the "no storage" paths', () => {
  it('without any storage it still opens once per run, and a new run opens it again', () => {
    const clock = { now: '2026-11-17T15:45' };
    const h = load(undefined, clock);
    expect(opens(h)).toBe(true); closeBriefing(h);
    h.advance(100000); expect(h.run.getState().briefing).toBe('dismissed');
    reset(h); expect(opens(h)).toBe(true);
  });
  it.each([['null storage', null], ['unreadable', brokenStorage('read')], ['unwritable', brokenStorage('write')], ['unreadable and unwritable', brokenStorage('both')]])('%s falls back to once per run without throwing', (_name, storage) => {
    const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock);
    expect(opens(h)).toBe(true); closeBriefing(h);
    h.advance(100000); expect(h.run.getState()).toMatchObject({ briefing: 'dismissed', overlay: { type: 'none' } });
    reset(h); expect(opens(h)).toBe(true); // a new run starts the fallback over
  });
  it('a throwing storage getter on the window never breaks the run either', () => {
    const clock = { now: '2026-11-17T15:45' };
    const storage = { get getItem(): never { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as BriefingDayStorage;
    expect(opens(load(storage, clock))).toBe(true);
  });
  it('a suppressed run can still be acknowledged from the briefing widget (pending -> dismissed)', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const first = load(storage, clock); expect(opens(first)).toBe(true); closeBriefing(first);
    const second = load(storage, clock); second.finishCoaching(); second.advance(100000);
    expect(second.run.getState().briefing).toBe('pending');
    second.run.actions.acknowledgeBriefing();
    expect(second.run.getState().briefing).toBe('dismissed');
  });
  it('the briefing widget detail still opens by hand any time, even after the automatic card has shown today', () => {
    const storage = new MemoryStorage(); const clock = { now: '2026-11-17T15:45' };
    const h = load(storage, clock); expect(opens(h)).toBe(true); closeBriefing(h);
    reset(h); h.finishCoaching(); h.advance(100000);
    expect(h.run.getState().overlay.type).toBe('none');
    h.run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'briefing' });
    expect(h.run.actions.openDetail('briefing', 'panel-briefing')).toBe(true);
    expect(h.run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'briefing' });
  });
});
