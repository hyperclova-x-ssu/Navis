import type {MenuItem} from './types';

export const MENU: readonly MenuItem[] = [
  {menuId: 'm-americano', name: '아메리카노', key: 'data.menu.americano', unitPrice: 4500, prepMin: 3},
  {menuId: 'm-latte', name: '카페라테', key: 'data.menu.latte', unitPrice: 5000, prepMin: 4},
  {menuId: 'm-vanilla', name: '바닐라라테', key: 'data.menu.vanillaLatte', unitPrice: 5500, prepMin: 4},
  {menuId: 'm-cold-brew', name: '콜드브루', key: 'data.menu.coldBrew', unitPrice: 5000, prepMin: 2},
  {menuId: 'm-smoothie', name: '딸기스무디', key: 'data.menu.strawberrySmoothie', unitPrice: 6500, prepMin: 5},
  {menuId: 'm-croffle', name: '크로플', key: 'data.menu.croffle', unitPrice: 6000, prepMin: 7},
  {menuId: 'm-cheesecake', name: '치즈케이크', key: 'data.menu.cheesecake', unitPrice: 6500, prepMin: 2},
  {menuId: 'm-sandwich', name: '샌드위치', key: 'data.menu.sandwich', unitPrice: 7500, prepMin: 6},
  {menuId: 'm-whole-cake', name: '홀케이크', key: 'data.menu.wholeCake', unitPrice: 32000, prepMin: 3},
];
const byName = new Map(MENU.map(item => [item.name, item]));
export function menuItem(name: string): MenuItem {
  const item = byName.get(name);
  if (!item) throw new Error(`Unknown menu: ${name}`);
  return item;
}
