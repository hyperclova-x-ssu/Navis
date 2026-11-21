import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * K-D (KIT-BUTTON-MARKETING): DS 5 ActionButton is 48 high by default and 56 for the main action; DS 12.1 detail add buttons are `secondary 48`.
 * jsdom has no layout, so this pins the CSS arithmetic; the real heights are measured in headless Chrome (.evidence/k-d/).
 */
const tokens = readFileSync('src/ui/tokens.css', 'utf8');
const master = readFileSync('src/ui/mastermanage.css', 'utf8');

/** First top-level rule of exactly this selector (the selector starts a line, so `a>.ui-press-surface {` never matches). */
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  return match ? match[1]! : '';
};
const px = (token: string) => {
  const match = new RegExp(`${token}:\\s*(-?[\\d.]+)(px|rem)`).exec(tokens);
  if (!match) throw new Error(`token ${token} not found`);
  return { value: Number(match[1]), unit: match[2] as 'px' | 'rem' };
};
/** A token in px at a root font size (16px at 100% text, 20px at 125% large text). */
const resolve = (token: string, root: number) => { const t = px(token); return t.unit === 'rem' ? t.value * root : t.value; };

describe('K-D 1: ActionButton default height is 48 at 100% and 125% text', () => {
  const surface = rule(tokens, '.ui-press-surface');
  const blockPadding = () => {
    const match = /padding:\s*var\((--space-\d+)\)\s+var\(--space-\d+\)/.exec(surface);
    if (!match) throw new Error('no block padding on .ui-press-surface');
    return resolve(match[1]!, 16);
  };
  it('the shared press surface pads the block by --space-1, not --space-3', () => {
    expect(surface).toMatch(/padding:\s*var\(--space-1\)\s+var\(--space-4\)/);
    expect(surface).not.toMatch(/var\(--space-3\)\s+var\(--space-4\)/);
  });
  it.each([[16, '100%'], [20, '125% large text']])('one line fits inside 48 at root %ipx (%s): 2 x padding + line + 2 x 1px border <= --target-default', (root) => {
    const line = resolve('--leading-control', root);
    const border = resolve('--stroke-hairline', root);
    expect(2 * blockPadding() + line + 2 * border).toBeLessThanOrEqual(resolve('--target-default', root));
  });
  it('so the 48 floor (min-height on the button and its surface) decides the one-line height, and a wrapped label grows the button', () => {
    expect(rule(tokens, '.ui-button')).toMatch(/min-height:\s*var\(--target-default\)/);
    expect(surface).toMatch(/min-height:\s*inherit/);
    expect(surface).not.toMatch(/(^|[;\s])height:/);
    expect(surface).not.toMatch(/overflow:\s*hidden/);
  });
  it('the DataGrid toolbar no longer needs its own surface padding override (K-A, now at the source)', () => {
    expect(master).not.toMatch(/\.ui-data-grid__toolbar>\.ui-button>\.ui-press-surface\s*\{[^}]*padding/);
    expect(rule(master, '.ui-data-grid__toolbar>.ui-button')).toMatch(/min-height:\s*var\(--target-default\)/);
  });
});

describe('K-D 1: the variants that DS gives another height keep it', () => {
  it('main action is 56 (size primary)', () => {
    expect(px('--target-primary').value).toBe(56);
    expect(rule(tokens, '.ui-button--primary')).toMatch(/min-height:\s*var\(--target-primary\)/);
  });
  it('icon buttons are 48 x 48 with no surface padding', () => {
    expect(rule(tokens, '.ui-button--icon')).toMatch(/width:\s*var\(--target-default\);\s*height:\s*var\(--target-default\)/);
    expect(tokens).toMatch(/\.ui-button--icon>\.ui-press-surface,\.ui-size-control \.ui-button>\.ui-press-surface \{\s*padding:\s*0;/);
  });
  it('the DS 7 panel button is 44 and sets its own surface padding', () => {
    expect(px('--panel-action-height').value).toBe(44);
    expect(rule(tokens, '.ui-panel-action')).toMatch(/height:\s*var\(--panel-action-height\)/);
    expect(rule(tokens, '.ui-panel-action>.ui-press-surface')).toMatch(/padding:\s*0 var\(--space-4\)/);
  });
  it('ClosingButton stays 48 high', () => {
    expect(rule(master, '.ui-closing-button.ui-button')).toMatch(/height:\s*var\(--target-default\)/);
  });
  it('POS action buttons keep their own 80 floor', () => {
    const pos = readFileSync('src/ui/pos.css', 'utf8');
    expect(pos).toMatch(/\.ui-pos-action\.ui-button \{[^}]*min-height:\s*var\(--pos-action-height\)/);
  });
});
