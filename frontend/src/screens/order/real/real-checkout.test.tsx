import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../../../ui';
import { screenPresets } from '../../../layout/presets';
import { PosProvider } from '../../../pos/react';
import { PosBridgeProvider } from '../../../pos/remote-context';
import { getPaymentBillId } from '../../../pos/loyalty';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { setup } from '../../../pos/loyalty/test-setup';
import { createPortTransport } from '../../../data/reality/00/transport';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { createPosBridge } from '../../../data/reality/02/bridge';
import { createPosRemote } from '../../../data/reality/02/remote';
import { LoyaltyCheckout } from '../loyalty/Checkout';

const day = POS_BUSINESS_DATE;
const line = { orderLineId: 'l1', allocationId: 'a1', menuId: 'm-americano', name: '아메리카노', qty: 1, basePrice: 3000, baseCost: 800, optionPrice: 0, optionCost: 0, recipeVersion: 'v1', options: [], gross: 3000, discount: 0, amount: 3000 };
const page = (items: unknown[]) => ({ items, nextCursor: null, asOf: `${day}T06:45:00.000Z`, sourceRevision: 1 });
const order = { orderId: 'o1', orderNo: 1, billId: 'b1', businessDate: day, orderedAt: `${day}T01:00:00.000Z`, revision: 1, preparation: 'accepted', tableId: null, settlementId: 's1', paymentId: 'p1', amount: 3000, remaining: 3000, lines: [line] };
const receipt = (method: 'cash' | 'card') => ({
  paymentId: 'p1', settlementId: 's1', billId: 'b1', storeName: '시험 카페', orderNos: [1], transactionNo: 'TX-1', approvalNo: method === 'cash' ? 'CASH-1' : 'SVC-1', at: order.orderedAt,
  channel: method === 'cash' ? 'cash_record' : 'terminal_record', terminal: method === 'cash' ? null : { approvalNo: 'A777', receiptNo: null, occurredAt: order.orderedAt },
  amount: 3000, gross: 3000, discount: 0, remaining: 3000, status: 'paid', splits: [{ method, amount: 3000 }],
  lines: [{ orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', qty: 1, options: [], request: '', gross: 3000, discount: 0, amount: 3000 }],
  currentPrepared: false, reversalLines: [{ allocationId: 'a1', orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', quantity: 1, prepared: false }], corrections: [],
});

function mount(method: 'cash' | 'card' = 'cash') {
  const h = setup(), backend = fakeBackend(), transport = createPortTransport(backend.fetch);
  const bridge = createPosBridge({ remote: createPosRemote({ transport, sleep: async () => {}, delaysMs: [0] }), read: h.pos.read, commit: h.actions.commit, reload: () => {}, schedule: () => 0, cancel: () => {} });
  let paid = false;
  backend.on('GET', '/pos/tables', () => page([]));
  backend.on('GET', '/pos/orders', () => page(paid ? [order] : []));
  backend.on('GET', '/pos/bills', () => page([]));
  backend.on('GET', /receipt$/, () => receipt(method));
  backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: [], quote: { quoteRevision: 1, lines: [line], gross: 3000, discount: 0, payable: 3000 } }));
  backend.on('POST', '/pos/bills/b1/payments', () => { paid = true; return { resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: [], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }; });
  const menu = h.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
  expect(h.pos.execute({ type: 'cart.add', menuId: 'm-americano', qty: 1, optionIds: menu.groups.filter(group => group.required).map(group => group.options[0].optionId), meta: h.meta() }).ok).toBe(true);
  const onClose = vi.fn(), onComplete = vi.fn();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
    <LoyaltyCheckout open billId={getPaymentBillId(h.pos.read())} summary="아메리카노 1" returnFocusRef={{ current: null }} onClose={onClose} onComplete={onComplete}/>
  </PosBridgeProvider></PosProvider></UiProvider>);
  return { h, backend, onClose, onComplete };
}
const dialog = () => within(screen.getByRole('dialog'));

