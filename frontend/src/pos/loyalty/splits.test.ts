import { describe, expect, it } from 'vitest';
import { deriveUsage, readModel, selectMembers, selectPosPayments, selectPosCouponPerformance } from '../../data/widget-data';
import { selectPosDayTotals } from '../domain';
import { buildSplitPlan, getPaymentBillId, normalizeMethodSplits, quotePaymentBill } from './index';
import { setup as setupBase } from './test-setup';
import { createTableLayout } from '../../layout/table-layout';
import { selectTableMap } from '../tables';
import { planLoyaltyCommand } from './commands';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import { seedOperations } from '../../data/db/generated/operations';
import { seedToday } from '../../data/db/generated/today';

const cafeCoupon = seedOperations.coupons.find(coupon => coupon.status === 'active')!;
const cafeCode = seedOperations.couponCodes.find(code => code.couponId === cafeCoupon.couponId)!;

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

describe('T-249 split and mixed money/state', () => {
  it('normalizes repeated methods and attributes equal amounts in card/easy-pay/cash order', () => {
    expect(normalizeMethodSplits([{ method: 'cash', amount: 2000 }, { method: 'card', amount: 4500 }, { method: 'cash', amount: 2500 }], 9000)).toMatchObject({ ok: true, countedMethod: 'card', splits: [{ method: 'card', amount: 4500 }, { method: 'cash', amount: 4500 }] });
    expect(normalizeMethodSplits([{ method: 'cash', amount: 5000 }], 9000)).toMatchObject({ ok: false, reason: 'SPLIT_TOTAL_MISMATCH', details: { remaining: 4000 } });
    expect(normalizeMethodSplits([{ method: 'card', amount: Number.MAX_SAFE_INTEGER }, { method: 'cash', amount: 1 }], 9000)).toMatchObject({ ok: false, reason: 'INVALID_AMOUNT' });
  });

  it('gives remainder won to the last equal part and rejects bad people/quantity allocations', () => {
    const h = setup(); h.add('m-cafe-latte', 2); const q = quotePaymentBill(h.pos.read(), getPaymentBillId(h.pos.read()));
    expect(buildSplitPlan(q, { kind: 'equal', n: 3 })).toMatchObject({ ok: true, plan: { parts: [{ amount: 2533 }, { amount: 2533 }, { amount: 2534 }] } });
    expect(buildSplitPlan(q, { kind: 'equal', n: 11 })).toMatchObject({ ok: false, reason: 'INVALID_PART_COUNT' });
    expect(buildSplitPlan(q, { kind: 'items', parts: [{ lineQtyAllocations: [{ allocationId: q.lines[0].lineId, qty: 1 }] }, { lineQtyAllocations: [{ allocationId: q.lines[0].lineId, qty: 2 }] }] })).toMatchObject({ ok: false, reason: 'QTY_ALLOCATION_INVALID' });
    expect(buildSplitPlan(q, { kind: 'items', parts: [{ lineQtyAllocations: [{ allocationId: q.lines[0].lineId, qty: 1 }] }, { lineQtyAllocations: [{ allocationId: q.lines[0].lineId, qty: 1 }] }] })).toMatchObject({ ok: true, plan: { parts: [{ amount: 3800 }, { amount: 3800 }] } });
  });

  it('pays one member+coupon bill in three parts, resumes after closing, and atomically recognizes it once', () => {
    const h = setup(); h.add('m-americano', 2); h.add('m-cafe-latte', 2);
    const billId = getPaymentBillId(h.pos.read());
    expect(h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId }, meta: h.meta() }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 3, meta: h.meta('split') }).ok).toBe(true);
    expect(h.pos.execute({ type: 'bill.member', billId, memberId: null, meta: h.meta() })).toMatchObject({ ok: false, reason: 'BILL_LOCKED' });
    let q = quotePaymentBill(h.pos.read(), billId);
    expect(q).toMatchObject({ payable: 12600, parts: [{ amount: 4200 }, { amount: 4200 }, { amount: 4200 }] });
    const first = { billId, partId: q.parts[0].partId, quoteRevision: q.revision, splits: [{ method: 'cash' as const, amount: 3000 }, { method: 'card' as const, amount: 1200 }], meta: h.meta('first') };
    expect(h.pos.beginApproval(first)).toMatchObject({ ok: true, status: 'pending' });
    expect(h.pos.beginApproval(first)).toMatchObject({ ok: true, duplicate: true });
    expect(h.pos.dismissApproval()).toBe(false);
    expect(h.finish()).toMatchObject({ ok: true, value: { settled: false, remaining: 8400, orderIds: [] } });
    expect(h.finish()).toMatchObject({ ok: true, duplicate: true });
    expect(h.pos.dismissApproval()).toBe(true);
    expect(h.pos.execute({ type: 'cart.quantity', lineId: h.pos.read().pos.cart.lines[0].lineId, qty: 3, meta: h.meta() })).toMatchObject({ ok: false, reason: 'BILL_LOCKED' });
    expect(h.pos.execute({ type: 'bill.clearSplit', billId, meta: h.meta() })).toMatchObject({ ok: false, reason: 'BILL_LOCKED' });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, paymentCount: 154, pendingReceived: 4200 });
    expect(h.pos.read().pos.orders).toHaveLength(153);
    expect(deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).byItem['i-bean-house']).toBe(2358);
    expect(selectMembers(h.data.getSnapshot(), {}).rows.find(r => r.memberId === 'M-0012')?.recentVisits).toBe(8);
    expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(365);
    expect(h.data.dispatch({ type: 'closing.closeDay', date: POS_BUSINESS_DATE, scenario: 'normal', expectedGeneration: 0, idempotencyKey: 'partial-close' })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
    for (const part of q.parts.slice(1)) {
      q = quotePaymentBill(h.pos.read(), billId);
      expect(h.pos.beginApproval({ billId, partId: part.partId, quoteRevision: q.revision, splits: [{ method: 'card', amount: part.amount }], meta: h.meta() }).ok).toBe(true);
      expect(h.finish().ok).toBe(true);
      h.pos.dismissApproval();
    }
    const s = h.data.getSnapshot(), totals = selectPosDayTotals(h.pos.read().pos);
    expect(totals).toMatchObject({ revenue: 843820, paymentCount: 156, pendingReceived: 0, byMethod: { card: 566650, cash: 59900 }, methodCounts: { card: 105, cash: 12 } });
    expect(s.tables.payment.reduce((n, p) => n + p.gross - p.discount - p.refundAmount, 0)).toBe(843820);
    expect(s.tables.menuDaily.filter(m => m.businessDate === POS_BUSINESS_DATE).reduce((n, m) => n + m.netSales, 0)).toBe(843820);
    expect(selectPosPayments(s, { date: POS_BUSINESS_DATE }).rows.filter(p => p.paymentId.startsWith('P-') && p.billId === billId).map(p => p.net)).toEqual([4200, 4200, 4200]);
    expect(h.pos.read().pos.orders.at(-1)).toMatchObject({ orderNo: 154, preparation: 'accepted' });
    expect(selectMembers(s, {}).rows.find(r => r.memberId === 'M-0012')).toMatchObject({ recentVisits: 9, grade: 'regular', lastPayment: { amount: 4200, at: POS_NOW } });
    expect(readModel(s, 'customer-groups').counts).toEqual({ regular: 250, 'first-visit': 2, 'churn-risk': 29 });
    expect(readModel(s, 'coupon-status')).toMatchObject({ monthUsed: 366, runningUsed: 224 });
    expect(readModel(s, 'marketing-performance')).toMatchObject({ used: 224, rate: 75, returnRate: null, revenue: { coupon: 1752000 }, discount: 337600 });
    expect(selectPosCouponPerformance(s).find(c => c.codeId === cafeCode.codeId)).toMatchObject({ usedDelta: 1, revenueDelta: 12600, discountDelta: 1000 });
    for (const payment of s.tables.payment.filter(p => p.billId === billId)) {
      const lines = s.tables.paymentLine.filter(l => l.paymentId === payment.paymentId);
      expect(lines.reduce((n, l) => n + (l.grossAmount ?? l.qty * l.unitPriceAtSale) - (l.discountAmount ?? 0), 0)).toBe(payment.gross - payment.discount);
    }
    expect(h.pos.read().pos.cart).toMatchObject({ lock: null, lines: [] });
  });

  it('clears an unpaid draft and cancels received partial money without creating a sale or loyalty use', () => {
    const h = setup(); h.add('m-cafe-latte', 2); let billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
    expect(h.pos.execute({ type: 'bill.clearSplit', billId, meta: h.meta() }).ok).toBe(true);
    expect(h.pos.read().pos.cart.lines).toHaveLength(1);
    billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
    const q = quotePaymentBill(h.pos.read(), billId);
    h.pos.beginApproval({ billId, partId: q.parts[0].partId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: 3800 }], meta: h.meta() });
    h.finish(); h.pos.dismissApproval();
    expect(h.pos.execute({ type: 'bill.cancelPartial', billId, confirmed: false, meta: h.meta() })).toMatchObject({ ok: false, reason: 'CONFIRMATION_REQUIRED' });
    const command = { type: 'bill.cancelPartial' as const, billId, confirmed: true, meta: h.meta('cancel') };
    expect(h.pos.execute(command)).toMatchObject({ ok: true });
    expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: seedToday.rollup.net, pendingReceived: 0, paymentCount: 153 });
    expect(h.pos.read().pos.cart.lock).toBe(null);
    expect(h.pos.read().pos.orders).toHaveLength(153);
  });

  it('leaves all business state untouched on failed approval and detects changed idempotency payloads', () => {
    const h = setup(); h.add('m-americano', 2); const billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
    const q = quotePaymentBill(h.pos.read(), billId), before = h.pos.read().pos;
    const input = { billId, quoteRevision: q.revision, splits: [{ method: 'cash' as const, amount: 6000 }], meta: h.meta('failed') };
    h.pos.beginApproval(input);
    expect(h.finish('failed')).toMatchObject({ ok: false, reason: 'APPROVAL_FAILED' });
    expect(h.pos.read().pos).toBe(before);
    expect(h.pos.beginApproval({ ...input, splits: [{ method: 'card', amount: 6000 }] })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    expect(selectMembers(h.data.getSnapshot(), {}).rows.find(r => r.memberId === 'M-0012')?.recentVisits).toBe(8);
  });
});

