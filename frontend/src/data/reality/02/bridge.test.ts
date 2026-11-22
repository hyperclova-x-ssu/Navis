import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POS_BUSINESS_DATE } from '../../../pos/clock';
import { setup } from '../../../pos/loyalty/test-setup';
import { selectReceipt } from '../../../pos/reversals';
import { createPortTransport } from '../00/transport';
import { fakeBackend, reply } from '../00/testing';
import { createPosBridge } from './bridge';
import { createPosRemote } from './remote';

const day = POS_BUSINESS_DATE;
const ids = { menu: '8d1f3c36-0d3c-4d0e-9a3a-000000000001' };
const saleLine = { orderLineId: 'l1', allocationId: 'a1', menuId: ids.menu, name: '아메리카노', qty: 1, basePrice: 4500, baseCost: 800, optionPrice: 0, optionCost: 0, recipeVersion: 'v1', options: [], gross: 4500, discount: 0, amount: 4500 };
const orderRow = (remaining = 4500, preparation = 'accepted') => ({
  orderId: 'o1', orderNo: 1, billId: 'b1', businessDate: day, orderedAt: `${day}T01:00:00.000Z`, revision: 1, preparation, tableId: null,
  settlementId: 's1', paymentId: 'p1', amount: 4500, remaining, lines: [saleLine],
});
const receiptRow = (remaining = 4500) => ({
  paymentId: 'p1', settlementId: 's1', billId: 'b1', storeName: '시험 카페', orderNos: [1], transactionNo: 'TX-1', approvalNo: 'CASH', at: `${day}T01:00:00.000Z`, channel: 'cash_record', terminal: null,
  amount: 4500, gross: 4500, discount: 0, remaining, status: 'paid', splits: [{ method: 'cash', amount: 4500 }],
  lines: [{ orderLineId: 'l1', menuId: ids.menu, name: '아메리카노', qty: 1, options: [], request: '', gross: 4500, discount: 0, amount: 4500 }],
  currentPrepared: false, reversalLines: [{ allocationId: 'a1', orderLineId: 'l1', menuId: ids.menu, name: '아메리카노', quantity: 1, prepared: false }], corrections: [],
});
const page = (items: unknown[]) => ({ items, nextCursor: null, asOf: `${day}T06:45:00.000Z`, sourceRevision: 1 });

function make() {
  const h = setup();
  const backend = fakeBackend();
  backend.on('GET', '/pos/tables', () => page([]));
  const transport = createPortTransport(backend.fetch);
  const remote = createPosRemote({ transport, sleep: async () => {}, delaysMs: [0] });
  const reloaded: string[][] = [];
  const timers: (() => void)[] = [];
  const bridge = createPosBridge({
    remote, read: h.pos.read, commit: h.actions.commit, reload: domains => { reloaded.push([...domains]); },
    schedule: callback => { timers.push(callback); return timers.length; }, cancel: () => {},
  });
  return { h, backend, bridge, reloaded, timers };
}
const addAmericano = (h: ReturnType<typeof setup>) => {
  const menu = h.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
  const optionIds = menu.groups.filter(group => group.required).map(group => group.options[0].optionId);
  return h.pos.execute({ type: 'cart.add', menuId: 'm-americano', qty: 1, optionIds, meta: h.meta() });
};

