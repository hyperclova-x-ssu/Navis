import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CELLS, GRID } from './types';
import { cellCount, decodeRle, encodeRle, eraseCells, isDrawTooSmall, lassoCells, readingOrder, smoothRing, zoneCenter, zoneOutline } from './mask';

const rectCells = (rects: readonly (readonly number[])[]) => {
  const m = new Uint8Array(CELLS);
  for (const [c0, r0, c1, r1] of rects) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) m[r * GRID.cols + c] = 1;
  return m;
};

describe('RLE (DATA_MODEL 12.2)', () => {
  const vectors = resolve(__dirname, '../../../../../cnn/live/tests/vectors/zones_rle.json');
  // The shared vectors ship with the CNN server; skip until that folder is present.
  it.skipIf(!existsSync(vectors))('matches the shared server vectors (cnn/live/tests/vectors/zones_rle.json, T-068)', () => {
    const file = JSON.parse(readFileSync(vectors, 'utf8')) as { cases: { name: string; rects: number[][]; cells: number; runs: number[] }[] };
    expect(file.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of file.cases) {
      const cells = rectCells(c.rects);
      expect(cellCount(cells), c.name).toBe(c.cells);
      expect(encodeRle(cells).runs, c.name).toEqual(c.runs);
      expect(Array.from(decodeRle({ cols: 160, rows: 90, runs: c.runs })), c.name).toEqual(Array.from(cells));
    }
  });
  it('round-trips and keeps the 0-first alternation; an empty mask is [14400]', () => {
    expect(encodeRle(new Uint8Array(CELLS)).runs).toEqual([14400]);
    const full = new Uint8Array(CELLS).fill(1);
    expect(encodeRle(full).runs).toEqual([0, 14400]);
    const m = rectCells([[3, 4, 9, 7], [150, 80, 160, 90]]);
    const rle = encodeRle(m);
    expect(rle.runs.reduce((a, b) => a + b, 0)).toBe(CELLS);
    expect(Array.from(decodeRle(rle))).toEqual(Array.from(m));
  });
  it('rejects a mask whose runs do not add up to 14,400', () => {
    expect(() => decodeRle({ cols: 160, rows: 90, runs: [100] })).toThrow();
  });
});

describe('lasso fill (even-odd, auto close)', () => {
  it('fills the cells whose centres are inside a rectangle, without the last edge drawn', () => {
    // 0.1..0.2 wide (16 cols), 0.1..0.2 high (9 rows); path left open on purpose.
    const cells = lassoCells([[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]]);
    expect(cellCount(cells)).toBe(16 * 9);
    expect(cells[10 * GRID.cols + 32]).toBe(0);
    expect(cells[9 * GRID.cols + 16]).toBe(1);
  });
  it('needs at least three points', () => {
    expect(cellCount(lassoCells([[0.1, 0.1], [0.5, 0.5]]))).toBe(0);
  });
  it('uses even-odd for a self-crossing (bow-tie) path', () => {
    const bow = lassoCells([[0.1, 0.1], [0.5, 0.5], [0.5, 0.1], [0.1, 0.5]]);
    expect(bow[Math.floor(0.3 * 90) * GRID.cols + Math.floor(0.12 * 160)]).toBe(1);
    expect(bow[Math.floor(0.12 * 90) * GRID.cols + Math.floor(0.3 * 160)]).toBe(0);
  });
  it('flags too-small drawings (under 4% of the video height)', () => {
    expect(isDrawTooSmall([[0.5, 0.5], [0.51, 0.5], [0.51, 0.51]], 16 / 9)).toBe(true);
    expect(isDrawTooSmall([[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]], 16 / 9)).toBe(false);
  });
});

