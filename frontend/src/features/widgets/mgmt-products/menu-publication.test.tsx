import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { createPortTransport } from '../../../data/reality/00/transport';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { menuAdapter } from '../../../data/reality/01/adapter';
import { promoAdapter } from '../../../data/reality/16/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { CommerceStock } from '../mgmt-supply/stock-grid-commerce';
import { SupplierMessage } from '../mgmt-supply/purchase-message';
import { MenuPlace, VenuePlace } from './menu-publication';

afterEach(cleanup);
const expiresAt = '2099-01-01';
const preview = { previewId: 'preview-key', inputHash: 'initial', expectedRevision: 3, expiresAt };
const approval = { approvalId: 'server-key', expiresAt, requiresConfirmation: false };
function approvalBackend(requiresConfirmation = false) {
  const backend = fakeBackend();
  backend.on('POST', '/inventory/approvals', () => ({ ...approval, requiresConfirmation }));
  return backend;
}

it('requires a separate Place card press and retries an uncertain response with its original key', async () => {
  const backend = approvalBackend();
  const path = '/inventory/menu/menu/place';
  const current = { name: '커피', price: 4000 };
  const desired = { ...current, price: 4500 };
  let items = [current];
  backend.on('GET', '/inventory/place/menu', () => ({ items }));
  backend.on('POST', path + '/preview', () => ({ ...preview, diff: { current, desired, patch: { price: desired.price } } }));
  backend.on('POST', path + '/confirm', () => {
    items = [desired];
    return backend.callsTo('POST', path + '/confirm').length === 1 ? reply(503, {}) : { receiptId: approval.approvalId };
  });
  renderWithKit(<MenuPlace transport={createPortTransport(backend.fetch)} menuId="menu" />);
  fireEvent.click(screen.getByRole('button', { name: '플레이스에 올리기' }));
  fireEvent.click(await screen.findByRole('button', { name: '미리보기' }));
  const card = await screen.findByRole('region', { name: '플레이스에 올리기' });
  expect(within(card).getByText(/4,000원 → 변경 후 4,500원/)).toBeInTheDocument();
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  expect(backend.callsTo('POST', '/inventory/approvals')).toHaveLength(0);
  const confirm = within(card).getByRole('button', { name: '플레이스에 올리기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(await screen.findByRole('button', { name: '같은 요청 다시 확인하기' }));
  expect(await screen.findByText('저장했어요 · 검색에 반영되는 데 시간이 걸려요')).toBeInTheDocument();
  const calls = backend.callsTo('POST', path + '/confirm');
  expect(calls).toHaveLength(2);
  expect(backend.callsTo('POST', '/inventory/approvals')).toHaveLength(1);
  expect(calls.map(call => call.body)).toEqual(Array(2).fill({ approvalId: approval.approvalId, previewId: preview.previewId, expectedRevision: preview.expectedRevision }));
  expect(calls.map(call => call.headers.get('idempotency-key'))).toEqual([approval.approvalId, approval.approvalId]);
});

it('previews only changed venue fields and reads provider state again after confirming', async () => {
  const backend = approvalBackend();
  const path = '/inventory/place/venue';
  let venue = { name: '카페', address: '서울', phone: '021234567', keywords: [], photos: [] };
  backend.on('GET', path, () => venue);
  backend.on('POST', path + '/preview', () => ({ ...preview, diff: { current: venue, patch: { address: '안성' } } }));
  backend.on('POST', path + '/confirm', () => {
    venue = { ...venue, address: '안성' };
    return { receiptId: approval.approvalId };
  });
  renderWithKit(<VenuePlace transport={createPortTransport(backend.fetch)} />);
  fireEvent.click(screen.getByRole('button', { name: '업체 정보' }));
  fireEvent.change(await screen.findByRole('textbox', { name: '주소' }), { target: { value: '안성' } });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  const confirm = await screen.findByRole('button', { name: '플레이스에 올리기' });
  expect(backend.callsTo('POST', path + '/preview')[0].body).toEqual({ input: { address: '안성' } });
  fireEvent.click(confirm);
  expect(await screen.findByDisplayValue('안성')).toBeInTheDocument();
  expect(backend.callsTo('GET', path)).toHaveLength(2);
});

it.each(['http', 'fixture'] as const)('shows the Place venue photo from the current source in %s mode', async mode => {
  const backend = fakeBackend();
  const path = '/marketing/photos/44ce6212-5f16-42b9-873e-2a5fad58752f/content';
  const contentUrl = `/api/v1/stores/${backend.storeId}${path}`;
  const photoId = 'cafe-storefront';
  const displayed = mode === 'http' ? 'blob:place-photo' : `/api/promo/photos/${photoId}`;
  const store = createWidgetDataStore();
  const page = { items: [], nextCursor: null, asOf: '2026-11-22T00:00:00Z', sourceRevision: 1 };
  backend.on('GET', '/inventory/place/venue', () => ({ name: '카페', address: '서울', phone: '021234567', keywords: [], photos: [photoId] }));
  backend.on('GET', '/marketing/promo/assets', () => ({ ...page, items: [{ photoId, menuId: null, fileId: null, url: contentUrl, width: 120, height: 90 }], store: null, menus: [], eligiblePhotoCount: 0 }));
  backend.on('GET', '/marketing/promo/drafts', () => page);
  backend.on('GET', '/marketing/promo/publications', () => page);
  backend.on('GET', '/marketing/photos', () => ({ items: [], nextCursor: null }));
  backend.on('GET', path, () => 'bytes');
  const port = createRealPort({ store, fetch: backend.fetch, source: () => mode, adapters: [menuAdapter, promoAdapter] });
  store.bindReal(port);
  const originalURL = globalThis.URL;
  globalThis.URL = class extends originalURL {
    static createObjectURL = () => displayed;
    static revokeObjectURL = vi.fn();
  };
  try {
    const { unmount } = renderWithKit(<VenuePlace transport={port.transport} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '업체 정보' }));
    const label = await screen.findByText('매장 앞 사진');
    await waitFor(() => expect(label.closest('p')?.querySelector('img')).toHaveAttribute('src', displayed));
    if (mode === 'http') expect(backend.callsTo('GET', path)[0].headers.get('authorization')).toMatch(/^Bearer token-/);
    else expect(backend.callsTo('GET', '/marketing/promo/assets')).toHaveLength(0);
    unmount();
  } finally {
    globalThis.URL = originalURL;
  }
});

