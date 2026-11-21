import { describe, expect, it } from 'vitest';
import { CELLS, GRID } from './types';
import { cellCount, decodeRle, displayRings, dropSmallParts, encodeRle, simplifyRing, zoneOutline } from './mask';

const { cols: COLS, rows: ROWS } = GRID;
function disc(cx: number, cy: number, r: number, cells = new Uint8Array(CELLS)) {
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) cells[y * COLS + x] = 1;
  return cells;
}
const points = (rings: readonly (readonly unknown[])[]) => rings.reduce((n, r) => n + r.length, 0);

describe('T-076 display rings (screen only)', () => {
  it('a staircase-edged blob gets far fewer points than the raw outline', () => {
    const cells = disc(60, 45, 22);
    const raw = zoneOutline(cells);
    expect(points(raw.map(r => simplifyRing(r)))).toBeLessThan(points(raw) / 3);
    expect(points(displayRings(cells))).toBeLessThan(points(raw));
  });
  it('rings stay inside the picture even when the mask touches the border', () => {
    const cells = disc(0, 0, 14, disc(COLS - 1, ROWS - 1, 12));
    for (const ring of displayRings(cells)) for (const [x, y] of ring) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1); }
  });
  it('tiny islands and tiny holes are not drawn, big parts are', () => {
    const cells = disc(50, 40, 20);
    cells[5 * COLS + 5] = 1; cells[5 * COLS + 6] = 1; // 2-cell island
    cells[40 * COLS + 50] = 0; // 1-cell hole
    const before = zoneOutline(cells).length;
    expect(before).toBe(3);
    expect(displayRings(cells)).toHaveLength(1);
    disc(130, 60, 8, cells); // a real second part stays
    expect(displayRings(cells)).toHaveLength(2);
  });
  it('the largest part always stays, and the input mask and its RLE are not touched', () => {
    const tiny = new Uint8Array(CELLS); tiny[10 * COLS + 10] = 1; tiny[10 * COLS + 11] = 1;
    expect(displayRings(tiny)).toHaveLength(1);
    const cells = disc(50, 40, 20); cells[3] = 1;
    const copy = cells.slice(); const rle = encodeRle(cells);
    const cleaned = dropSmallParts(cells);
    expect(cellCount(cleaned)).toBe(cellCount(cells) - 1);
    expect(cells).toEqual(copy);
    expect(decodeRle(rle)).toEqual(copy);
  });
  it('simplifyRing keeps a rectangle as is', () => {
    const rect: [number, number][] = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]];
    expect(simplifyRing(rect)).toHaveLength(4);
  });
});
