import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rule = (source: string, selector: string) => source.match(new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

// FIX-PKG-C T-33 (G1): text links and the photo file input keep their look, but their box is the 44 px touch target (--target-min).
describe('touch targets of the marketing links', () => {
  it.each(['./widget.css', '../mkt-coupon/widget.css'])('%s grows .mkt-touch-link to the touch target without moving the line', path => {
    const body = rule(css(path), '.mkt-touch-link');
    expect(body).toContain('min-height: var(--target-min)');
    expect(body).toContain('min-width: var(--target-min)');
    expect(body).toMatch(/margin-block:\s*calc\(\(1lh - var\(--target-min\)\) \/ 2\)/);
  });
  it('makes the promo photo file input and its button at least the touch target high', () => {
    const promo = css('../mkt-promo/promo.css');
    expect(rule(promo, '.pv-real-fields input[type="file"]')).toContain('min-height: var(--target-min)');
    expect(rule(promo, '.pv-real-fields input[type="file"]::file-selector-button')).toContain('min-height: var(--target-min)');
  });
});
