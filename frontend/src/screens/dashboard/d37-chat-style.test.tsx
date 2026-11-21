import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync('src/screens/dashboard/dashboard.css', 'utf8');
const conversation = readFileSync('src/features/assistant/conversation.css', 'utf8');
const tokens = readFileSync('src/ui/tokens.css', 'utf8');
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start) + 1);
};

describe('D-37 conversation and compact panels', () => {
  it('uses the semantic closed, open and focus colors for the launcher', () => {
    const closed = rule(dashboard, '.dashboard-ai-launcher');
    expect(closed).toContain('background:var(--card)');
    expect(closed).toContain('var(--stroke-hairline) solid var(--input)');
    const open = rule(dashboard, '.dashboard-ai-launcher[aria-expanded="true"]');
    expect(open).toContain('background:var(--card)');
    expect(open).toContain('border-color:var(--selection-foreground)');
    expect(rule(dashboard, '.dashboard-ai-launcher:focus-visible')).toContain('outline:var(--stroke-focus) solid var(--ring)');
    expect(rule(dashboard, '.dashboard-ai-launcher:focus-visible')).toContain('var(--focus-offset)');
  });
  it('uses opaque semantic conversation and bubble surfaces with a separated input focus ring', () => {
    expect(conversation).toContain('background:var(--popover);color:var(--popover-foreground)');
    expect(conversation).toContain('background:var(--card);color:var(--card-foreground)');
    expect(conversation).toContain('background:var(--selection);color:var(--foreground)');
    expect(conversation).toContain('outline-offset:var(--focus-offset)');
  });
  it('keeps comparison information visible at large text size', () => {
    expect(tokens).not.toMatch(/\[data-text-scale="125"\]\s+\.ui-panel-comparison\s*\{\s*display:\s*none/);
  });
});
