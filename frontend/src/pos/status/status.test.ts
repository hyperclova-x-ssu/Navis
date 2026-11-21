import { describe, expect, it } from 'vitest';
import type { PosOrder, PosReadSnapshot, PosState } from '../../contracts/pos';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import { createPosSeed, createPosSeedCatalog, createPosUi } from '../seed';
import { createTableLayout } from '../../layout/table-layout';
import { setup as setupBase } from '../loyalty/test-setup';
import { quotePaymentBill } from '../loyalty';
import { selectTableMap } from '../tables';
import { quoteReversal } from '../reversals';
import {
applyOrderStatusCommand, createOrderStatusSlice, dismissOrderAlert, evaluateOrderAlert,
  initialOrderAlert, pauseOrderUndo, resumeOrderUndo, seenOrderAlert, selectOrderSummary,
} from './index';
import { seedToday } from '../../data/db/generated/today';

function setupPaymentRun(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}

const T0 = 1_000_000;
const catalog = createPosSeedCatalog();
const cafe = createPosSeed();
const [recent, slow, missing] = cafe.orders.slice(-3);
const at = (time: string) => `${POS_BUSINESS_DATE}T${time}`;

function activeOrders(): PosState {
  // The cafe opens with all orders completed. Stage three real orders for queue tests.
  return { ...cafe, orders: cafe.orders.map(order => {
    if (order === missing) return { ...order, orderedAt: at('15:18'), preparation: 'accepted', completedAt: null };
    if (order === slow) return { ...order, orderedAt: at('15:30'), preparation: 'preparing', preparedAt: at('15:31'), completedAt: null };
    if (order === recent) return { ...order, orderedAt: at('15:42'), preparation: 'accepted', completedAt: null };
    return order;
  }) };
}
const read = (pos = activeOrders()): PosReadSnapshot => ({
  runId: 'status-test', runRevision: 0, pos, posRevision: pos.revision, posUi: createPosUi(),
  dataRevision: 0, settings: { businessType: 'cafe', paymentStyle: 'prepaid', tableLayout: null, revision: 0 },
  scenario: 'normal', data: { revision: 0, catalog, dayClosed: false, closingGeneration: 0 },
});
const context = { onDashboard: true, coachVisible: false, overlayOpen: false, orderDetailOpen: false };

