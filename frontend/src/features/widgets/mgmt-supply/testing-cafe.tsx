/**
 * Test-only helpers for the mgmt-supply tests on the 안숭잘부 카페 seed (D-312/D-313): the demo day is TODAY (2026-11-17 화 15:45),
 * the DB holds 26 ingredients, 5 suppliers and 128 completed orders, but no order is open, nothing needs restocking and there is no
 * retail product. A test that needs such a state builds it with the same commands the screens dispatch (or with explicit table fixtures
 * when no command exists), and reads the expected values from the same selectors the widgets use.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWidgetDataStore, TODAY, type WidgetDataStore } from '../../../data/widget-data';
import type { DataTables } from '../../../data/widget-data';
import { addIsoDays } from './shared';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
/** `10월 26일 월요일`: the DateField day name (DS 6.1 long date). */
export const longDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}월 ${d}일 ${WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]}요일`;
};
/** `10/26(월)`: the short date of tables and rows. */
export const shortDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]})`;
};

/** Opens a kit DateField (named `<label> <long date>`) inside `scope`, pages the calendar to the month of `iso` and picks that day. */
export async function pickDate(scope: ReturnType<typeof within> | typeof screen, label: string, iso: string): Promise<void> {
  const field = scope.getByRole('button', { name: new RegExp(`^${label} `) });
  await userEvent.click(field);
  const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
  const [y, m] = iso.split('-').map(Number);
  const target = `${y}년 ${m}월`;
  for (let guard = 0; guard < 36 && !within(dialog).queryByRole('grid', { name: target }); guard += 1) {
    const shown = within(dialog).getByRole('grid').getAttribute('aria-labelledby');
    const title = shown ? document.getElementById(shown)!.textContent!.match(/(\d+)년 (\d+)월/) : null;
    const later = title ? Number(title[1]) * 12 + Number(title[2]) < y! * 12 + m! : true;
    await userEvent.click(within(dialog).getByRole('button', { name: later ? '다음 달' : '이전 달' }));
  }
  await userEvent.click(within(dialog).getByRole('button', { name: longDate(iso) }));
}

export const PAST_DAY = addIsoDays(TODAY, -7);
export const LATER_DAY = addIsoDays(TODAY, 3);
/** The direct event of the cafe sample calendar that is on today's list (16:30). */
export const SAMPLE_EVENT = { eventId: 'sample-calendar-1', title: '쇼케이스 진열 수량 확인', time: '16:30' } as const;

export const MILK = 'i-milk';
export const BEANS = 'i-bean-house';
export const CUPS = 'i-cup-takeout';

type Tables = DataTables;
export const purchaseOf = (tables: Tables, itemId: string) => tables.purchaseItem.find((p) => p.itemId === itemId)!;
export const itemOf = (tables: Tables, itemId: string) => tables.inventoryItem.find((i) => i.itemId === itemId)!;

let seq = 0;
const key = (p: string) => `${p}:test-${(seq += 1)}`;

/** Puts one open order for `itemId` on the books (the order screen's own command). */
export function placeOrder(store: WidgetDataStore, itemId: string, qty: number, dueDate: string = TODAY): string {
  const purchase = purchaseOf(store.getSnapshot().tables, itemId);
  const result = store.dispatch({ type: 'suppliers.createOrder', purchaseItemId: purchase.purchaseItemId, qty, dueDate, idempotencyKey: key('po'), confirmDuplicate: true });
  if (!result.ok) throw new Error(`createOrder refused: ${result.reason ?? result.code}`);
  return (result.value as { poId: string }).poId;
}
/** Sets the counted stock of an ingredient in its own unit (the 재고 grid's own command). */
export function setStock(store: WidgetDataStore, itemId: string, stock: number): void {
  const result = store.dispatch({ type: 'inventory.updateItem', itemId, stock });
  if (!result.ok) throw new Error(`updateItem refused: ${result.reason ?? result.code}`);
}
/**
 * The classic shortage of the screens: milk is counted out (0 mL, below its safe stock) and 12 L of it is on order for today.
 * Returns the order id, so a test can open that order.
 */
export function shortMilk(store: WidgetDataStore = createWidgetDataStore(), qty = 12): { store: WidgetDataStore; poId: string } {
  setStock(store, MILK, 0);
  return { store, poId: placeOrder(store, MILK, qty, TODAY) };
}

export const OVERDUE_PO = 'po-overdue';
/**
 * A week of orders on the cafe seed: milk 12 L today, beans 5 kg tomorrow, cups 500 in two days (the order screen's own command) and one
 * order that was due yesterday and is still open (a table fixture: the command refuses a past arrival day).
 */
export function supplyWeek(): { store: WidgetDataStore; milk: string; beans: string; cups: string; overdue: string } {
  const base = createWidgetDataStore().getSnapshot().tables;
  const store = createWidgetDataStore({
    purchaseOrder: [...base.purchaseOrder, { poId: OVERDUE_PO, supplierId: 's-bakery', orderedOn: addIsoDays(TODAY, -4), dueDate: addIsoDays(TODAY, -1), expectedTime: null, status: 'scheduled', variant: null }],
    purchaseOrderLine: [...base.purchaseOrderLine, { polId: 'pol-overdue', poId: OVERDUE_PO, itemId: 'i-bagel-plain', qtyOrdered: 24, unitPrice: 1200, unitSnapshot: 'pcs', basePerUnit: 1, itemNameSnapshot: { raw: '구운 플레인 베이글' } }],
  });
  return { store, milk: placeOrder(store, MILK, 12, TODAY), beans: placeOrder(store, BEANS, 5, addIsoDays(TODAY, 1)), cups: placeOrder(store, CUPS, 500, addIsoDays(TODAY, 2)), overdue: OVERDUE_PO };
}

/** Two retail products with store and online stock (the cafe DB has no retail item; this is an explicit fixture for the 판매 상품 tab). */
export function withRetail(): { store: WidgetDataStore; ids: readonly string[] } {
  const base = createWidgetDataStore().getSnapshot().tables;
  const make = (itemId: string, name: string, sku: string, inStore: number, online: number, sold: { store: number; online: number }, low: number) => ({
    item: { itemId, nameKey: `seed:${name}`, name: { raw: name }, sku, kind: 'retail' as const, unit: 'pcs' as const, restockThreshold: null, trackRestock: false, lowStockPerChannel: low, sales7d: sold, updatedAt: '2026-11-17T00:00:00', trackExpiry: false, expiresOn: null },
    stock: [{ itemId, channel: 'store' as const, qty: inStore }, { itemId, channel: 'online' as const, qty: online }],
  });
  const a = make('it-beans200', '원두 200g', 'PD-001', 120, 40, { store: 38, online: 14 }, 30), b = make('it-dripbag', '드립백 세트', 'PD-002', 60, 28, { store: 26, online: 10 }, 30);
  const next = createWidgetDataStore({ inventoryItem: [...base.inventoryItem, a.item, b.item], inventoryStock: [...base.inventoryStock, ...a.stock, ...b.stock] });
  return { store: next, ids: [a.item.itemId, b.item.itemId] };
}
/** Milk out (12 L on order for today), beans and cups under their safe stock: 보충 필요 3, 품절 1. */
export function shortage(store: WidgetDataStore): { store: WidgetDataStore; poId: string } {
  const { poId } = shortMilk(store, 12);
  setStock(store, BEANS, 3000);
  setStock(store, CUPS, 400);
  return { store, poId };
}

export { fireEvent, screen, within };
