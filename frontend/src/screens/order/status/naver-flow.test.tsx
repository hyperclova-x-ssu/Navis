import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { connectMemo } from '../../../connect-kiosk/channel';
import { I18nProvider } from '../../../i18n';
import { createPortTransport } from '../../../data/reality/00/transport';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { createPosBridge } from '../../../data/reality/02/bridge';
import { createPosRemote } from '../../../data/reality/02/remote';
import { WidgetDataProvider } from '../../../data/react';
import { screenPresets } from '../../../layout/presets';
import { setup } from '../../../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../../../pos/loyalty';
import { PosProvider } from '../../../pos/react';
import { PosBridgeProvider } from '../../../pos/remote-context';
import { orderStatusRuntime } from '../../../pos/runtime';
import { selectOrderSummary } from '../../../pos/status';
import { UiProvider } from '../../../ui';
import { OrderScreen } from '../index';
import { OrderStatus } from './OrderStatus';
import { useNaverOrders } from './useNaverOrders';

afterEach(cleanup);

it('counts the same open NAVER orders before and after opening the status tab', async () => {
  vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http');
  try {
    const h = setup(), backend = fakeBackend();
    const bridge = createPosBridge({ remote: createPosRemote({ transport: createPortTransport(backend.fetch) }), read: h.pos.read, commit: h.actions.commit });
    backend.on('GET', '/pos/naver/orders', () => ({
      items: [
        naverOrder('order-01'),
        { ...naverOrder('N2026112207'), status: 'preparing' },
        { ...naverOrder('order-03'), status: 'picked-up' },
      ],
      nextCursor: null, status: 'ready',
    }));
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><WidgetDataProvider store={h.data}>
      <PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
        <OrderScreen run={h.run} onOpenReceipt={() => {}}/>
      </PosBridgeProvider></PosProvider>
    </WidgetDataProvider></UiProvider>);

    const tab = await screen.findByRole('tab', { name: '주문 현황, 진행 중 2건' });
    fireEvent.click(tab);
    expect(screen.getByRole('region', { name: '오늘 주문' })).toHaveTextContent(/2\s*건/u);
    expect(screen.getByRole('region', { name: '진행 중' })).toHaveTextContent(/2\s*건/u);
    expect(screen.getByRole('radio', { name: '진행 중 2' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '전체 3' })).toBeInTheDocument();
    const row = screen.getByText('네이버 주문 1', { exact: true });
    expect(screen.getByText('네이버 N2026112207')).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByRole('region', { name: '네이버 주문 1 · 접수' })).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveTextContent('order-01');
    expect(backend.callsTo('GET', '/pos/naver/orders')).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
  }
});

function mount(backend: ReturnType<typeof fakeBackend>) {
  const h = setup();
  const bridge = createPosBridge({ remote: createPosRemote({ transport: createPortTransport(backend.fetch) }), read: h.pos.read, commit: h.actions.commit });
  const notice = vi.fn();
  function Status() {
    const naver = useNaverOrders(bridge.remote.naver, notice);
    const openCount = selectOrderSummary(h.pos.read()).counts.open + naver.rows.open.length;
    return <OrderStatus naver={naver} openCount={openCount} onRetry={() => {}} onNotice={notice} onOpenReceipt={() => {}}/>;
  }
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion>
    <WidgetDataProvider store={h.data} preview={h.run.getState().preview}><PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
      <Status/>
    </PosBridgeProvider></PosProvider></WidgetDataProvider>
  </UiProvider>);
  return notice;
}

