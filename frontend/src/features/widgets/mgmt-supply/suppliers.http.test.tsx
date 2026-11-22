import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore, readModel, TODAY } from '../../../data/widget-data';
import { addDays } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { createKitTranslator } from '../../../ui';
import { suppliersDomain } from '../../assistant/domains/suppliers';
import { suppliersWidget } from './suppliers';
import { createTestHost } from './testing';

const suppliers = '/inventory/suppliers';
const items = '/inventory/purchase-items';
const orders = '/inventory/purchase-orders';
const receipts = `${orders}/po-1/receipts`;
const bulkReceipts = '/inventory/purchasing/receipts';
const asOf = `${TODAY}T07:00:00.000Z`;
const list = <T,>(items: readonly T[]) => ({ items, nextCursor: null, asOf, sourceRevision: 9 });
const supplier = { supplierId: 'supplier-1', name: 'HTTP 원두 상사', contact: '담당자', phoneMask: '010-****-1234', memo: '포장 단위 문의', revision: 2 };
const purchase = { purchaseItemId: 'terms-1', itemId: 'item-1', supplierId: supplier.supplierId, minimumQty: 2, orderStep: 1, unitPrice: 4500, leadDays: 1, purchaseUnit: 'kg', basePerUnit: 1000, revision: 3 };
const line = { polId: 'line-1', itemId: purchase.itemId, qtyOrdered: 4, received: 0, remaining: 4, unitPrice: 4500, itemNameSnapshot: 'HTTP 원두', unitSnapshot: 'kg', basePerUnit: 1000 };
const order = { poId: 'po-1', supplierId: supplier.supplierId, orderedOn: TODAY, dueDate: TODAY, expectedTime: null, status: 'scheduled', lines: [line], revision: 5 };
const receipt = { receiptId: 'receipt-1', polId: line.polId, qty: 2, receivedAt: asOf, businessDate: TODAY, amount: 9000, qtyRemaining: 2, voidedAt: null };
const commandReceipt = (resourceId: string, revision: number) => ({ resourceId, revision, receiptId: 'effect-1', affectedSources: ['purchase'], changed: true });

function setup(backend = fakeBackend()) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'purchase') });
  store.bindReal(port);
  const featureId = 'suppliers' as const;
  const host = createTestHost(featureId);
  const Detail = suppliersWidget.Detail!;
  return { backend, port, store, render: (selected = false) => renderWithKit(<Detail featureId={featureId} condition={{ kind: 'default' }}
    detailRef={selected ? { featureId, view: 'order', itemId: order.poId } : { featureId }} host={host} />, { store }) };
}

function serve(backend: ReturnType<typeof fakeBackend>) {
  backend.on('GET', suppliers, () => list([supplier]));
  backend.on('GET', items, () => list([purchase]));
  backend.on('GET', orders, () => list([order]));
  backend.on('GET', bulkReceipts, () => list([]));
}

afterEach(cleanup);

it('gives the send confirmation priority only while the approved message is being reviewed', async () => {
  const { backend, render } = setup();
  serve(backend);
  backend.on('GET', suppliers, () => list([{ ...supplier, phone: '010-0000-1234' }]));
  const path = `${orders}/${order.poId}/supplier-message`;
  backend.on('GET', path, () => ({ items: [] }));
  backend.on('POST', `${path}/preview`, () => ({ previewId: 'preview', inputHash: 'message', expectedRevision: order.revision,
    expiresAt: '2099-01-01', diff: { supplierName: supplier.name, targetHint: '••••1234', body: '발주 요청\nHTTP 원두 4 kg', scheduledAt: null } }));
  render(true);
  const record = await screen.findByRole('button', { name: '입고 기록하기' });
  expect(record).not.toHaveClass('ui-button--secondary');
  fireEvent.click(await screen.findByRole('button', { name: '발주사에 발주 보내기' }));
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  const confirmation = await screen.findByRole('region', { name: '발주 보내기' });
  expect(record).toHaveClass('ui-button--secondary');
  expect(within(confirmation).getByRole('button', { name: '발주 보내기' })).not.toHaveClass('ui-button--secondary');
  expect(backend.callsTo('POST', `${path}/confirm`)).toHaveLength(0);
  expect(backend.callsTo('POST', receipts)).toHaveLength(0);
  fireEvent.click(within(confirmation).getByRole('button', { name: '닫기' }));
  expect(record).not.toHaveClass('ui-button--secondary');
});

