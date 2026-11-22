import type { MessageBundle } from '../../i18n';

/** D-353: the POS ordering tabs, in this exact order. `all` is a view, not a catalog category. */
export const POS_MENU_TABS = ['all', 'coffee', 'tea', 'beverage', 'dessert'] as const;
export type PosMenuTab = (typeof POS_MENU_TABS)[number];

/** Catalog category → ordering tab. Legacy `drink` is the new `beverage`; anything else (e.g. retail goods) is only under 전체. */
export function posMenuTab(category: string): Exclude<PosMenuTab, 'all'> | null {
  const normalized = category === 'drink' ? 'beverage' : category;
  return normalized === 'coffee' || normalized === 'tea' || normalized === 'beverage' || normalized === 'dessert' ? normalized : null;
}

const ko = {
  'pos.category.all': '전체', 'pos.category.coffee': '커피', 'pos.category.tea': '티', 'pos.category.beverage': '음료', 'pos.category.dessert': '디저트',
} as const;
export const posCategoryBundle: MessageBundle<keyof typeof ko> = {
  id: 'pos-order-categories', ko,
  en: { 'pos.category.all': 'All', 'pos.category.coffee': 'Coffee', 'pos.category.tea': 'Tea', 'pos.category.beverage': 'Drinks', 'pos.category.dessert': 'Desserts' },
  'zh-Hans': { 'pos.category.all': '全部', 'pos.category.coffee': '咖啡', 'pos.category.tea': '茶', 'pos.category.beverage': '饮品', 'pos.category.dessert': '甜点' },
  'zh-Hant': { 'pos.category.all': '全部', 'pos.category.coffee': '咖啡', 'pos.category.tea': '茶', 'pos.category.beverage': '飲品', 'pos.category.dessert': '甜點' },
};
