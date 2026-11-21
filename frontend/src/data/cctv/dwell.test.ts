import {seedSupplement} from '../db/generated/supplement';
import {describe, expect, it} from 'vitest';
import {HOURLY_DWELL, TODAY_AVG_DWELL_MIN, dwellMinutes, splitSeconds} from './dwell';

describe('dwell time table (DATA_MODEL 12.2)', () => {
  it('hourly minutes', () => {
    expect(HOURLY_DWELL.map(r => [r.hour, r.minutes])).toEqual(seedSupplement.cctv.map(r => [r.hour, r.dwellMinutes]));
  });
  it('weights the daily dwell by visits and keeps the source order count separate', () => {
    expect(TODAY_AVG_DWELL_MIN).toBe(39);
    expect(HOURLY_DWELL.reduce((s, r) => s + r.orders, 0)).toBe(153);
    expect(HOURLY_DWELL.reduce((s, r) => s + (r.visits ?? 0), 0)).toBe(180);
  });
  it('formula', () => {
    expect(dwellMinutes(10.78, 7, 2 / 3)).toBe(62);
    expect(dwellMinutes(3, 0, 2)).toBe(0);
  });
  it('splits seconds into minutes and seconds (wording is the screen\'s job)', () => {
    expect(splitSeconds(281)).toEqual({minutes: 4, seconds: 41});
    expect(splitSeconds(240)).toEqual({minutes: 4, seconds: 0});
    expect(splitSeconds(-3)).toEqual({minutes: 0, seconds: 0});
  });
});