describe('eraser', () => {
  it('clears only the cells within the radius of the stroke', () => {
    const m = rectCells([[0, 0, 160, 90]]);
    const out = eraseCells(m, [[0.1, 0.5], [0.9, 0.5]], 0.02, 16 / 9);
    expect(out).not.toBe(m);
    expect(out[45 * 160 + 80]).toBe(0);
    expect(out[10 * 160 + 80]).toBe(1);
    expect(out[45 * 160 + 2]).toBe(1);
    // radius 0.02 of width = 3.2 cols, = 0.0356 of height = 3.2 rows.
    expect(out[(45 - 6) * 160 + 80]).toBe(1);
    expect(cellCount(out)).toBeLessThan(CELLS);
    expect(cellCount(out)).toBeGreaterThan(CELLS - 160 * 12);
  });
  it('erases a disc for a single-point stroke and returns the same array when nothing changes', () => {
    const m = rectCells([[0, 0, 10, 10]]);
    expect(eraseCells(m, [[0.9, 0.9]], 0.02, 16 / 9)).toBe(m);
    expect(cellCount(eraseCells(m, [[0.03, 0.05]], 0.02, 16 / 9))).toBeLessThan(100);
  });
});

describe('reading order numbers (SCREENS 9.6)', () => {
  it('reads rows top to bottom, left to right inside a row band of 0.05', () => {
    const centers = [
      { id: 'b', cx: 0.8, cy: 0.21 },
      { id: 'a', cx: 0.2, cy: 0.2 },
      { id: 'c', cx: 0.1, cy: 0.6 },
      { id: 'd', cx: 0.5, cy: 0.62 },
      { id: 'e', cx: 0.3, cy: 0.9 },
    ];
    expect(readingOrder(centers)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('computes the cell centre of a zone', () => {
    const c = zoneCenter(rectCells([[0, 0, 16, 9]]));
    expect(c.cx).toBeCloseTo(0.05, 5);
    expect(c.cy).toBeCloseTo(0.05, 5);
  });
});

describe('outline rings (marching squares)', () => {
  it('gives one ring for a rectangle with its four corners in 0..1', () => {
    const rings = zoneOutline(rectCells([[16, 9, 32, 18]]));
    expect(rings).toHaveLength(1);
    const xs = rings[0].map(p => p[0]); const ys = rings[0].map(p => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0.1, 5); expect(Math.max(...xs)).toBeCloseTo(0.2, 5);
    expect(Math.min(...ys)).toBeCloseTo(0.1, 5); expect(Math.max(...ys)).toBeCloseTo(0.2, 5);
    expect(rings[0]).toHaveLength(4);
  });
  it('counts separate parts and holes as rings', () => {
    expect(zoneOutline(rectCells([[0, 0, 5, 5], [20, 20, 30, 30]]))).toHaveLength(2);
    const holed = rectCells([[10, 10, 30, 30]]);
    for (let r = 15; r < 20; r++) for (let c = 15; c < 20; c++) holed[r * 160 + c] = 0;
    expect(zoneOutline(holed)).toHaveLength(2);
    expect(zoneOutline(new Uint8Array(CELLS))).toHaveLength(0);
  });
  it('keeps diagonal-touching cells as two closed rings', () => {
    const m = new Uint8Array(CELLS); m[0] = 1; m[161] = 1;
    const rings = zoneOutline(m);
    expect(rings).toHaveLength(2);
    for (const ring of rings) expect(ring).toHaveLength(4);
  });
  it('smooths a ring for display (Chaikin) without leaving the bounding box', () => {
    const ring = zoneOutline(rectCells([[16, 9, 32, 18]]))[0];
    const s = smoothRing(ring, 2);
    expect(s.length).toBe(16);
    for (const [x, y] of s) { expect(x).toBeGreaterThanOrEqual(0.1 - 1e-9); expect(x).toBeLessThanOrEqual(0.2 + 1e-9); expect(y).toBeGreaterThanOrEqual(0.1 - 1e-9); expect(y).toBeLessThanOrEqual(0.2 + 1e-9); }
  });
});
