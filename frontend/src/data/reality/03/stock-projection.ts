import type { DataSnapshot } from '../../db/types';
import { TODAY, addDays, dateRange } from '../../db/time';
import { fromBase } from '../../derive/common';
import type { StockHistoryRow } from '../../derive/stock';
import { baseQuantity, displayQuantity, type RealStockSnapshot, type StockItemDto, type StockMovementDto } from './stock-dto';

export const realStock = (snapshot: DataSnapshot) => snapshot.tables.realStock?.[0];
export const stockDate = (snapshot: DataSnapshot) => realStock(snapshot)?.businessDate ?? TODAY;

export function readStockForecast(source: RealStockSnapshot, item: StockItemDto) {
  const forecast = source.forecast;
  if (forecast?.status !== 'ready' || forecast.targetDate !== source.businessDate || !item.unit) return null;
  const row = forecast.results.find(result => result.scope === 'ingredient' && result.targetId === item.itemId);
  if (!row || !/^\d+(?:\.\d+)?$/.test(row.expected)) return null;
  const base = Number(row.expected);
  if (!Number.isFinite(base) || base > Number.MAX_SAFE_INTEGER) return null;
  return { amount: fromBase(base, item.unit), stale: forecast.stale === true };
}

export function stockMetrics(source: RealStockSnapshot | undefined, item: StockItemDto | undefined) {
  const unit = item?.unit ?? null;
  const balance = item?.stock;
  const opening = displayQuantity(balance?.openingQuantityBase, unit) ?? 0;
  const usedToday = displayQuantity(balance?.usedQuantityBase, unit) ?? 0;
  const raw = displayQuantity(balance?.rawQuantityBase, unit) ?? 0;
  const stock = displayQuantity(balance?.availableQuantityBase, unit);
  const forecast = source && item ? readStockForecast(source, item) : null;
  return {
    opening, usedToday, raw, stock, display: stock ?? 0,
    rawBase: baseQuantity(balance?.rawQuantityBase) ?? 0,
    deficit: displayQuantity(balance?.deficitQuantityBase, unit) ?? 0,
    expectedUsageRemaining: forecast && !forecast.stale ? Math.max(0, forecast.amount - usedToday) : 0,
  };
}

export function projectRealUsage(source: RealStockSnapshot | undefined, date: string) {
  const byItem: Record<string, number> = {}, byMenu: Record<string, Record<string, number>> = {};
  const usageRows: { rowId: string; itemId: string; menuId: string; soldQty: number; quantityBase: number; asOf: string }[] = [];
  if (source?.businessDate === date) for (const item of source.items) {
    const used = baseQuantity(item.stock?.usedQuantityBase);
    if (used !== null) byItem[item.itemId] = used;
  }
  if (source?.movementsComplete) for (const row of source.movements) {
    if (row.kind !== 'usage' || row.businessDate !== date || !row.menuId || row.menuQuantity === null) continue;
    const delta = baseQuantity(row.deltaBase);
    if (delta === null) continue;
    const usage = byMenu[row.menuId] ??= {};
    usage[row.itemId] = (usage[row.itemId] ?? 0) - delta;
    if (date !== source.businessDate) byItem[row.itemId] = (byItem[row.itemId] ?? 0) - delta;
    usageRows.push({ rowId: row.movementId, itemId: row.itemId, menuId: row.menuId, soldQty: row.menuQuantity, quantityBase: -delta, asOf: row.at.slice(11, 16) });
  }
  // Stock movements only cover recipe-bearing sales and cannot count all menu sales.
  return { byItem, byMenu, usageRows, soldQty: {} as Record<string, number>, asOf: '' };
}

function movementDescription(row: StockMovementDto): StockHistoryRow['description'] {
  if (row.kind === 'opening') return { key: 'data.management.history.opening' };
  if (row.kind === 'usage') return { key: 'data.management.history.usage', params: { count: row.menuQuantity ?? 0 }, keyParams: { menu: '' } };
  if (row.kind === 'receive') return { key: 'supply.stock.receive' };
  if (row.kind === 'waste') return { key: 'supply.stock.lotDiscard' };
  if (row.kind === 'transfer') return { key: 'supply.stock.movementTransfer' };
  return { key: 'data.management.history.adjust' };
}

function historyKind(row: StockMovementDto): StockHistoryRow['kind'] {
  return row.kind === 'waste' || row.kind === 'transfer' ? 'adjust' : row.kind;
}

export function projectRealStockHistory(source: RealStockSnapshot | undefined, itemId: string, period: 'today' | 'last7days') {
  const item = source?.items.find(row => row.itemId === itemId);
  const unit = item?.unit ?? 'pcs';
  const currentOpening = baseQuantity(item?.stock?.openingQuantityBase);
  const dayGroups: { date: string; opening: number; rows: StockHistoryRow[]; endingRaw: number; endingDisplay: number }[] = [];
  if (!source?.movementsComplete || !item?.unit || currentOpening === null) return { itemId, unit, dayGroups };

  const today = source.businessDate;
  const dates = period === 'today' ? [today] : dateRange(addDays(today, -6), today).reverse();
  const allMoves = source.movements.filter(row => row.itemId === itemId && row.channel === 'store');
  const oldestOpening = allMoves.filter(row => row.kind === 'opening').map(row => row.businessDate).sort()[0];
  let nextOpening = currentOpening;
  for (const date of dates) {
    const movements = allMoves.filter(row => row.businessDate === date).sort((a, b) => a.at.localeCompare(b.at) || a.movementId.localeCompare(b.movementId));
    const changes = movements.filter(row => row.kind !== 'opening').map(row => ({ row, delta: baseQuantity(row.deltaBase) }));
    if (changes.some(change => change.delta === null)) break;
    const openingRow = movements.find(row => row.kind === 'opening');
    const movementOpening = baseQuantity(openingRow?.deltaBase);
    const total = changes.reduce((sum, change) => sum + (change.delta ?? 0), 0);
    const openingBase = date === today ? currentOpening : movementOpening ?? nextOpening - total;
    let balance = openingBase;
    const opening = fromBase(balance, unit);
    const rows: StockHistoryRow[] = [];
    if (date === today || openingRow) rows.push({
      rowId: openingRow?.movementId ?? `opening:${date}:${itemId}`, itemId, at: openingRow?.at ?? '', kind: 'opening', delta: opening,
      balanceRaw: opening, balanceDisplay: Math.max(0, opening), sourceRef: itemId, description: { key: 'data.management.history.opening' },
    });
    for (const { row, delta } of changes) {
      balance += delta ?? 0;
      const balanceRaw = fromBase(balance, unit);
      rows.push({ rowId: row.movementId, itemId, at: row.at, kind: historyKind(row), delta: fromBase(delta ?? 0, unit), balanceRaw,
        balanceDisplay: Math.max(0, balanceRaw), sourceRef: row.menuId ?? row.sourceId, description: movementDescription(row) });
    }
    const endingRaw = date === today ? displayQuantity(item.stock?.rawQuantityBase, unit) : fromBase(balance, unit);
    if (endingRaw === null) break;
    dayGroups.push({ date, opening, rows, endingRaw, endingDisplay: Math.max(0, endingRaw) });
    // Stop at the oldest opening in view. Later openings also anchor their own day.
    if (date === oldestOpening) break;
    nextOpening = openingBase;
  }
  return { itemId, unit, dayGroups };
}