// Returning payment must not cancel submitted kitchen orders or unlock closing.
it('returns postpaid partial cash, preserves the kitchen bill, and recognizes one successful retry', () => {
  const h = setup('postpaid');
  expect(h.pos.execute({ type: 'table.saveLayout', layout: createTableLayout(), expectedSettingsRevision: h.pos.read().settings.revision, meta: h.meta() }).ok).toBe(true);
  h.add('m-cafe-latte', 2);
  expect(h.pos.execute({ type: 'bill.submitOrder', tableId: 'T2', cartId: h.pos.read().pos.cart.cartId, meta: h.meta() }).ok).toBe(true);
  const billId = h.pos.read().pos.bills.find(b => b.status === 'open')!.billId;
  h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
  h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 1000 }, meta: h.meta() });
  h.pos.execute({ type: 'order.start', orderId: 'O-154', meta: h.meta() });
  h.pos.execute({ type: 'bill.requestPayment', billId, meta: h.meta() });
  h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
  let q = quotePaymentBill(h.pos.read(), billId);
  h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: 3300 }], meta: h.meta() });
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  const before = h.pos.read(), stock = deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE });
  const command = { type: 'bill.cancelPartial' as const, billId, confirmed: true, meta: h.meta('postpaid-return') };
  expect(planLoyaltyCommand({ ...before, scenario: 'payment-failure' }, command, POS_NOW)).toMatchObject({ ok: false, reason: 'REVERSAL_FAILED' });
  expect(h.pos.read().pos).toBe(before.pos);
  expect(h.pos.execute(command).ok).toBe(true);
  const after = h.pos.read().pos;
  expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
  expect(h.pos.read().pos).toBe(after);
  expect(after.orders).toEqual(before.pos.orders);
  expect(after.billAllocations).toEqual(before.pos.billAllocations);
  expect(after.bills.find(b => b.billId === billId)).toMatchObject({ status: 'open', memberId: 'M-0012', discounts: before.pos.bills.find(b => b.billId === billId)!.discounts });
  expect(after.bills.find(b => b.billId === billId)?.splitPlan).toBeUndefined();
  expect(after.bills.find(b => b.billId === billId)?.requestedAt).toBeUndefined();
  expect(after.tableSessions.find(s => s.billId === billId)).toEqual({ tableId: 'T2', billId, cleaning: false });
  expect(selectTableMap(h.pos.read()).tables.find(t => t.tableId === 'T2')?.state).toBe('occupied');
  expect(after.payments.at(-1)).toMatchObject({ amount: 3300, status: 'canceled', splits: [{ method: 'cash', amount: 3300 }] });
  expect(after.cancellations.at(-1)).toMatchObject({ amount: 3300, methodAmounts: [{ method: 'cash', amount: 3300 }], allocations: [] });
  expect(deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE })).toEqual(stock);
  expect(selectPosDayTotals(after)).toMatchObject({ revenue: seedToday.rollup.net, pendingReceived: 0 });
  expect(h.data.dispatch({ type: 'closing.closeDay', date: POS_BUSINESS_DATE, scenario: 'empty', expectedGeneration: 0, idempotencyKey: 'still-unpaid' })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
  q = quotePaymentBill(h.pos.read(), billId);
  expect(q).toMatchObject({ received: 0, remaining: 6600 });
  h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'card', amount: 6600 }], meta: h.meta() });
  expect(h.finish('failed')).toMatchObject({ ok: false, reason: 'APPROVAL_FAILED' }); h.pos.dismissApproval();
  expect(h.pos.read().pos).toBe(after);
  h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'card', amount: 6600 }], meta: h.meta() });
  expect(h.finish().ok).toBe(true); expect(h.finish()).toMatchObject({ ok: true, duplicate: true });
  expect(h.pos.read().pos.orders).toHaveLength(154);
  expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: 837820, paymentCount: 154, pendingReceived: 0, byMethod: { cash: 56900, card: 563650 } });
  expect(deriveUsage(h.data.getSnapshot(), { date: POS_BUSINESS_DATE }).byItem['i-cup-takeout']).toBe(203);
});
