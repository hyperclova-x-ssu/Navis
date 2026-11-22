import '../ui/test-setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { selectPosDayTotals } from '../pos/domain';
import { timePolicy } from '../ui';
import { beginDashboard } from '../app/test-session';
import { createWidgetDataStore } from '../data/widget-data';
import { createSessionActions, sessionGateFor } from '../app/session-actions';
import { orderStatusRuntime } from '../pos/runtime';
import { attachMoneyApprovalScheduler, browserApprovalScheduler } from '../app/pos-host';
import type { PosBridge } from '../data/reality/02/bridge';
import { selectCommonNotice } from '../state';
import { connectOrigin, forgetConnectOrders, isConnectOrderMessage, type ConnectOrderMessage } from './channel';
import { enterConnectOrder, methodFor, resolveLines } from './enter';
import { kioskItem } from './menu';
import { buildAssistantContext, storeFactSource } from '../features/assistant/snapshot';

const americano = kioskItem('m-americano')!;
const optionOf = (group: string, name: string) => { const g = americano.groups.find(x => x.name === group)!; return g.options.find(o => o.name === name)!; };
const ice = optionOf('온도', 'ICE'), grande = optionOf('사이즈', '라지(벤티)');
const message = (over: Partial<ConnectOrderMessage> = {}): ConnectOrderMessage => ({
  v: 1, type: 'order', id: 'kiosk-order-1', orderType: 'takeout', total: 7600, payment: '네이버페이', buzzer: '123', paidAt: '2026-11-22T12:00:00.000Z',
  lines: [{ menuId: 'm-americano', name: '아메리카노', qty: 2, unitPrice: 3800, options: [
    { optionId: ice.id, name: ice.name, extraPrice: 0 }, { optionId: grande.id, name: grande.name, extraPrice: grande.extraPrice }] }],
  ...over,
});

function setup() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => Date.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  const store = createWidgetDataStore({ shopSettings: { ...run.getState().shopSettings, layoutActivated: false } }, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const session = createSessionActions(run, store);
  const stop = attachMoneyApprovalScheduler(session.money, browserApprovalScheduler);
  const runtime = orderStatusRuntime(session.pos);
  return { run, runtime, store, stop, deps: { run, runtime, bridge: null as PosBridge | null } };
}
afterEach(() => { forgetConnectOrders(); vi.restoreAllMocks(); });

