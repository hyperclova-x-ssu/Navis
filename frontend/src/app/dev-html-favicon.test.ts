import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pages = [
  'src/app/closing-content-check.html',
  'src/screens/detail/detail-body-check.html',
];

describe('development page favicons', () => {
  it.each(pages)('%s points to the existing app icon', (page) => {
    const html = readFileSync(resolve(process.cwd(), page), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const icon = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');

    expect(icon?.getAttribute('type')).toBe('image/svg+xml');
    expect(icon?.getAttribute('href')).toBe('/src/assets/brand/navis-symbol.svg');
    expect(readFileSync(resolve(process.cwd(), `.${icon?.getAttribute('href')}`), 'utf8')).toMatch(/<svg\b/);
  });
});
