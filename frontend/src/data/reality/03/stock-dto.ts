import type { StockOpening } from '../../db/management-types';
import type { Channel, InventoryItem, InventoryStock, UnitCode } from '../../db/types';
import { fromBase } from '../../derive/common';

export interface StockBalanceDto {
  readonly openingQuantityBase: string;
  readonly usedQuantityBase: string;
  readonly rawQuantityBase: string;
  readonly availableQuantityBase: string;
  readonly deficitQuantityBase: string;
}

export interface StockItemDto {
  readonly itemId: string;
  readonly sku: string | null;
  readonly name: string | null;
  readonly kind: InventoryItem['kind'];
  readonly unit: UnitCode | null;
  readonly baseUnit: 'g' | 'mL' | 'pcs' | null;
  readonly thresholdBase: string | null;
  readonly trackRestock: boolean;
  readonly trackExpiry: boolean;
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly businessDate: string;
  readonly stock: StockBalanceDto | null;
  readonly onlineStock: StockBalanceDto | null;
  readonly expiresOn: string | null;
  readonly referenced: boolean;
}

export interface StockMovementDto {
  readonly movementId: string;
  readonly itemId: string;
  readonly businessDate: string;
  readonly at: string;
  readonly kind: 'opening' | 'usage' | 'receive' | 'adjust' | 'transfer' | 'waste';
  readonly channel: Channel;
  readonly deltaBase: string;
  readonly sourceId: string;
  readonly menuId: string | null;
  readonly menuQuantity: number | null;
  readonly reason: string | null;
}

export interface StockBatchDto {
  readonly batchId: string;
  readonly itemId: string;
  readonly quantityBase: string;
  readonly remainingQuantityBase: string;
  readonly expiresOn: string;
  readonly receivedAt: string;
  readonly discardedAt: string | null;
  readonly revision: number;
}

export interface StockForecastDto {
  readonly targetDate: string;
  readonly modelVersion: 'weekday-4w-v1';
  readonly status: 'ready' | 'no_data';
  readonly stale?: true;
  readonly results: readonly { readonly scope: 'store' | 'menu' | 'ingredient'; readonly targetId: string | null; readonly expected: string }[];
}

export interface RealStockSnapshot {
  readonly businessDate: string;
  readonly items: readonly StockItemDto[];
  readonly movements: readonly StockMovementDto[];
  readonly movementsComplete: boolean;
  readonly batches: readonly StockBatchDto[];
  readonly batchesComplete: boolean;
  readonly forecast: StockForecastDto | null;
}

export function baseQuantity(value: string | null | undefined): number | null {
  if (value == null || !/^-?\d+(?:\.0+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function displayQuantity(value: string | null | undefined, unit: UnitCode | null): number | null {
  const base = baseQuantity(value);
  return unit === null || base === null ? null : fromBase(base, unit);
}

export function toInventoryItem(item: StockItemDto): InventoryItem {
  return {
    itemId: item.itemId,
    ...(item.sku !== null ? { sku: item.sku } : {}),
    ...(item.name !== null ? { name: { raw: item.name } } : {}),
    nameKey: 'data.state.inventory-booking.partial-data',
    kind: item.kind,
    unit: item.unit ?? 'pcs',
    restockThreshold: displayQuantity(item.thresholdBase, item.unit),
    trackRestock: item.trackRestock,
    lowStockPerChannel: item.kind === 'retail' ? displayQuantity(item.thresholdBase, item.unit) : null,
    sales7d: null,
    updatedAt: item.updatedAt ?? '',
    trackExpiry: item.trackExpiry,
    expiresOn: item.expiresOn,
  };
}

export function toInventoryStock(item: StockItemDto, commerceQuantity?: number | null): InventoryStock[] {
  return [
    { itemId: item.itemId, channel: 'store', qty: displayQuantity(item.stock?.availableQuantityBase, item.unit) },
    ...(item.kind === 'retail' ? [{ itemId: item.itemId, channel: 'online' as const, qty: commerceQuantity === undefined ? displayQuantity(item.onlineStock?.availableQuantityBase, item.unit) : commerceQuantity }] : []),
  ];
}

export function toStockOpening(item: StockItemDto): StockOpening[] {
  const quantityBase = baseQuantity(item.stock?.openingQuantityBase);
  return quantityBase === null ? [] : [{ itemId: item.itemId, businessDate: item.businessDate, quantityBase }];
}