// UXP-18: NAVER orders are table rows; the preparation popover under [준비 시작] is the confirmation.
it('shows NAVER orders as table rows and starts preparing only from the popover, re-reading the status after each receipt', async () => {
  const backend = fakeBackend();
  let status = 'received', revision = 3;
  const order = () => ({ orderNumber: 'N1', status, revision, preparationMinutes: status === 'received' ? null : 7,
    actions: { prepare: status === 'received', pickup: status === 'preparing' } });
  backend.on('GET', '/pos/naver/orders', () => ({ items: [order()], nextCursor: null, status: 'ready' }));
  const update = (next: string) => () => {
    status = next;
    revision += 1;
    return { resourceId: 'N1', receiptId: 'r' + revision, revision, affectedSources: ['pos.naver-orders'] };
  };
  const prepare = '/pos/naver/orders/N1/prepare', pickup = '/pos/naver/orders/N1/pickup';
  backend.on('POST', prepare, update('preparing'));
  backend.on('POST', pickup, update('picked-up'));
  const notice = mount(backend);
  const grid = (await screen.findByText('네이버 N1')).closest('table')!;
  expect(within(grid).getByText('네이버 N1')).toBeInTheDocument();
  expect(within(grid).getByText('접수')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '픽업 완료' })).toBeNull();
  fireEvent.click(within(grid).getByRole('button', { name: /준비 시작/ }));
  const minutes = await screen.findByLabelText('준비 시간(분)');
  fireEvent.change(minutes, { target: { value: '7' } });
  fireEvent.keyDown(minutes, { key: 'Enter' });
  expect(backend.callsTo('POST', prepare)).toHaveLength(0);
  const start = screen.getByRole('button', { name: '7분으로 준비 시작' });
  fireEvent.click(start);
  fireEvent.click(start);
  await waitFor(() => expect(notice).toHaveBeenCalledWith({ message: '네이버 N1 준비를 시작했어요' }));
  expect(backend.callsTo('POST', prepare)).toHaveLength(1);
  expect(backend.callsTo('POST', prepare)[0].body).toEqual({ preparationMinutes: 7, expectedRevision: 3 });
  fireEvent.click(await within(grid).findByRole('button', { name: /픽업 완료/ }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith({ message: '네이버 N1 픽업 완료했어요' }));
  await waitFor(() => expect(backend.callsTo('POST', pickup)[0].body).toEqual({ expectedRevision: 4 }));
  expect(backend.callsTo('POST', pickup)[0].headers.get('idempotency-key')).toBeTruthy();
  await waitFor(() => expect(within(grid).queryByText('네이버 N1')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('radio', { name: /^완료 / }));
  const completedRow = (await screen.findByText('네이버 N1')).closest('tr')!;
  expect(within(completedRow).getByText('픽업 완료')).toBeInTheDocument();
  expect(backend.callsTo('GET', '/pos/naver/orders').length).toBeGreaterThanOrEqual(3);
});

it('keeps the order-status filters available when NAVER orders fail to load', async () => {
  const backend = fakeBackend();
  let ready = false;
  backend.on('GET', '/pos/naver/orders', () => ready ? { items: [], nextCursor: null, status: 'ready' } : reply(503, { code: 'UNAVAILABLE' }));
  mount(backend);
  expect(await screen.findByText('네이버 주문을 불러오지 못했어요')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /^진행 중 / })).toBeChecked();
  ready = true;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(backend.callsTo('GET', '/pos/naver/orders')).toHaveLength(2));
  expect(backend.callsTo('POST', /naver/)).toHaveLength(0);
});

it('explains missing provider links inside the existing order detail', async () => {
  const backend = fakeBackend();
  backend.on('GET', '/pos/naver/orders', () => ({
    items: [{ orderNumber: 'N1', status: 'received', revision: 1, preparationMinutes: null, actions: { prepare: true, pickup: false } }],
    nextCursor: null, status: 'ready',
  }));
  mount(backend);
  fireEvent.click(await screen.findByText('네이버 N1'));
  expect(await screen.findByText('아직 연결된 Npay 결제가 없어요')).toBeInTheDocument();
  expect(screen.queryByText('스마트스토어 주문 상태')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '결제 번호' })).not.toBeInTheDocument();
  expect(backend.callsTo('GET', /npay/)).toHaveLength(0);
  expect(backend.callsTo('POST', /smartstore/)).toHaveLength(0);
});

const productOrderId = '202611220001101';
const settlementPath = '/pos/naver/npay/payments/PN09SETTLED01';
const smartStorePath = '/pos/naver/smartstore/order-statuses';
const naverOrder = (orderNumber: string) => ({
  orderNumber, source: 'naver', status: 'received', revision: 1, preparationMinutes: null, actions: { prepare: true, pickup: false },
});

