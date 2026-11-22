import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiProvider } from '../../../ui';
import { screenPresets } from '../../../layout/presets';
import { PosProvider } from '../../../pos/react';
import { PosBridgeProvider } from '../../../pos/remote-context';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { setup } from '../../../pos/loyalty/test-setup';
import { createPortTransport } from '../../../data/reality/00/transport';
import { fakeBackend } from '../../../data/reality/00/testing';
import { createPosBridge } from '../../../data/reality/02/bridge';
import { createPosRemote } from '../../../data/reality/02/remote';
import { ReversalReceipt } from '../ReversalReceipt';

const day = POS_BUSINESS_DATE;
const line = { orderLineId: 'l1', allocationId: 'a1', menuId: 'm-americano', name: '아메리카노', qty: 1, basePrice: 3000, baseCost: 800, optionPrice: 0, optionCost: 0, recipeVersion: 'v1', options: [], gross: 3000, discount: 0, amount: 3000 };
const page = (items: unknown[]) => ({ items, nextCursor: null, asOf: `${day}T06:45:00.000Z`, sourceRevision: 1 });
const order = { orderId: 'o1', orderNo: 1, billId: 'b1', businessDate: day, orderedAt: `${day}T01:00:00.000Z`, revision: 1, preparation: 'accepted', tableId: null, settlementId: 's1', paymentId: 'p1', amount: 3000, remaining: 3000, lines: [line] };
const receipt = (method: 'cash' | 'card') => ({
  paymentId: 'p1', settlementId: 's1', billId: 'b1', storeName: '시험 카페', orderNos: [1], transactionNo: 'TX-1', approvalNo: 'SVC-1', at: order.orderedAt,
  channel: method === 'cash' ? 'cash_record' : 'terminal_record', terminal: method === 'cash' ? null : { approvalNo: 'A777', receiptNo: null, occurredAt: order.orderedAt },
  amount: 3000, gross: 3000, discount: 0, remaining: 3000, status: 'paid', splits: [{ method, amount: 3000 }],
  lines: [{ orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', qty: 1, options: [], request: '', gross: 3000, discount: 0, amount: 3000 }],
  currentPrepared: false, reversalLines: [{ allocationId: 'a1', orderLineId: 'l1', menuId: 'm-americano', name: '아메리카노', quantity: 1, prepared: false }], corrections: [],
});

async function mount(method: 'cash' | 'card', memberLedger = false, naverPayPaymentId?: string) {
  const h = setup(), backend = fakeBackend(), transport = createPortTransport(backend.fetch);
  const bridge = createPosBridge({ remote: createPosRemote({ transport, sleep: async () => {}, delaysMs: [0] }), read: h.pos.read, commit: h.actions.commit, reload: () => {}, schedule: () => 0, cancel: () => {} });
  backend.on('GET', '/pos/orders', () => page([order]));
  backend.on('GET', '/pos/bills', () => page([]));
  backend.on('GET', '/pos/tables', () => page([]));
  backend.on('GET', /receipt$/, () => memberLedger ? { ...receipt(method), paymentId: null, containsMemberValue: true, splits: [], memberAllocations: [{ kind: 'charge', amount: 3000 }] } : { ...receipt(method), naverPayPaymentId });
  backend.on('POST', '/pos/payments/p1/reversal-quote', () => ({ quoteToken: 'tok-1', kind: 'cancel', amount: 3000, remaining: 3000, methods: [{ method, amount: 3000 }] }));
  backend.on('POST', '/pos/settlements/s1/corrections', () => ({ resourceId: 'c1', revision: 1, receiptId: 'r9', affectedSources: ['pos.sales'], paymentId: 'p1' }));
  await bridge.sync();
  const onClose = vi.fn();
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><PosProvider value={h.pos}><PosBridgeProvider value={bridge}>
    <ReversalReceipt paymentId={memberLedger ? 's1' : 'p1'} initialView={memberLedger ? 'receipt' : 'cancel'} fromMemberLedger={memberLedger} onClose={onClose}/>
  </PosBridgeProvider></PosProvider></UiProvider>);
  return { h, backend, onClose };
}
const dialog = () => within(screen.queryByRole('alertdialog') ?? screen.getByRole('dialog'));

describe('F02 receipt correction over HTTP', () => {
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

  it('renders an HTTP member settlement in the existing receipt with its real account tender', async () => {
    await mount('cash', true);
    expect(await dialog().findByText('결제 상태')).toBeInTheDocument();
    expect(dialog().getByText('충전 잔액')).toBeInTheDocument();
    expect(dialog().getByText('거래번호')).toBeInTheDocument();
  });

  it('opens the receipt for a linked Npay payment even when asked for a POS correction', async () => {
    const { backend } = await mount('card', false, 'NPAY-P1');
    expect(await dialog().findByText('TX-1')).toBeInTheDocument();
    expect(dialog().queryByRole('button', { name: /취소하기|환불하기/ })).not.toBeInTheDocument();
    expect(backend.callsTo('POST', /reversal-quote|corrections/)).toHaveLength(0);
  });

  it('cancels a cash sale with the service quote token and no terminal record', async () => {
    const { backend } = await mount('cash');
    expect(dialog().queryByRole('textbox', { name: '취소 승인번호' })).not.toBeInTheDocument();
    fireEvent.click(dialog().getByRole('button', { name: /3,000.*(취소하기|취소)/ }));
    await waitFor(() => expect(backend.callsTo('POST', '/pos/settlements/s1/corrections')).toHaveLength(1));
    expect(backend.callsTo('POST', '/pos/settlements/s1/corrections')[0].body).toEqual({ quoteToken: 'tok-1', confirmed: true });
    expect(backend.callsTo('POST', '/pos/payments/p1/reversal-quote')[0].body).toEqual({ kind: 'cancel' });
  });

  it('asks for the terminal return numbers before cancelling a card payment', async () => {
    const { backend } = await mount('card');
    const confirm = () => dialog().getByRole('button', { name: /3,000.*(취소하기|취소)/ });
    fireEvent.click(confirm());
    expect(await dialog().findByText('승인번호나 영수증 번호 중 하나를 적어 주세요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/pos/settlements/s1/corrections')).toHaveLength(0);
    fireEvent.change(dialog().getByRole('textbox', { name: '취소 승인번호' }), { target: { value: 'R-55' } });
    fireEvent.click(dialog().getByRole('button', { name: /다시 시도|3,000.*취소/ }));
    await waitFor(() => expect(backend.callsTo('POST', '/pos/settlements/s1/corrections')).toHaveLength(1));
    expect(backend.callsTo('POST', '/pos/settlements/s1/corrections')[0].body).toMatchObject({ quoteToken: 'tok-1', confirmed: true, terminal: { approvalNo: 'R-55', occurredAt: expect.stringContaining('+09:00') } });
  });
});
