import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync('src/screens/dashboard/dashboard.css', 'utf8');
const conversation = readFileSync('src/features/assistant/conversation.css', 'utf8');
const tokens = readFileSync('src/ui/tokens.css', 'utf8');
const rule = (css: string, selector: string) => {
  const normalized = css.replace(/\s*\{/gu, '{');
  const start = normalized.indexOf(`${selector}{`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  return normalized.slice(start, normalized.indexOf('}', start) + 1).replace(/:\s+/gu, ':');
};

describe('D-37 conversation and compact panels', () => {
  it('uses the semantic closed, open and focus colors for the launcher (D-38, CHAT-UI M-03)', () => {
    const closed = rule(dashboard, '.dashboard-ai-launcher');
    expect(closed).toContain('background:var(--primary)');
    expect(closed).toContain('color:var(--primary-foreground)');
    expect(closed).toContain('var(--stroke-hairline) solid var(--input)');
    const open = rule(dashboard, '.dashboard-ai-launcher[aria-expanded="true"]');
    expect(open).toContain('background:var(--selection)');
    expect(open).toContain('var(--stroke-control) solid var(--selection-foreground)');
    expect(rule(dashboard, '.dashboard-ai-launcher:focus-visible')).toContain('outline:var(--stroke-focus) solid var(--ring)');
    expect(rule(dashboard, '.dashboard-ai-launcher:focus-visible')).toContain('var(--focus-offset)');
    // Owner 2026-11-22: the circle carries the Navis symbol image (not a generic glyph), 32 px inside the 64-px circle.
    const mark = rule(dashboard, '.dashboard-ai-launcher img');
    expect(mark).toContain('width:var(--space-8)');
    expect(mark).toContain('height:var(--space-8)');
    expect(dashboard).not.toContain('.dashboard-ai-launcher .ui-icon');
  });
  it('keeps the launcher clear of POS actions and matches the detail header controls (UXP-1, UXS-6)', () => {
    // POS layer: top-right header slot, same column as the rail on the board layers.
    const pos = rule(dashboard, '.dashboard-ai-launcher[data-layer="orders-payment"]');
    expect(pos).toContain('top:var(--layout-margin)');
    expect(pos).toContain('bottom:auto');
    // Detail window header: 48 px like the neighbouring expand / help / close controls, logo 28 px.
    const header = rule(dashboard, '.ui-dialog > .dashboard-navis-dock[data-header-dock] .dashboard-ai-launcher');
    expect(header).toContain('width:var(--space-12)');
    expect(header).toContain('height:var(--space-12)');
    expect(rule(dashboard, '.ui-dialog > .dashboard-navis-dock[data-header-dock] .dashboard-ai-launcher img')).toContain('var(--icon-row)');
  });
  it('keeps assistant text on the pane and gives the owner a selection bubble (C-01, DS §10.1)', () => {
    const pane = rule(conversation, '.ai-conversation');
    expect(pane).toContain('background:var(--popover)');
    expect(pane).toContain('color:var(--popover-foreground)');
    expect(rule(conversation, '.ai-conversation__message')).not.toMatch(/(?:background|border)[\w-]*:/u);
    expect(conversation).not.toMatch(/\.ai-conversation__message\[data-role="assistant"\]\s*\{[^}]*(?:background|border)[\w-]*\s*:/u);
    const owner = rule(conversation, '.ai-conversation__message[data-role="user"]');
    expect(owner).toContain('background:var(--selection)');
    expect(owner).toContain('color:var(--foreground)');
    // M-20: the ring belongs to the one composer box and shows for the field's keyboard focus only.
    expect(rule(conversation, '.ai-conversation__box:has(textarea:focus-visible)')).toContain('outline:var(--stroke-focus) solid var(--ring)');
    expect(rule(conversation, '.ai-conversation__box:has(textarea:focus-visible)')).toContain('outline-offset:var(--focus-offset)');
  });
  it('keeps comparison information visible at large text size', () => {
    expect(tokens).not.toMatch(/\[data-text-scale="125"\]\s+\.ui-panel-comparison\s*\{\s*display:\s*none/);
  });
});
