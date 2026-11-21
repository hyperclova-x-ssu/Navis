import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// U-C (owner feedback 2026-11-20): on "어떤 가게를 하세요?" each business card centers its icon over the label.
// jsdom does not apply imported stylesheets, so this guards the rule in the source CSS instead of computed layout;
// the real layout was checked in headless Chrome (.evidence/task_bb9baa4c4d06/).
const css = readFileSync('src/screens/onboarding/onboarding.css', 'utf8');
const rule = (selector: string) => css.split('\n').find(line => line.trimStart().startsWith(selector));

describe('onboarding step 1 business cards center the icon over the label', () => {
  it('overrides the kit start alignment on the question step cards only', () => {
    const line = rule('.t207-business .business-options .ui-business-card>.ui-press-surface');
    expect(line, 'a scoped override for the business card surface exists').toBeDefined();
    expect(line).toMatch(/justify-items:\s*center/);
    expect(line).toMatch(/text-align:\s*center/);
  });

  it('keeps the compact settings-dialog cards out of the override', () => {
    expect(css).not.toMatch(/business-options--compact[^{]*\{[^}]*justify-items/);
  });
});
