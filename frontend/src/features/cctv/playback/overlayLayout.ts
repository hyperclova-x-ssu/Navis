/** Overlay options and zone-chip layout (API-13 v4.2 9). The board panel passes persons only (D-64a). */
export interface OverlayOptions { readonly persons: boolean; readonly cups: boolean; readonly zones: boolean }
export const PANEL_OVERLAY: OverlayOptions = Object.freeze({persons: true, cups: false, zones: false});
export const FULL_OVERLAY: OverlayOptions = Object.freeze({persons: true, cups: true, zones: true});

export interface OverlayRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

const CHIP_H = 22;

/** Greedy de-overlap: a chip that collides with an earlier one moves below it. */
export function placeLabels(items: readonly {id: string; x: number; y: number; w: number}[]) {
  const placed: {id: string; x: number; y: number; w: number}[] = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = it.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) if (it.x < p.x + p.w && p.x < it.x + it.w && y < p.y + CHIP_H && p.y < y + CHIP_H) { y = p.y + CHIP_H + 2; moved = true; }
    }
    placed.push({...it, y});
  }
  return placed;
}

type Ring = readonly (readonly [number, number])[];
const SCAN_STEP = 3;

/** Spans [x0, x1] of the area covered by `rings` (even-odd) on the horizontal line `y`; everything in pixels. */
function spansAt(rings: readonly Ring[], y: number, w: number, h: number): [number, number][] {
  const xs: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]; const [bx, by] = ring[(i + 1) % ring.length];
      const y1 = ay * h; const y2 = by * h;
      if ((y1 > y) !== (y2 > y)) xs.push((ax + ((y - y1) / (y2 - y1)) * (bx - ax)) * w);
    }
  }
  xs.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

/**
 * Top-left pixel of a zone chip of `chipW` x `chipH` that lies inside the zone: the topmost row where the whole chip fits, centred in the
 * free width there (T-076). A zone too small for it gets the chip centred on its widest row. Always kept inside the `w` x `h` picture.
 */
export function labelSpot(rings: readonly Ring[], w: number, h: number, chipW: number, chipH = CHIP_H): { x: number; y: number } {
  const clamp = (x: number, y: number) => ({ x: Math.max(0, Math.min(x, w - chipW)), y: Math.max(0, Math.min(y, h - chipH)) });
  const ys = rings.flat().map(p => p[1] * h);
  if (ys.length === 0) return clamp(0, 0);
  const top = Math.min(...ys); const bottom = Math.max(...ys);
  let widest = { width: -1, cx: 0, y: top };
  for (let y = top; y + chipH <= bottom + 0.5; y += SCAN_STEP) {
    const rows = [spansAt(rings, y + 0.5, w, h), spansAt(rings, y + chipH / 2, w, h), spansAt(rings, y + chipH - 0.5, w, h)];
    for (const [a0, a1] of rows[0]) for (const [b0, b1] of rows[1]) for (const [c0, c1] of rows[2]) {
      const lo = Math.max(a0, b0, c0); const hi = Math.min(a1, b1, c1);
      if (hi - lo >= chipW + 4) return clamp((lo + hi) / 2 - chipW / 2, y);
      if (hi - lo > widest.width) widest = { width: hi - lo, cx: (lo + hi) / 2, y };
    }
  }
  if (widest.width < 0) { // thinner than the chip everywhere: centre it on the widest mid-line
    for (let y = top; y <= bottom; y += SCAN_STEP) for (const [s0, s1] of spansAt(rings, y, w, h)) if (s1 - s0 > widest.width) widest = { width: s1 - s0, cx: (s0 + s1) / 2, y: y - chipH / 2 };
  }
  return clamp(widest.cx - chipW / 2, widest.y);
}