describe('F02 real checkout dialog', () => {
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

  it('records a cash sale with one press, empties the cart and reports the order number', async () => {
    const { h, backend, onComplete } = mount();
    expect(screen.getByRole('dialog', { name: '결제' })).toBeInTheDocument();
    fireEvent.click(dialog().getByRole('button', { name: '현금' }));
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
    expect(dialog().getByText('현금으로 받은 금액을 매출로 기록해요')).toBeInTheDocument();
    const confirm = dialog().getByRole('button', { name: /현금 .*3,000.* 받았어요/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(dialog().getByText(/결제했어요 · 주문 #1/)).toBeInTheDocument());
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(1);
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')[0].body).toEqual({ method: 'cash', amount: 3000, quoteRevision: 1 });
    expect(h.pos.read().pos.cart.lines).toEqual([]);
    expect(h.pos.read().pos.orders.map(o => o.orderNo)).toEqual([1]);
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(1), { timeout: 3000 });
  });

  it('asks for the terminal numbers before recording a card payment and sends them', async () => {
    const { backend } = mount('card');
    fireEvent.click(dialog().getByRole('button', { name: '카드' }));
    const confirm = () => dialog().getByRole('button', { name: /카드 .*3,000.* 결제 기록하기/ });
    fireEvent.click(confirm());
    expect(await dialog().findByText('승인번호나 영수증 번호 중 하나를 적어 주세요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
    fireEvent.change(dialog().getByRole('textbox', { name: '승인번호' }), { target: { value: 'A777' } });
    fireEvent.change(dialog().getByRole('textbox', { name: '단말기 결제 시각(시:분)' }), { target: { value: '15:40' } });
    fireEvent.click(confirm());
    await waitFor(() => expect(dialog().getByText(/결제했어요 · 주문 #1/)).toBeInTheDocument());
    expect(backend.callsTo('POST', '/pos/bills/b1/payments')[0].body).toMatchObject({ method: 'card', terminal: { approvalNo: 'A777', occurredAt: `${day}T15:40:00+09:00` } });
  });

  it('rejects slip numbers the service would refuse, a bad slip time, and keeps the confirm single', async () => {
    const { backend } = mount('card');
    fireEvent.click(dialog().getByRole('button', { name: '카드' }));
    const confirm = () => dialog().getByRole('button', { name: /카드 .*3,000.* 결제 기록하기/ });
    fireEvent.change(dialog().getByRole('textbox', { name: '승인번호' }), { target: { value: 'A'.repeat(41) } });
    fireEvent.click(confirm());
    expect(await dialog().findByText('영문, 숫자, -, _ 로 40자까지 적을 수 있어요')).toBeInTheDocument();
    fireEvent.change(dialog().getByRole('textbox', { name: '승인번호' }), { target: { value: '한글번호' } });
    fireEvent.click(confirm());
    expect(await dialog().findByText('영문, 숫자, -, _ 로 40자까지 적을 수 있어요')).toBeInTheDocument();
    fireEvent.change(dialog().getByRole('textbox', { name: '승인번호' }), { target: { value: 'A1' } });
    fireEvent.change(dialog().getByRole('textbox', { name: '단말기 결제 시각(시:분)' }), { target: { value: '25:99' } });
    fireEvent.click(confirm());
    expect(await dialog().findByText('시각을 09:30 모양으로 적어 주세요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
  });

  it('shows the service reason and keeps the cart when the day is closed', async () => {
    const { h, backend } = mount();
    backend.on('POST', '/pos/bills', () => reply(409, { ok: false, code: 'CONFLICT', reason: 'DAY_CLOSED' }));
    fireEvent.click(dialog().getByRole('button', { name: '현금' }));
    fireEvent.click(dialog().getByRole('button', { name: /현금 .* 받았어요/ }));
    expect(await dialog().findByText('오늘 영업을 마감했어요. 마감을 되돌린 뒤 기록해 주세요')).toBeInTheDocument();
    expect(h.pos.read().pos.cart.lines).toHaveLength(1);
    await act(async () => {});
  });

  it('searches masked members without writes and links the selected member only on checkout confirmation', async () => {
    const { backend } = mount();
    backend.on('GET', '/customers', () => page([{ memberId: 'member-1', name: '박회원', phoneMasked: '010-****-4444' }]));
    backend.on('POST', '/pos/bills/b1/member-quote', () => ({ quoteRevision: 72, accountRevision: 0, amountDue: 3000, realAmount: 3000, canSubmit: true, issues: [] }));
    backend.on('POST', '/pos/bills/b1/member-payments', () => ({ resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: ['members'], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }));
    fireEvent.click(dialog().getByRole('button', { name: '회원 찾기' }));
    fireEvent.click(await dialog().findByRole('button', { name: /박○원.*4444/ }));
    fireEvent.click(dialog().getByRole('button', { name: '현금' }));
    expect(backend.callsTo('POST', '/pos/bills')).toHaveLength(0);
    fireEvent.click(dialog().getByRole('button', { name: /현금 .*3,000.* 받았어요/ }));
    await waitFor(() => expect(backend.callsTo('POST', '/pos/bills/b1/member-payments')[0].body).toMatchObject({ memberId: 'member-1', allocations: [{ kind: 'method', method: 'cash', amount: 3000 }] }));
  });
});
