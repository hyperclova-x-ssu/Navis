import { describe, expect, it } from 'vitest';
import { labelSpot } from './overlayLayout';

type Ring = [number, number][];
const inside = (ring: Ring, x: number, y: number, w: number, h: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = [ring[i][0] * w, ring[i][1] * h]; const [xj, yj] = [ring[j][0] * w, ring[j][1] * h];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const W = 640; const H = 360; const CHIP = 150;

describe('T-076 zone chip spot', () => {
  it('whole chip lies inside a table zone, near its top (not at the bounding-box corner)', () => {
    const ring: Ring = [[0.2, 0.3], [0.7, 0.3], [0.7, 0.8], [0.2, 0.8]];
    const { x, y } = labelSpot([ring], W, H, CHIP);
    for (const [px, py] of [[x, y], [x + CHIP, y], [x, y + 22], [x + CHIP, y + 22], [x + CHIP / 2, y + 11]]) expect(inside(ring, px, py, W, H)).toBe(true);
    expect(y).toBeLessThan(0.3 * H + 30);
  });
  it('a slanted / L-shaped zone: the chip sits where the zone is wide enough', () => {
    const ring: Ring = [[0.1, 0.1], [0.25, 0.1], [0.25, 0.6], [0.8, 0.6], [0.8, 0.9], [0.1, 0.9]];
    const { x, y } = labelSpot([ring], W, H, CHIP);
    expect(inside(ring, x + 1, y + 1, W, H)).toBe(true);
    expect(inside(ring, x + CHIP - 1, y + 21, W, H)).toBe(true);
  });
  it('a hole is not covered by the chip centre', () => {
    const outer: Ring = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
    const hole: Ring = [[0.3, 0.1 + 0.001], [0.7, 0.101], [0.7, 0.5], [0.3, 0.5]];
    const { x, y } = labelSpot([outer, hole], W, H, CHIP);
    const cx = x + CHIP / 2; const cy = y + 11;
    expect(inside(hole, cx, cy, W, H) && inside(outer, cx, cy, W, H)).toBe(false);
  });
  it('a zone thinner than the chip still gives a spot inside the picture', () => {
    const ring: Ring = [[0.9, 0.2], [0.98, 0.2], [0.98, 0.6], [0.9, 0.6]];
    const { x, y } = labelSpot([ring], W, H, CHIP);
    expect(x).toBeGreaterThanOrEqual(0); expect(x + CHIP).toBeLessThanOrEqual(W);
    expect(y).toBeGreaterThanOrEqual(0); expect(y + 22).toBeLessThanOrEqual(H);
    expect(y).toBeGreaterThanOrEqual(0.2 * H - 22);
  });
});
