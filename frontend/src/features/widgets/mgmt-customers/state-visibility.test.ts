import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');

describe('customer and menu panel state messages', () => {
  it('does not clip or shrink the message or its widget-owned ancestors', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const root = document.createElement('div');
    root.className = 'mc-root';
    root.innerHTML = '<div class="mc-state"><div class="ui-panel-state"><p class="ui-panel-state__message">A long state message</p></div></div>';
    document.body.append(root);
    const message = root.querySelector<HTMLElement>('.ui-panel-state__message')!;
    const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    const violations: string[] = [];
    for (const rule of Array.from(style.sheet!.cssRules)) {
      if (!('selectorText' in rule) || !('style' in rule)) continue;
      const styleRule = rule as CSSStyleRule;
      for (const node of nodes) {
        if (!node.matches(styleRule.selectorText)) continue;
        for (const property of ['-webkit-line-clamp', 'line-clamp', 'max-height', 'text-overflow', 'overflow', 'overflow-x', 'overflow-y', 'flex-shrink']) {
          const value = styleRule.style.getPropertyValue(property);
          if (value && value !== 'none' && value !== 'visible' && !(property === 'flex-shrink' && value === '0')) violations.push(`${styleRule.selectorText}: ${property}: ${value}`);
        }
        if (node === message && styleRule.style.getPropertyValue('display') === '-webkit-box') violations.push(`${styleRule.selectorText}: display: -webkit-box`);
      }
    }
    root.remove();
    style.remove();
    expect(violations).toEqual([]);
  });
});
