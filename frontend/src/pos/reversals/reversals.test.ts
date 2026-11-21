import { selectAccountingDay } from '../../data/iteration7/accounting';
import { describe, expect, it, vi } from 'vitest';
import type { PosReadSnapshot, PosReversalInput } from '../../contracts/pos';
import { deriveStock, deriveUsage, readModel, selectMembers, selectPosPayments } from '../../data/widget-data';
import { selectPosDayTotals, selectPosSalesByMenu } from '../domain';
import { paymentSettlementShares } from '../domain/settlement';
import { getPaymentBillId, quotePaymentBill } from '../loyalty';
import { setup as setupBase } from '../loyalty/test-setup';
import { createTableLayout } from '../../layout/table-layout';
import { planReversalCommand, quoteReversal, selectReceipt, selectPaymentRemaining } from './index';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import * as widgetData from '../../data/widget-data';
import { createSeedTables } from '../../data/db/seed';
import { createLegacySeedTables } from '../../data/db/legacy-seed';
import { seedOperations } from '../../data/db/generated/operations';
import { seedToday } from '../../data/db/generated/today';

const cafeCoupon = seedOperations.coupons.find(coupon => coupon.status === 'active')!;

const createStore = widgetData.createWidgetDataStore;

function setup(paymentStyle?: 'prepaid' | 'postpaid') {
  const h = setupBase(paymentStyle);
  const add = (menuId = 'm-americano', qty = 1) => {
    const menu = h.pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'ICE')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    return h.pos.execute({ type: 'cart.add', menuId, qty, optionIds, meta: h.meta() });
  };
  return { ...h, add };
}

function setupRetail() {
  const legacy = createLegacySeedTables(), cafe = createSeedTables();
  const historicalLine = legacy.paymentLine.find(row => row.menuId === 'm-beans200' && row.unitCostAtSale !== null)!;
  const historicalPayment = legacy.payment.find(row => row.paymentId === historicalLine.paymentId)!;
  const store = vi.spyOn(widgetData, 'createWidgetDataStore').mockImplementationOnce((seed, options) => createStore({
    ...seed,
    menuItem: [...cafe.menuItem, legacy.menuItem.find(row => row.menuId === 'm-beans200')!],
    inventoryItem: [...cafe.inventoryItem, legacy.inventoryItem.find(row => row.itemId === 'it-beans200')!],
    inventoryStock: [...cafe.inventoryStock, ...legacy.inventoryStock.filter(row => row.itemId === 'it-beans200')],
    payment: [...cafe.payment, historicalPayment],
    paymentLine: [...cafe.paymentLine, historicalLine],
  }, options));
  try { return setup(); } finally { store.mockRestore(); }
}

