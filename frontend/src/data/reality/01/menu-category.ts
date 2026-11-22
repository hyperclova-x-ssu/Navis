import type { MenuCategory } from '../../../contracts';

export function cafeMenuCategory(row: { readonly menuId: string; readonly sourceCategory: string }): MenuCategory {
  if (row.sourceCategory === '커피') return 'coffee';
  if (row.sourceCategory === '티' || row.menuId === 'm-yuja-chamomile') return 'tea';
  if (row.sourceCategory === '디저트') return 'dessert';
  return 'beverage';
}
