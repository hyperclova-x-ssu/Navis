// U-B: one logo treatment. The symbol (floating button, favicon) is the very mark of the full logo (app header, chat title),
// drawn at the same scale: a square as tall as the logo's viewBox, centred on the mark.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(__dirname, name), 'utf8');
const box = (svg: string) => svg.match(/viewBox="([^"]+)"/u)![1].split(/\s+/u).map(Number) as [number, number, number, number];
const markShapes = (svg: string) => [...svg.matchAll(/<(?:path|circle)\b[^>]*>/gu)].slice(0, 3).map((m) => m[0].replace(/navis-(?:logo|symbol)-gradient/gu, 'g'));

describe('Navis brand assets', () => {
  const logo = read('navis-logo.svg'), symbol = read('navis-symbol.svg');
  it('the symbol draws exactly the three mark shapes that open the full logo', () => {
    expect(markShapes(symbol)).toHaveLength(3);
    expect(markShapes(symbol)).toEqual(markShapes(logo));
  });
  it('the symbol has the same mark scale and vertical position as the logo', () => {
    const [lx, ly, lw, lh] = box(logo), [sx, sy, sw, sh] = box(symbol);
    expect(lw).toBeGreaterThan(lh * 2); // wordmark follows the mark
    expect(sw).toBe(sh); expect(sh).toBe(lh); expect(sy).toBe(ly);
    // centred on the mark: the mark spans x 101.66-380.34 in both files
    expect(sx + sw / 2).toBeCloseTo(241, 1);
    expect(lx).toBeLessThan(sx);
  });
  it('the logo carries the gradient wordmark (no plain text fill)', () => {
    expect(logo).not.toMatch(/<text\b/u);
    expect(logo.match(/fill="url\(#navis-logo-gradient-3\)"/gu)!.length).toBeGreaterThanOrEqual(5);
  });
});
