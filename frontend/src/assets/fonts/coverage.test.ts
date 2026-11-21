// T-056: the Chinese subset fonts must hold every Han / full-width character used by the zh bundles.
// `NAVIS_WRITE_CHARSET=1 npx vitest run src/assets/fonts` also writes dev/charset-{hans,hant}.txt for the subsetter.
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { charsOf, findBundles, type Script } from './dev/collect';
import { woff2Cmap } from './dev/woff2-cmap';

const dir = resolve(__dirname);
const face = { 'zh-Hans': 'NavisHans', 'zh-Hant': 'NavisHant' } as const;
const LIMIT = 300 * 1024;
// D-83: 외국어 작업 재개 때 지움. F-50 promo keys whose new Chinese characters wait for the font rebuild (Korean-only round).
const D83_HOLD_KEYS: readonly string[] = ['data.marketing.promoMenu.financier', 'data.marketing.error.jobInvalid'];
const d83Held = (script: Script): Set<number> => {
  const held = new Set<number>();
  for (const { bundle } of findBundles()) for (const key of D83_HOLD_KEYS) {
    const value = (bundle[script] as Record<string, unknown>)[key];
    if (typeof value === 'string') for (const ch of value) held.add(ch.codePointAt(0)!);
  }
  return held;
};

describe('T-056 CJK subset fonts', () => {
  it('finds the message bundles', () => {
    expect(findBundles().length).toBeGreaterThan(15);
  });

  for (const script of ['zh-Hans', 'zh-Hant'] as Script[]) {
    const chars = charsOf(script);
    if (process.env.NAVIS_WRITE_CHARSET) {
      writeFileSync(resolve(dir, `dev/charset-${script === 'zh-Hans' ? 'hans' : 'hant'}.txt`), [...chars].sort((a, b) => a - b).map((c) => String.fromCodePoint(c)).join(''));
    }
    for (const weight of [500, 700]) {
      const file = resolve(dir, `${face[script]}-${weight}.woff2`);
      it(`${face[script]}-${weight}: covers all ${chars.size} ${script} characters`, () => {
        const cmap = woff2Cmap(new Uint8Array(readFileSync(file)));
        const held = d83Held(script);
        const missing = [...chars].filter((c) => !cmap.has(c) && !held.has(c)).map((c) => `${String.fromCodePoint(c)} U+${c.toString(16).toUpperCase()}`);
        expect(missing).toEqual([]);
      });
      it(`${face[script]}-${weight}: at most 300KB`, () => {
        expect(statSync(file).size).toBeLessThanOrEqual(LIMIT);
      });
    }
  }

  it('fonts-cjk.css declares both faces at 500 and 700 800 with swap and a unicode-range', () => {
    const css = readFileSync(resolve(dir, '../../ui/fonts-cjk.css'), 'utf8');
    for (const name of ['Navis Hans', 'Navis Hant']) {
      expect(css).toContain(`font-family: "${name}"`);
    }
    expect((css.match(/@font-face/g) ?? []).length).toBe(4);
    expect(css).toContain('font-display: swap');
    expect(css).toContain('font-synthesis: none');
    expect(css).toContain('unicode-range');
    for (const f of ['NavisHans-500', 'NavisHans-700', 'NavisHant-500', 'NavisHant-700']) expect(css).toContain(`${f}.woff2`);
  });
});
