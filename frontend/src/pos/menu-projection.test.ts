import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { cafeMenuPhoto } from '../data/db/cafe-menu-photos';
import { seedCatalog } from '../data/db/generated/catalog';

it('maps each of the 24 café fixture menus to its own shipped image', () => {
  expect(seedCatalog.menu).toHaveLength(24);
  const urls = seedCatalog.menu.map(({ menuId }) => {
    const url = cafeMenuPhoto(menuId);
    expect(url).toBe(`/menu-photos/cafe-${menuId.slice(2)}-01.jpeg`);
    expect(existsSync(resolve('public', url!.slice(1)))).toBe(true);
    return url;
  });
  expect(new Set(urls).size).toBe(24);
  expect(cafeMenuPhoto('m-unknown')).toBeNull();
});
