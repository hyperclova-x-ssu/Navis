/**
 * T-073 grid-mask helpers (DATA_MODEL 12.2, 12.3): RLE, lasso fill, eraser, reading order, outline rings.
 * Pure functions on 160 x 90 Uint8Array masks (row-major, 0/1). Coordinates are camera-frame 0..1.
 */
import { CELLS, GRID, ROW_BAND, zoneTokens, type MaskRle, type Point } from './types';

const { cols: COLS, rows: ROWS } = GRID;

export function cellCount(cells: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) n += cells[i];
  return n;
}

/** Mask -> runs starting with a run of 0s (DATA_MODEL 12.2). Empty mask = [14400]. */
export function encodeRle(cells: Uint8Array): MaskRle {
  const runs: number[] = [];
  let value = 0; let len = 0;
  for (let i = 0; i < CELLS; i++) {
    const v = cells[i] ? 1 : 0;
    if (v === value) { len++; continue; }
    runs.push(len); value = v; len = 1;
  }
  runs.push(len);
  return { cols: 160, rows: 90, runs };
}

export function decodeRle(mask: MaskRle): Uint8Array {
  const out = new Uint8Array(CELLS);
  let i = 0; let value = 0;
  for (const run of mask.runs) {
    if (!Number.isInteger(run) || run < 0 || i + run > CELLS) throw new Error('INVALID_RLE');
    if (value) out.fill(1, i, i + run);
    i += run; value ^= 1;
  }
  if (i !== CELLS) throw new Error('INVALID_RLE');
  return out;
}

/** Cells whose centre is inside the closed path (even-odd rule; the last point joins the first). */
export function lassoCells(path: readonly Point[]): Uint8Array {
  const out = new Uint8Array(CELLS);
  if (path.length < 3) return out;
  const n = path.length;
  const xs: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    const y = (r + 0.5) / ROWS;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = path[i]; const [x2, y2] = path[(i + 1) % n];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] * COLS - 0.5));
      const c1 = Math.min(COLS - 1, Math.ceil(xs[k + 1] * COLS - 0.5) - 1);
      for (let c = c0; c <= c1; c++) out[r * COLS + c] ^= 1;
    }
  }
  return out;
}

/** SCREENS 9.6 ③: a drawing whose box is under 4% of the video height (either side) is too small. */
export function isDrawTooSmall(path: readonly Point[], aspect: number): boolean {
  if (path.length < 3) return true;
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const [x, y] of path) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return (y1 - y0) < zoneTokens.minSizeOfHeight || (x1 - x0) * aspect < zoneTokens.minSizeOfHeight;
}

/**
 * Clears the cells whose centre lies within `radius` (frame-width units) of the stroke.
 * Returns the same array when nothing was cleared (callers compare by identity).
 */
export function eraseCells(cells: Uint8Array, path: readonly Point[], radius: number, aspect: number): Uint8Array {
  if (path.length === 0) return cells;
  let out: Uint8Array | null = null;
  const ry = radius * aspect; // radius in height units
  const segs = path.length === 1 ? [[path[0], path[0]] as const] : path.slice(1).map((p, i) => [path[i], p] as const);
  for (const [[ax, ay], [bx, by]] of segs) {
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius) * COLS));
    const c1 = Math.min(COLS - 1, Math.floor((Math.max(ax, bx) + radius) * COLS));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - ry) * ROWS));
    const r1 = Math.min(ROWS - 1, Math.floor((Math.max(ay, by) + ry) * ROWS));
    // Work in width units: y is divided by the aspect.
    const ux = ax; const uy = ay / aspect; const vx = bx - ax; const vy = (by - ay) / aspect;
    const len2 = vx * vx + vy * vy; const rr = radius * radius;
    for (let r = r0; r <= r1; r++) {
      const py = ((r + 0.5) / ROWS) / aspect;
      for (let c = c0; c <= c1; c++) {
        const i = r * COLS + c;
        if (!(out ?? cells)[i]) continue;
        const px = (c + 0.5) / COLS;
        let t = len2 > 0 ? ((px - ux) * vx + (py - uy) * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ux + t * vx); const dy = py - (uy + t * vy);
        if (dx * dx + dy * dy <= rr) { out ??= cells.slice(); out[i] = 0; }
      }
    }
  }
  return out ?? cells;
}

/** Cells of `cells` that are not in `taken` (copy). */
export function subtractCells(cells: Uint8Array, taken: Uint8Array): Uint8Array {
  const out = cells.slice();
  for (let i = 0; i < CELLS; i++) if (taken[i]) out[i] = 0;
  return out;
}

