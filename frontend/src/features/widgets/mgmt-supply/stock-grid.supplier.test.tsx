import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailStack } from './testing';
import { BEANS, itemOf, placeOrder, purchaseOf } from './testing-cafe';
import { addIsoDays } from './shared';

afterEach(cleanup);
// The cafe seed holds 26 ingredients, so a screen that opens the grid takes longer than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const raw = (value: unknown) => (value as { raw: string }).raw;

function openStockDetail(store: ReturnType<typeof createWidgetDataStore>) {
  renderWithKit(<DetailStack root={{ featureId: 'inventory-booking' }} />, { store });
  const grid = within(screen.getByRole('grid', { name: '재료' }));
  fireEvent.click(grid.getByRole('button', { name: `${raw(itemOf(store.getSnapshot().tables, BEANS).name)} 재고 변동 기록` }));
  return grid;
}

it('fixture mode: the expanded next-delivery link keeps the seeded supplier name', () => {
  const store = createWidgetDataStore();
  placeOrder(store, BEANS, 5, addIsoDays(TODAY, 1));
  const { supplierId } = purchaseOf(store.getSnapshot().tables, BEANS);
  const seeded = raw(store.getSnapshot().tables.supplier.find(s => s.supplierId === supplierId)!.name);
  const grid = openStockDetail(store);
  expect(grid.getByRole('button', { name: `5 kg · ${seeded}` })).toBeInTheDocument();
});

it('real mode: the expanded next-delivery link shows the real supplierName when there is no message key', () => {
  const base = createWidgetDataStore().getSnapshot().tables;
  const { supplierId } = purchaseOf(base, BEANS);
  const real = '서울 원두 상회';
  // A real DTO supplier has its own words (`name`) and no seed message key.
  const store = createWidgetDataStore({ supplier: base.supplier.map(s => (s.supplierId === supplierId ? { ...s, nameKey: '', name: { raw: real } } : s)) });
  placeOrder(store, BEANS, 5, addIsoDays(TODAY, 1));
  const grid = openStockDetail(store);
  expect(grid.getByRole('button', { name: `5 kg · ${real}` })).toBeInTheDocument();
});
