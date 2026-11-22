/**
 * KIOSK-UI — the customer-facing menu of the 안숭잘부 카페, read from the same seed the Navis POS menu projection reads
 * (24 menus, their option groups, real prices, the photos under /menu-photos). The category tabs are the store-defined tabs of
 * D-353, in this order: 전체, 커피, 티, 음료, 디저트. Seasonal menus use their designated category and keep their seasonal marker.
 */
import { seedCatalog } from '../data/db/generated/catalog';
import { cafeMenuPhoto } from '../data/db/cafe-menu-photos';
import { MENU_CATEGORIES, type Locale, type MenuCategory } from '../contracts';
import { cafeMenuCategory } from '../data/reality/01/menu-category';

export interface KioskOption { readonly id: string; readonly name: string; readonly extraPrice: number }
export interface KioskGroup { readonly id: string; readonly name: string; readonly required: boolean; readonly options: readonly KioskOption[] }
export type KioskCategory = MenuCategory;
export type KioskTabKey = 'all' | KioskCategory;
export interface KioskTab { readonly key: KioskTabKey; readonly label: string }
const TAB_KEYS = ['all', ...MENU_CATEGORIES] as const;
export const kioskCategoryMessages = {
  ko: { all: '전체', coffee: '커피', tea: '티', beverage: '음료', dessert: '디저트', menu: '메뉴 분류', sheet: '전체 분류' },
  en: { all: 'All', coffee: 'Coffee', tea: 'Tea', beverage: 'Drinks', dessert: 'Desserts', menu: 'Menu categories', sheet: 'All categories' },
  'zh-Hans': { all: '全部', coffee: '咖啡', tea: '茶', beverage: '饮品', dessert: '甜点', menu: '菜单分类', sheet: '全部分类' },
  'zh-Hant': { all: '全部', coffee: '咖啡', tea: '茶', beverage: '飲品', dessert: '甜點', menu: '菜單分類', sheet: '全部分類' },
} satisfies Record<Locale, Record<KioskTabKey | 'menu' | 'sheet', string>>;

export function kioskCategoryLocale(language: string): Locale {
  const [primary, ...subtags] = language.toLowerCase().split('-');
  if (primary === 'en') return 'en';
  if (primary === 'zh') return subtags.some(tag => ['hant', 'hk', 'mo', 'tw'].includes(tag)) ? 'zh-Hant' : 'zh-Hans';
  return 'ko';
}

export const kioskTabs = (locale: Locale): readonly KioskTab[] => TAB_KEYS.map(key => ({ key, label: kioskCategoryMessages[locale][key] }));

export interface KioskItem {
  readonly id: string; readonly name: string; readonly price: number; readonly category: KioskCategory; readonly photo: string | null;
  readonly seasonal: string | null;
  readonly description: string | null; readonly soldOut: boolean; readonly groups: readonly KioskGroup[];
}

interface SeedOption { readonly optionId: string; readonly name: string; readonly extraPrice: number }
interface SeedGroup { readonly groupId: string; readonly name: string; readonly required: boolean; readonly sortOrder: number; readonly options: readonly SeedOption[] }
interface SeedMenu {
  readonly menuId: string; readonly name: string; readonly sourceCategory: string; readonly price: number; readonly memo: string | null;
  readonly season: string | null; readonly saleStatus: string; readonly groups: readonly SeedGroup[];
}

export function toKioskItem(menu: SeedMenu): KioskItem {
  return {
    id: menu.menuId, name: menu.name, price: menu.price, category: cafeMenuCategory(menu), seasonal: menu.season, photo: cafeMenuPhoto(menu.menuId),
    description: menu.memo && menu.memo.trim() ? menu.memo.trim() : null, soldOut: menu.saleStatus === 'sold_out',
    groups: [...menu.groups].sort((a, b) => a.sortOrder - b.sortOrder).map(group => ({
      id: group.groupId, name: group.name, required: group.required,
      options: group.options.map(option => ({ id: option.optionId, name: option.name, extraPrice: option.extraPrice })),
    })),
  };
}

/** All 24 menus, grouped by tab order (coffee, tea, beverage, dessert), the seed's order kept inside a group. */
export const kioskItems: readonly KioskItem[] = (seedCatalog.menu as readonly SeedMenu[]).map(toKioskItem)
  .sort((a, b) => MENU_CATEGORIES.indexOf(a.category) - MENU_CATEGORIES.indexOf(b.category));
export const itemsForTab = (tab: KioskTabKey): readonly KioskItem[] => tab === 'all' ? kioskItems : kioskItems.filter(item => item.category === tab);
export const kioskItem = (id: string): KioskItem | undefined => kioskItems.find(item => item.id === id);