describe('a paid kiosk order enters the Navis POS through its own command path', () => {
  it('becomes one paid, highlighted order in 주문현황, in the P&L, with its 커넥트 label and one notice line', async () => {
    const { run, runtime, stop, deps } = setup();
    const before = runtime.read().pos, totals = selectPosDayTotals(before);
    const result = await enterConnectOrder(deps, message());
    expect(result).toBe('done');
    const pos = run.getState().pos;
    expect(pos.orders).toHaveLength(before.orders.length + 1);
    const order = pos.orders.at(-1)!;
    expect(order).toMatchObject({ type: 'takeout', preparation: 'accepted', memo: '커넥트 · 네이버페이' });
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]).toMatchObject({ menuId: 'm-americano', qty: 2, unitPriceAtOrder: 3800 });
    expect(order.lines[0].optionsAtOrder.map(o => o.name).sort()).toEqual(['ICE', '라지(벤티)']);
    expect(connectOrigin(order)).toEqual({ source: '커넥트', payment: '네이버페이' });
    // paid through the ordinary approval: one new payment, 간편결제 for Naver Pay, the day's revenue moves
    expect(pos.payments).toHaveLength(before.payments.length + 1);
    expect(pos.payments.at(-1)).toMatchObject({ amount: 7600, status: 'paid', countedMethod: 'easy_pay' });
    expect(selectPosDayTotals(pos).revenue).toBe(totals.revenue + 7600);
    expect(pos.cart.lines).toHaveLength(0);
    // POS 주문현황 opens on the new order, highlighted; one common-notice line; nothing is left pending
    expect(run.getState().layer).toBe('orders-payment');
    expect(run.getState().posUi).toMatchObject({ tab: 'status', selectedOrderId: order.orderId, orderHighlight: { orderId: order.orderId } });
    expect(run.getState().posUi.approval).toBeNull();
    expect(selectCommonNotice(run.getState())).toMatchObject({ kind: 'complete', messageKey: 'pos.connectOrder' });
    // the owner's existing prepare → ready flow works on it
    const started = runtime.execute({ type: 'order.start', orderId: order.orderId, meta: { runId: run.getState().runId, idempotencyKey: 'start-1' } });
    expect(started.ok).toBe(true);
    expect(run.getState().pos.orders.at(-1)!.preparation).toBe('preparing');
    stop(); run.dispose();
  }, 30_000);

  it('the chatbot’s existing reads see the new order: 주문 확인해줘 → POS order counts, 최근 결제된 거 있어? → the sales ledger (no per-order fact exists)', async () => {
    const { run, store, stop, deps } = setup();
    const source = storeFactSource(store);
    const entries = (text: string) => buildAssistantContext({ source, text }).snapshot;
    const posCounts = (text: string) => {
      const entry = entries(text).find(item => 'sourceId' in item && item.sourceId === 'pos');
      return entry && 'facts' in entry ? Object.fromEntries(entry.facts.map(fact => [fact.key, fact.value])) : {};
    };
    const ledger = (text: string) => entries(text).flatMap(item => 'featureId' in item && item.featureId === 'ledger' && 'facts' in item ? item.facts : [])
      .filter(fact => typeof fact.value === 'number').map(fact => Number(fact.value));
    const countsBefore = posCounts('주문 확인해줘'), ledgerBefore = ledger('최근 결제된 거 있어?');
    expect(entries('최근 결제된 거 있어?').some(item => 'sourceId' in item && item.sourceId === 'pos')).toBe(false);
    expect(await enterConnectOrder(deps, message())).toBe('done');
    const countsAfter = posCounts('주문 확인해줘'), ledgerAfter = ledger('최근 결제된 거 있어?');
    expect(countsAfter['orders.today.count']).toBe(Number(countsBefore['orders.today.count']) + 1);
    expect(countsAfter['orders.open.count']).toBe(Number(countsBefore['orders.open.count']) + 1);
    // the ledger facts moved by exactly the order's 7,600 on at least one sales figure (net sales, 간편결제 sales)
    expect(ledgerAfter.filter((value, index) => value - ledgerBefore[index] === 7600).length).toBeGreaterThan(0);
    stop(); run.dispose();
  }, 30_000);

  it('records card and 삼성·애플·NFC as card, 네이버페이 and 페이스사인 as 간편결제 (display names only)', () => {
    expect(methodFor('카드')).toBe('card');
    expect(methodFor('삼성·애플·NFC')).toBe('card');
    expect(methodFor('네이버페이')).toBe('easy_pay');
    expect(methodFor('페이스사인')).toBe('easy_pay');
  });

  it('waits while the owner has items in the cart or a payment is pending, and changes nothing', async () => {
    const { run, runtime, stop, deps } = setup();
    runtime.execute({ type: 'cart.add', menuId: 'm-americano', optionIds: [ice.id, optionOf('사이즈', '레귤러').id], qty: 1, meta: { runId: run.getState().runId, idempotencyKey: 'owner-1' } });
    const before = run.getState().pos;
    expect(await enterConnectOrder(deps, message())).toBe('retry');
    expect(run.getState().pos).toBe(before);
    stop(); run.dispose();
  });

  it('refuses a menu it cannot find, shows the failure notice and leaves no half-filled cart', async () => {
    const { run, stop, deps } = setup();
    const result = await enterConnectOrder(deps, message({ lines: [{ menuId: 'm-nope', name: '없는 메뉴', qty: 1, unitPrice: 1000, options: [] }] }));
    expect(result).toBe('drop');
    expect(run.getState().pos.cart.lines).toHaveLength(0);
    expect(run.getState().pos.orders.length).toBe(deps.runtime.read().pos.orders.length);
    expect(selectCommonNotice(run.getState())).toMatchObject({ kind: 'error', messageKey: 'pos.connectFailed' });
    stop(); run.dispose();
  });

  it('finds the same menu and options by name when the Navis ids differ from the kiosk seed (HTTP data)', () => {
    const { run, runtime, stop } = setup();
    const lines = resolveLines(runtime.read(), message({ lines: [{ menuId: 'other-id', name: '아메리카노', qty: 1, unitPrice: 3800,
      options: [{ optionId: 'x1', name: 'ICE', extraPrice: 0 }, { optionId: 'x2', name: '라지(벤티)', extraPrice: 800 }] }] }).lines);
    expect(lines).toEqual([{ menuId: 'm-americano', optionIds: [ice.id, grande.id], qty: 1 }]);
    expect(resolveLines(runtime.read(), [{ menuId: 'm-americano', name: '아메리카노', qty: 1, unitPrice: 3000, options: [{ optionId: 'x', name: '없는 옵션', extraPrice: 0 }] }])).toBeNull();
    stop(); run.dispose();
  });

  it('over HTTP the POS service records the sale (one checkout, a kiosk reference), the label is remembered and the cart is left clean', async () => {
    const { run, runtime, stop } = setup();
    const checkout = vi.fn(async () => ({ status: 'paid' as const, orderNo: 777, paymentId: 'P-777', billId: 'B-777' }));
    const bridge = { checkout } as unknown as PosBridge;
    const result = await enterConnectOrder({ run, runtime, bridge }, message({ id: 'abc-123-def', payment: '페이스사인' }));
    expect(result).toBe('done');
    expect(checkout).toHaveBeenCalledTimes(1);
    const call = checkout.mock.calls[0] as unknown as [{ method: string; expectedPayable: number; attemptId: string; terminal: { approvalNo: string; at: string } }];
    expect(call[0]).toMatchObject({ method: 'easy_pay', expectedPayable: 7600, attemptId: 'abc-123-def' });
    expect(call[0].terminal.approvalNo).toMatch(/^NC-[A-Za-z0-9]+$/);
    expect(connectOrigin({ orderNo: 777 })).toEqual({ source: '커넥트', payment: '페이스사인' });
    expect(run.getState().pos.cart.lines).toHaveLength(0);
    expect(selectCommonNotice(run.getState())).toMatchObject({ messageKey: 'pos.connectOrder' });
    stop(); run.dispose();
  });
});

describe('the kiosk → Navis message', () => {
  it('accepts only well-formed orders', () => {
    expect(isConnectOrderMessage(message())).toBe(true);
    expect(isConnectOrderMessage({ ...message(), lines: [] })).toBe(false);
    expect(isConnectOrderMessage({ ...message(), v: 2 })).toBe(false);
    expect(isConnectOrderMessage({ ...message(), orderType: 'delivery' })).toBe(false);
    expect(isConnectOrderMessage(null)).toBe(false);
  });
});
