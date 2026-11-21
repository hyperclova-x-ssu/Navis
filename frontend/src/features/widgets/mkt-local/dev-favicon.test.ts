// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pages = [
  'src/features/widgets/mkt-local/detail-scroll-check.html',
];

describe('development page favicon', () => {
  it.each(pages)('%s points to the available app icon', page => {
    const html = readFileSync(resolve(process.cwd(), page), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const icon = document.head.querySelector('link[rel="icon"]');

    expect(icon?.getAttribute('type')).toBe('image/svg+xml');
    expect(icon?.getAttribute('href')).toBe('/src/assets/brand/navis-symbol.svg');
    expect(readFileSync(resolve(process.cwd(), `.${icon?.getAttribute('href')}`), 'utf8')).toMatch(/<svg\b/);
  });
});