describe('F02 POS bridge', () => {
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('publishes the business day on start and skips an unchanged re-read', async () => {
    const { h, backend, bridge } = make();
    backend.on('GET', '/pos/orders', () => page([orderRow()]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /receipt$/, () => receiptRow());
    expect((await bridge.sync()).status).toBe('ready');
    expect(h.pos.read().pos.orders).toHaveLength(1);
    const revision = h.pos.read().posRevision;
    await bridge.sync({ force: true });
    expect(h.pos.read().posRevision).toBe(revision);
    expect(selectReceipt(h.pos.read(), { paymentId: 'p1' })).toMatchObject({ approvalNo: 'CASH', amount: 4500 });
  });

  it('shows an error state with the cause when the service is unreachable and keeps the run untouched', async () => {
    const { h, backend, bridge } = make();
    backend.on('GET', '/pos/orders', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    backend.on('GET', '/pos/bills', () => page([]));
    const state = await bridge.sync();
    expect(state).toMatchObject({ status: 'error', error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(h.pos.read().pos.orders).toEqual([]);
  });

  it('records a checkout, empties the cart, publishes the order and re-reads stock now and after the relay delay', async () => {
    const { h, backend, bridge, reloaded, timers } = make();
    let paid = false;
    backend.on('GET', '/pos/orders', () => page(paid ? [orderRow()] : []));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /receipt$/, () => receiptRow());
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b1', revision: 1, receiptId: 'r1', affectedSources: ['pos.bills'], quote: { quoteRevision: 1, lines: [saleLine], gross: 4500, discount: 0, payable: 4500 } }));
    backend.on('POST', '/pos/bills/b1/payments', () => { paid = true; return { resourceId: 'p1', revision: 1, receiptId: 'r2', affectedSources: ['pos.orders'], billId: 'b1', orderId: 'o1', paymentId: 'p1', settlementId: 's1' }; });
    await bridge.sync();
    expect(addAmericano(h)).toMatchObject({ ok: true });
    const payable = h.pos.read().pos.cart.lines.length;
    expect(payable).toBe(1);
    const outcome = await bridge.checkout({ attemptId: 'a1', method: 'cash', expectedPayable: 4500 });
    expect(outcome).toEqual({ status: 'paid', orderNo: 1, paymentId: 'p1', billId: 'b1' });
    expect(h.pos.read().pos.cart.lines).toEqual([]);
    expect(h.pos.read().pos.cart.revision).toBeGreaterThan(0);
    expect(backend.callsTo('POST', '/pos/bills')[0].body).toMatchObject({ type: h.pos.read().pos.cart.type, lines: [{ menuId: 'm-americano', qty: 1 }] });
    expect(reloaded).toEqual([['stock']]);
    timers.forEach(fire => fire());
    expect(reloaded).toEqual([['stock'], ['stock'], ['stock']]);
  });

  it('keeps the cart and reports the new amount when the service price differs', async () => {
    const { h, backend, bridge, reloaded } = make();
    backend.on('GET', '/pos/orders', () => page([]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('POST', '/pos/bills', () => ({ resourceId: 'b9', revision: 1, receiptId: 'r1', affectedSources: [], quote: { quoteRevision: 2, lines: [saleLine], gross: 5000, discount: 0, payable: 5000 } }));
    addAmericano(h);
    const outcome = await bridge.checkout({ attemptId: 'a1', method: 'cash', expectedPayable: 4500 });
    expect(outcome).toEqual({ status: 'quote-changed', billId: 'b9', payable: 5000 });
    expect(h.pos.read().pos.cart.lines).toHaveLength(1);
    expect(reloaded).toEqual([]);
  });

  it('keeps the cart when the day is closed and names the reason', async () => {
    const { h, backend, bridge } = make();
    backend.on('POST', '/pos/bills', () => reply(409, { ok: false, code: 'CONFLICT', reason: 'DAY_CLOSED' }));
    addAmericano(h);
    expect(await bridge.checkout({ attemptId: 'a1', method: 'cash', expectedPayable: 4500 })).toEqual({ status: 'failed', reason: 'DAY_CLOSED', field: undefined, outcomeUnknown: false });
    expect(h.pos.read().pos.cart.lines).toHaveLength(1);
  });

  it('moves an order through preparation with the service revision and re-reads', async () => {
    const { h, backend, bridge } = make();
    let preparation = 'accepted';
    backend.on('GET', '/pos/orders', () => page([{ ...orderRow(4500, preparation), revision: preparation === 'accepted' ? 1 : 2 }]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /receipt$/, () => receiptRow());
    backend.on('POST', '/pos/orders/o1/preparation', () => { preparation = 'preparing'; return { resourceId: 'o1', revision: 2, receiptId: 'r5', affectedSources: ['pos.orders'] }; });
    await bridge.sync();
    expect(await bridge.setPreparation('o1', 'preparing')).toMatchObject({ ok: true });
    expect(backend.callsTo('POST', '/pos/orders/o1/preparation')[0].body).toEqual({ status: 'preparing', expectedRevision: 1 });
    expect(h.pos.read().pos.orders[0].preparation).toBe('preparing');
    expect(await bridge.setPreparation('missing', 'completed')).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('F02 POS bridge scope reset', () => {
  beforeEach(() => { vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'http'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('shows no sales after sign-out or a store change and re-reads when asked', async () => {
    const { h, backend, bridge } = make();
    backend.on('GET', '/pos/orders', () => page([orderRow()]));
    backend.on('GET', '/pos/bills', () => page([]));
    backend.on('GET', /receipt$/, () => receiptRow());
    await bridge.sync();
    expect(h.pos.read().pos.orders).toHaveLength(1);
    bridge.clearRows();
    expect(h.pos.read().pos.orders).toEqual([]);
    expect(h.pos.read().pos.payments).toEqual([]);
    expect(bridge.state().status).toBe('idle');
    await bridge.sync({ force: true });
    expect(h.pos.read().pos.orders).toHaveLength(1);
  });
});