/** Mean cell centre (0..1). */
export function zoneCenter(cells: Uint8Array): { cx: number; cy: number } {
  let sx = 0; let sy = 0; let n = 0;
  for (let i = 0; i < CELLS; i++) if (cells[i]) { sx += (i % COLS) + 0.5; sy += Math.floor(i / COLS) + 0.5; n++; }
  return n ? { cx: sx / n / COLS, cy: sy / n / ROWS } : { cx: 0, cy: 0 };
}

/** Reading order (SCREENS 9.6): rows by cy (a row holds centres within ROW_BAND of its first), left to right inside. */
export function readingOrder<T extends { readonly id: string; readonly cx: number; readonly cy: number }>(items: readonly T[]): string[] {
  const byY = [...items].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const out: string[] = [];
  let i = 0;
  while (i < byY.length) {
    const top = byY[i].cy; const row: T[] = [];
    while (i < byY.length && byY[i].cy - top <= ROW_BAND) row.push(byY[i++]);
    row.sort((a, b) => a.cx - b.cx).forEach(z => out.push(z.id));
  }
  return out;
}

/** Bounding box in 0..1 (null for an empty mask). */
export function zoneBounds(cells: Uint8Array): { x0: number; y0: number; x1: number; y1: number } | null {
  let c0: number = COLS; let c1 = -1; let r0: number = ROWS; let r1 = -1;
  for (let i = 0; i < CELLS; i++) if (cells[i]) { const c = i % COLS; const r = (i - c) / COLS; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
  return c1 < 0 ? null : { x0: c0 / COLS, y0: r0 / ROWS, x1: (c1 + 1) / COLS, y1: (r1 + 1) / ROWS };
}

export function cellAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return -1;
  return Math.floor(y * ROWS) * COLS + Math.floor(x * COLS);
}

/**
 * Outline rings of a mask (marching squares on the cell grid): one closed ring per boundary
 * (outer edges and holes), corners in 0..1, collinear points removed. Diagonal-touching cells stay separate rings.
 */
