import type { DataSnapshot, DataText } from '../db/types';
import { seedCatalog, seedHistory } from '../db/cafe-fixtures';
import { projectPosRemainingUsage, projectPosUsage } from '../pos/projection';
import { addDays, dateOf, dateRange, TODAY } from '../db/time';
import { DataQueryError, fromBase, memoSelector, requireDate, roundRate, toBase, unitDimension } from './common';
import { projectRealStockHistory, projectRealUsage, realStock, stockMetrics } from '../reality/03/stock-projection';
import { baseQuantity } from '../reality/03/stock-dto';

export function purchaseQuantityBase(quantity: number, unit: string, basePerUnit?: number): number | null {
  if (basePerUnit === undefined) return toBase(quantity, unit);
  const base = quantity * basePerUnit;
  const rounded = Math.round(base);
  return Number.isSafeInteger(rounded) && Math.abs(base - rounded) < 1e-7 ? rounded : null;
}

export const deriveUsage = memoSelector((q: { readonly date: string }) => q.date, (s, q) => {
  requireDate(q.date);
  if (s.tables.realStock !== undefined) return projectRealUsage(realStock(s), q.date === TODAY ? realStock(s)?.businessDate ?? q.date : q.date);
  if (s.pos && q.date === s.pos.businessDate) return projectPosUsage(s.pos, s.tables, q.date);
  const soldQty: Record<string, number> = {};
  const paymentIds = new Set(s.tables.payment.filter((p) => p.businessDate === q.date && p.kind === 'payment').map((p) => p.paymentId));
  for (const l of s.tables.paymentLine) if (paymentIds.has(l.paymentId)) soldQty[l.menuId] = (soldQty[l.menuId] ?? 0) + l.qty;
  const byItem: Record<string, number> = {}, byMenu: Record<string, Record<string, number>> = {};
  const history = seedHistory.days.find(day => day.date === q.date);
  if (history) for (const [id, qty] of history.menu) soldQty[id] = qty;
  const recipe = history ? seedCatalog.menu.flatMap(menu => menu.recipeBase.map(part => ({ menuId: menu.menuId, itemId: part.itemId, quantity: part.quantityBase, unit: part.unitDimension }))) : s.tables.recipeLine;
  const usageRows = [...recipe].sort((a, b) => s.tables.menuItem.findIndex((m) => m.menuId === a.menuId) - s.tables.menuItem.findIndex((m) => m.menuId === b.menuId)).flatMap((r) => {
    const sold = soldQty[r.menuId] ?? 0;
    if (!sold) return [];
    const base = (toBase(r.quantity, r.unit) ?? 0) * sold;
    byItem[r.itemId] = (byItem[r.itemId] ?? 0) + base;
    (byMenu[r.menuId] ??= {})[r.itemId] = base;
    return [{ rowId: `usage:${q.date}:${r.menuId}:${r.itemId}`, menuId: r.menuId, itemId: r.itemId, soldQty: sold, quantityBase: base, asOf: history ? '22:00' : '15:42' }];
  });
  return { byItem, byMenu, usageRows, soldQty, asOf: history ? '22:00' : '15:42' };
});
export const deriveRecipeCost = memoSelector((menuId: string) => menuId, (s, menuId) => {
  const menu = s.tables.menuItem.find((m) => m.menuId === menuId);
  if (!menu) throw new DataQueryError('NOT_FOUND', 'menuId');
  const usage = deriveUsage(s, { date: TODAY });
  const recipeLines = s.tables.recipeLine.filter((r) => r.menuId === menuId).map((r) => {
    const item = s.tables.inventoryItem.find((i) => i.itemId === r.itemId);
    // A real recipe line can arrive before its ingredient table (REAL-PLAN F01 → F03): keep the line, in the recipe's own unit, without a cost.
    if (!item) return { ...r, name: { key: 'data.state.inventory-booking.partial-data' }, nameKey: 'data.state.inventory-booking.partial-data', inventoryUnit: r.unit, cost: null, usedToday: fromBase(usage.byMenu[menuId]?.[r.itemId] ?? 0, r.unit) };
    const purchase = s.tables.purchaseItem.find((p) => p.itemId === r.itemId);
    const cost = purchase && unitDimension(r.unit) === unitDimension(item.unit) ? (purchase.basePerUnit ? (toBase(r.quantity, r.unit) ?? 0) / purchase.basePerUnit : fromBase(toBase(r.quantity, r.unit) ?? 0, item.unit)) * purchase.unitPrice : null;
    return { ...r, name: item.name ?? { key: item.nameKey }, nameKey: item.nameKey, inventoryUnit: item.unit, cost, usedToday: fromBase(usage.byMenu[menuId]?.[r.itemId] ?? 0, item.unit) };
  });
  const retailCost = s.tables.paymentLine.find((l) => l.menuId === menuId)?.unitCostAtSale ?? null;
  const cost = menu.sourceCost ? menu.sourceCost.unitCost === null ? null : Math.round(menu.sourceCost.unitCost) : menu.kind === 'retail' ? retailCost : menu.deletedAt && !recipeLines.length && menu.recipe.length ? Math.round(menu.recipe.reduce((n, p) => n + p.cost, 0)) : recipeLines.length && recipeLines.every((r) => r.cost !== null) ? Math.round(recipeLines.reduce((n, r) => n + (r.cost ?? 0), 0)) : null;
  return { menuId, cost, margin: cost === null ? null : menu.price - cost, rate: cost === null ? null : roundRate(menu.price - cost, menu.price), soldQty: usage.soldQty[menuId] ?? 0, recipeLines };
});
function receivedBase(s: DataSnapshot, itemId: string, date: string): number {
  const item = s.tables.inventoryItem.find((i) => i.itemId === itemId)!;
  return s.tables.receipt.filter((r) => dateOf(r.receivedAt) === date).reduce((n, r) => {
    const line = s.tables.purchaseOrderLine.find((l) => l.polId === r.polId);
    return n + (line?.itemId === itemId ? purchaseQuantityBase(r.qty, line.unitSnapshot ?? item.unit, line.basePerUnit) ?? 0 : 0);
  }, 0);
}
function openingBase(s: DataSnapshot, itemId: string, date: string): number {
  const opening = s.tables.stockOpening.find((o) => o.itemId === itemId && o.businessDate === date);
  if (opening) return opening.quantityBase;
  const today = s.tables.stockOpening.find((o) => o.itemId === itemId && o.businessDate === TODAY)?.quantityBase ?? 0;
  // Fixed seven-day example history. Previous sales aggregates are not a stock ledger.
  if (date < TODAY) return today - dateRange(date, addDays(TODAY, -1)).reduce((n, d) => n + receivedBase(s, itemId, d), 0);
  return 0;
}
export const deriveStock = memoSelector((q: { readonly date: string }) => q.date, (s, q) => {
  requireDate(q.date);
  if (s.tables.realStock !== undefined) {
    const source = realStock(s);
    const date = q.date === TODAY ? source?.businessDate : q.date;
    const rows = s.tables.inventoryItem.filter(item => item.kind === 'ingredient' && !item.deletedAt).map(item => {
      const record = source?.items.find(row => row.itemId === item.itemId && row.businessDate === date);
      const metrics = stockMetrics(source, record);
      const receivedBase = source?.movementsComplete ? source.movements.filter(row => row.itemId === item.itemId && row.businessDate === date && row.channel === 'store' && row.kind === 'receive')
        .reduce((sum, row) => sum + (baseQuantity(row.deltaBase) ?? 0), 0) : 0;
      const tracksReplenishment = item.trackRestock && !(item.trackExpiry && item.expiresOn && date && item.expiresOn <= date);
      const projectedRaw = metrics.raw - metrics.expectedUsageRemaining;
      const projectedDeficit = tracksReplenishment && metrics.stock !== null ? Math.max(0, -projectedRaw) : 0;
      const needsRestock = tracksReplenishment && metrics.stock !== null && item.restockThreshold !== null && metrics.stock <= item.restockThreshold;
      const outOfStock = tracksReplenishment && metrics.stock === 0;
      const status = item.trackExpiry ? 'same-day' : outOfStock ? 'out-of-stock' : needsRestock ? 'restock' : 'sufficient';
      return { ...item, ...metrics, stock: metrics.display, tracksReplenishment, receivedToday: fromBase(receivedBase, item.unit), projectedRaw, projectedDeficit, needsRestock, outOfStock, status,
        usingMenus: s.tables.recipeLine.filter(r => r.itemId === item.itemId).map(r => ({ menuId: r.menuId, name: s.tables.menuItem.find(m => m.menuId === r.menuId)?.name, quantity: r.quantity, unit: r.unit })) };
    });
    return { rows, restockCount: rows.filter(r => r.needsRestock).length, outOfStockCount: rows.filter(r => r.outOfStock).length, usingMenus: rows.map(r => ({ itemId: r.itemId, menus: r.usingMenus })) };
  }
  const usage = deriveUsage(s, q);
  const remainingUsage = s.pos ? projectPosRemainingUsage(s.pos, s.tables, q.date) : {};
  const rows = s.tables.inventoryItem.filter((i) => i.kind === 'ingredient' && !i.deletedAt).map((item) => {
    const opening = openingBase(s, item.itemId, q.date), used = usage.byItem[item.itemId] ?? 0;
    const received = receivedBase(s, item.itemId, q.date);
    const adjustment = s.tables.stockAdjustment.filter((a) => a.itemId === item.itemId && dateOf(a.at) === q.date).reduce((n, a) => n + a.deltaBase, 0);
    const rawBase = opening + received - used + adjustment;
    const raw = fromBase(rawBase, item.unit), display = Math.max(0, raw), deficit = Math.max(0, -raw);
    const remainingBase = remainingUsage[item.itemId] ?? 0;
    const expectedUsageRemaining = fromBase(remainingBase, item.unit);
    const projectedRaw = fromBase(rawBase - remainingBase, item.unit);
    const tracksReplenishment = item.trackRestock && !(item.trackExpiry && item.expiresOn === q.date);
    const projectedDeficit = tracksReplenishment ? Math.max(0, -projectedRaw) : 0;
    const needsRestock = tracksReplenishment && item.restockThreshold !== null && display <= item.restockThreshold;
    const outOfStock = tracksReplenishment && display === 0;
    const status = item.trackExpiry ? 'same-day' : outOfStock ? 'out-of-stock' : needsRestock ? 'restock' : 'sufficient';
    return { ...item, tracksReplenishment, opening: fromBase(opening, item.unit), rawBase, raw, display, stock: display, deficit, usedToday: fromBase(used, item.unit), receivedToday: fromBase(received, item.unit), expectedUsageRemaining, projectedRaw, projectedDeficit, needsRestock, outOfStock, status,
      usingMenus: s.tables.recipeLine.filter((r) => r.itemId === item.itemId).map((r) => ({ menuId: r.menuId, name: s.tables.menuItem.find((m) => m.menuId === r.menuId)?.name, quantity: r.quantity, unit: r.unit })) };
  });
  return { rows, restockCount: rows.filter((r) => r.needsRestock).length, outOfStockCount: rows.filter((r) => r.outOfStock).length, usingMenus: rows.map((r) => ({ itemId: r.itemId, menus: r.usingMenus })) };
});
export interface StockHistoryRow { readonly rowId: string; readonly itemId: string; readonly at: string; readonly asOf?: string; readonly kind: 'opening' | 'receive' | 'usage' | 'adjust'; readonly delta: number; readonly balanceRaw: number; readonly balanceDisplay: number; readonly sourceRef: string; readonly description: DataText }
export const selectStockHistory = memoSelector((q: { readonly itemId: string; readonly period: 'today' | 'last7days' }) => `${q.itemId}:${q.period}`, (s, q) => {
  if (s.tables.realStock !== undefined) return projectRealStockHistory(realStock(s), q.itemId, q.period);
  const item = s.tables.inventoryItem.find((i) => i.itemId === q.itemId);
  if (!item) throw new DataQueryError('NOT_FOUND', 'itemId');
  const dates = q.period === 'today' ? [TODAY] : dateRange(addDays(TODAY, -6), TODAY).reverse();
  const dayGroups = dates.map((date) => {
    let balance = openingBase(s, item.itemId, date);
    const opening = fromBase(balance, item.unit);
    const rows: StockHistoryRow[] = [{ rowId: `opening:${date}:${q.itemId}`, itemId: q.itemId, at: `${date}T05:00`, kind: 'opening', delta: opening, balanceRaw: opening, balanceDisplay: Math.max(0, opening), sourceRef: q.itemId, description: { key: 'data.management.history.opening' } }];
    const append = (row: Omit<StockHistoryRow, 'itemId' | 'delta' | 'balanceRaw' | 'balanceDisplay'>, deltaBase: number) => {
      balance += deltaBase;
      rows.push({ ...row, itemId: q.itemId, delta: fromBase(deltaBase, item.unit), balanceRaw: fromBase(balance, item.unit), balanceDisplay: Math.max(0, fromBase(balance, item.unit)) });
    };
    for (const u of deriveUsage(s, { date }).usageRows.filter((u) => u.itemId === item.itemId)) append({ rowId: u.rowId, at: `${date}T${u.asOf}`, asOf: u.asOf, kind: 'usage', sourceRef: u.menuId, description: { key: 'data.management.history.usage', params: { count: u.soldQty }, keyParams: { menu: s.tables.menuItem.find((m) => m.menuId === u.menuId)?.nameKey ?? '' } } }, -u.quantityBase);
    const changes = [
      ...s.tables.receipt.filter((r) => dateOf(r.receivedAt) === date).flatMap((r) => {
        const line = s.tables.purchaseOrderLine.find((l) => l.polId === r.polId && l.itemId === q.itemId);
        return line ? [{ rowId: `receipt:${r.receiptId}`, at: r.receivedAt, seq: r.seq ?? 0, kind: 'receive' as const, sourceRef: r.receiptId, deltaBase: purchaseQuantityBase(r.qty, line.unitSnapshot ?? item.unit, line.basePerUnit) ?? 0, description: { key: 'data.management.history.receiveFrom', keyParams: { supplier: s.tables.supplier.find((supplier) => supplier.supplierId === s.tables.purchaseOrder.find((po) => po.poId === line.poId)?.supplierId)?.nameKey ?? '' } } }] : [];
      }),
      ...s.tables.stockAdjustment.filter((a) => a.itemId === q.itemId && dateOf(a.at) === date).map((a) => ({ rowId: a.adjustmentId, at: a.at, seq: a.seq, kind: 'adjust' as const, sourceRef: a.adjustmentId, deltaBase: a.deltaBase, description: { key: a.reason === 'initial' ? 'data.management.history.initial' : 'data.management.history.adjust' } })),
    ].sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq || a.rowId.localeCompare(b.rowId));
    for (const c of changes) append(c, c.deltaBase);
    return { date, opening, rows, endingRaw: fromBase(balance, item.unit), endingDisplay: Math.max(0, fromBase(balance, item.unit)) };
  });
  return { itemId: q.itemId, unit: item.unit, dayGroups };
});
export const deriveOpenOrders = memoSelector((q: { readonly date: string }) => q.date, (s, q) => {
  requireDate(q.date);
  const orders = s.tables.purchaseOrder.filter((o) => !o.variant).map((po) => {
    const supplier = s.tables.supplier.find((p) => p.supplierId === po.supplierId);
    const lines = s.tables.purchaseOrderLine.filter((l) => l.poId === po.poId).map((l) => {
      const item = s.tables.inventoryItem.find((i) => i.itemId === l.itemId);
      const receipts = s.tables.receipt.filter((r) => r.polId === l.polId);
      const received = receipts.reduce((n, r) => n + r.qty, 0);
      return { ...l, itemName: l.itemNameSnapshot ?? item?.name, itemNameKey: item?.nameKey ?? '', unit: l.unitSnapshot ?? item?.unit ?? 'pcs', ordered: l.qtyOrdered, received, remaining: Math.max(0, l.qtyOrdered - received), receipts };
    });
    const open = ['scheduled', 'partial'].includes(po.status) && lines.some((l) => l.remaining > 0);
    return { ...po, supplierNameKey: supplier?.nameKey ?? '', supplierName: supplier?.name, phoneMask: supplier?.phoneMask ?? '', contactKey: supplier?.contactKey ?? '', lines, open, overdue: open && po.dueDate !== null && po.dueDate < q.date, total: lines.reduce((n, l) => n + l.qtyOrdered * l.unitPrice, 0) };
  }).sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.poId.localeCompare(b.poId));
  return { orders, open: orders.filter((o) => o.open), recentReceipts: [...s.tables.receipt].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), monthCount: orders.filter((o) => o.orderedOn?.slice(0, 7) === q.date.slice(0, 7)).length, monthTotal: orders.filter((o) => o.orderedOn?.slice(0, 7) === q.date.slice(0, 7)).reduce((n, o) => n + o.total, 0) };
});
export const deriveSuggestions = memoSelector((q: { readonly date: string }) => q.date, (s, q) => {
  const open = deriveOpenOrders(s, q).open;
  return deriveStock(s, q).rows.flatMap((r) => {
    const forecastShortage = r.expectedUsageRemaining > 0 && r.projectedDeficit > 0;
    if (!r.needsRestock && !forecastShortage) return [];
    if (open.some(o => o.lines.some(l => l.itemId === r.itemId && l.remaining > 0))) return [];
    const p = s.tables.purchaseItem.find((p) => p.itemId === r.itemId);
    if (!p) return [];
    const balance = r.expectedUsageRemaining > 0 ? r.projectedRaw : r.display;
    const shortage = 2 * (r.restockThreshold ?? 0) - balance;
    const inPurchaseUnits = p.basePerUnit ? (toBase(shortage, r.unit) ?? 0) / p.basePerUnit : shortage;
    const qty = Math.ceil(Math.max(p.minimumQty, inPurchaseUnits) / p.orderStep) * p.orderStep;
    return [{ itemId: r.itemId, purchaseItemId: p.purchaseItemId, supplierId: p.supplierId, qty, total: Math.round(qty * p.unitPrice), dueDate: addDays(q.date, p.leadDays), unit: p.purchaseUnit ?? r.unit }];
  });
});
