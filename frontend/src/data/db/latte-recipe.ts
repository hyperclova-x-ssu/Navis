import { seedCatalog } from './generated/catalog';

const parts = seedCatalog.menu.find(menu => menu.menuId === 'm-cafe-latte')!.recipeBase;
export const LATTE_RECIPE = Object.freeze({
  beansG: parts.find(part => part.itemId === 'i-bean-house')!.quantityBase,
  milkMl: parts.find(part => part.itemId === 'i-milk')!.quantityBase,
});
