import { describe, expect, it } from 'vitest';
import { humanDate } from './facts';

describe('the as-of stamp of an answer\'s evidence', () => {
  it('writes month, day and weekday, never the ISO date', () => {
    expect(humanDate('2026-11-22')).toBe('11월 22일(일)');
    expect(humanDate('2026-11-17')).toBe('11월 17일(화)');
    expect(humanDate('2026-01-05')).toBe('1월 5일(월)');
    expect(humanDate('not a date')).toBe('not a date');
  });
});
