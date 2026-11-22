// D-333 (LARGE-CARDS-1): a large card shows more of the real data when it exists, and never invents rows when it does not.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan } from '../../../contracts';
import { createWidgetDataStore, deriveOpenOrders, readModel, TODAY } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { SupplyPanel, createTestHost } from './testing';
import { MILK, shortage, withRetail } from './testing-cafe';

afterEach(cleanup);
vi.setConfig({ testTimeout: 60_000 });

type Store = ReturnType<typeof createWidgetDataStore>;
const panel = (id: 'inventory-booking' | 'suppliers', width: CellSpan, height: CellSpan, store: Store) =>
  renderWithKit(<SupplyPanel id={id} width={width} height={height} host={createTestHost(id)} />, { store });
const bodyRows = (name: string) => [...screen.getByRole('table', { name }).querySelectorAll('tbody tr')];
/** The same store with fewer rows in one table (what a small café would hold). */
const trimmed = <K extends string>(store: Store, table: K, keep: number): Store => {
  const snapshot = store.getSnapshot();
  const tables = snapshot.tables as unknown as Record<string, readonly unknown[]>;
  // one stable snapshot object: a new object per call would loop useSyncExternalStore
  const next = { ...snapshot, tables: { ...tables, [table]: tables[table]!.slice(0, keep) } };
  return { ...store, getSnapshot: () => next } as unknown as Store;
};

describe('재고 4×4 (D-333)', () => {
  it('lists more of the ingredients the data has than the 5 rows of a short card', () => {
    const store = createWidgetDataStore();
    const have = readModel(store.getSnapshot(), 'inventory-booking').ingredients.length;
    expect(have).toBeGreaterThan(8);
    panel('inventory-booking', 4, 4, store);
    expect(bodyRows('원자재').length).toBeGreaterThan(5);
    expect(bodyRows('원자재').length).toBeLessThanOrEqual(have);
    cleanup();
    panel('inventory-booking', 4, 2, store);
    expect(bodyRows('원자재')).toHaveLength(5);
  });
  it('shows only the rows the data has when there are few ingredients', () => {
    const store = trimmed(createWidgetDataStore(), 'inventoryItem', 3);
    panel('inventory-booking', 4, 4, store);
    expect(bodyRows('원자재')).toHaveLength(readModel(store.getSnapshot(), 'inventory-booking').ingredients.length);
    expect(bodyRows('원자재').length).toBeLessThanOrEqual(3);
  });
  it('re-shows the nearest incoming delivery line only when an order is open', () => {
    const staged = shortage(withRetail().store).store;
    panel('inventory-booking', 4, 4, staged);
    expect(document.querySelector('[data-widget="inventory-booking"]')).toHaveTextContent('목장 1등급 우유 · 입고 예정 12L · 오늘');
    cleanup();
    panel('inventory-booking', 4, 4, createWidgetDataStore());
    expect(document.querySelector('[data-widget="inventory-booking"]')).not.toHaveTextContent('입고 예정');
    cleanup();
    panel('inventory-booking', 4, 2, staged);
    expect(document.querySelector('[data-widget="inventory-booking"]')).not.toHaveTextContent('오늘 12L 입고 예정');
  });
  it('keeps the stock rows in the order of the data (shortage first)', () => {
    const staged = shortage(withRetail().store).store;
    panel('inventory-booking', 4, 4, staged);
    const first = bodyRows('원자재')[0]!;
    expect(first).toHaveTextContent('품절');
    expect(first).toHaveTextContent(String((staged.getSnapshot().tables.inventoryItem.find((i) => i.itemId === MILK)!.name as { raw: string }).raw));
  });
});

describe('발주 4×4 (D-333)', () => {
  it('lists more orders than 5 and re-shows the supplier column', () => {
    const store = createWidgetDataStore();
    const orders = deriveOpenOrders(store.getSnapshot(), { date: TODAY }).orders;
    expect(orders.length).toBeGreaterThan(8);
    panel('suppliers', 4, 4, store);
    const table = screen.getByRole('table', { name: '발주 내역' });
    expect(within(table).getByRole('columnheader', { name: '발주사' })).toBeInTheDocument();
    expect(bodyRows('발주 내역').length).toBeGreaterThan(5);
    expect(bodyRows('발주 내역').length).toBeLessThanOrEqual(orders.length);
  });
  it('writes each row\'s own supplier from its order, and 4×2 stays as before (5 rows)', () => {
    const store = createWidgetDataStore();
    const t = store.getSnapshot().tables;
    const orders = [...deriveOpenOrders(store.getSnapshot(), { date: TODAY }).orders];
    panel('suppliers', 4, 4, store);
    const supplierName = (supplierId: string) => (t.supplier.find((s) => s.supplierId === supplierId)!.name as { raw: string }).raw;
    const rows = bodyRows('발주 내역');
    expect(rows[0]!.querySelectorAll('td')).toHaveLength(6);
    // every shown row carries the supplier of one of the shown orders
    const suppliers = new Set(orders.map((o) => supplierName(o.supplierId)));
    for (const row of rows) expect(suppliers.has(row.querySelectorAll('td')[2]!.textContent!)).toBe(true);
    cleanup();
    panel('suppliers', 4, 2, store);
    expect(bodyRows('발주 내역')).toHaveLength(5);
    expect(within(screen.getByRole('table', { name: '발주 내역' })).queryByRole('columnheader', { name: '발주사' })).toBeNull();
  });
  it('shows only the orders the data has', () => {
    const store = trimmed(createWidgetDataStore(), 'purchaseOrder', 2);
    const have = deriveOpenOrders(store.getSnapshot(), { date: TODAY }).orders.length;
    expect(have).toBeLessThanOrEqual(2);
    panel('suppliers', 4, 4, store);
    expect(bodyRows('발주 내역')).toHaveLength(have);
  });
});

/** The fit guard with a fake layout: the panel box is `rows` table rows high, every visible row is 64 high. */
function fitRowsTo(id: 'inventory-booking' | 'suppliers', allowed: number) {
  let measure: () => void = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { measure = cb; } observe() {} disconnect() {} });
  panel(id, 4, 4, createWidgetDataStore());
  const root = document.querySelector<HTMLElement>('.ms-panel')!;
  const table = screen.getByRole('table', { name: id === 'suppliers' ? '발주 내역' : '원자재' });
  Object.defineProperties(root, {
    clientWidth: { get: () => 5000 }, clientHeight: { get: () => 100 + allowed * 64 }, scrollWidth: { get: () => 100 },
    scrollHeight: { get: () => 100 + [...table.querySelectorAll('tbody tr')].filter((r) => !(r as HTMLElement).hidden).length * 64 },
  });
  act(() => measure());
  return [...table.querySelectorAll<HTMLElement>('tbody tr')].map((r) => !r.hidden);
}

describe('큰 카드의 덤 행은 맨 먼저 숨는다 (D-333)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['inventory-booking', 'suppliers'] as const)('%s: when the room is short, the rows past the 5 of the short card go first and those 5 stay', (id) => {
    const visible = fitRowsTo(id, 7);
    expect(visible.length).toBeGreaterThan(7);
    expect(visible.slice(0, 5).every(Boolean)).toBe(true);
    expect(visible.filter(Boolean)).toHaveLength(7);
    cleanup();
    const five = fitRowsTo(id, 5);
    expect(five.filter(Boolean)).toHaveLength(5);
    expect(five.slice(0, 5).every(Boolean)).toBe(true);
  });
});
