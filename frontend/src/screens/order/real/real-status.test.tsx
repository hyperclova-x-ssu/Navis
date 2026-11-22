import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../../../ui';
import { screenPresets } from '../../../layout/presets';
import { WidgetDataProvider } from '../../../data/react';
import { PosProvider } from '../../../pos/react';
import { PosBridgeProvider } from '../../../pos/remote-context';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { setup } from '../../../pos/loyalty/test-setup';
import { createPortTransport } from '../../../data/reality/00/transport';
import { fakeBackend } from '../../../data/reality/00/testing';
import { createPosBridge } from '../../../data/reality/02/bridge';
import { createPosRemote } from '../../../data/reality/02/remote';
import { forgetConnectOrders } from '../../../connect-kiosk/channel';
import { OrderStatus } from '../status/OrderStatus';

const day = POS_BUSINESS_DATE;
const line = { orderLineId: 'l1', allocationId: 'a1', menuId: 'm-americano', name: '아메리카노', qty: 1, basePrice: 3000, baseCost: 800, optionPrice: 0, optionCost: 0, recipeVersion: 'v1', options: [], gross: 3000, discount: 0, amount: 3000 };
const page = (items: unknown[]) => ({ items, nextCursor: null, asOf: `${day}T06:45:00.000Z`, sourceRevision: 1 });
const receipt = {
  paymentId: 'p1', settlementId: 's1', billId: 'b1', storeName: '시험 카페', orderNos: [1], transactionNo: 'TX-1', approvalNo: 'CASH', at: `${day}T01:00:00.000Z`, channel: 'cash_record', terminal: null,
  amount: 3000, gross: 3000, discount: 0, remaining: 3000, status: 'paid', splits: [{ method: 'cash', amount: 3000 }],
  lines: [{ orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', qty: 1, options: [], request: '', gross: 3000, discount: 0, amount: 3000 }],
  currentPrepared: false, reversalLines: [{ allocationId: 'a1', orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', quantity: 1, prepared: false }], corrections: [],
};

describe('F02 order status over HTTP', () => {
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

  it('lists the service orders and starts preparation through the service, with no reopen', async () => {
    const h = setup(), backend = fakeBackend(), transport = createPortTransport(backend.fetch);
    const bridge = createPosBridge({ remote: createPosRemote({ transport, sleep: async () => {}, delaysMs: [0] }), read: h.pos.read, commit: h.actions.commit, reload: () => {}, schedule: () => 0, cancel: () => {} });
    let preparation = 'accepted';
    backend.on('GET', '/pos/naver/orders', () => ({ items: [{ orderNumber: 'N1', status: 'received', revision: 1, preparationMinutes: null, actions: { prepare: true, pickup: false } }], nextCursor: null, status: 'ready' }));
    backend.on('GET', '/pos/orders', () => page([{ orderId: 'o1', orderNo: 1, billId: 'b1', businessDate: day, orderedAt: `${day}T01:00:00.000Z`, revision: preparation === 'accepted' ? 1 : 2, preparation, tableId: null, settlementId: 's1', paymentId: 'p1', amount: 3000, remaining: 3000, lines: [line] }]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', '/pos/tables', () => page([]));
    backend.on('GET', /receipt$/, () => receipt);
    backend.on('POST', '/pos/orders/o1/preparation', () => { preparation = 'preparing'; return { resourceId: 'o1', revision: 2, receiptId: 'r1', affectedSources: ['pos.orders'] }; });
    await bridge.sync();
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><WidgetDataProvider store={h.data} preview={h.run.getState().preview}><PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
      <OrderStatus onRetry={() => {}} onNotice={() => {}} onOpenReceipt={() => {}}/>
    </PosBridgeProvider></PosProvider></WidgetDataProvider></UiProvider>);
    expect(await screen.findByText('#1')).toBeInTheDocument();
    await screen.findByText('네이버 N1');
    const grid = screen.getByText('#1').closest('table')!;
    expect(within(grid).getByText('네이버 N1')).toBeInTheDocument();
    expect(screen.queryByText('네이버 결제·상품 조회')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '준비 중으로 되돌리기' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '준비 시작' })[0]);
    await waitFor(() => expect(backend.callsTo('POST', '/pos/orders/o1/preparation')).toHaveLength(1));
    expect(backend.callsTo('POST', '/pos/orders/o1/preparation')[0].body).toEqual({ status: 'preparing', expectedRevision: 1 });
    await waitFor(() => expect(h.pos.read().pos.orders[0].preparation).toBe('preparing'));
  });

  it.each([
    { source: 'naver', naverPayPaymentId: 'NPAY-P1', smartstoreProductOrderId: '202611220001101' },
    { source: 'connect', naverPayPaymentId: null, smartstoreProductOrderId: null },
  ] as const)('restores the $source order and receipt display after reload', async links => {
    forgetConnectOrders();
    const h = setup(), backend = fakeBackend();
    const remote = createPosRemote({ transport: createPortTransport(backend.fetch) });
    const bridge = createPosBridge({ remote, read: h.pos.read, commit: h.actions.commit });
    backend.on('GET', '/pos/naver/orders', () => ({ items: [], nextCursor: null, status: 'ready' }));
    backend.on('GET', '/pos/orders', () => page([{
      orderId: 'o1', orderNo: 1, billId: 'b1', businessDate: day, orderedAt: `${day}T01:00:00.000Z`,
      revision: 1, preparation: 'accepted', tableId: null, settlementId: 's1', paymentId: 'p1', amount: 3000, remaining: 3000, lines: [line],
      ...links,
    }]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', '/pos/tables', () => page([]));
    backend.on('GET', '/pos/payments/p1/receipt', () => ({
      ...receipt, ...links, terminal: { approvalNo: 'NC-KIOSK', receiptNo: null, occurredAt: receipt.at },
    }));
    backend.on('GET', '/pos/naver/npay/payments/NPAY-P1', () => ({ page: { currentPage: 1, responseCount: 0 }, items: [] }));
    backend.on('POST', '/pos/naver/smartstore/order-statuses', () => ({
      items: [{ productOrderId: links.smartstoreProductOrderId, productOrderStatus: 'DELIVERED' }], unavailable: [],
    }));
    await bridge.sync();
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><WidgetDataProvider store={h.data}><PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
      <OrderStatus onRetry={() => {}} onNotice={() => {}} onOpenReceipt={() => {}}/>
    </PosBridgeProvider></PosProvider></WidgetDataProvider></UiProvider>);
    const orderNumber = screen.getByText('#1');
    const row = within(orderNumber.closest('tr')!);
    expect(row.getByText(links.source === 'connect' ? '포장 · 커넥트' : '포장')).toBeInTheDocument();
    fireEvent.click(orderNumber);
    if (links.source === 'naver') {
      expect(await screen.findByText('아직 정산 전이에요')).toBeInTheDocument();
      expect(await screen.findByText('배송 완료')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '결제 취소하기' })).not.toBeInTheDocument();
      expect(backend.callsTo('GET', /\/npay\/payments\//).map(call => call.path)).toEqual(['/pos/naver/npay/payments/NPAY-P1']);
    } else {
      expect(screen.getByText(/10:00.*포장 · 커넥트/u)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: '주문 메모' })).not.toBeInTheDocument();
      expect(screen.getByText('단말 결제는 Npay 정산을 조회할 수 없어요')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '결제 취소하기' })).toBeInTheDocument();
      expect(backend.callsTo('GET', /\/npay\//)).toHaveLength(0);
      expect(backend.callsTo('POST', /\/smartstore\//)).toHaveLength(0);
    }
  });
});
