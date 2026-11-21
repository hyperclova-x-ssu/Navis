import { seedCatalog } from '../../data/db/generated/catalog';
import type { DataText } from '../../data/widget-data';

const stapleKeys = new Map([
  ['i-milk', 'data.item.milk'],
  ['i-bean-house', 'data.item.beans'],
]);
const keysByCafeLabel = new Map(seedCatalog.items.flatMap(item => {
  const key = stapleKeys.get(item.itemId);
  return key ? [[String(item.name), key] as const] : [];
}));

export function inventoryIngredientKey(label: DataText | undefined): string | undefined {
  if (label && 'key' in label) return label.key;
  return label && keysByCafeLabel.get(label.raw);
}
