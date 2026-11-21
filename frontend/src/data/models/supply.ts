import type { DataSnapshot, DataTables } from '../db/types';
import { addDays, inRange, TODAY, YESTERDAY } from '../db/time';
import type { IncomingDelivery, IngredientRow, InventoryModel, OrderRow, ProductRow, SuppliersModel } from './types';
import { emptyView, note, ready, sum, type Projector } from './util';
import { deriveOpenOrders, deriveStock, deriveSuggestions } from '../derive/stock';
import { selectCalendar } from '../derive/operations';

/** Compatibility reader; joins use IDs and share the pure order derivation. */
export function orderRows(t: DataTables): OrderRow[] {
  return [...deriveOpenOrders({ revision: 0, seq: 0, tables: t }, { date: TODAY }).orders];
}
const isOpen = (o: OrderRow) => ['scheduled', 'partial'].includes(o.status) && o.lines.some((l) => l.remaining > 0);
const byDue = (a: OrderRow, b: OrderRow) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.poId.localeCompare(b.poId);
function withOverdueExample(snapshot: DataSnapshot): DataSnapshot {
  const t = snapshot.tables;
  const milk = t.purchaseItem.find(item => item.itemId === 'i-milk');
  if (!milk || !t.supplier.some(supplier => supplier.supplierId === milk.supplierId && !supplier.deletedAt)
    || !t.inventoryItem.some(item => item.itemId === milk.itemId && !item.deletedAt)) return snapshot;
  const poId = 'sample-overdue-milk';
  // Use the café's 12 L, 09:00 milk delivery scenario (PRD 2.4.7), due the day before demo today.
  return { ...snapshot, tables: { ...t,
    purchaseOrder: [...t.purchaseOrder, {
      poId, supplierId: milk.supplierId, orderedOn: addDays(YESTERDAY, -milk.leadDays),
      dueDate: YESTERDAY, expectedTime: '09:00', status: 'scheduled', variant: null,
    }],
    purchaseOrderLine: [...t.purchaseOrderLine, {
      polId: `line:${poId}`, poId, itemId: milk.itemId, qtyOrdered: 12, unitPrice: milk.unitPrice,
      unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit,
    }],
  } };
}
export const projectSuppliers: Projector<'suppliers'> = (ctx, condition, variant) => {
  const window = condition.kind === 'dateRange' ? { start: condition.start, end: condition.end } : { start: TODAY, end: addDays(TODAY, 6) };
  const actual = deriveOpenOrders(ctx.snapshot, { date: TODAY });
  const derived = variant === 'overdue' && !actual.open.some(order => order.overdue)
    ? deriveOpenOrders(withOverdueExample(ctx.snapshot), { date: TODAY }) : actual;
  const { orders, open } = derived;
  const upcoming = open.filter((o) => o.dueDate !== null && inRange(o.dueDate, window.start, window.end));
  const overdue = open.filter((o) => o.overdue), undated = open.filter((o) => o.dueDate === null);
  if (variant === 'no-upcoming') return emptyView('suppliers', variant, { upcomingCount: 0, overdueCount: overdue.length });
  const model: SuppliersModel = { window, upcomingCount: upcoming.length, overdueCount: overdue.length, undatedCount: undated.length, upcoming, overdue, undated, past: orders.filter((o) => !isOpen(o)).sort((a, b) => -byDue(a, b)), orders, suppliers: ctx.snapshot.tables.supplier.filter((s) => !s.deletedAt).map((supplier) => ({ supplierId: supplier.supplierId, nameKey: supplier.nameKey, name: supplier.name, phoneMask: supplier.phoneMask, contactKey: supplier.contactKey, contact: supplier.contact, memo: supplier.memo, deletedAt: supplier.deletedAt })), purchaseItems: ctx.snapshot.tables.purchaseItem, suggestions: deriveSuggestions(ctx.snapshot, { date: TODAY }), monthCount: derived.monthCount, monthTotal: derived.monthTotal };
  return ready('suppliers', condition, variant, model, variant === 'overdue' ? [note('suppliers', 'overdue', { count: overdue.length })] : undefined);
};
const stockOf = (t: DataTables, itemId: string, channel: 'store' | 'online') => t.inventoryStock.find((s) => s.itemId === itemId && s.channel === channel)?.qty ?? 0;
export const projectInventory: Projector<'inventory-booking'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables, derived = deriveStock(ctx.snapshot, { date: TODAY });
  const openOrders = deriveOpenOrders(ctx.snapshot, { date: TODAY }).open;
  const nextDelivery = (itemId: string): IncomingDelivery | null => {
    for (const o of openOrders) {
      const line = o.lines.find((l) => l.itemId === itemId && l.remaining > 0);
      if (line) return { poId: o.poId, polId: line.polId, date: o.dueDate, time: o.expectedTime, remaining: { value: line.remaining, unit: line.unit }, supplierNameKey: o.supplierNameKey };
    }
    return null;
  };
  const rows: IngredientRow[] = derived.rows.filter((r) => variant !== 'partial-data' || ['i-milk', 'i-bean-house', 'i-cup-takeout'].includes(r.itemId)).map((r) => {
    const stock = variant === 'no-restock' && r.needsRestock ? (r.restockThreshold ?? 0) * 2 + 1 : r.display;
    const threshold = variant === 'partial-zero' && ['i-milk', 'i-bean-house', 'i-cup-takeout'].includes(r.itemId) ? null : r.restockThreshold;
    const trackRestock = r.tracksReplenishment;
    return { ...r, stock, threshold, trackRestock, needsReview: trackRestock && threshold === null, needsRestock: trackRestock && threshold !== null && stock <= threshold, outOfStock: trackRestock && stock === 0, nextDelivery: nextDelivery(r.itemId) };
  });
  const ingredients = [...rows].sort((a, b) => Number(b.needsRestock) - Number(a.needsRestock) || Number(b.outOfStock) - Number(a.outOfStock) || (a.stock ?? 0) / (a.threshold || Infinity) - (b.stock ?? 0) / (b.threshold || Infinity) || a.itemId.localeCompare(b.itemId));
  const restockItems = ingredients.filter((r) => r.needsRestock);
  const items: ProductRow[] = variant === 'no-products' ? [] : t.inventoryItem.filter((i) => i.kind === 'retail' && !i.deletedAt).map((i) => {
    const store = stockOf(t, i.itemId, 'store'), online = stockOf(t, i.itemId, 'online'), low = i.lowStockPerChannel ?? 0, sales = i.sales7d ?? { store: 0, online: 0 };
    return { itemId: i.itemId, nameKey: i.nameKey, unit: i.unit, store, online, total: store + online, lowThreshold: low, lowChannels: (['store', 'online'] as const).filter((c) => (c === 'store' ? store : online) <= low), sales7d: { store: sales.store, online: sales.online, total: sales.store + sales.online } };
  });
  const model: InventoryModel = { asOf: TODAY, restockCount: restockItems.length, outOfStockCount: rows.filter((r) => r.outOfStock).length, ingredients, restockItems, reviewCount: rows.filter((r) => r.needsReview).length, products: { total: sum(items.map((p) => p.total)), byChannel: { store: sum(items.map((p) => p.store)), online: sum(items.map((p) => p.online)) }, items, lowCount: items.filter((p) => p.lowChannels.length > 0).length } };
  return ready('inventory-booking', condition, variant, model, variant !== 'normal' ? [note('inventory-booking', variant)] : undefined);
};
export const projectCalendar: Projector<'calendar'> = (ctx, condition, variant) => {
  const date = condition.kind === 'dateRange' ? condition.start : condition.kind === 'snapshot' ? condition.asOf : TODAY;
  return ready('calendar', condition, variant, selectCalendar(ctx.snapshot, { date, ...(condition.kind === 'dateRange' ? { start: condition.start, end: condition.end } : {}), sourceFailed: variant === 'source-failed' }), variant === 'source-failed' ? [note('calendar', 'source-failed')] : undefined);
};
