import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * BUG-003: in layout-edit mode the remove button (x8..56) covered the first letters of every panel title.
 * The edit-mode title rule sat BELOW the regular title rule in specificity, so the regular x50 always won. jsdom has no
 * cascade engine, so this reads the real CSS and compares selector specificity and the resulting title x (SCREENS: x64).
 */
const dashboard = readFileSync('src/screens/dashboard/dashboard.css', 'utf8');
const tokens = readFileSync('src/ui/tokens.css', 'utf8');

type Rule = { readonly selector: string; readonly body: string; readonly order: number };
const rules: Rule[] = [...dashboard.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  .map((match, order) => ({ selector: match[1]!.trim().replace(/\s+/gu, ' '), body: match[2]!, order }));

/** (ids, classes + attributes + pseudo-classes, elements) packed into one comparable number; the selectors under test use no :is/:not. */
const specificity = (selector: string) => {
  const ids = (selector.match(/#[\w-]+/gu) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)[\w-]+/gu) ?? []).length;
  return ids * 10000 + classes * 100;
};
const declared = (rule: Rule, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`, 'u').exec(rule.body)?.[1]?.trim();

const titleRules = rules.filter((r) => r.selector.endsWith('.ui-panel-title') && r.selector.includes('.dashboard-screen'));
const flow = (r: Rule) => r.selector.includes('[data-flow="true"]');
const editing = (r: Rule) => r.selector.includes('[data-editing="true"]');
const plain = titleRules.filter((r) => !flow(r) && !editing(r) && declared(r, 'left') !== undefined);
const plainFlow = titleRules.filter((r) => flow(r) && !editing(r) && declared(r, 'margin') !== undefined);
const edit = titleRules.filter((r) => !flow(r) && editing(r) && declared(r, 'left') !== undefined);
const editFlow = titleRules.filter((r) => flow(r) && editing(r) && declared(r, 'margin-left') !== undefined);

/** Resolves var(--token) from the kit tokens and the dashboard panel's own custom properties, then evaluates the calc(). */
const customProperty = (name: string): string => {
  const own = new RegExp(`${name}\\s*:\\s*([^;}]+)`, 'u').exec(dashboard)?.[1] ?? new RegExp(`${name}\\s*:\\s*([^;}]+)`, 'u').exec(tokens)?.[1];
  if (own === undefined) throw new Error(`unknown token ${name}`);
  return own.trim();
};
const px = (value: string): number => {
  const flat = value.replace(/var\((--[\w-]+)\)/gu, (_, name: string) => `(${px(customProperty(name))})`);
  const expression = flat.replace(/calc/gu, '').replace(/(\d+(?:\.\d+)?)px/gu, '$1');
  if (!/^[\d\s.+\-*/()]+$/u.test(expression)) throw new Error(`cannot evaluate ${value}`);
  return Function(`"use strict";return (${expression});`)() as number;
};

const removeRight = px('calc(var(--space-2) + var(--target-default))');
const surfacePadding = px('var(--surface-padding)');

describe('layout-edit panel title (BUG-003)', () => {
  it('finds the title rules this guards', () => {
    expect(plain.length).toBeGreaterThan(0);
    expect(edit.length).toBeGreaterThan(0);
    expect(plainFlow.length).toBeGreaterThan(0);
    expect(editFlow.length).toBeGreaterThan(0);
  });
  it('lets the edit-mode title rule win over the regular one (specificity, then source order)', () => {
    for (const rule of edit) for (const base of plain) {
      expect(specificity(rule.selector), `${rule.selector} vs ${base.selector}`).toBeGreaterThanOrEqual(specificity(base.selector));
      if (specificity(rule.selector) === specificity(base.selector)) expect(rule.order).toBeGreaterThan(base.order);
    }
    for (const rule of editFlow) for (const base of plainFlow) {
      expect(specificity(rule.selector), `${rule.selector} vs ${base.selector}`).toBeGreaterThanOrEqual(specificity(base.selector));
      if (specificity(rule.selector) === specificity(base.selector)) expect(rule.order).toBeGreaterThan(base.order);
    }
  });
  it('starts the edit title at x64 so it clears the remove button (x8..56) by at least 8px, in both panel layouts', () => {
    for (const rule of edit) expect(px(declared(rule, 'left')!), rule.selector).toBe(64);
    // a flow title sits inside the surface padding: its margin is measured from the content edge
    for (const rule of editFlow) expect(surfacePadding + px(declared(rule, 'margin-left')!), rule.selector).toBe(64);
    expect(64 - removeRight).toBeGreaterThanOrEqual(8);
  });
  it('keeps the regular title where it was (the edit change must not move the normal state)', () => {
    for (const rule of plain) expect(px(declared(rule, 'left')!), rule.selector).toBe(50);
  });
});
