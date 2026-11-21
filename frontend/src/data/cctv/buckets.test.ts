import {describe, expect, it} from 'vitest';
import {OPEN_MINUTE, BUCKET_VALUES_15M, BUCKET_VALUES_5M, CCTV_BUCKETS, CCTV_BUCKETS_15M, bucketChange, changeFor, interpolateAt} from './buckets';

describe('bucketChange (moving, people not percent)', () => {
  it('fake 9 now vs 11.4 before → ▼ 2명', () => {
    const c = bucketChange(9, 11.4);
    expect(c).toEqual({direction: 'down', count: 2});
  });
  it('up, flat by rounding, and hidden with no earlier value', () => {
    expect(bucketChange(12, 9.4)).toEqual({direction: 'up', count: 3});
    expect(bucketChange(10, 9.8)).toEqual({direction: 'flat', count: 0});
    expect(bucketChange(5, null)).toBeNull();
    expect(changeFor(5, OPEN_MINUTE + 3)).toBeNull();
  });
  it('recomputes when the now value changes', () => {
    expect(changeFor(4)).toEqual({direction: 'down', count: 2});
    expect(changeFor(5)).toEqual({direction: 'down', count: 1});
    expect(changeFor(6)).toEqual({direction: 'flat', count: 0});
    expect(changeFor(7)).toEqual({direction: 'up', count: 1});
  });
});

describe('café camera buckets', () => {
  it('covers 08:00 to the 15:45 demo time with complete 15-minute buckets', () => {
    expect(CCTV_BUCKETS_15M).toHaveLength(31);
    expect(CCTV_BUCKETS_15M[0]).toMatchObject({start: '08:00', end: '08:15'});
    expect(CCTV_BUCKETS_15M.at(-1)).toMatchObject({start: '15:30', end: null});
  });
  it('scales the hourly estimates to the three tables and accounts for the partial last hour', () => {
    for (const value of BUCKET_VALUES_15M.slice(0, 4)) expect(value).toBeCloseTo(0.777273, 5);
    expect(interpolateAt(15 * 60 + 40)).toBeCloseTo(6.181818, 5);
  });
  it('interpolates through the hourly boundary at 09:00', () => {
    expect(interpolateAt(9 * 60)).toBeCloseTo(2.490909, 5);
  });
  it('ends the 5-minute series at the demo clock with the same estimate used for the comparison', () => {
    expect(BUCKET_VALUES_5M).toHaveLength(93);
    expect(CCTV_BUCKETS[0]).toMatchObject({start: '08:00', end: '08:05', value: 0.8});
    expect(CCTV_BUCKETS.at(-1)).toEqual({start: '15:40', end: null, value: 6.2});
  });
});
