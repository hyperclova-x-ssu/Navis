import { expect, it } from 'vitest';
import { menuCommandRequest, projectMenuTables, type MenuDto } from './menu-dto';

const menu: MenuDto = {
  menuId: '22222222-2222-4222-8222-222222222222', name: '카페라떼', category: 'drink', price: 5000,
  memo: '우유 사용', prepMin: 3, saleStatus: 'selling', photoKey: 'menu-photo-01', photoFileId: null,
  groups: [], recipeLines: [{ recipeLineId: 'line', itemId: 'milk', quantity: 200, unit: 'mL', cost: 1800 }],
  recipeVersion: 'recipe-version', unitCost: 1800, revision: 7,
};

it('projects authoritative cost, photo and recipe into the shared snapshot tables', () => {
  expect(projectMenuTables([menu], '2026-11-21T07:45:00Z')).toMatchObject({
    menuItem: [{ menuId: menu.menuId, name: { raw: '카페라떼' }, memo: { raw: '우유 사용' },
      photoKey: 'menu-photo-01', sourceCost: { unitCost: 1800 } }],
    recipeLine: [{ menuId: menu.menuId, recipeLineId: 'line', itemId: 'milk', quantity: 200, unit: 'mL', sourceCost: 1800 }],
  });
  expect(projectMenuTables([{ ...menu, unitCost: null }], '2026-11-21T07:45:00Z').menuItem[0].sourceCost.unitCost).toBeNull();
});

it('projects the four menu categories, keeps the seasonal marker, and reads legacy drinks as beverages', () => {
  const categories = ['coffee', 'tea', 'beverage', 'dessert', 'drink'] as const;
  const { menuItem } = projectMenuTables(categories.map(category => ({ ...menu, category, seasonal: 'autumn' })), '2026-11-21T07:45:00Z');
  expect(menuItem.map(({ category, categoryKey, seasonal }) => [category, categoryKey, seasonal])).toEqual([
    ['coffee', 'data.management.category.coffee', 'autumn'],
    ['tea', 'data.management.category.tea', 'autumn'],
    ['beverage', 'data.management.category.beverage', 'autumn'],
    ['dessert', 'data.management.category.dessert', 'autumn'],
    ['beverage', 'data.management.category.beverage', 'autumn'],
  ]);
});

it('writes the resource revision and preserves the existing command inputs', () => {
  expect(menuCommandRequest({ type: 'menu.create', name: '차', category: 'drink', price: 3500, idempotencyKey: 'once' })).toEqual({
    method: 'POST', path: '/inventory/menu', body: { name: '차', category: 'drink', price: 3500, memo: null },
  });
  expect(menuCommandRequest({ type: 'menu.setSaleStatus', menuId: menu.menuId, status: 'sold_out', baseRevision: 100 }, menu.revision)).toEqual({
    method: 'PATCH', path: `/inventory/menu/${menu.menuId}`, expectedRevision: 7, body: { saleStatus: 'sold_out' },
  });
  expect(menuCommandRequest({ type: 'menu.setRecipe', menuId: menu.menuId, lines: menu.recipeLines }, menu.revision)).toEqual({
    method: 'PATCH', path: '/inventory/recipes', expectedRevision: 7, body: { menuId: menu.menuId, lines: [{ itemId: 'milk', quantity: 200, unit: 'mL' }] },
  });
  expect(menuCommandRequest({ type: 'menu.delete', menuId: menu.menuId }, menu.revision)).toEqual({
    method: 'DELETE', path: `/inventory/menu/${menu.menuId}`, expectedRevision: 7,
  });
  expect(() => menuCommandRequest({ type: 'menu.delete', menuId: menu.menuId })).toThrow(/STALE_REVISION/);
});

it('only sends authored option fields and supports a completed photo file', () => {
  const readOption = { optionId: 'option', groupId: 'group', name: '샷', extraPrice: 500, extraCost: 130,
    extraRecipe: [{ itemId: 'beans', quantityBase: 18, unitDimension: 'g' as const }], recipeVersion: 'derived' };
  const group = { groupId: 'group', menuId: menu.menuId, name: '추가', required: false, options: [readOption] };
  expect(menuCommandRequest({ type: 'menu.setOptions', menuId: menu.menuId, groups: [group] }, 7)?.body).toEqual({
    groups: [{ ...group, options: [{ optionId: 'option', groupId: 'group', name: '샷', extraPrice: 500,
      extraRecipe: [{ itemId: 'beans', quantityBase: 18, unitDimension: 'g' }] }] }],
  });
  const photo = { type: 'menu.setPhoto', menuId: menu.menuId, photoKey: null } as const;
  expect(menuCommandRequest(photo, 7, 'file-uuid').body).toEqual({ photoFileId: 'file-uuid' });
  expect(menuCommandRequest(photo, 7).body).toEqual({ photoKey: null });
});
