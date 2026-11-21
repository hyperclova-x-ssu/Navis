import type { PosCatalog, PosDataRead, PosRecipePart, PosUnitDimension } from '../../contracts/pos';
import { createPosSeedCatalog } from '../../pos/seed';
import type { DataSnapshot, DataText } from '../db/types';
import { deepFreeze } from '../db/freeze';
import { fromBase, toBase, unitDimension } from '../derive/common';
import { deriveRecipeCost, deriveStock } from '../derive/stock';
import { selectClosing } from '../derive/payments';
import manifest from '../db/generated/manifest.json';
import { TODAY } from '../db/time';
import { dataBundles } from '../messages';
import { selectPosLoyaltyRead } from './loyalty';

const seedCatalog = createPosSeedCatalog();
const dimension = (unit: string): PosUnitDimension => unitDimension(unit) === 'mass' ? 'g' : unitDimension(unit) === 'volume' ? 'mL' : 'pcs';
const label = (text: DataText): string => 'raw' in text ? text.raw : dataBundles.map(b => b.ko[text.key]).find(Boolean) ?? text.key;
const reads = new WeakMap<DataSnapshot, PosDataRead>();

/** Stable snapshot adapter for createPosRuntime. Uses live menu/recipe/stock values. */
export function selectPosDataRead(snapshot: DataSnapshot): PosDataRead {
  const cached = reads.get(snapshot); if (cached) return cached;
  const t = snapshot.tables, stock = deriveStock(snapshot, { date: TODAY });
  const partCost = (part: PosRecipePart): number | null => {
    const item = t.inventoryItem.find(i => i.itemId === part.itemId), purchase = t.purchaseItem.find(p => p.itemId === part.itemId);
    return item && purchase && dimension(item.unit) === part.unitDimension ? (purchase.basePerUnit ? part.quantityBase / purchase.basePerUnit : fromBase(part.quantityBase, item.unit)) * purchase.unitPrice : null;
  };
  const catalog: PosCatalog = {
    ingredients: t.inventoryItem.filter(i => i.kind === 'ingredient').map(i => ({ itemId: i.itemId, unitDimension: dimension(i.unit) })),
    items: t.menuItem.map(m => {
      const seed = seedCatalog.items.find(s => s.menuId === m.menuId);
      const groups = (m.optionGroups ?? seed?.groups ?? []).filter(g => !g.archivedAt).map(g => ({ ...g, options: g.options.filter(o => !o.archivedAt).map(o => {
        const costs = o.extraRecipe.map(partCost);
        return { ...o, extraCost: costs.some(c => c === null) ? null : Math.round(costs.reduce<number>((n, c) => n + (c ?? 0), 0)) };
      }) }));
      const recipeBase = t.recipeLine.filter(r => r.menuId === m.menuId).map(r => ({ itemId: r.itemId, quantityBase: toBase(r.quantity, r.unit) ?? 0, unitDimension: dimension(r.unit) }));
      return { menuId: m.menuId, name: m.name ? label(m.name) : seed?.name ?? label({ key: m.nameKey }), category: m.category ?? (m.kind === 'retail' ? 'retail' : 'drink'),
        kind: m.kind ?? 'menu', ...(m.itemId ? { itemId: m.itemId } : {}), price: m.price, prepMin: m.prepMin ?? 3, unitCost: deriveRecipeCost(snapshot, m.menuId).cost,
        saleStatus: m.saleStatus ?? 'selling', photoKey: m.photoKey ?? null,
        ...(m.customPhotoUrl ? { customPhotoUrl: m.customPhotoUrl } : {}), ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}), recipeBase, groups,
        shortageItems: recipeBase.filter(p => stock.rows.some(r => r.itemId === p.itemId && r.trackRestock && r.rawBase < p.quantityBase)).map(p => p.itemId) };
    }),
  };
  const closing = selectClosing(snapshot, { date: TODAY, scenario: 'normal' });
  const read: PosDataRead = deepFreeze({ revision: snapshot.revision, catalog, dayClosed: closing.status === 'closed', closingGeneration: closing.generation, source: snapshot, loyalty: selectPosLoyaltyRead(snapshot), storeDisplayName: manifest.store.name });
  reads.set(snapshot, read); return read;
}