it('shows the linked payment and Smart Store status in the open NAVER order detail', async () => {
  const backend = fakeBackend();
  backend.on('GET', '/pos/naver/orders', () => ({
    items: [{ ...naverOrder('N1'), naverPayPaymentId: 'PN09SETTLED01', smartstoreProductOrderId: productOrderId }],
    nextCursor: null, status: 'ready',
  }));
  const approval = {
    paymentId: 'PN09SETTLED01', payHistId: 'PN09SETTLED01-A', kind: 'approval', settleType: '정산',
    payDate: '20261120', settleCompleteDate: '20261121', paySettleAmount: 4500, totalCommissionAmount: -90, status: 'settled',
  };
  backend.on('GET', settlementPath, call => call.query.page === '1' ? {
    page: { currentPage: 1, responseCount: 2, totalPageCount: 2 },
    items: [approval, {
      ...approval, payHistId: 'PN09SETTLED01-C1', kind: 'cancellation', settleType: '정산 후 취소',
      settleCompleteDate: '', settleExpectDate: '20261124', paySettleAmount: -500, totalCommissionAmount: 15, status: 'scheduled',
    }],
  } : {
    page: { currentPage: 2, responseCount: 1 },
    items: [{ ...approval, payHistId: 'PN09SETTLED01-C2', kind: 'cancellation', settleType: '정산 후 취소',
      settleCompleteDate: '20261122', paySettleAmount: -200, totalCommissionAmount: 6 }],
  });
  backend.on('POST', smartStorePath, () => ({ items: [{ productOrderId, productOrderStatus: 'DELIVERING' }], unavailable: [] }));
  mount(backend);
  const row = await screen.findByText('네이버 N1');
  const orderRow = row.closest('tr')!;
  expect(await within(orderRow).findByText('결제 11/20(금)')).toBeInTheDocument();
  expect(within(orderRow).getByText('4,500원')).toBeInTheDocument();
  expect(backend.callsTo('POST', smartStorePath)).toHaveLength(0);
  fireEvent.click(row);
  const detail = screen.getByRole('region', { name: /네이버 N1/ });
  expect(await within(detail).findByText('승인')).toBeInTheDocument();
  expect(within(detail).queryByText('PN09SETTLED01')).not.toBeInTheDocument();
  expect(within(detail).queryByText('결제 번호')).not.toBeInTheDocument();
  expect(within(detail).getByText('11/21(토)')).toHaveAttribute('datetime', '2026-11-21');
  expect(within(detail).getByText('4,500원')).toBeInTheDocument();
  expect(within(detail).getByText('정산일')).toBeInTheDocument();
  expect(within(detail).getByText('정산 수수료')).toBeInTheDocument();
  expect(within(detail).getByText('일부 취소 −500원')).toBeInTheDocument();
  expect(within(detail).getByText('정산 후 취소')).toBeInTheDocument();
  expect(within(detail).getByText('아직 정산 전이에요')).toBeInTheDocument();
  expect(await within(detail).findByText('배송 중')).toBeInTheDocument();
  expect(within(detail).getByText(productOrderId)).toBeInTheDocument();
  expect(within(detail).queryByText(/아직 연결된/)).not.toBeInTheDocument();
  expect(backend.callsTo('GET', settlementPath).map(call => call.query)).toEqual([{ page: '1' }]);
  const [lookup] = backend.callsTo('POST', smartStorePath);
  expect(lookup.body).toEqual({ productOrderIds: [productOrderId] });
  expect(lookup.headers.has('idempotency-key')).toBe(false);
  fireEvent.click(within(detail).getByRole('button', { name: '다음 페이지' }));
  expect(await within(detail).findByText('−200원')).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole('button', { name: '이전 페이지' }));
  expect(await within(detail).findByText('승인')).toBeInTheDocument();
  expect(backend.callsTo('GET', settlementPath).map(call => call.query.page)).toEqual(['1', '2']);
  expect(backend.callsTo('POST', smartStorePath)).toHaveLength(1);
  expect(backend.callsTo('POST', /\/(prepare|pickup)$/)).toHaveLength(0);
});