describe('API-245 shared order summary', () => {
  it('derives the cafe timing metrics and keeps order gross separate from net revenue', () => {
    const summary = selectOrderSummary(read(cafe));
    expect(summary).toMatchObject({
      todayCount: cafe.orders.length, orderGross: 859500, netRevenue: seedToday.rollup.net, doneCount: cafe.orders.length, openCount: 0,
      canceledCount: 0, avgWaitMin: 0.5, missingCount: 0, slowCount: 0, recent10: 5, prev10: 3, rush: false,
    });
    expect(summary.rows).toEqual([]);
    expect(selectOrderSummary(read(cafe), { filter: 'done' }).rows.map(row => row.orderNo)).toEqual(cafe.orders.map(order => order.orderNo).reverse());
    expect(selectOrderSummary(read(cafe), { filter: 'canceled' }).rows).toEqual([]);

    const queue = selectOrderSummary(read());
    expect(queue.rows.map(row => row.orderId)).toEqual([missing.orderId, slow.orderId, recent.orderId]);
    expect(queue.rows.map(row => [row.elapsedMin, row.usualMin, row.preparation, row.paymentStatus])).toEqual([
      [27, 3, 'accepted', 'paid'], [15, 3, 'preparing', 'paid'], [3, 3, 'accepted', 'paid'],
    ]);
  });

  it('joins preparation by menu ID, including renamed, removed and new menus; cache follows every input', () => {
    const snapshot = read();
    const renamed = { ...catalog, items: catalog.items.map(item => ({ ...item, name: '동일한 이름' })) };
    const input = { ...snapshot, data: { ...snapshot.data, catalog: renamed } };
    expect(selectOrderSummary(input).rows.map(row => row.usualMin)).toEqual([3, 3, 3]);
    expect(selectOrderSummary(snapshot)).toBe(selectOrderSummary({ ...snapshot }));
    const later = selectOrderSummary(snapshot, { businessNow: at('16:00') });
    expect(later).toMatchObject({ missingCount: 2, slowCount: 1, recent10: 0 });
    const newOrder: PosOrder = { ...recent, orderId: 'new', orderNo: 154, preparation: 'accepted', completedAt: null,
      lines: [{ ...recent.lines[0], menuId: 'new-menu', qty: 1 }] };
    const unknown = { ...snapshot, pos: { ...snapshot.pos, orders: [newOrder] }, data: { ...snapshot.data, catalog: { ...catalog, items: [] } } };
    expect(selectOrderSummary(unknown).rows[0].usualMin).toBe(3);
    const override = { ...catalog, items: catalog.items.map(item => ({ ...item, prepMin: 8 })) };
    expect(selectOrderSummary({ ...snapshot, data: { ...snapshot.data, catalog: override } }).rows.map(row => row.usualMin)).toEqual([8, 8, 8]);
    expect(selectOrderSummary({ ...snapshot, scenario: 'empty' })).toMatchObject({ todayCount: 0, orderGross: 0, netRevenue: 0, avgWaitMin: null, rows: [] });
  });

  it('excludes canceled orders from timing, active counts and rush without hiding their history', () => {
    const pos = activeOrders();
    const orders = pos.orders.map(order => order.orderNo >= recent.orderNo ? { ...order, preparation: 'canceled' as const } : order);
    const summary = selectOrderSummary(read({ ...pos, orders }), { filter: 'canceled' });
    expect(summary).toMatchObject({ todayCount: 150, canceledCount: 3, openCount: 0, missingCount: 0, slowCount: 0, avgWaitMin: 0.5, recent10: 2, prev10: 3, rush: false });
    expect(summary.rows.map(row => row.orderNo)).toEqual([missing.orderNo, slow.orderNo, recent.orderNo]);
    expect(summary.rows.every(row => row.waitMin === null && !row.canReopen)).toBe(true);
    expect(selectOrderSummary(read({ ...pos, orders }), { filter: 'all' }).rows).toHaveLength(153);
  });

  it('enforces all three rush conditions and the exact 10/20-minute boundaries', () => {
    const seed = activeOrders();
    const extra = Array.from({ length: 5 }, (_, i): PosOrder => ({ ...seed.orders.find(order => order.orderId === recent.orderId)!,
      orderId: `new-${i}`, orderNo: 154 + i, seq: 154 + i, orderedAt: POS_NOW,
    }));
    const pos = { ...seed, orders: [...seed.orders, ...extra] };
    expect(selectOrderSummary(read(pos))).toMatchObject({ recent10: 8, prev10: 4, openCount: 8, rush: true });
    expect(selectOrderSummary(read({ ...pos, orders: pos.orders.map(order => ({ ...order, preparation: 'completed', completedAt: POS_NOW })) }))).toMatchObject({ openCount: 0, rush: false });
    const boundary = extra.map((order, i) => ({ ...order, orderedAt: [at('15:25'), at('15:35'), at('15:36'), POS_NOW, at('15:46')][i] }));
    expect(selectOrderSummary(read({ ...seed, orders: boundary }))).toMatchObject({ recent10: 2, prev10: 1, rush: false });
    const equal = extra.slice(0, 4).map(order => ({ ...order, orderId: `${order.orderId}-previous`, orderedAt: at('15:30') }));
    expect(selectOrderSummary(read({ ...pos, orders: [...pos.orders, ...equal] }))).toMatchObject({ recent10: 8, prev10: 8, rush: false });
  });

  it('joins current allocations to bills and ledger, with distinct partial/refund/cancel payment states', () => {
    const seed = activeOrders(), order = seed.orders.find(order => order.orderId === missing.orderId)!;
    const allocation = seed.billAllocations.find(a => a.orderLineId === order.lines[0].orderLineId)!;
    const origin = seed.bills.find(b => b.billId === order.originBillId)!;
    const moved = { ...origin, billId: 'moved', tableId: 'T10', status: 'open' as const, recognizedAt: undefined };
    const second = { ...moved, billId: 'split', tableId: 'T2' };
    const pos: PosState = { ...seed, bills: [...seed.bills, moved, second], billAllocations: seed.billAllocations.map(a => a === allocation ? { ...a, billId: moved.billId } : a).concat({ ...allocation, allocationId: 'split', billId: second.billId }) };
    const row = selectOrderSummary(read(pos)).rows[0];
    expect(row).toMatchObject({ paymentStatus: 'unpaid', tableIds: ['T2', 'T10'], billIds: ['moved', 'split'], amount: 3000 });
    expect(selectOrderSummary(read({ ...pos, bills: pos.bills.map(b => b.billId === 'moved' ? { ...b, status: 'partial' } : b) })).rows[0].paymentStatus).toBe('partial');
    expect(selectOrderSummary(read(cafe), { filter: 'done' }).rows.find(r => r.orderId === missing.orderId)?.paymentStatus).toBe('paid');
    const payment = seed.payments.find(p => p.billId === order.originBillId)!;
    const refunded = { ...seed, refunds: [{ refundId: 'refund', at: POS_NOW, seq: 999, billId: order.originBillId, paymentId: payment.paymentId, amount: 3000, methodAmounts: [{ method: 'card' as const, amount: 3000 }], lineAmounts: [], reason: '' }] };
    expect(selectOrderSummary(read(refunded)).rows[0].paymentStatus).toBe('refunded');
    expect(selectOrderSummary(read({ ...refunded, orders: cafe.orders }), { filter: 'done' }).rows
      .find(r => r.orderId === order.orderId)?.paymentStatus).toBe('refunded');
    expect(selectOrderSummary(read({ ...refunded, refunds: [{ ...refunded.refunds[0], amount: 1000 }] })).rows[0].paymentStatus).toBe('partially_refunded');
    expect(selectOrderSummary(read({ ...seed, payments: seed.payments.map(p => p === payment ? { ...p, status: 'canceled' } : p), bills: seed.bills.map(b => b === origin ? { ...b, status: 'void' } : b) })).rows[0].paymentStatus).toBe('canceled');
    const cancellation = { cancellationId: 'cancel', billId: origin.billId, paymentId: payment.paymentId, at: POS_NOW, seq: 999, amount: 1000, methodAmounts: [], allocations: [], reason: '', restockRetail: false };
    expect(selectOrderSummary(read({ ...seed, cancellations: [cancellation] })).rows[0].paymentStatus).toBe('partially_canceled');
  });

  it('retains quantities and original amount for fully canceled order history', () => {
    const seed = activeOrders();
    const order = { ...missing, preparation: 'canceled' as const,
      lines: missing.lines.map(line => ({ ...line, qty: 3, canceledQty: 3 })) };
    const summary = selectOrderSummary(read({ ...seed, orders: [order] }), { filter: 'canceled' });
    expect(summary).toMatchObject({ todayCount: 0, recent10: 0, prev10: 0 });
    expect(summary.rows[0]).toMatchObject({ amount: 9000, items: [{ menuId: 'm-americano', qty: 3 }], isMissing: false });
  });

  it('keeps both postpaid orders paid after abandoning partial cash and retrying the full bill by card', () => {
    const h = setupPaymentRun('postpaid');
    expect(h.pos.execute({ type: 'table.saveLayout', layout: createTableLayout(), expectedSettingsRevision: h.pos.read().settings.revision, meta: h.meta() }).ok).toBe(true);
    expect(h.add('m-basque-cake').ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.submitOrder', tableId: 'T1', cartId: h.pos.read().pos.cart.cartId, meta: h.meta() }).ok).toBe(true);
    const billId = h.pos.read().pos.bills.find(bill => bill.status === 'open')!.billId;
    expect(h.add('m-americano').ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.submitOrder', billId, tableId: 'T1', cartId: h.pos.read().pos.cart.cartId, meta: h.meta() }).ok).toBe(true);
    const orders = h.pos.read().pos.orders.slice(-2);
    const statuses = () => selectOrderSummary(h.pos.read()).rows.filter(row => orders.some(order => order.orderId === row.orderId)).map(row => row.paymentStatus);
    expect(quotePaymentBill(h.pos.read(), billId).payable).toBe(8200);
    expect(h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() }).ok).toBe(true);
    let quote = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, partId: quote.parts[0].partId, quoteRevision: quote.revision, splits: [{ method: 'cash', amount: 4100 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
    expect(statuses()).toEqual(['partial', 'partial']);
    expect(h.pos.execute({ type: 'bill.cancelPartial', billId, confirmed: true, meta: h.meta() }).ok).toBe(true);
    expect(h.pos.read().pos.payments.at(-1)).toMatchObject({ status: 'canceled', recognizedAt: null });
    expect(selectTableMap(h.pos.read()).tables.find(table => table.tableId === 'T1')?.state).toBe('occupied');
    const afterAbandoning = statuses();
    quote = quotePaymentBill(h.pos.read(), billId);
    expect(quote).toMatchObject({ received: 0, remaining: 8200 });
    expect(h.pos.beginApproval({ billId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: 8200 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
    expect(h.pos.read().pos.payments.at(-1)).toMatchObject({ status: 'paid', recognizedAt: POS_NOW });
    expect(statuses()).toEqual(['paid', 'paid']);
    expect(afterAbandoning).toEqual(['unpaid', 'unpaid']);

    // A subsequent cancellation of a recognized sale must still affect both linked orders.
    const paymentId = h.pos.read().pos.payments.at(-1)!.paymentId;
    const reversal = quoteReversal(h.pos.read(), { paymentId, kind: 'cancel', lines: [{ orderLineId: orders[0].lines[0].orderLineId, qty: 1 }] });
    expect(reversal.canSubmit).toBe(true);
    expect(h.pos.execute({ type: 'payment.reverse', quoteToken: reversal.quoteToken, confirmed: true, meta: h.meta() }).ok).toBe(true);
    expect(statuses()).toEqual(['partially_canceled', 'partially_canceled']);
  });

  it('does not subtract an already canceled payment again when classifying a later refund', () => {
    const seed = activeOrders(), billId = seed.orders.find(order => order.orderId === missing.orderId)!.originBillId;
    const payment = seed.payments.find(p => p.billId === billId)!;
    const canceled = { ...payment, paymentId: 'old-canceled', amount: 3000, status: 'canceled' as const };
    const cancellation = { cancellationId: 'old-cancel', paymentId: canceled.paymentId, billId, at: POS_NOW, seq: 100, amount: 3000, methodAmounts: [], allocations: [], reason: '', restockRetail: false };
    const pos = { ...seed, payments: [...seed.payments, canceled], cancellations: [cancellation],
      refunds: [{ refundId: 'refund', at: POS_NOW, seq: 1000, paymentId: payment.paymentId, billId, amount: 2000, methodAmounts: [{ method: 'card' as const, amount: 2000 }], lineAmounts: [], reason: '' }] };
    expect(selectOrderSummary(read(pos)).rows[0].paymentStatus).toBe('partially_refunded');
  });

  it('uses strict slow and inclusive missing thresholds and ignores canceled quantities for usual time', () => {
    const seed = activeOrders();
    const orders = [6, 7, 19, 20].map((elapsed, index): PosOrder => ({ ...seed.orders.find(order => order.orderId === missing.orderId)!, orderId: `threshold-${index}`, orderNo: 154 + index,
      orderedAt: at(`15:${45 - elapsed}`), lines: [{ ...seed.orders.find(order => order.orderId === missing.orderId)!.lines[0], qty: 3, canceledQty: 2 }] }));
    const summary = selectOrderSummary(read({ ...seed, orders }));
    expect(summary).toMatchObject({ missingCount: 1, slowCount: 2 });
    expect(summary.rows.map(row => [row.elapsedMin, row.usualMin, row.isSlow, row.isMissing])).toEqual([
      [20, 3, false, true], [19, 3, true, false], [7, 3, true, false], [6, 3, false, false],
    ]);
  });

  it('keeps unrecognized postpaid orders out of order gross and net revenue', () => {
    const seed = activeOrders();
    const order: PosOrder = { ...seed.orders.find(order => order.orderId === missing.orderId)!, orderId: 'postpaid', orderNo: 154, originBillId: 'unpaid', orderedAt: POS_NOW, lines: [{ ...missing.lines[0], orderLineId: 'postpaid-line', qty: 1 }] };
    const pos: PosState = { ...seed, orders: [...seed.orders, order], bills: [...seed.bills, { billId: 'unpaid', originOrderNo: 154, tableId: 'T1', status: 'open', discounts: [], settlementLines: [] }], billAllocations: [...seed.billAllocations, { allocationId: 'postpaid-allocation', billId: 'unpaid', orderLineId: 'postpaid-line', qty: 1 }] };
    expect(selectOrderSummary(read(pos))).toMatchObject({ todayCount: 154, orderGross: 859500, netRevenue: seedToday.rollup.net, openCount: 4 });
    expect(selectOrderSummary(read(pos)).rows.at(-1)).toMatchObject({ orderNo: 154, amount: 3000, paymentStatus: 'unpaid' });
  });
});

describe('SL-242 order processing and alert state', () => {
  it('starts a recent order, completes a missing order, pauses/undoes and reopens while preserving ledger and alert seen IDs', () => {
    const seed = activeOrders();
    let slice = createOrderStatusSlice(seed);
    const act = (command: Parameters<typeof applyOrderStatusCommand>[1], now = T0) => {
      const outcome = applyOrderStatusCommand(slice, command, { now, businessNow: POS_NOW });
      expect(outcome.result.status).toBe('applied'); slice = outcome.slice;
    };
    let alert = evaluateOrderAlert(initialOrderAlert, selectOrderSummary(read(slice.pos)), context);
    expect(alert).toEqual({ visible: true, notifiedIds: [missing.orderId] });
    act({ type: 'order.start', orderId: recent.orderId });
    expect(slice.pos.orders.find(order => order.orderId === recent.orderId)).toMatchObject({ preparation: 'preparing', preparedAt: POS_NOW });
    act({ type: 'order.complete', orderId: missing.orderId });
    const completed = selectOrderSummary(read(slice.pos), { filter: 'done' });
    expect(completed).toMatchObject({ openCount: 2, missingCount: 0, avgWaitMin: 0.7, orderGross: 859500, netRevenue: seedToday.rollup.net });
    expect(completed.rows[0]).toMatchObject({ orderNo: missing.orderNo, completedAt: POS_NOW, waitMin: 27, canReopen: true });
    alert = evaluateOrderAlert(alert, completed, context);
    expect(alert).toEqual({ visible: false, notifiedIds: [missing.orderId] });
    const token = slice.orderUndo!.token;
    const paused = pauseOrderUndo(slice.orderUndo, 'focus', T0 + 3000);
    const hidden = pauseOrderUndo(paused, 'page-hidden', T0 + 4000);
    const focused = resumeOrderUndo(hidden, 'page-hidden', T0 + 50_000);
    expect(focused?.remainingMs).toBe(3000);
    slice = { ...slice, orderUndo: resumeOrderUndo(focused, 'focus', T0 + 60_000) };
    act({ type: 'order.undo', token }, T0 + 62_999);
    expect(slice.pos.orders.find(order => order.orderId === missing.orderId)).toMatchObject({ preparation: 'accepted', completedAt: null, completedInRun: false });
    expect(selectOrderSummary(read(slice.pos))).toMatchObject({ missingCount: 1, avgWaitMin: 0.5 });
    expect(evaluateOrderAlert(alert, selectOrderSummary(read(slice.pos)), context)).toBe(alert);
    act({ type: 'order.complete', orderId: slow.orderId });
    act({ type: 'order.reopen', orderId: slow.orderId }, T0 + 7000);
    expect(slice.pos.orders.find(order => order.orderId === slow.orderId)).toMatchObject({ preparation: 'preparing', completedAt: null });
    for (const key of ['payments', 'refunds', 'bills', 'billAllocations', 'cart', 'drawer'] as const) expect(slice.pos[key]).toBe(seed[key]);
  });

  it('rejects stale, expired, duplicate, unknown and seed-reopen commands with zero changes', () => {
    const start = createOrderStatusSlice(activeOrders());
    const complete = applyOrderStatusCommand(start, { type: 'order.complete', orderId: missing.orderId }, { now: T0, businessNow: POS_NOW }).slice;
    const token = complete.orderUndo!.token;
    for (const [slice, command, now, code] of [
      [start, { type: 'order.complete', orderId: 'missing' }, T0, 'UNKNOWN_ORDER'],
      [start, { type: 'order.reopen', orderId: cafe.orders[0].orderId }, T0, 'NOT_REOPENABLE'],
      [complete, { type: 'order.complete', orderId: missing.orderId }, T0, 'NOT_OPEN'],
      [complete, { type: 'order.undo', token }, T0 + 6000, 'UNDO_UNAVAILABLE'],
      [{ ...complete, pos: { ...complete.pos, orders: complete.pos.orders.map(o => o.orderId === missing.orderId ? { ...o, completedAt: at('15:46') } : o) } }, { type: 'order.undo', token }, T0, 'UNDO_UNAVAILABLE'],
    ] as const) {
      const result = applyOrderStatusCommand(slice, command, { now, businessNow: POS_NOW });
      expect(result.result).toEqual({ status: 'unchanged', code }); expect(result.slice).toBe(slice);
    }
    const undone = applyOrderStatusCommand(complete, { type: 'order.undo', token }, { now: T0, businessNow: POS_NOW }).slice;
    expect(applyOrderStatusCommand(undone, { type: 'order.undo', token }, { now: T0, businessNow: POS_NOW }).slice).toBe(undone);
  });

  it('defers alerts, allows the POS order tab, marks status-tab orders seen and does not revive dismissed IDs', () => {
    const summary = selectOrderSummary(read());
    for (const blocked of [{ ...context, coachVisible: true }, { ...context, overlayOpen: true }, { ...context, onDashboard: false }]) {
      expect(evaluateOrderAlert(initialOrderAlert, summary, blocked)).toBe(initialOrderAlert);
    }
    const shown = evaluateOrderAlert(initialOrderAlert, summary, { ...context, onDashboard: false, onPos: true });
    expect(shown.visible).toBe(true);
    const dismissed = dismissOrderAlert(shown);
    expect(evaluateOrderAlert(dismissed, summary, context)).toBe(dismissed);
    const seen = evaluateOrderAlert(initialOrderAlert, summary, { ...context, orderDetailOpen: true, overlayOpen: true });
    expect(seen).toEqual({ visible: false, notifiedIds: [missing.orderId] });
    expect(seenOrderAlert(seen, [missing.orderId])).toBe(seen);
  });
});
