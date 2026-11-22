import { expect, it } from 'vitest';
import type { PosCatalogItem, PosOption, PosOptionGroup } from '../../contracts/pos';
import { createTranslator } from '../../i18n';
import { POS_MENU_TABS, posCategoryBundle, posMenuTab } from './categories';
import { retainActiveOptions, lineSummary, optionCaption, optionLabel, orderedOptions } from './option-text';

const opt = (groupId: string, name: string, extraPrice = 0, archivedAt?: string): PosOption =>
  ({ optionId: `${groupId}:${name}`, groupId, name, extraPrice, extraCost: 0, extraRecipe: [], ...(archivedAt ? { archivedAt } : {}) });
const group = (groupId: string, required: boolean, options: PosOption[]): PosOptionGroup => ({ groupId, menuId: 'm', name: groupId, required, options });
const item = (groups: PosOptionGroup[]): PosCatalogItem => ({ menuId: 'm', name: '카페라떼', category: 'coffee', kind: 'menu', price: 3800, prepMin: 3, unitCost: null, photoKey: null, saleStatus: 'selling', shortageItems: [], recipeBase: [], groups });

it('prints a price delta only for paid options', () => {
  expect(optionLabel(opt('g', 'HOT'))).toBe('HOT');
  expect(optionLabel(opt('g', '샷 추가', 500))).toBe('샷 추가 +500원');
  expect(optionCaption([opt('g', 'ICE'), opt('g', '샷 추가', 500)])).toBe('ICE · 샷 추가 +500원');
  expect(lineSummary('카페라떼', [opt('g', 'ICE'), opt('g', '오트', 600)], 2)).toBe('카페라떼 (ICE · 오트 +600원) ×2');
  expect(lineSummary('크루아상', [], 1)).toBe('크루아상 ×1');
});

it('starts without choices and preserves only active selections when editing a line', () => {
  const temperature = group('temp', true, [opt('temp', 'HOT'), opt('temp', 'ICE')]);
  const size = group('size', true, [opt('size', 'old', 0, '2026-11-01'), opt('size', '레귤러'), opt('size', '라지', 500)]);
  const extra = group('extra', false, [opt('extra', '샷', 500)]);
  const menu = item([temperature, size, extra]);
  expect(retainActiveOptions(menu)).toEqual([]);
  expect(retainActiveOptions(menu, ['temp:ICE', 'extra:샷', 'size:old'])).toEqual(['temp:ICE', 'extra:샷']);
  expect(retainActiveOptions(item([extra]))).toEqual([]);
});

it('orders chosen options by the menu group order, not by id', () => {
  const menu = item([group('temp', true, [opt('temp', 'HOT'), opt('temp', 'ICE')]), group('size', false, [opt('size', '사이즈업', 500)]), group('extra', false, [opt('extra', '샷', 500)])]);
  const chosen = [opt('extra', '샷', 500), opt('temp', 'ICE'), opt('size', '사이즈업', 500)];
  expect(orderedOptions(menu, chosen).map(option => option.name)).toEqual(['ICE', '사이즈업', '샷']);
});

// D-353: five tabs, this exact order, labelled in all four languages; the legacy `drink` is 음료.
it('defines the five D-353 ordering tabs with ko/en/zh labels and maps legacy drink to beverage', () => {
  expect([...POS_MENU_TABS]).toEqual(['all', 'coffee', 'tea', 'beverage', 'dessert']);
  const labels = (locale: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant') => { const { t } = createTranslator(locale, posCategoryBundle); return POS_MENU_TABS.map(tab => t(`pos.category.${tab}`)); };
  expect(labels('ko')).toEqual(['전체', '커피', '티', '음료', '디저트']);
  expect(labels('en')).toEqual(['All', 'Coffee', 'Tea', 'Drinks', 'Desserts']);
  expect(labels('zh-Hans')).toEqual(['全部', '咖啡', '茶', '饮品', '甜点']);
  expect(labels('zh-Hant')).toEqual(['全部', '咖啡', '茶', '飲品', '甜點']);
  expect(['drink', 'beverage', 'coffee', 'tea', 'dessert', 'retail'].map(posMenuTab)).toEqual(['beverage', 'beverage', 'coffee', 'tea', 'dessert', null]);
});
