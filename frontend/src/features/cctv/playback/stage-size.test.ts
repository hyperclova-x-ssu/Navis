/** T-079 (D-391): the picture area rule. jsdom has no layout, so the stylesheet text is what is checked; sizes were measured in Chrome (t079-*.png). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/features/cctv/playback/playback.css', 'utf8');
const zones = readFileSync('src/features/cctv/zones/zones.css', 'utf8');

describe('detail picture area size', () => {
  it('numbers column is a fixed 320px and the picture takes the rest (no 60/40 split)', () => {
    expect(css).not.toMatch(/\.cctv-stage-row \{[^}]*60fr/);
    expect(css).toMatch(/--cctv-now-w:320px/);
    expect(css).toMatch(/\.cctv-stage-row \{[^}]*100% - var\(--cctv-now-w\)[^}]*minmax\(var\(--cctv-now-w\), 1fr\)/); // the numbers column takes all the rest
  });
  it('picture height is capped by the window height so it fits without scrolling', () => {
    expect(css).toMatch(/--cctv-cap:calc\(\(var\(--canvas-height, 100dvh\) - var\(--cctv-chrome\)\) \* 16 \/ 9\)/);
  });
  it('narrow window: numbers go under the picture; the zone editor picture is capped too', () => {
    expect(css).toMatch(/max-width: 900px\) \{ \.cctv-stage-row \{ grid-template-columns:minmax\(0,1fr\)/);
    expect(zones).toMatch(/\.cz-stage \{ max-width: max\(calc\(\(var\(--canvas-height, 100dvh\) - var\(--cz-chrome\)\)/);
  });
});