it('renders a partial receipt after the server confirms it and reads it in a fresh store', async () => {
  const { backend, store, render } = setup();
  serve(backend);
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  backend.on('POST', receipts, async () => {
    await responseReady;
    backend.on('GET', orders, () => list([{ ...order, status: 'partial', lines: [{ ...line, received: 2, remaining: 2 }], revision: 6 }]));
    backend.on('GET', bulkReceipts, () => list([receipt, { ...receipt, receiptId: 'voided', qty: 1, voidedAt: asOf }]));
    return commandReceipt(receipt.receiptId, 6);
  });
  render(true);
  const submit = await screen.findByRole('button', { name: '입고 기록하기' });
  const quantity = screen.getByRole('spinbutton');
  fireEvent.change(quantity, { target: { value: '2' } });
  fireEvent.blur(quantity);
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(backend.callsTo('POST', receipts)).toHaveLength(1));
  expect(backend.callsTo('POST', receipts)[0]?.body).toEqual({ polId: line.polId, qty: 2, expectedRevision: 5 });
  expect(backend.callsTo('POST', receipts)[0]?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/u);
  expect(screen.queryByText('일부 입고')).toBeNull();
  await act(async () => release());
  expect(await within(screen.getByRole('grid', { name: '발주 내역' })).findByRole('gridcell', { name: /발주 상태, 일부 입고/ })).toBeInTheDocument();
  expect(readModel(store.getSnapshot(), 'suppliers').orders[0]?.lines[0]).toMatchObject({ received: 2, remaining: 2 });
  const fresh = setup(backend);
  await fresh.port.load('purchase');
  expect(readModel(fresh.store.getSnapshot(), 'suppliers').orders[0]?.lines[0]).toMatchObject({ received: 2, remaining: 2 });
  expect(fresh.store.getSnapshot().tables.receipt.map(row => row.receiptId)).toEqual([receipt.receiptId]);
});

it('waits for a second cancel press and sends the order revision', async () => {
  const { backend, render } = setup();
  serve(backend);
  const route = `${orders}/${order.poId}/cancel`;
  backend.on('POST', route, () => commandReceipt(order.poId, 6));
  render(true);
  fireEvent.click(await screen.findByRole('button', { name: '발주 취소하기' }));
  expect(backend.callsTo('POST', route)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '발주 취소 확인' }));
  await waitFor(() => expect(backend.callsTo('POST', route).map(call => call.body)).toEqual([{ expectedRevision: 5, confirmed: true }]));
});

it('registers a supplier, terms, and order through the same command names', async () => {
  const { backend, port, store } = setup();
  serve(backend);
  backend.on('POST', suppliers, () => commandReceipt(supplier.supplierId, 2));
  backend.on('POST', items, () => commandReceipt(purchase.purchaseItemId, 3));
  backend.on('POST', orders, () => commandReceipt(order.poId, 5));
  await port.load('purchase');
  expect(await store.execute({ type: 'suppliers.createSupplier', name: supplier.name, contact: supplier.contact, phone: '010-0000-1234', memo: supplier.memo, idempotencyKey: 'new-supplier' })).toMatchObject({ ok: true });
  expect(await store.execute({ type: 'suppliers.createPurchaseItem', itemId: purchase.itemId, supplierId: supplier.supplierId, minimumQty: 2, unitPrice: 4500, orderStep: 1, leadDays: 1, idempotencyKey: 'new-terms' })).toMatchObject({ ok: true });
  expect(await store.execute({ type: 'suppliers.createOrder', purchaseItemId: purchase.purchaseItemId, qty: 4, dueDate: TODAY, idempotencyKey: 'new-order' })).toMatchObject({ ok: true });
  expect(backend.callsTo('POST', suppliers)[0]?.headers.get('Idempotency-Key')).toBe('new-supplier');
  expect(backend.callsTo('POST', items)[0]?.body).toMatchObject({ itemId: purchase.itemId, supplierId: supplier.supplierId, unitPrice: 4500 });
  expect(backend.callsTo('POST', orders)[0]?.body).toEqual({ purchaseItemId: purchase.purchaseItemId, qty: 4, dueDate: TODAY, expectedRevision: 3 });
});

it('clears purchasing tables after store authorization ends', async () => {
  const { backend, port, store } = setup();
  serve(backend);
  backend.on('GET', bulkReceipts, () => list([receipt]));
  await port.load('purchase');
  expect(store.getSnapshot().tables.purchaseOrderLine).toHaveLength(1);
  backend.on('GET', suppliers, () => reply(403, { code: 'FORBIDDEN', reason: 'STORE_FORBIDDEN' }));
  await port.retry('purchase');
  const { supplier, purchaseItem, purchaseOrder, purchaseOrderLine, receipt: receiptRows } = store.getSnapshot().tables;
  expect([supplier, purchaseItem, purchaseOrder, purchaseOrderLine, receiptRows]).toEqual([[], [], [], [], []]);
});

it('uses the operating date of a receipt in Navis history', async () => {
  const { backend, port, store } = setup();
  serve(backend);
  backend.on('GET', bulkReceipts, () => list([{ ...receipt, receivedAt: `${addDays(TODAY, -1)}T22:30:00Z` }]));
  await port.load('purchase');
  const reader = suppliersDomain.reads.find(row => row.kind === 'purchaseOrder')!;
  const query = { snapshot: store.getSnapshot(), query: line.itemNameSnapshot, querySlot: 'receiptHistory', privateLookup: false, locale: 'ko' } as const;
  const [match] = reader.search(query);
  expect(reader.describe?.(match!, query.locale, query)?.split(' · ').at(-1)).toBe(createKitTranslator('ko').format.date(TODAY, 'short'));
});