export function zoneOutline(cells: Uint8Array): Point[][] {
  const VW = COLS + 1;
  const filled = (c: number, r: number) => c >= 0 && r >= 0 && c < COLS && r < ROWS && cells[r * COLS + c] === 1;
  // Directed boundary edges, clockwise around filled cells (y down): from vertex -> to vertex.
  const from: number[] = []; const to: number[] = []; const dir: number[] = []; // dir 0=E 1=S 2=W 3=N
  const outMap = new Map<number, number[]>();
  const add = (a: number, b: number, d: number) => { const k = from.length; from.push(a); to.push(b); dir.push(d); const l = outMap.get(a); if (l) l.push(k); else outMap.set(a, [k]); };
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!filled(c, r)) continue;
    if (!filled(c, r - 1)) add(r * VW + c, r * VW + c + 1, 0);
    if (!filled(c + 1, r)) add(r * VW + c + 1, (r + 1) * VW + c + 1, 1);
    if (!filled(c, r + 1)) add((r + 1) * VW + c + 1, (r + 1) * VW + c, 2);
    if (!filled(c - 1, r)) add((r + 1) * VW + c, r * VW + c, 3);
  }
  const used = new Uint8Array(from.length);
  const rings: Point[][] = [];
  for (let s = 0; s < from.length; s++) {
    if (used[s]) continue;
    const verts: number[] = []; const dirs: number[] = [];
    let e = s;
    while (!used[e]) {
      used[e] = 1; verts.push(from[e]); dirs.push(dir[e]);
      const options = (outMap.get(to[e]) ?? []).filter(k => !used[k]);
      if (options.length === 0) break;
      // At a saddle prefer the right turn, which keeps diagonal-touching cells apart.
      const right = (dir[e] + 1) % 4;
      e = options.find(k => dir[k] === right) ?? options[0];
    }
    const ring: Point[] = [];
    for (let i = 0; i < verts.length; i++) {
      if (dirs[i] === dirs[(i - 1 + verts.length) % verts.length]) continue; // collinear corner
      const v = verts[i]; ring.push([(v % VW) / COLS, Math.floor(v / VW) / ROWS]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Chaikin corner cutting on a closed ring (display only; stays inside the ring's bounding box). */
export function smoothRing(ring: readonly Point[], iterations = 2): Point[] {
  let pts: Point[] = [...ring];
  for (let it = 0; it < iterations; it++) {
    const next: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]; const [bx, by] = pts[(i + 1) % pts.length];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    pts = next;
  }
  return pts;
}

/** SVG path data for rings in a w x h box. */
export function ringsToPath(rings: readonly (readonly Point[])[], w: number, h: number): string {
  return rings.map(ring => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join('') + 'Z').join('');
}

/** Display only: parts (filled islands, holes) of at most this many cells are not drawn. */
export const DISPLAY_MIN_PART = 8;
/** Display only: Douglas-Peucker tolerance in cells (corner-to-line distance of the staircase). */
export const DISPLAY_SIMPLIFY_CELLS = 1.6;

/** 4-connected components of `value` cells: label per cell (0 = other value) and each component's size / whether it touches the border. */
function components(cells: Uint8Array, value: 0 | 1): { label: Int32Array; sizes: number[]; border: boolean[] } {
  const label = new Int32Array(CELLS); const sizes = [0]; const border = [false];
  const stack: number[] = [];
  for (let s = 0; s < CELLS; s++) {
    if ((cells[s] ? 1 : 0) !== value || label[s]) continue;
    const id = sizes.length; sizes.push(0); border.push(false);
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!; sizes[id]++;
      const c = i % COLS; const r = (i - c) / COLS;
      if (c === 0 || r === 0 || c === COLS - 1 || r === ROWS - 1) border[id] = true;
      const nb = [c > 0 ? i - 1 : -1, c < COLS - 1 ? i + 1 : -1, r > 0 ? i - COLS : -1, r < ROWS - 1 ? i + COLS : -1];
      for (const n of nb) if (n >= 0 && !label[n] && (cells[n] ? 1 : 0) === value) { label[n] = id; stack.push(n); }
    }
  }
  return { label, sizes, border };
}

/** Copy of `cells` without filled islands and enclosed holes of at most `minPart` cells (the largest filled part always stays). Input is not changed. */
export function dropSmallParts(cells: Uint8Array, minPart = DISPLAY_MIN_PART): Uint8Array {
  const out = cells.slice();
  const on = components(cells, 1);
  const biggest = on.sizes.reduce((best, n, id) => (id > 0 && n > (on.sizes[best] ?? 0) ? id : best), 0);
  for (let i = 0; i < CELLS; i++) if (on.label[i] && on.label[i] !== biggest && on.sizes[on.label[i]] <= minPart) out[i] = 0;
  const off = components(cells, 0);
  for (let i = 0; i < CELLS; i++) if (off.label[i] && !off.border[off.label[i]] && off.sizes[off.label[i]] <= minPart) out[i] = 1;
  return out;
}

/** Douglas-Peucker on a closed ring (split at the first point and the point farthest from it); `eps` in cells. */
export function simplifyRing(ring: readonly Point[], eps = DISPLAY_SIMPLIFY_CELLS): Point[] {
  const n = ring.length;
  if (n <= 4) return [...ring];
  const px = (p: Point) => p[0] * COLS; const py = (p: Point) => p[1] * ROWS;
  const dist = (p: Point, a: Point, b: Point) => {
    const dx = px(b) - px(a); const dy = py(b) - py(a); const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px(p) - px(a), py(p) - py(a));
    const t = Math.max(0, Math.min(1, ((px(p) - px(a)) * dx + (py(p) - py(a)) * dy) / len2));
    return Math.hypot(px(p) - px(a) - t * dx, py(p) - py(a) - t * dy);
  };
  let far = 0; let farD = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(px(ring[i]) - px(ring[0]), py(ring[i]) - py(ring[0])); if (d > farD) { farD = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = 1; keep[far] = 1;
  const walk = (lo: number, hi: number) => { // open chain lo..hi (indices modulo n, hi > lo)
    const stack: [number, number][] = [[lo, hi]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let worst = -1; let worstD = eps;
      for (let i = a + 1; i < b; i++) { const d = dist(ring[i % n], ring[a % n], ring[b % n]); if (d > worstD) { worstD = d; worst = i; } }
      if (worst >= 0) { keep[worst % n] = 1; stack.push([a, worst], [worst, b]); }
    }
  };
  walk(0, far); walk(far, n);
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : [...ring];
}

/**
 * Rings for the screen only (live view and zone editor): small islands and holes dropped, staircase simplified, then smoothed (Chaikin).
 * The mask sent to the server and every count are untouched. Points stay inside 0..1.
 */
export function displayRings(cells: Uint8Array): Point[][] {
  return zoneOutline(dropSmallParts(cells)).map(r => smoothRing(simplifyRing(r), 2));
}
