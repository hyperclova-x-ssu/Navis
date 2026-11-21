import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditToolbar } from './controls';

afterEach(cleanup);

// jsdom has no layout engine or custom-property resolution. Exercise the real
// toolbar rules with their token values; browser verification measures the rect.
function toolbarStyles() {
  const css = readFileSync('src/ui/tokens.css', 'utf8');
  const tokens = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map(match => [match[1], match[2]]));
  const rules = [...css.matchAll(/(?:^|\n)(\*|\.ui-(?:edit-toolbar|button)\b[^{]*)\s*\{([^}]*)\}/g)].map(match => `${match[1]}{${match[2]}}`).join('\n');
  const style = document.createElement('style');
  style.textContent = rules.replace(/var\((--[\w-]+)\)/g, (value, name: string) => tokens.get(name) ?? value);
  return style;
}

it.each([100, 125])('keeps the completion button 96×48 inside the 64px bar with an 8px inset at text scale %s', scale => {
  const done = vi.fn();
  const view = render(<div style={{ fontSize: scale === 125 ? '20px' : '16px' }}><EditToolbar onDone={done} /></div>);
  const style = toolbarStyles();
  view.container.append(style);
  const button = screen.getByRole('button', { name: '완료' });
  const bar = getComputedStyle(button.parentElement!);
  const control = getComputedStyle(button);
  expect(bar.height).toBe('64px');
  expect(bar.paddingTop).toBe('8px');
  expect(bar.paddingBottom).toBe('8px');
  expect(bar.paddingRight).toBe('8px');
  expect(bar.alignItems).toBe('center');
  expect(bar.boxSizing).toBe('border-box');
  expect(control.width).toBe('96px');
  expect(control.height).toBe('48px');
  expect(control.flexShrink).toBe('0');
  expect(bar.boxShadow).toContain('2px');
  fireEvent.click(button);
  expect(done).toHaveBeenCalledOnce();
});