it('reads online stock back after confirmation and omits the store transfer for a linked product', async () => {
  const backend = approvalBackend();
  const path = '/inventory/items/item/commerce-stock';
  let option = { id: 1, name: '기본', stockQuantity: 6, price: 1000, usable: true };
  backend.on('GET', path, () => ({ stockQuantity: option.stockQuantity, options: [option] }));
  backend.on('POST', path + '/preview', () => ({ ...preview, diff: { current: option, stockQuantity: 8 } }));
  backend.on('POST', path + '/confirm', () => {
    option = { ...option, stockQuantity: 8 };
    return { receiptId: approval.approvalId };
  });
  const refreshes: string[] = [];
  renderWithKit(<CommerceStock transport={createPortTransport(backend.fetch)} itemId="item" unlinked="transfer"
    onSaved={() => refreshes.push('re-read')} />);
  fireEvent.click(await screen.findByRole('button', { name: '스마트스토어 재고 바꾸기' }));
  expect(screen.queryByText('transfer')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton', { name: '온라인' }), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  const card = await screen.findByRole('region', { name: '스마트스토어 재고 바꾸기' });
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  fireEvent.click(within(card).getByRole('button', { name: '스마트스토어 재고 바꾸기' }));
  await waitFor(() => expect(refreshes).toEqual(['re-read']));
  expect(await screen.findByText('온라인 재고를 저장했어요')).toBeInTheDocument();
});

it('sends the reviewed supplier message and shows acceptance separately from delivery', async () => {
  const backend = approvalBackend();
  const path = '/inventory/purchase-orders/order/supplier-message';
  let items: object[] = [];
  backend.on('GET', path, () => ({ items }));
  backend.on('POST', path + '/preview', () => ({ ...preview, diff: { supplierName: '업체', targetHint: '••••1234', body: '발주 요청\n원두 2', scheduledAt: null } }));
  backend.on('POST', path + '/confirm', () => {
    const receipt = { receiptId: approval.approvalId, channel: 'sms', scheduledAt: null, state: 'accepted' };
    items = [receipt];
    return receipt;
  });
  const mount = (sendable: boolean) => renderWithKit(<SupplierMessage transport={createPortTransport(backend.fetch)}
    scope={backend} poId="order" supplierName="업체" phone="01000001234" sendable={sendable} copyText="발주 요청" />);
  const view = mount(true);
  fireEvent.click(await screen.findByRole('button', { name: '발주사에 발주 보내기' }));
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  const send = await screen.findByRole('button', { name: '발주 보내기' });
  expect(screen.getByText('업체 · ••••1234')).toBeInTheDocument();
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  fireEvent.click(send);
  expect(await screen.findByText('접수했어요')).toBeInTheDocument();
  expect(screen.queryByText('보냈어요')).not.toBeInTheDocument();
  view.unmount();
  items = [{ ...items[0], state: 'delivered' }];
  mount(false);
  expect(await screen.findByText('보냈어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '발주사에 발주 보내기' })).not.toBeInTheDocument();
});

it('requires the extra removal confirmation before publishing a venue photo deletion', async () => {
  const backend = approvalBackend(true);
  const path = '/inventory/place/venue';
  const venue = { name: '카페', address: '서울', phone: '021234567', keywords: [], photos: ['storefront'] };
  backend.on('GET', path, () => venue);
  backend.on('POST', path + '/preview', () => ({ ...preview, diff: { current: venue, patch: { photos: [] } } }));
  backend.on('POST', path + '/confirm', () => { venue.photos = []; return { receiptId: approval.approvalId }; });
  renderWithKit(<VenuePlace transport={createPortTransport(backend.fetch)} />);
  fireEvent.click(screen.getByRole('button', { name: '업체 정보' }));
  fireEvent.click(await screen.findByRole('button', { name: '사진 지우기' }));
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  fireEvent.click(await screen.findByRole('button', { name: '플레이스에 올리기' }));
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(0);
  fireEvent.click(await screen.findByRole('button', { name: '사진 삭제 확인' }));
  await waitFor(() => expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(1));
});

it('requires a fresh preview and a second owner press after a stale supplier card', async () => {
  const backend = approvalBackend();
  const path = '/inventory/purchase-orders/order/supplier-message';
  backend.on('GET', path, () => ({ items: [] }));
  backend.on('POST', path + '/preview', () => ({
    ...preview, diff: { supplierName: '업체', targetHint: '••••1234', body: '발주 요청', scheduledAt: null },
  }));
  backend.on('POST', path + '/confirm', () => reply(409, { code: 'STALE_REVISION' }));
  renderWithKit(<SupplierMessage transport={createPortTransport(backend.fetch)}
    scope={backend} poId="order" supplierName="업체" phone="01000001234" sendable copyText="발주 요청" />);
  fireEvent.click(await screen.findByRole('button', { name: '발주사에 발주 보내기' }));
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  fireEvent.click(await screen.findByRole('button', { name: '발주 보내기' }));
  expect(await screen.findByText(/다시 미리보기를 열어 주세요/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '발주 보내기' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  expect(await screen.findByRole('button', { name: '발주 보내기' })).toBeInTheDocument();
  expect(backend.callsTo('POST', '/inventory/approvals')).toHaveLength(1);
  expect(backend.callsTo('POST', path + '/confirm')).toHaveLength(1);
});

it('offers a fresh supplier preview after a failed receipt', async () => {
  const backend = approvalBackend();
  const path = '/inventory/purchase-orders/order/supplier-message';
  backend.on('GET', path, () => ({ items: [{ receiptId: 'previous', channel: 'sms', scheduledAt: null, state: 'failed' }] }));
  renderWithKit(<SupplierMessage transport={createPortTransport(backend.fetch)}
    scope={backend} poId="order" supplierName="업체" phone="01000001234" sendable copyText="발주 요청" />);
  expect(await screen.findByText('보내지 못했어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '발주사에 발주 보내기' }));
  expect(screen.getByRole('button', { name: '보낼 내용 확인하기' })).toBeInTheDocument();
  expect(backend.callsTo('POST', '/inventory/approvals')).toHaveLength(0);
});

it('shows the no-contact guidance by channel and keeps the fixture result unsent', async () => {
  const props = { scope: {}, poId: 'order', supplierName: '테스트 발주사', sendable: true, copyText: '발주 요청' };
  renderWithKit(<SupplierMessage {...props} phone="01000000001" />);
  fireEvent.click(await screen.findByRole('button', { name: '발주사에 발주 보내기' }));
  expect(screen.getByText('메일로 보내려면 발주사 탭에 메일 주소를 추가해 주세요')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  const send = await screen.findByRole('button', { name: '발주 보내기' });
  expect(screen.queryByText('보낼 수 없어요')).not.toBeInTheDocument();
  fireEvent.click(send);
  expect(await screen.findByText('보낼 수 없어요')).toBeVisible();
  expect(screen.queryByText('보냈어요')).not.toBeInTheDocument();
});

it('does not present a virtual delivery receipt as a live send', async () => {
  const backend = approvalBackend();
  backend.on('GET', '/inventory/purchase-orders/order/supplier-message', () => ({ items: [{
    receiptId: 'virtual-result', channel: 'sms', scheduledAt: null, state: 'delivered', providerMode: 'virtual',
  }] }));
  renderWithKit(<SupplierMessage transport={createPortTransport(backend.fetch)} scope={backend} poId="order"
    supplierName="테스트 발주사" phone="01000000001" sendable copyText="발주 요청" />);
  expect(await screen.findByText('시험 발송으로 기록했어요')).toBeVisible();
  expect(screen.getByText('실제로 발송하지 않았어요')).toBeVisible();
  expect(screen.queryByText('보냈어요')).not.toBeInTheDocument();
  expect(screen.queryByText('발주를 받았는지는 발주사에 확인해 주세요')).not.toBeInTheDocument();
});
