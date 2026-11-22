import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import type { StockItemDto } from '../../../data/reality/03/stock-dto';
import { projectInventoryFacts } from '../../assistant/domains/inventory';
import { renderWithKit } from '../../../ui/test-utils';
import { inventoryWidget } from './inventory';
import { createTestHost } from './testing';

const id = '11111111-1111-4111-8111-111111111103';
const batchId = '11111111-1111-4111-8111-111111111104';
const day = '2026-11-22';
const asOf = '2026-11-22T04:30:00Z';
const name = 'HTTP 우유';
const itemsPath = '/inventory/items';
const batchesPath = '/inventory/stock-batches';
const movementsPath = '/inventory/stock-movements';
const forecastPath = `/inventory/forecasts/${day}/weekday-4w-v1`;
const list = <T,>(items: readonly T[]) => ({ items, nextCursor: null, asOf, sourceRevision: 1, businessDate: day });
const balance = { openingQuantityBase: '1500', usedQuantityBase: '300', rawQuantityBase: '1200', availableQuantityBase: '1200', deficitQuantityBase: '0' };
const item: StockItemDto = { itemId: id, sku: 'MILK-HTTP', name, kind: 'ingredient', unit: 'L', baseUnit: 'mL', thresholdBase: '2000', trackRestock: true,
  trackExpiry: false, revision: 1, updatedAt: asOf, businessDate: day, stock: balance, onlineStock: null, expiresOn: null, referenced: false };
const lot = { batchId, itemId: id, quantityBase: '500', remainingQuantityBase: '500', expiresOn: '2026-11-24', receivedAt: asOf, discardedAt: null, revision: 1 };
const receipt = { resourceId: id, revision: 2, receiptId: id, affectedSources: ['inventory'], changed: true };

function setup(initialItems: readonly StockItemDto[] = [item]) {
  const backend = fakeBackend();
  backend.on('GET', itemsPath, () => list(initialItems));
  backend.on('GET', batchesPath, () => list([]));
  backend.on('GET', movementsPath, () => list([]));
  backend.on('GET', forecastPath, () => ({ targetDate: day, modelVersion: 'weekday-4w-v1', status: 'no_data', results: [] }));
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', reconcileDelaysMs: [], adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'stock') });
  store.bindReal(port);
  const featureId = 'inventory-booking' as const;
  const condition = { kind: 'default' } as const;
  const host = createTestHost(featureId);
  const Detail = inventoryWidget.Detail!;
  return { backend, store, port, render: () => renderWithKit(<Detail featureId={featureId} condition={condition} detailRef={{ featureId }} host={host} />, { store }) };
}

afterEach(cleanup);