function reverse(h: ReturnType<typeof setup>, input: PosReversalInput, key?: string) {
  const quote = quoteReversal(h.pos.read(), input);
  expect(quote.issues).toEqual([]);
  expect(quote.canSubmit).toBe(true);
  return h.pos.execute({ type: 'payment.reverse', quoteToken: quote.quoteToken, confirmed: true, meta: h.meta(key) });
}
function pay(h: ReturnType<typeof setup>, billId = getPaymentBillId(h.pos.read()), splits?: PosReadSnapshot['pos']['payments'][number]['splits']) {
  let q = quotePaymentBill(h.pos.read(), billId);
  for (const part of q.parts.length ? q.parts : [{ partId: undefined, amount: q.payable }]) {
    q = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, partId: part.partId, quoteRevision: q.revision, splits: splits ?? [{ method: 'card', amount: part.amount }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  }
  return h.pos.read().pos.payments.filter(p => p.billId === billId);
}

function paidAmericanos(h: ReturnType<typeof setup>, qty = 3) {
  expect(h.add('m-americano', qty).ok).toBe(true);
  const payment = pay(h)[0];
  return { paymentId: payment.paymentId, order: h.pos.read().pos.orders.at(-1)! };
}

describe('T-251 reversal money, stock and state', () => {
  it('recognizes a zero-won bill once without creating payment shares or losing its sales, cost or stock usage', () => {
    const h = setup(), before = h.pos.read().pos;
    const beansBefore = deriveStock(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.find(r => r.itemId === 'i-bean-house')!.rawBase;
    h.add('m-americano', 2);
    const billId = getPaymentBillId(h.pos.read());
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', percent: 100 }, meta: h.meta() }).ok).toBe(true);
    const command = { type: 'bill.confirmZero' as const, billId, meta: h.meta('zero-settlement') };
    expect(h.pos.execute(command)).toMatchObject({ ok: true, value: { settled: true, orderIds: ['O-154'] } });
    expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    const pos = h.pos.read().pos, data = h.data.getSnapshot(), bill = pos.bills.find(b => b.billId === billId)!;
    expect(bill).toMatchObject({ status: 'paid', recognizedAt: POS_NOW });
    expect(paymentSettlementShares(pos, bill)).toEqual([]);
    expect(pos.orders).toHaveLength(before.orders.length + 1);
    expect(pos.payments).toEqual(before.payments);
    expect(pos.receipts).toEqual(before.receipts);
    expect(selectPosDayTotals(pos)).toMatchObject({ gross: 865500, discount: 34280, revenue: seedToday.rollup.net, paymentCount: 153,
      byMethod: { card: 557050, easy_pay: 217270, cash: 56900 }, methodCounts: { card: 103, easy_pay: 39, cash: 11 } });
    expect(selectPosSalesByMenu(pos)['m-americano']).toBe(64);
    expect(readModel(data, 'margin')).toMatchObject({ cost: 245381, netSales: seedToday.rollup.net });
    expect(deriveUsage(data, { date: POS_BUSINESS_DATE }).byItem).toMatchObject({ 'i-bean-house': 2394, 'i-cup-takeout': 203 });
    expect(deriveStock(data, { date: POS_BUSINESS_DATE }).rows.find(r => r.itemId === 'i-bean-house')!.rawBase).toBe(beansBefore - 36);
    expect(selectPosPayments(data, { date: POS_BUSINESS_DATE }).rows.reduce((n, r) => n + r.net, 0)).toBe(seedToday.rollup.net);
    expect(selectReceipt(h.pos.read(), { paymentId: billId })).toBeNull();
    expect(quoteReversal(h.pos.read(), { paymentId: billId, kind: 'cancel' })).toMatchObject({ canSubmit: false, issues: expect.arrayContaining([expect.objectContaining({ reason: 'NOT_FOUND' })]) });
  });

  it('atomically cancels a freshly accepted order and corrects the same receipt without double counting', () => {
    const h = setup(), { paymentId, order } = paidAmericanos(h), before = selectReceipt(h.pos.read(), { paymentId });
    const quote = quoteReversal(h.pos.read(), { paymentId, kind: 'cancel' });
    expect(quote).toMatchObject({ amount: 9000, methods: [{ method: 'card', amount: 9000 }], salesEffect: 'restore', stockEffect: 'restore', canSubmit: true });
    expect(h.pos.read().pos.cancellations).toHaveLength(0);
    const observed: number[] = [];
    const off = h.data.subscribe(() => {
      expect(h.data.getSnapshot().pos).toBe(h.pos.read().pos);
      observed.push(selectPosDayTotals(h.pos.read().pos).revenue);
    });
    const command = { type: 'payment.reverse' as const, quoteToken: quote.quoteToken, confirmed: true, meta: h.meta('cancel94') };
    const result = h.pos.execute(command);
    expect(result).toMatchObject({ ok: true, value: { paymentId } });
    expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(h.pos.execute({ ...command, meta: h.meta('same-quote') })).toMatchObject({ ok: true, duplicate: true });
    expect(observed).toEqual([seedToday.rollup.net]); off();
    const s = h.data.getSnapshot(), totals = selectPosDayTotals(h.pos.read().pos);
    expect(totals).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 153, cancelCount: 1, canceled: 9000, byMethod: { card: 557050 }, methodCounts: { card: 103 } });
    expect(selectPosSalesByMenu(h.pos.read().pos)['m-americano']).toBe(62);
    expect(deriveUsage(s, { date: POS_BUSINESS_DATE }).byItem).toMatchObject({ 'i-bean-house': 2358, 'i-cup-takeout': 201 });
    expect(readModel(s, 'margin')).toMatchObject({ cost: 244333 });
    expect(h.pos.read().pos.orders.find(o => o.orderId === order.orderId)?.preparation).toBe('canceled');
    expect(selectPosPayments(s, { date: POS_BUSINESS_DATE }).rows.reduce((n, r) => n + r.net, 0)).toBe(seedToday.rollup.net);
    expect(selectReceipt(h.pos.read(), { paymentId })).toMatchObject({ transactionNo: before!.transactionNo, amount: 9000, remaining: 0, status: 'canceled', corrections: [{ kind: 'cancel', amount: 9000 }] });
  });

  it('refunds a made latte while preserving sales quantity, ingredients, cost and payment count', () => {
    const h = setup(); h.add('m-cafe-latte'); h.add('m-americano');
    const { paymentId } = pay(h, getPaymentBillId(h.pos.read()), [{ method: 'easy_pay', amount: 6800 }])[0];
    const order = h.pos.read().pos.orders.at(-1)!;
    expect(h.pos.execute({ type: 'order.start', orderId: order.orderId, meta: h.meta() }).ok).toBe(true);
    const line = order.lines.find(row => row.menuId === 'm-cafe-latte')!;
    expect(reverse(h, { paymentId, kind: 'refund', lines: [{ orderLineId: line.orderLineId, qty: 1 }] }).ok).toBe(true);
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net + 3000, refund: 3800,
      refundCount: 1, paymentCount: seedToday.rollup.paymentCount + 1, byMethod: { easy_pay: 220270 }, methodCounts: { easy_pay: 40 } });
    expect(selectPosSalesByMenu(h.pos.read().pos)['m-cafe-latte']).toBe(25);
    expect(deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).byItem['i-milk']).toBe(22220);
    expect(readModel(h.data.getSnapshot(), 'margin')).toMatchObject({ cost: 246135, grossProfit: 588085 });
    expect(selectReceipt(h.pos.read(), { paymentId })).toMatchObject({ remaining: 3000, status: 'partially_refunded' });
    expect(quoteReversal(h.pos.read(), { paymentId, kind: 'refund', lines: [{ orderLineId: line.orderLineId, qty: 1 }] }).canSubmit).toBe(false);
  });

  it('returns resellable retail to stock and cancels its cash receipt and tax contribution together', () => {
    const h = setupRetail(); expect(h.add('m-beans200').ok).toBe(true);
    const [p] = pay(h, getPaymentBillId(h.pos.read()), [{ method: 'cash', amount: 12000 }]);
    expect(h.pos.execute({ type: 'cashReceipt.issue', paymentId: p.paymentId, kind: 'income', identifier: '01012345678', meta: h.meta() }).ok).toBe(true);
    expect(readModel(h.data.getSnapshot(), 'inventory-booking').products.items[0]).toMatchObject({ store: 119, online: 40 });
    expect(reverse(h, { paymentId: p.paymentId, kind: 'refund', restockRetail: true }).ok).toBe(true);
    expect(h.pos.read().pos.cancellations.at(-1)).toMatchObject({ paymentId: p.paymentId, amount: 12000, restockRetail: true });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 153, cancelCount: 1, byMethod: { cash: 56900 }, methodCounts: { cash: 11 } });
    expect(readModel(h.data.getSnapshot(), 'inventory-booking').products.items[0]).toMatchObject({ store: 120, online: 40 });
    expect(selectPosSalesByMenu(h.pos.read().pos)['m-beans200']).toBe(0);
    expect(h.pos.read().pos.cashReceipts.find(r => r.paymentId === p.paymentId)?.status).toBe('canceled');
    expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.cashReceipts).toEqual({ count: 0, amount: 0 });
  });

  it('validates confirmation, closed day, made orders, limits, whole-bill discounts and stale quotes with zero changes', () => {
    const h = setup(), { paymentId } = paidAmericanos(h), read = h.pos.read();
    const made = read.pos.payments.find(p => p.amount === 3000 && read.pos.orders.some(order => order.originBillId === p.billId && order.preparation === 'completed'))!;
    expect(quoteReversal(read, { paymentId: made.paymentId, kind: 'cancel' }).issues[0].reason).toBe('USE_REFUND');
    expect(quoteReversal(read, { paymentId: made.paymentId, kind: 'refund', amount: 9000 }).issues).toContainEqual(expect.objectContaining({ reason: 'REFUND_LIMIT', details: { remaining: 3000 } }));
    const q = quoteReversal(read, { paymentId, kind: 'cancel' });
    expect(h.pos.execute({ type: 'payment.reverse', quoteToken: q.quoteToken, confirmed: false, meta: h.meta() })).toMatchObject({ ok: false, reason: 'CONFIRMATION_REQUIRED' });
    expect(h.pos.execute({ type: 'payment.reverse', quoteToken: '{}', confirmed: true, meta: h.meta() }).ok).toBe(false);
    expect(h.pos.read().pos).toBe(read.pos);
    h.add();
    expect(h.pos.execute({ type: 'payment.reverse', quoteToken: q.quoteToken, confirmed: true, meta: h.meta() })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    const failed = { ...h.pos.read(), scenario: 'payment-failure' } as PosReadSnapshot;
    expect(quoteReversal(failed, { paymentId, kind: 'cancel' }).canSubmit).toBe(true);
    expect(planReversalCommand(failed, { type: 'payment.reverse', quoteToken: quoteReversal(failed, { paymentId, kind: 'cancel' }).quoteToken, confirmed: true, meta: h.meta() }, POS_NOW)).toMatchObject({ ok: false, reason: 'REVERSAL_FAILED' });
    const closed = { ...read, data: { ...read.data, dayClosed: true } };
    expect(quoteReversal(closed, { paymentId, kind: 'cancel' }).issues[0].reason).toBe('DAY_CLOSED');
    const d = setup(); d.add('m-americano', 2); const id = getPaymentBillId(d.pos.read());
    d.pos.execute({ type: 'bill.setDiscount', billId: id, discountInput: { source: 'direct', percent: 10 }, meta: d.meta() });
    const p = pay(d, id)[0], line = d.pos.read().pos.orders.at(-1)!.lines[0];
    expect(quoteReversal(d.pos.read(), { paymentId: p.paymentId, kind: 'cancel', lines: [{ orderLineId: line.orderLineId, qty: 1 }] }).issues[0].reason).toBe('WHOLE_BILL_DISCOUNT');
  });

  it('preserves original mixed-method count attribution and enforces each remaining method/line balance', () => {
    const h = setup(); h.add('m-americano', 3); h.add('m-cafe-latte');
    const [p] = pay(h, getPaymentBillId(h.pos.read()), [{ method: 'card', amount: 9800 }, { method: 'cash', amount: 3000 }]);
    expect(h.pos.execute({ type: 'order.start', orderId: h.pos.read().pos.orders.at(-1)!.orderId, meta: h.meta() }).ok).toBe(true);
    expect(quoteReversal(h.pos.read(), { paymentId: p.paymentId, kind: 'refund', amount: 6000, methodAmounts: [{ method: 'cash', amount: 6000 }] }).canSubmit).toBe(false);
    expect(quoteReversal(h.pos.read(), { paymentId: p.paymentId, kind: 'refund', amount: 3000 }).issues[0].reason).toBe('METHOD_REQUIRED');
    expect(reverse(h, { paymentId: p.paymentId, kind: 'refund', amount: 3000, methodAmounts: [{ method: 'cash', amount: 3000 }] }).ok).toBe(true);
    expect(selectPaymentRemaining(h.pos.read().pos, p.paymentId)).toMatchObject({ remaining: 9800, methods: [{ method: 'card', amount: 9800 }, { method: 'cash', amount: 0 }] });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ paymentCount: 154, methodCounts: { card: 104, cash: 11 }, byMethod: { cash: 56900 } });
    expect(selectPosPayments(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.reduce((n, r) => n + r.net, 0)).toBe(841020);
    expect(h.data.getSnapshot().tables.menuDaily.filter(m => m.businessDate === POS_BUSINESS_DATE).reduce((n, m) => n + m.netSales, 0)).toBe(841020);
  });

  it('partially cancels units once using cost at sale, then cancels the remainder without charging it twice', () => {
    const h = setup(), { paymentId, order } = paidAmericanos(h), line = order.lines[0];
    expect(reverse(h, { paymentId, kind: 'cancel', lines: [{ orderLineId: line.orderLineId, qty: 1 }] }).ok).toBe(true);
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: 837220, paymentCount: 154 });
    expect(readModel(h.data.getSnapshot(), 'margin').cost).toBe(245381);
    expect(reverse(h, { paymentId, kind: 'cancel' }).ok).toBe(true);
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 153 });
    expect(selectPosPayments(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.reduce((n, r) => n + r.net, 0)).toBe(seedToday.rollup.net);
    expect(quoteReversal(h.pos.read(), { paymentId, kind: 'cancel' }).issues[0].reason).toBe('ALREADY_REVERSED');
  });

  it('restores split quantity shares and bill-level coupon/visit exactly once after the last canceled share', () => {
    const h = setup(); h.add('m-americano', 2); h.add('m-cafe-latte', 2); const billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
    h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId }, meta: h.meta() });
    h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 3, meta: h.meta() });
    const payments = pay(h, billId);
    expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(366);
    for (const [i, p] of payments.entries()) {
      expect(reverse(h, { paymentId: p.paymentId, kind: 'cancel' }).ok).toBe(true);
      expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(i === 2 ? 365 : 366);
      const t = selectPosDayTotals(h.pos.read().pos), rows = selectPosPayments(h.data.getSnapshot(), { date: POS_BUSINESS_DATE });
      // PRD 12.6: each axis is independently reconciled after each original return.
      const day=selectAccountingDay(h.actions.money.read(),{date:POS_BUSINESS_DATE});
      const methodSales=Object.values(t.byMethod).reduce((n,a)=>n+a,0);
      expect(rows.rows.reduce((n,r)=>n+r.net,0)).toBe(methodSales);
      expect(t.revenue).toBe(methodSales+day.sales.chargeUsed+day.sales.receivableCreated+day.sales.membershipCount+day.sales.subscriptionDaily+day.sales.membershipExpiry+day.sales.customPickup);
      expect(day.deposits.total).toBe(seedToday.rollup.net + [8400, 4200, 0][i]);
      expect(day.deposits.byMethod).toEqual({card: 557050 + [8400, 4200, 0][i], easy_pay: 217270, cash: 56900});
    }
    expect(selectPosSalesByMenu(h.pos.read().pos)).toMatchObject({ 'm-americano': 62, 'm-cafe-latte': 24 });
    expect(readModel(h.data.getSnapshot(), 'margin').cost).toBe(244333);
    expect(selectMembers(h.data.getSnapshot(), {}).rows.find(m => m.memberId === 'M-0012')?.recentVisits).toBe(8);
  });

  it('restores a membership use once after the last split cancellation, keeping the bill visit until then', () => {
    const h = setup(); h.add('m-americano', 3); const billId = getPaymentBillId(h.pos.read());
    const pass = h.pos.read().data.loyalty!.passes.find(p => p.membershipId === 'sample-pass-1' && p.active)!;
    const usesLeft = pass.usesLeft;
    h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId: pass.membershipId }, meta: h.meta() }).ok).toBe(true);
    h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
    const payments = pay(h, billId);
    expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === pass.membershipId)!.usesLeft).toBe(usesLeft! - 1);
    for (const [i, p] of payments.entries()) {
      expect(reverse(h, { paymentId: p.paymentId, kind: 'cancel' }).ok).toBe(true);
      expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === pass.membershipId)!.usesLeft).toBe(i ? usesLeft : usesLeft! - 1);
    }
    expect(h.data.getSnapshot().tables.membershipUse.filter(u => u.useId.startsWith('pos:') && !u.canceledAt)).toHaveLength(0);
    expect(selectPosDayTotals(h.pos.read().pos).revenue).toBe(seedToday.rollup.net);
  });

  it('previews coupon and membership restoration only when their last live transferred fragment is canceled', () => {
    const h = setup('postpaid'), settings = h.pos.read().settings;
    expect(h.actions.updateSettings({ ...settings, revision: settings.revision + 1, tableLayout: createTableLayout() }).ok).toBe(true);
    h.add('m-americano', 3); h.add('m-cafe-latte', 2);
    expect(h.pos.execute({ type: 'bill.submitOrder', cartId: h.pos.read().pos.cart.cartId, tableId: 'T2', meta: h.meta() }).ok).toBe(true);
    const order = h.pos.read().pos.orders.at(-1)!, billId = order.originBillId;
    const pass = h.pos.read().data.loyalty!.passes.find(p => p.membershipId === 'sample-pass-1' && p.active)!;
    const usesBefore = pass.usesLeft;
    expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'membership', membershipId: pass.membershipId }, meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId }, meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.separateTable', billId, targetTableId: 'T1', lines: [{ orderLineId: order.lines.find(l => l.menuId === 'm-americano')!.orderLineId, qty: 1 }], meta: h.meta() }).ok).toBe(true);
    const otherBillId = h.pos.read().pos.bills.find(b => b.status === 'open' && b.tableId === 'T1')!.billId;
    const payments = [pay(h, billId)[0], pay(h, otherBillId)[0]];
    expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(366);
    expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === pass.membershipId)!.usesLeft).toBe(usesBefore! - 1);
    for (const [i, p] of payments.entries()) {
      const quote = quoteReversal(h.pos.read(), { paymentId: p.paymentId, kind: 'cancel' });
      expect(quote).toMatchObject({ canSubmit: true, couponEffect: i === 0 ? 'keep' : 'restore', membershipEffect: i === 0 ? 'keep' : 'restore' });
      expect(h.pos.execute({ type: 'payment.reverse', quoteToken: quote.quoteToken, confirmed: true, meta: h.meta() }).ok).toBe(true);
      expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(i === 0 ? 366 : 365);
      expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === pass.membershipId)!.usesLeft).toBe(i === 0 ? usesBefore! - 1 : usesBefore);
    }
    expect(selectPosDayTotals(h.pos.read().pos).revenue).toBe(seedToday.rollup.net);
  });

  it('cancels item split shares without restoring units or discounts assigned to another payment', () => {
    const h = setup(); h.add('m-americano', 2); h.add('m-basque-cake'); const billId = getPaymentBillId(h.pos.read()), q = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.execute({ type: 'bill.split', billId, kind: 'items', parts: q.lines.map(l => ({ lineQtyAllocations: [{ allocationId: l.lineId, qty: l.qty }] })), meta: h.meta() }).ok).toBe(true);
    const payments = pay(h, billId);
    expect(reverse(h, { paymentId: payments[0].paymentId, kind: 'cancel' }).ok).toBe(true);
    expect(selectPosSalesByMenu(h.pos.read().pos)).toMatchObject({ 'm-americano': 62, 'm-basque-cake': 4 });
    expect(reverse(h, { paymentId: payments[1].paymentId, kind: 'cancel' }).ok).toBe(true);
    expect(selectPosSalesByMenu(h.pos.read().pos)).toMatchObject({ 'm-americano': 62, 'm-basque-cake': 3 });
    expect(selectPosDayTotals(h.pos.read().pos).revenue).toBe(seedToday.rollup.net);
  });

  it('refunds made food and restocks retail in one transaction, then preserves both effects on later data edits', () => {
    const h = setupRetail(); h.add('m-beans200'); h.add('m-cafe-latte'); const payment = pay(h)[0];
    const order = h.pos.read().pos.orders.at(-1)!;
    h.pos.execute({ type: 'order.start', orderId: order.orderId, meta: h.meta() });
    expect(reverse(h, { paymentId: payment.paymentId, kind: 'refund', restockRetail: true }).ok).toBe(true);
    expect(h.pos.read().pos.cancellations.at(-1)!.amount).toBe(12000);
    expect(h.pos.read().pos.refunds.at(-1)!.amount).toBe(3800);
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 154, cancelCount: 1, refundCount: 1 });
    expect(selectPosSalesByMenu(h.pos.read().pos)).toMatchObject({ 'm-beans200': 0, 'm-cafe-latte': 25 });
    expect(readModel(h.data.getSnapshot(), 'margin').cost).toBe(245611);
    expect(readModel(h.data.getSnapshot(), 'inventory-booking').products.items[0].store).toBe(120);
    h.data.dispatch({ type: 'ledger.recordExpense', date: POS_BUSINESS_DATE, category: 'operations', amount: 100 });
    expect(readModel(h.data.getSnapshot(), 'inventory-booking').products.items[0].store).toBe(120);
    expect(selectPosPayments(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).rows.reduce((n, r) => n + r.net, 0)).toBe(seedToday.rollup.net);
  });

  it('leaves run/data references and notifications unchanged on failure preview and data prepare rejection', () => {
    const h = setup(), { paymentId } = paidAmericanos(h); h.run.actions.setPosPreview('payment-failure');
    let q = quoteReversal(h.pos.read(), { paymentId, kind: 'cancel' });
    const state = h.pos.read().pos, snapshot = h.data.getSnapshot(); let notifications = 0;
    const offRun = h.run.subscribe(() => notifications++), offData = h.data.subscribe(() => notifications++);
    expect(h.pos.execute({ type: 'payment.reverse', quoteToken: q.quoteToken, confirmed: true, meta: h.meta() })).toMatchObject({ ok: false, reason: 'REVERSAL_FAILED' });
    expect(h.pos.read().pos).toBe(state); expect(h.data.getSnapshot()).toBe(snapshot); expect(notifications).toBe(0);
    offRun(); offData();
    h.run.actions.setPosPreview('normal'); q = quoteReversal(h.pos.read(), { paymentId, kind: 'cancel' });
    const planned = planReversalCommand(h.pos.read(), { type: 'payment.reverse', quoteToken: q.quoteToken, confirmed: true, meta: h.meta() }, POS_NOW);
    if (!planned.ok) throw new Error(planned.reason);
    const stale = h.pos.read();
    h.data.dispatch({ type: 'ledger.recordExpense', date: POS_BUSINESS_DATE, category: 'operations', amount: 100 });
    const latest = h.data.getSnapshot();
    expect(h.actions.commit(planned.plan, stale)).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(h.pos.read().pos).toBe(state); expect(h.data.getSnapshot()).toBe(latest);
  });

  it('allocates repeated amount refunds from remaining line balances, preserves cost, and rejects reused quantities', () => {
    const h = setup();
    h.add('m-americano'); h.add('m-cafe-latte');
    const [payment] = pay(h), paymentId = payment.paymentId;
    expect(h.pos.execute({ type: 'order.start', orderId: h.pos.read().pos.orders.at(-1)!.orderId, meta: h.meta() }).ok).toBe(true);
    expect(reverse(h, { paymentId, kind: 'refund', amount: 2501 }).ok).toBe(true);
    expect(reverse(h, { paymentId, kind: 'refund', amount: 2000 }).ok).toBe(true);
    expect(reverse(h, { paymentId, kind: 'refund' }).ok).toBe(true);
    const totals = selectPosDayTotals(h.pos.read().pos);
    expect(totals).toMatchObject({ revenue: seedToday.rollup.net, refundCount: 3, paymentCount: 154 });
    expect(readModel(h.data.getSnapshot(), 'margin').cost).toBe(246135);
    expect(h.data.getSnapshot().tables.menuDaily.filter(m => m.businessDate === POS_BUSINESS_DATE).reduce((n, m) => n + m.netSales, 0)).toBe(seedToday.rollup.net);
    expect(selectReceipt(h.pos.read(), { paymentId })).toMatchObject({ remaining: 0, status: 'refunded' });
    expect(quoteReversal(h.pos.read(), { paymentId, kind: 'refund' }).issues[0].reason).toBe('ALREADY_REVERSED');
  });

  it('requires the literal confirmation flag and returns zero-change validation for invalid quantities', () => {
    const h = setup(), { paymentId, order } = paidAmericanos(h), read = h.pos.read(), q = quoteReversal(read, { paymentId, kind: 'cancel' });
    const command = { type: 'payment.reverse' as const, quoteToken: q.quoteToken, confirmed: 'yes' as unknown as boolean, meta: h.meta() };
    expect(h.pos.execute(command)).toMatchObject({ ok: false, reason: 'CONFIRMATION_REQUIRED' });
    const line = order.lines[0];
    for (const qty of [0, -1, 4, 1.5, Number.MAX_SAFE_INTEGER]) expect(quoteReversal(read, { paymentId, kind: 'cancel', lines: [{ orderLineId: line.orderLineId, qty }] }).canSubmit).toBe(false);
    expect(h.pos.read().pos).toBe(read.pos);
  });
});

