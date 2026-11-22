import {describe, expect, it} from 'vitest';
import {createFaceAttempt, hasFaceInFrame, FACE_FRAME} from './attempt';

describe('Facesign attempt', () => {
  it('approves one fresh face after a continuous second', () => {
    const attempt = createFaceAttempt(0);
    for (const now of [100, 300, 500, 700, 900, 1099]) {
      expect(attempt.observe(true, now)).toBe('scanning');
    }
    expect(attempt.observe(true, 1100)).toBe('approved');
    expect(attempt.observe(false, 20_000)).toBe('approved');
  });

  it('starts the hold over when a face moves out or the feed goes stale', () => {
    const attempt = createFaceAttempt(0);
    for (const now of [100, 300, 500, 700, 900]) attempt.observe(true, now);
    expect(attempt.observe(false, 950)).toBe('scanning');
    for (const now of [1000, 1200, 1400]) attempt.observe(true, now);
    // A stale frame cannot add time to the hold.
    expect(attempt.observe(true, 2100)).toBe('scanning');
    for (const now of [2300, 2500, 2700, 2900]) attempt.observe(true, now);
    expect(attempt.observe(true, 3100)).toBe('approved');
  });

  it('times out at ten seconds even if the camera sends nothing', () => {
    const attempt = createFaceAttempt(100);
    expect(attempt.advance(10_099)).toBe('scanning');
    expect(attempt.advance(10_100)).toBe('timed-out');
    expect(attempt.observe(true, 10_105)).toBe('timed-out');
  });

  it('times out when a hold reaches the deadline and starts fresh on retry', () => {
    const attempt = createFaceAttempt(0);
    for (const now of [9000, 9200, 9400, 9600, 9800]) attempt.observe(true, now);
    expect(attempt.observe(true, 10_000)).toBe('timed-out');
    const retry = createFaceAttempt(10_000);
    for (const now of [10_100, 10_300, 10_500, 10_700, 10_900]) retry.observe(true, now);
    expect(retry.observe(true, 11_100)).toBe('approved');
  });
});

describe('Facesign face frame', () => {
  const centered = {x: .37, y: .34, width: .26, height: .32};

  it('requires exactly one face entirely within the visible frame', () => {
    expect(hasFaceInFrame([centered])).toBe(true);
    expect(hasFaceInFrame([])).toBe(false);
    expect(hasFaceInFrame([centered, {...centered, x: 0}])).toBe(false);
    expect(hasFaceInFrame([{...centered, x: FACE_FRAME.x - .01}])).toBe(false);
    expect(hasFaceInFrame([{...centered, y: .9}])).toBe(false);
  });
});