it('keeps an unchanged retry key and sends a fresh key after editing an unacknowledged new item', async () => {
  const { backend, render } = setup();
  const accepted = new Map<string | null, unknown>();
  backend.on('POST', itemsPath, call => {
    const key = call.headers.get('idempotency-key');
    if (accepted.has(key) && JSON.stringify(accepted.get(key)) !== JSON.stringify(call.body)) {
      return reply(409, { code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH' });
    }
    accepted.set(key, call.body);
    if ((call.body as { sku: string }).sku === item.sku) {
      return reply(503, { code: 'SERVICE_UNAVAILABLE' });
    }
    return receipt;
  });
  render();
  fireEvent.click(await screen.findByRole('button', { name: '품목 추가하기' }));
  const form = screen.getByRole('form', { name: '품목 추가하기' });
  const sku = within(form).getByLabelText('코드(SKU)');
  fireEvent.change(sku, { target: { value: item.sku } });
  fireEvent.change(within(form).getByLabelText('이름'), { target: { value: '새 품목' } });
  const save = within(form).getByRole('button', { name: '품목 저장하기' });
  fireEvent.click(save);
  await waitFor(() => expect(within(form).getByRole('alert')).toBeInTheDocument());
  fireEvent.click(save);
  await waitFor(() => expect(backend.callsTo('POST', itemsPath)).toHaveLength(2));
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(sku, { target: { value: 'NEW-HTTP-SKU' } });
  fireEvent.click(save);
  await waitFor(() => expect(backend.callsTo('POST', itemsPath)).toHaveLength(3));
  const keys = backend.callsTo('POST', itemsPath).map(call => call.headers.get('idempotency-key'));
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  await waitFor(() => expect(form).not.toBeInTheDocument());
});

it('shows previous forecast quantities with the storage unit precision and calculation basis', async () => {
  const { backend, render } = setup();
  backend.on('GET', forecastPath, () => ({ targetDate: day, modelVersion: 'weekday-4w-v1', status: 'ready', stale: true,
    results: [{ scope: 'ingredient', targetId: id, expected: '2209.5' }] }));
  render();
  fireEvent.click(await screen.findByRole('button', { name: /HTTP 우유 재고 변동 기록/ }));
  expect(screen.getByText('이전 예상 사용량 2.21L')).toBeInTheDocument();
  expect(screen.getByText('최근 4주 같은 요일의 평균 사용량이에요')).toBeInTheDocument();
});

it('opens, switches and closes untouched stock editors without a PATCH', async () => {
  const other = { ...item, itemId: batchId, sku: 'BREAD-HTTP', name: 'HTTP 빵' };
  const { backend, render } = setup([item, other]);
  const user = userEvent.setup();
  const view = render();
  await user.click(await screen.findByRole('gridcell', { name: /^HTTP 우유, 이름,/ }));
  expect(screen.getByRole('textbox', { name: 'HTTP 우유, 이름' })).toHaveFocus();
  await user.click(screen.getByRole('gridcell', { name: /^HTTP 빵, 이름,/ }));
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'HTTP 빵, 이름' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'HTTP 빵, 이름' })).not.toBeInTheDocument();
  view.unmount();
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(0);
  expect(backend.callsTo('PATCH', `${itemsPath}/${other.itemId}`)).toHaveLength(0);
});

it('skips a formatting-only stock change on Enter', async () => {
  const { backend, render } = setup();
  render();
  const stock = await screen.findByRole('gridcell', { name: /현재 재고, 1\.2L$/ });
  fireEvent.click(stock);
  const editor = within(stock).getByRole('textbox');
  fireEvent.change(editor, { target: { value: '1.20' } });
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }); });
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(0);
  expect(within(stock).queryByRole('textbox')).not.toBeInTheDocument();
});

it('sends exactly one changed quantity on repeated Enter and waits for the HTTP result', async () => {
  const { backend, render } = setup();
  let resolveSave!: () => void;
  const pending = new Promise<void>(resolve => { resolveSave = resolve; });
  backend.on('PATCH', `${itemsPath}/${id}`, async () => {
    await pending;
    backend.on('GET', itemsPath, () => list([{ ...item, revision: 2, stock: { ...balance, rawQuantityBase: '2500', availableQuantityBase: '2500' } }]));
    return receipt;
  });
  render();
  const stock = await screen.findByRole('gridcell', { name: /현재 재고, 1\.2L$/ });
  fireEvent.click(stock);
  const editor = within(stock).getByRole('textbox');
  fireEvent.change(editor, { target: { value: '2.5' } });
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(0);
  act(() => {
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.keyDown(editor, { key: 'Enter', repeat: true });
  });
  await waitFor(() => expect(backend.callsTo('PATCH', `${itemsPath}/${id}`).map(call => call.body)).toEqual([{ stock: 2.5, expectedRevision: 1 }]));
  expect(stock).toHaveTextContent('1.2L');
  await act(async () => resolveSave());
  expect(await screen.findByRole('gridcell', { name: /현재 재고, 2\.5L$/ })).toBeInTheDocument();
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(1);
});

