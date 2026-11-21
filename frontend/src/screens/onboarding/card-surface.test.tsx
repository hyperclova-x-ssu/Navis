import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TemplatePreview } from '../../ui/components/onboarding';

// U-C (owner feedback 2026-11-20): unselected choice/template cards are plain cards (no pre-drawn inner gray box);
// gray shows only while hovering/pressing, green only on the selected card, and the preview draws only the panel
// blocks plus faint grid lines. jsdom does not apply imported stylesheets, so the rules are checked in the source
// CSS; computed styles were checked in headless Chrome (.evidence/task_bb9baa4c4d06/).
const css = readFileSync('src/screens/onboarding/onboarding.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]!.replace(/\s+/g, '') }));
const find = (...needles: string[]) => rules.filter(rule => needles.every(needle => rule.selector.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''))));
const cards = '.ui-button:is(.ui-choice-card,.ui-template-card)';

describe('choice and template cards on the onboarding steps', () => {
  it('never fills the inner press surface (the kit outline button paints the page gray into it)', () => {
    const [surface] = find('.t207-onboarding-host', cards, '>.ui-press-surface');
    expect(surface, 'a scoped override for the card surface exists').toBeDefined();
    expect(surface!.body).toContain('background:transparent');
    expect(surface!.selector).not.toContain(':hover');
  });

  it('shows the gray surface on the card itself only while hovering or pressing an unselected card', () => {
    const hover = find('.t207-onboarding-host', cards, ':not([aria-checked="true"])', ':hover');
    const pressed = find('.t207-onboarding-host', cards, ':not([aria-checked="true"])', '[data-pressed="true"]');
    expect(hover).toHaveLength(1);
    expect(pressed).toHaveLength(1);
    for (const rule of [...hover, ...pressed]) {
      expect(rule.body).toBe('background:var(--accent);');
      expect(rule.selector).not.toContain('.ui-press-surface');
    }
  });

  it('draws the template preview without gray fill or dashed cells: faint grid lines from the token border colour', () => {
    const preview = find('.t207-onboarding-host .ui-template-preview').find(rule => !rule.selector.includes('>'));
    expect(preview, 'a scoped override for the preview exists').toBeDefined();
    expect(preview!.body).toContain('linear-gradient');
    expect(preview!.body).toContain('var(--border)');
    expect(preview!.body).not.toMatch(/dashed|--secondary|--muted|--background|--accent/);
    expect(preview!.body).toContain('var(--template-preview-columns');
    expect(preview!.body).toContain('var(--template-preview-rows');
  });
});

describe('TemplatePreview', () => {
  it('exposes the grid size to CSS and renders only the panel blocks as cells', () => {
    const { container } = render(<TemplatePreview columns={3} rows={4}
      items={[{ id: 'a', label: '브리핑', groupId: 'finance', column: 0, row: 0, width: 1, height: 2 }]} />);
    const preview = container.querySelector<HTMLElement>('.ui-template-preview')!;
    expect(preview.style.getPropertyValue('--template-preview-columns')).toBe('3');
    expect(preview.style.getPropertyValue('--template-preview-rows')).toBe('4');
    expect(preview.style.gridTemplateColumns).toBe('repeat(3,minmax(0,1fr))');
    expect(preview.querySelectorAll(':scope>span')).toHaveLength(1);
  });
});
