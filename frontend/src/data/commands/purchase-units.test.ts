import { expect, test } from 'vitest';
import { createWidgetDataStore } from '../db/store';
import { TODAY } from '../db/time';
import { deriveStock } from '../derive/stock';

test.each([
  { itemId: 'i-bean-house', unit: 'kg', baseUnit: 'g' },
  { itemId: 'i-milk', unit: 'L', baseUnit: 'mL' },
])('receiving 2 $unit adds 2,000 $baseUnit exactly once', ({ itemId, unit }) => {
  const store = createWidgetDataStore();
  const stock = () => deriveStock(store.getSnapshot(), { date: TODAY }).rows.find(row => row.itemId === itemId)!.rawBase;
  const before = stock();
  const purchaseItem = store.getSnapshot().tables.purchaseItem.find(row => row.itemId === itemId)!;
  const order = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: purchaseItem.purchaseItemId, qty: 2, idempotencyKey: 'order' });
  expect(order.ok).toBe(true);
  if (!order.ok) throw new Error(order.reason);
  const { polId } = order.value as { polId: string };
  expect(store.getSnapshot().tables.purchaseOrderLine.find(row => row.polId === polId)).toMatchObject({ unitSnapshot: unit, basePerUnit: 1000, qtyOrdered: 2 });
  const command = { type: 'suppliers.recordReceipt', polId, qty: 2, idempotencyKey: 'receipt' } as const;
  const receipt = store.dispatch(command);
  expect(receipt.ok).toBe(true);
  if (!receipt.ok) throw new Error(receipt.reason);
  expect(stock()).toBe(before + 2000);
  expect(store.dispatch(command)).toMatchObject({ ok: true, duplicate: true });
  expect(stock()).toBe(before + 2000);
  expect(store.undo(receipt.undoToken!)).toMatchObject({ ok: true });
  expect(stock()).toBe(before);
});
