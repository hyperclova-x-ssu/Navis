import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../data/db/generated/manifest.json';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.useRealTimers(); });

describe('F02 POS business clock', () => {
  it('keeps the mockup store day unless the operating build asks for the real one', async () => {
    const clock = await import('./clock');
    expect(clock.POS_BUSINESS_DATE).toBe(manifest.cutoff.businessDate);
    expect(clock.POS_NOW_TIME).toBe(manifest.cutoff.localTime.slice(0, 5));
    expect(clock.businessNow()).toBe(`${manifest.cutoff.businessDate}T${manifest.cutoff.localTime.slice(0, 5)}`);
  });

  it('reads live local timestamps while keeping the initial dashboard snapshot', async () => {
    vi.stubEnv('VITE_NAVIS_POS_CLOCK', 'real');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T08:50:30.000Z')); // 17:50 in Asia/Seoul
    vi.resetModules();
    const clock = await import('./clock');
    expect(clock.POS_BUSINESS_DATE).toBe('2026-11-21');
    expect(clock.POS_NOW_TIME).toBe('17:50');
    vi.setSystemTime(new Date('2026-11-22T20:00:00.000Z'));
    expect(clock.businessNow()).toBe('2026-11-23T05:00');
    expect(clock.POS_BUSINESS_DATE).toBe('2026-11-21');
  });

  it('attributes early morning to the preceding business day', async () => {
    vi.stubEnv('VITE_NAVIS_POS_CLOCK', 'real');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T16:10:00.000Z')); // 01:10 on 11-21 in Asia/Seoul
    vi.resetModules();
    const clock = await import('./clock');
    expect(clock.POS_BUSINESS_DATE).toBe('2026-11-20');
    expect(clock.POS_NOW_TIME).toBe('01:10');
    expect(clock.POS_NOW).toBe('2026-11-21T01:10');
  });
});