it('retries only the failed link and keeps provider results scoped to the selected order', async () => {
  const backend = fakeBackend();
  const order2 = '202611220001102';
  let attempts = 0;
  let finishFirstOrder!: (result: unknown) => void;
  const firstOrderResult = new Promise(resolve => { finishFirstOrder = resolve; });
  backend.on('GET', '/pos/naver/orders', () => ({
    items: [
      { ...naverOrder('N1'), naverPayPaymentId: 'PN09SETTLED01', smartstoreProductOrderId: productOrderId },
      { ...naverOrder('N2'), smartstoreProductOrderId: order2 },
    ],
    nextCursor: null, status: 'ready',
  }));
  backend.on('GET', settlementPath, () => ++attempts === 1 ? reply(503, { code: 'UNAVAILABLE' })
    : { page: { currentPage: 1, responseCount: 0 }, items: [] });
  backend.on('POST', smartStorePath, call => (call.body as { productOrderIds: string[] }).productOrderIds[0] === productOrderId
    ? firstOrderResult : { items: [], unavailable: [order2] });
  mount(backend);
  fireEvent.click(await screen.findByText('네이버 N1'));
  expect(await screen.findByText('Npay 결제 정보를 불러오지 못했어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  expect(await screen.findByText('아직 정산 전이에요')).toBeInTheDocument();
  expect(backend.callsTo('POST', smartStorePath)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  fireEvent.click(screen.getByText('네이버 N2'));
  expect(await screen.findByText(order2)).toBeInTheDocument();
  expect(screen.getByText('조회할 수 없어요')).toBeInTheDocument();
  await act(async () => finishFirstOrder({ items: [{ productOrderId, productOrderStatus: 'DELIVERING' }], unavailable: [] }));
  expect(screen.queryByText('배송 중')).not.toBeInTheDocument();
  expect(backend.callsTo('GET', settlementPath)).toHaveLength(2);
});

it.each([
  ['ko', '단말 결제는 Npay 정산을 조회할 수 없어요'],
  ['en', 'Npay settlement details are unavailable for terminal payments'],
  ['zh-Hans', '终端付款无法查询 Npay 结算信息'],
  ['zh-Hant', '終端付款無法查詢 Npay 結算資訊'],
] as const)('explains terminal settlement availability for a fixture Connect order in %s', (locale, copy) => {
  const h = setup();
  expect(h.pos.execute({ type: 'cart.type', orderType: 'takeout', meta: h.meta() }).ok).toBe(true);
  const menu = h.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
  const optionIds = menu.groups.filter(group => group.required).map(group => group.options[0].optionId);
  expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, qty: 1, optionIds, meta: h.meta() }).ok).toBe(true);
  h.pos.execute({ type: 'cart.note', text: connectMemo('네이버페이'), meta: h.meta() });
  const billId = getPaymentBillId(h.pos.read());
  const quote = quotePaymentBill(h.pos.read(), billId);
  expect(h.pos.beginApproval({ billId, quoteRevision: quote.revision, splits: [{ method: 'easy_pay', amount: quote.payable }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true);
  const order = h.pos.read().pos.orders.at(-1)!;
  orderStatusRuntime(h.pos).openPos({ tab: 'status', orderId: order.orderId });
  render(<I18nProvider locale={locale}><UiProvider screenPreset={screenPresets.A} reducedMotion>
    <WidgetDataProvider store={h.data}><PosProvider value={h.pos}>
      <OrderScreen run={h.run} onOpenReceipt={() => {}}/>
    </PosProvider></WidgetDataProvider>
  </UiProvider></I18nProvider>);
  expect(screen.getByText('포장 · 커넥트')).toBeInTheDocument();
  expect(screen.getByText('커넥트 · 네이버페이')).toBeInTheDocument();
  expect(screen.getByText(copy).closest('[lang]')).toHaveAttribute('lang', locale);
});