it('does not write the old value back when an untouched editor survives a refresh', async () => {
  const { backend, port, render } = setup();
  render();
  const stock = await screen.findByRole('gridcell', { name: /현재 재고, 1\.2L$/ });
  fireEvent.click(stock);
  backend.on('GET', itemsPath, () => list([{ ...item, revision: 2, stock: { ...balance, rawQuantityBase: '1800', availableQuantityBase: '1800' } }]));
  await act(async () => { await port.retry('stock'); });
  const editor = within(stock).getByRole('textbox');
  expect(editor).toHaveValue('1.2');
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(await screen.findByRole('gridcell', { name: /현재 재고, 1\.8L$/ })).toBeInTheDocument();
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`)).toHaveLength(0);
});

it('creates and adjusts an item from the HTTP widget and re-reads the server quantity', async () => {
  const { backend, render } = setup([]);
  backend.on('POST', itemsPath, () => {
    backend.on('GET', itemsPath, () => list([item]));
    return receipt;
  });
  backend.on('PATCH', `${itemsPath}/${id}`, () => {
    backend.on('GET', itemsPath, () => list([{ ...item, revision: 2, stock: { ...balance, rawQuantityBase: '2500', availableQuantityBase: '2500' } }]));
    return receipt;
  });
  render();
  expect(await screen.findByText('아직 등록한 품목이 없어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '품목 추가하기' }));
  const form = screen.getByRole('form', { name: '품목 추가하기' });
  fireEvent.change(within(form).getByLabelText('코드(SKU)'), { target: { value: item.sku } });
  fireEvent.change(within(form).getByLabelText('이름'), { target: { value: name } });
  fireEvent.change(within(form).getByLabelText('단위'), { target: { value: 'L' } });
  fireEvent.click(within(form).getByRole('button', { name: '품목 저장하기' }));
  fireEvent.submit(form);
  const stock = await screen.findByRole('gridcell', { name: /현재 재고, 1\.2L$/ });
  expect(backend.callsTo('POST', itemsPath)).toHaveLength(1);
  fireEvent.click(stock);
  const input = within(stock).getByRole('textbox');
  fireEvent.change(input, { target: { value: '2.5' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('gridcell', { name: /현재 재고, 2\.5L$/ })).toBeInTheDocument();
  expect(backend.callsTo('PATCH', `${itemsPath}/${id}`).map(call => call.body)).toEqual([{ stock: 2.5, expectedRevision: 1 }]);
});

it('leaves a new draft open when an earlier save finishes after its form was closed', async () => {
  const { backend, render } = setup([]);
  let finish!: () => void;
  const delay = new Promise<void>(resolve => { finish = resolve; });
  backend.on('POST', itemsPath, async () => {
    await delay;
    backend.on('GET', itemsPath, () => list([item]));
    return receipt;
  });
  render();
  const add = await screen.findByRole('button', { name: '품목 추가하기' });
  fireEvent.click(add);
  const form = screen.getByRole('form', { name: '품목 추가하기' });
  fireEvent.change(within(form).getByLabelText('코드(SKU)'), { target: { value: item.sku } });
  fireEvent.change(within(form).getByLabelText('이름'), { target: { value: name } });
  fireEvent.click(within(form).getByRole('button', { name: '품목 저장하기' }));
  await waitFor(() => expect(backend.callsTo('POST', itemsPath)).toHaveLength(1));
  fireEvent.click(within(form).getByRole('button', { name: '품목 추가 닫기' }));
  fireEvent.click(add);
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '두 번째 초안' } });
  await act(async () => finish());
  expect(await screen.findByRole('gridcell', { name: /HTTP 우유, 현재 재고/ })).toBeInTheDocument();
  expect(screen.getByLabelText('이름')).toHaveValue('두 번째 초안');
});

it('creates a lot without changing the quantity and requires explicit discard confirmation', async () => {
  const { backend, render } = setup();
  backend.on('POST', batchesPath, () => {
    backend.on('GET', batchesPath, () => list([lot]));
    return { ...receipt, resourceId: batchId };
  });
  backend.on('POST', `${batchesPath}/${batchId}/discard`, () => reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }));
  render();
  fireEvent.click(await screen.findByRole('button', { name: `${name} 재고 변동 기록` }));
  fireEvent.click(screen.getByRole('button', { name: '로트 등록하기' }));
  const form = screen.getByRole('form', { name: '로트 등록하기' });
  fireEvent.change(within(form).getByLabelText('수량'), { target: { value: '0.5' } });
  fireEvent.change(within(form).getByLabelText('유통기한'), { target: { value: lot.expiresOn } });
  fireEvent.click(within(form).getByRole('button', { name: '저장하기' }));
  fireEvent.click(await screen.findByRole('button', { name: '로트 폐기' }));
  expect(backend.callsTo('POST', `${batchesPath}/${batchId}/discard`)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '폐기 확인' }));
  await waitFor(() => expect(backend.callsTo('POST', `${batchesPath}/${batchId}/discard`).map(call => call.body)).toEqual([{ expectedRevision: 1, confirmed: true }]));
  expect(backend.callsTo('POST', batchesPath).map(call => call.body)).toEqual([{ itemId: id, quantity: 0.5, expiresOn: lot.expiresOn, expectedRevision: 1 }]);
  expect(screen.getByRole('gridcell', { name: /현재 재고, 1\.2L$/ })).toBeInTheDocument();
});

it('uses the server business date and signed sale corrections for Navis facts', async () => {
  const { backend, store, port } = setup();
  backend.on('GET', movementsPath, ({ query }) => list(query.businessDate === day ? [
    { movementId: 'opening', itemId: id, businessDate: day, channel: 'store', kind: 'opening', deltaBase: '1500', sourceId: id, at: '2026-11-21T20:00:00Z', menuId: null, menuQuantity: null, reason: null },
    { movementId: 'sale', itemId: id, businessDate: day, channel: 'store', kind: 'usage', deltaBase: '-500', sourceId: id, at: asOf, menuId: id, menuQuantity: 5, reason: 'sale_recognized' },
    { movementId: 'correction', itemId: id, businessDate: day, channel: 'store', kind: 'usage', deltaBase: '200', sourceId: id, at: '2026-11-22T04:40:00Z', menuId: id, menuQuantity: -2, reason: 'sale_corrected' },
  ] : []));
  await port.load('stock');
  expect(projectInventoryFacts(store.getSnapshot(), 'inventory-booking', { kind: 'snapshot', asOf: day }, 'ko')).toMatchObject({
    facts: expect.arrayContaining([
      { key: `inventory.stock.${id}`, value: 1.2, unit: 'L', label: `${name} · 현재 재고`, display: '1.2 L', date: day },
      expect.objectContaining({ key: `inventory.stockHistory.${id}.usage`, value: 0.3, date: day }),
    ]),
  });
  expect(backend.callsTo('GET', forecastPath)).toHaveLength(1);
});

it('loads a complete seven-day stock history when the combined movement list exceeds the page cap', async () => {
  const { backend, store, port } = setup();
  const dates = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', day];
  backend.on('GET', movementsPath, ({ query }) => {
    const businessDate = query.businessDate ?? day;
    const row = { itemId: id, businessDate, channel: 'store', kind: 'usage', deltaBase: '-100',
      sourceId: id, at: `${businessDate}T04:30:00Z`, menuId: id, menuQuantity: 1, reason: 'sale_recognized' };
    const offset = Number(query.cursor ?? 0);
    const pages = query.businessDate ? 3 : 21;
    const moves = [{ ...row, movementId: `${businessDate}-${offset}` }];
    if (offset === 0) moves.unshift({ ...row, movementId: `opening-${businessDate}`, kind: 'opening', deltaBase: '1500' });
    return { ...list(moves), nextCursor: offset + 1 < pages ? String(offset + 1) : null };
  });
  await port.load('stock');
  const source = store.getSnapshot().tables.realStock?.[0];
  expect(source).toMatchObject({ movementsComplete: true });
  expect(source?.movements).toHaveLength(28);
  expect(new Set(backend.callsTo('GET', movementsPath).map(call => call.query.businessDate))).toEqual(new Set(dates));
  expect(projectInventoryFacts(store.getSnapshot(), 'inventory-booking',
    { kind: 'dateRange', start: dates[0], end: day }, 'ko')).toMatchObject({
    facts: expect.arrayContaining([expect.objectContaining({ key: `inventory.stockHistory.${id}.usage`, value: 2.1 })]),
  });
});

it('records one channel transfer through HTTP and preserves the combined quantity', async () => {
  const channelBalance = (qty: string) => ({ openingQuantityBase: qty, usedQuantityBase: '0', rawQuantityBase: qty, availableQuantityBase: qty, deficitQuantityBase: '0' });
  const product = { ...item, name: '검증 원두 상품', kind: 'retail', unit: 'pcs', baseUnit: 'pcs', thresholdBase: '0',
    stock: channelBalance('10'), onlineStock: channelBalance('4') } as const;
  const { backend, render } = setup([product]);
  backend.on('GET', `${itemsPath}/${id}/commerce-stock`, () => reply(404, { code: 'COMMERCE_ITEM_NOT_LINKED' }));
  backend.on('POST', '/inventory/channel-transfers', () => {
    backend.on('GET', itemsPath, () => list([{ ...product, revision: 2, stock: channelBalance('7'), onlineStock: channelBalance('7') }]));
    return receipt;
  });
  render();
  fireEvent.click(await screen.findByRole('tab', { name: '판매 상품' }));
  fireEvent.click(screen.getByRole('gridcell', { name: /검증 원두 상품, 상품/ }));
  fireEvent.change(await screen.findByRole('spinbutton', { name: '매장 → 온라인' }), { target: { value: '3' } });
  const press = screen.getByRole('button', { name: '옮기기' });
  act(() => { press.click(); press.click(); });
  expect(await screen.findByRole('img', { name: '매장 7개, 온라인 7개' })).toBeInTheDocument();
  expect(screen.getByText('14개', { exact: true })).toBeInTheDocument();
  expect(backend.callsTo('POST', '/inventory/channel-transfers').map(call => call.body)).toEqual([{ itemId: id, from: 'store', to: 'online', qty: 3, expectedRevision: 1 }]);
});

it('projects the linked Smart Store quantity into the product summary after the approved stock change', async () => {
  const balance = (value: string) => ({ openingQuantityBase: value, usedQuantityBase: '0', rawQuantityBase: value, availableQuantityBase: value, deficitQuantityBase: '0' });
  const product = { ...item, name: '온라인 상품', kind: 'retail', unit: 'pcs', baseUnit: 'pcs', thresholdBase: '0',
    stock: balance('10'), onlineStock: balance('4') } as const;
  const { backend, render, store } = setup([product]);
  const path = `${itemsPath}/${id}/commerce-stock`;
  let option = { id: 1, name: '기본', stockQuantity: 6, price: 1000, usable: true };
  const card = { previewId: 'stock-preview', expectedRevision: 2, inputHash: 'digest', expiresAt: '2099-01-01' };
  backend.on('GET', path, () => ({ originProductNo: 1, name: product.name, stockQuantity: option.stockQuantity, options: [option] }));
  backend.on('POST', path + '/preview', () => ({ ...card, diff: { current: option, stockQuantity: 8 } }));
  backend.on('POST', '/inventory/approvals', () => ({ approvalId: 'stock-approval', expiresAt: card.expiresAt, requiresConfirmation: false }));
  backend.on('POST', path + '/confirm', () => {
    option = { ...option, stockQuantity: 8 };
    return { receiptId: 'stock-approval' };
  });

  render();
  const Panel = inventoryWidget.Panel!;
  const panel = renderWithKit(<Panel featureId="inventory-booking" condition={{ kind: 'default' }}
    width={2} height={1} shape="W" presetId="A" editing={false} host={createTestHost('inventory-booking')} />, { store });
  fireEvent.click(await screen.findByRole('tab', { name: '판매 상품' }));
  expect(await screen.findByRole('img', { name: '매장 10개, 온라인 6개' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('gridcell', { name: /온라인 상품, 상품/ }));
  fireEvent.click(await screen.findByRole('button', { name: '스마트스토어 재고 바꾸기' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: '온라인' }), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  const approve = await screen.findByRole('region', { name: '스마트스토어 재고 바꾸기' });
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  fireEvent.click(within(approve).getByRole('button', { name: '스마트스토어 재고 바꾸기' }));
  expect(await screen.findByRole('img', { name: '매장 10개, 온라인 8개' })).toBeInTheDocument();
  expect(panel.container).toHaveTextContent(/온라인 8/);
  expect(store.getSnapshot().tables.inventoryStock.find(row => row.itemId === id && row.channel === 'online')?.qty).toBe(8);
});
