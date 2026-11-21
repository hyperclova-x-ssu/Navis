/** GD-1: the 재고·발주 forms show the handler's refusal at the field, and a look-alike order asks before it is saved. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { inventoryWidget } from './inventory';
import { suppliersWidget } from './suppliers';
import { createTestHost } from './testing';
import { BEANS, MILK, itemOf, placeOrder, purchaseOf, shortDate } from './testing-cafe';
import { TODAY } from '../../../data/widget-data';

afterEach(cleanup);
// The order grid holds the cafe's 128 past orders, so these screens take longer than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

it('a new ingredient with a name that already exists is refused with 이미 같은 이름이 있어요 and nothing is saved', () => {
  const store = createWidgetDataStore(), Detail = inventoryWidget.Detail!;
  const milkName = (itemOf(store.getSnapshot().tables, MILK).name as { raw: string }).raw;
  renderWithKit(<Detail featureId="inventory-booking" condition={{ kind: 'default' }} detailRef={{ featureId: 'inventory-booking', view: 'register' }} host={createTestHost('inventory-booking')} />, { store });
  fireEvent.change(screen.getByLabelText('코드(SKU)'), { target: { value: 'RM-GD1' } });
  // the same name with other spacing is the same name
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: ` ${milkName.replace(/ /g, '  ')} ` } });
  fireEvent.change(screen.getByLabelText('처음 수량'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('안전 재고'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  expect(store.getSnapshot().revision).toBe(0);
  expect(screen.getByRole('alert')).toHaveTextContent('이미 같은 이름이 있어요');
});

it('a look-alike order asks first and is saved only after 그래도 발주하기', () => {
  const store = createWidgetDataStore(), Detail = suppliersWidget.Detail!;
  renderWithKit(<Detail featureId="suppliers" condition={{ kind: 'default' }} detailRef={{ featureId: 'suppliers' }} host={createTestHost('suppliers')} />, { store });
  fireEvent.click(screen.getByRole('tab', { name: '발주 내역' }));
  const orders = () => store.getSnapshot().tables.purchaseOrder.length;
  const beans = purchaseOf(store.getSnapshot().tables, BEANS);
  const place = () => {
    fireEvent.click(screen.getByRole('button', { name: '발주 추가하기' }));
    const form = screen.getByRole('form', { name: '발주 추가하기' });
    fireEvent.change(within(form).getByLabelText('발주 품목'), { target: { value: beans.purchaseItemId } });
    fireEvent.change(within(form).getByRole('spinbutton', { name: '주문 수량' }), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: '저장하기' }));
    return form;
  };
  const before = orders();
  place();
  expect(orders()).toBe(before + 1);
  const form = place();
  expect(orders()).toBe(before + 1);
  expect(within(form).getByRole('alert')).toHaveTextContent('비슷한 발주가 이미 있어요');
  fireEvent.click(within(form).getByRole('button', { name: '그래도 발주하기' }));
  expect(orders()).toBe(before + 2);
});

it('an arrival day before the business date is refused in the 입고 예정일 popover', () => {
  const store = createWidgetDataStore(), Detail = suppliersWidget.Detail!;
  placeOrder(store, MILK, 12, TODAY);
  const milkName = (itemOf(store.getSnapshot().tables, MILK).name as { raw: string }).raw;
  renderWithKit(<Detail featureId="suppliers" condition={{ kind: 'default' }} detailRef={{ featureId: 'suppliers' }} host={createTestHost('suppliers')} />, { store });
  const before = store.getSnapshot().tables.purchaseOrder.map((p) => p.dueDate);
  const change = screen.getByRole('button', { name: `${milkName} 입고 예정일 바꾸기` });
  expect(change).toHaveTextContent(shortDate(TODAY));
  fireEvent.click(change);
  const previous = screen.getAllByRole('button', { name: /이전/ })[0];
  for (let i = 0; i < 12; i++) fireEvent.click(previous);
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  expect(screen.getByRole('alert')).toHaveTextContent('예정일을 영업일 이후로 골라 주세요');
  expect(store.getSnapshot().tables.purchaseOrder.map((p) => p.dueDate)).toEqual(before);
});
