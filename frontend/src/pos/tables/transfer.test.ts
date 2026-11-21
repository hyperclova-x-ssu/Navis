import { afterEach, expect, it } from 'vitest';
import type { PosSessionCommand } from '../../contracts/pos';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createTableLayout } from '../../layout/table-layout';
import { testTime } from '../../layout/test-policy';
import { createRunStore } from '../../state';
import { selectPosCouponPerformance, selectMembers, readModel, createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions, createSessionGate } from '../../app/session-actions';
import { selectPosDayTotals } from '../domain';
import { quotePaymentBill } from '../loyalty';
import { quoteReversal } from '../reversals';
import { selectOrderSummary } from '../status';
import { quoteBill, selectTableMap } from './index';
import { POS_BUSINESS_DATE, POS_NOW } from '../clock';
import { seedOperations } from '../../data/db/generated/operations';
import { seedToday } from '../../data/db/generated/today';

const cafeCoupon = seedOperations.coupons.find(coupon => coupon.status === 'active')!;
const cafeCode = seedOperations.couponCodes.find(code => code.couponId === cafeCoupon.couponId)!;

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
function setup() {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: gate, pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data, gate), pos = actions.pos;
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  run.actions.saveOnboardingTables(createTableLayout());
  expect(actions.completeOnboarding(null).ok).toBe(true);
  disposers.push(() => { pos.dispose(); run.dispose(); });
  let seq = 0;
  const meta = () => ({ runId: run.getState().runId, idempotencyKey: `transfer:${++seq}` });
  type Input = PosSessionCommand extends infer C ? C extends PosSessionCommand ? Omit<C, 'meta'> : never : never;
  const execute = (input: Input) => pos.execute({ ...input, meta: meta() } as PosSessionCommand);
  const order = (tableId: string, menuId = 'm-americano', qty = 1) => {
    const menu = pos.read().data.catalog.items.find(item => item.menuId === menuId)!;
    const optionIds = menu.groups.filter(group => group.required).map(group =>
      group.options.find(option => option.name === 'HOT')?.optionId ?? group.options.find(option => option.extraPrice === 0)!.optionId);
    expect(execute({ type: 'cart.add', menuId, qty, optionIds }).ok).toBe(true);
    const result = execute({ type: 'bill.submitOrder', tableId, cartId: pos.read().pos.cart.cartId });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value || !('billId' in result.value)) throw new Error('Order failed');
    return result.value.billId;
  };
  const finish = () => { const attempt = pos.read().posUi.approval!; return pos.finishApproval({ runId: pos.read().runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome: 'approved' }); };
  return { run, data, pos, meta, execute, order, finish };
}

// Losing allocations or allocating one line twice must fail these state/money checks.
it('moves, merges and separates quantities without creating orders or recognizing sales; undo restores the write set', () => {
  const h = setup(), a = h.order('T2'), b = h.order('T3', 'm-cafe-latte', 2);
  const before = h.pos.read().pos, totals = selectPosDayTotals(before);
  const move = h.execute({ type: 'bill.moveTable', billId: a, targetTableId: 'T1' });
  expect(move).toMatchObject({ ok: true });
  expect(selectOrderSummary(h.pos.read()).rows.find(r => r.orderId === 'O-154')?.tableIds).toEqual(['T1']);
  expect(move.ok && h.pos.undo(move.undoToken!)).toMatchObject({ ok: true });
  const merge = h.execute({ type: 'bill.mergeTables', sourceBillId: a, targetBillId: b });
  expect(merge).toMatchObject({ ok: true });
  expect(quoteBill(h.pos.read(), b)).toMatchObject({ payable: 10600, totalQty: 3, orderIds: ['O-154', 'O-155'] });
  expect(selectTableMap(h.pos.read()).tables.find(t => t.tableId === 'T2')?.state).toBe('empty');
  const lineId = h.pos.read().pos.orders.at(-1)!.lines[0].orderLineId;
  const split = h.execute({ type: 'bill.separateTable', billId: b, targetTableId: 'T1', lines: [{ orderLineId: lineId, qty: 1 }] });
  expect(split).toMatchObject({ ok: true });
  const destination = h.pos.read().pos.bills.find(x => x.tableId === 'T1' && x.status === 'open')!;
  expect(quoteBill(h.pos.read(), b)).toMatchObject({ payable: 6800, totalQty: 2 });
  expect(quoteBill(h.pos.read(), destination.billId)).toMatchObject({ payable: 3800, totalQty: 1 });
  expect(selectOrderSummary(h.pos.read()).rows.find(r => r.orderId === 'O-155')?.tableIds).toEqual(['T1', 'T3']);
  expect(h.pos.read().pos.billAllocations.filter(x => x.orderLineId === lineId).reduce((n, x) => n + x.qty, 0)).toBe(2);
  expect(h.pos.read().pos.orders).toHaveLength(before.orders.length);
  expect(selectPosDayTotals(h.pos.read().pos).revenue).toBe(totals.revenue);
  expect(split.ok && h.pos.undo(split.undoToken!)).toMatchObject({ ok: true });
  expect(quoteBill(h.pos.read(), b).payable).toBe(10600);
  expect(h.pos.read().pos.bills.some(x => x.billId === destination.billId)).toBe(false);
});

it('rejects invalid destinations and duplicate, excess, empty or all-line separations with zero publication', () => {
  const h = setup(), billId = h.order('T2', 'm-cafe-latte', 2), other = h.order('T3');
  const lineId = h.pos.read().pos.orders.find(o => o.originBillId === billId)!.lines[0].orderLineId;
  expect(h.data.dispatch({ type: 'booking.create', date: POS_BUSINESS_DATE, time: '16:00',
    guest: { name: '테스트 손님' }, partySize: 2, tableChoice: { tableId: 'T4' }, idempotencyKey: 'reserved-destination' }).ok).toBe(true);
  const commands = [
    { type: 'bill.moveTable', billId, targetTableId: 'T2' },
    { type: 'bill.moveTable', billId, targetTableId: 'T3' },
    { type: 'bill.moveTable', billId, targetTableId: 'T99' },
    { type: 'bill.mergeTables', sourceBillId: billId, targetBillId: billId },
    { type: 'bill.mergeTables', sourceBillId: billId, targetBillId: 'missing' },
    ...[[], [{ orderLineId: lineId, qty: 0 }], [{ orderLineId: lineId, qty: 1.5 }], [{ orderLineId: lineId, qty: 3 }], [{ orderLineId: lineId, qty: 2 }], [{ orderLineId: lineId, qty: 1 }, { orderLineId: lineId, qty: 1 }], [{ orderLineId: 'missing', qty: 1 }]].map(lines => ({ type: 'bill.separateTable', billId, targetTableId: 'T1', lines })),
    { type: 'bill.separateTable', billId, targetTableId: 'T4', lines: [{ orderLineId: lineId, qty: 1 }] },
    { type: 'bill.separateTable', billId, targetTableId: 'T3', lines: [{ orderLineId: lineId, qty: 1 }] },
  ];
  const before = h.run.getState(), data = h.data.getSnapshot();
  for (const command of commands) expect(h.execute(command as Parameters<typeof h.execute>[0])).toMatchObject({ ok: false });
  expect(h.run.getState()).toBe(before); expect(h.data.getSnapshot()).toBe(data);
  expect(quoteBill(h.pos.read(), other).payable).toBe(3000);
});

it('allows moving partial payments while rejecting merges from either end and separation', () => {
  const h = setup(), billId = h.order('T2', 'm-cafe-latte', 2), other = h.order('T3');
  expect(h.execute({ type: 'bill.split', billId, kind: 'equal', n: 2 }).ok).toBe(true);
  expect(h.pos.beginApproval({ billId, quoteRevision: h.pos.read().posRevision, splits: [{ method: 'card', amount: 3800 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  const before = h.pos.read().pos;
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: billId, targetBillId: other })).toMatchObject({ ok: false, reason: 'PARTIAL_BILL_LOCKED' });
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: other, targetBillId: billId })).toMatchObject({ ok: false, reason: 'PARTIAL_BILL_LOCKED' });
  expect(h.execute({ type: 'bill.separateTable', billId, targetTableId: 'T1', lines: [{ orderLineId: before.orders.at(-2)!.lines[0].orderLineId, qty: 1 }] })).toMatchObject({ ok: false, reason: 'PARTIAL_BILL_LOCKED' });
  expect(h.pos.read().pos).toBe(before);
  const move = h.execute({ type: 'bill.moveTable', billId, targetTableId: 'T4' });
  expect(move.ok).toBe(true);
  expect(quotePaymentBill(h.pos.read(), billId)).toMatchObject({ received: 3800, remaining: 3800 });
  expect(h.pos.read().pos.payments).toBe(before.payments);
  expect(move.ok && h.pos.undo(move.undoToken!)).toMatchObject({ ok: true });
});

it('preserves odd-won discount allocations over repeated splits and merge', () => {
  const h = setup(), billId = h.order('T2', 'm-cafe-latte', 3);
  expect(h.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 1001 } }).ok).toBe(true);
  const orderLineId = h.pos.read().pos.orders.at(-1)!.lines[0].orderLineId;
  expect(h.execute({ type: 'bill.separateTable', billId, targetTableId: 'T1', lines: [{ orderLineId, qty: 1 }] }).ok).toBe(true);
  let read = h.pos.read();
  const destination = read.pos.bills.find(b => b.tableId === 'T1' && b.status === 'open')!;
  expect(quoteBill(read, billId)).toMatchObject({ payable: 6933, discount: 667 });
  expect(quoteBill(read, destination.billId)).toMatchObject({ payable: 3466, discount: 334 });
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: destination.billId, targetBillId: billId }).ok).toBe(true);
  read = h.pos.read();
  expect(quoteBill(read, billId)).toMatchObject({ payable: 10399, discount: 1001, totalQty: 3 });
  expect(h.execute({ type: 'bill.separateTable', billId, targetTableId: 'T3', lines: [{ orderLineId, qty: 2 }] }).ok).toBe(true);
  read = h.pos.read();
  expect(read.pos.bills.filter(b => b.status === 'open').flatMap(b => b.discounts).reduce((n, d) => n + d.amount, 0)).toBe(1001);
  expect(read.pos.bills.filter(b => b.status === 'open').flatMap(b => b.discounts).flatMap(d => d.fixedAllocations ?? []).reduce((n, a) => n + a.amount, 0)).toBe(1001);
});

it('settles merged fixed discounts without repricing percent or losing a source discount', () => {
  const h = setup(), source = h.order('T2'), target = h.order('T3', 'm-cafe-latte');
  expect(h.execute({ type: 'bill.setDiscount', billId: source, discountInput: { source: 'direct', percent: 10 } }).ok).toBe(true);
  expect(h.execute({ type: 'bill.setDiscount', billId: target, discountInput: { source: 'direct', amount: 100 } }).ok).toBe(true);
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: source, targetBillId: target }).ok).toBe(true);
  expect(quoteBill(h.pos.read(), target)).toMatchObject({ discount: 400, payable: 6400 });
  expect(quotePaymentBill(h.pos.read(), target)).toMatchObject({ discount: 400, payable: 6400 });
  expect(h.pos.beginApproval({ billId: target, quoteRevision: h.pos.read().posRevision, splits: [{ method: 'card', amount: 6400 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true);
  expect(selectPosDayTotals(h.pos.read().pos)).toMatchObject({ revenue: 837620, discount: 28680 });
});

it('prevents undo from erasing a later payment, preserves preparation updates, and deduplicates transfer commands', () => {
  const h = setup(), billId = h.order('T2');
  const command = { type: 'bill.moveTable' as const, billId, targetTableId: 'T3', meta: h.meta() };
  const moved = h.pos.execute(command);
  expect(moved.ok).toBe(true);
  const before = h.pos.read().pos;
  expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
  expect(h.pos.read().pos).toBe(before);
  expect(h.execute({ type: 'order.complete', orderId: 'O-154' }).ok).toBe(true);
  expect(moved.ok && h.pos.undo(moved.undoToken!)).toMatchObject({ ok: true });
  expect(h.pos.read().pos.orders.at(-1)?.preparation).toBe('completed');
  const movedAgain = h.execute({ type: 'bill.moveTable', billId, targetTableId: 'T1' });
  expect(h.pos.beginApproval({ billId, quoteRevision: h.pos.read().posRevision, splits: [{ method: 'card', amount: 3000 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  expect(movedAgain.ok && h.pos.undo(movedAgain.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
});

it('refuses undo if the vacated table was deleted, without losing the destination bill', () => {
  const h = setup(), billId = h.order('T2');
  const moved = h.execute({ type: 'bill.moveTable', billId, targetTableId: 'T3' });
  expect(moved.ok).toBe(true);
  const settings = h.pos.read().settings, layout = settings.tableLayout!;
  expect(h.execute({ type: 'table.saveLayout', expectedSettingsRevision: settings.revision, layout: { ...layout, revision: layout.revision + 1, tables: layout.tables.filter(t => t.tableId !== 'T2') } }).ok).toBe(true);
  const before = h.pos.read().pos;
  expect(moved.ok && h.pos.undo(moved.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  expect(h.pos.read().pos).toBe(before);
  expect(quoteBill(h.pos.read(), billId).remaining).toBe(3000);
});

it('records affected order transfer history once and removes the event on undo', () => {
  const h = setup(), billId = h.order('T2', 'm-cafe-latte', 2), orderId = 'O-154';
  const original = h.pos.read().pos.orders.find(o => o.orderId === orderId)!;
  const command = { type: 'bill.separateTable' as const, billId, targetTableId: 'T1', lines: [{ orderLineId: original.lines[0].orderLineId, qty: 1 }], meta: h.meta() };
  const result = h.pos.execute(command);
  expect(result.ok).toBe(true);
  h.pos.execute(command);
  expect(h.pos.read().pos.orders.find(o => o.orderId === orderId)?.statusHistory).toMatchObject([{ kind: 'separate', fromTableId: 'T2', toTableId: 'T1', at: POS_NOW }]);
  expect(h.pos.read().pos.orders[0].statusHistory).toBeUndefined();
  expect(result.ok && h.pos.undo(result.undoToken!)).toMatchObject({ ok: true });
  expect(h.pos.read().pos.orders.find(o => o.orderId === orderId)?.statusHistory ?? []).toEqual([]);
});

// A fragmented original redemption must contribute one use, then restore only after all fragments are canceled.
for (const benefit of ['coupon', 'membership'] as const) it(`counts a transferred ${benefit} once across separate recognition and cancellation`, () => {
  const h = setup(), billId = h.order('T2', benefit === 'coupon' ? 'm-cafe-latte' : 'm-americano', benefit === 'coupon' ? 3 : 2);
  const membershipId = h.pos.read().data.loyalty!.passes.find(p => p.membershipId === 'sample-pass-1')!.membershipId;
  const usesBefore = h.data.getSnapshot().tables.membership.find(p => p.membershipId === membershipId)!.usesLeft;
  expect(h.execute({ type: 'bill.member', billId, memberId: 'M-0012' }).ok).toBe(true);
  expect(h.execute({ type: 'bill.setDiscount', billId, discountInput: benefit === 'coupon' ? { source: 'coupon', couponId: cafeCoupon.couponId } : { source: 'membership', membershipId } }).ok).toBe(true);
  const lineId = h.pos.read().pos.orders.at(-1)!.lines[0].orderLineId;
  expect(h.execute({ type: 'bill.separateTable', billId, targetTableId: 'T1', lines: [{ orderLineId: lineId, qty: 1 }] }).ok).toBe(true);
  const other = h.pos.read().pos.bills.find(b => b.status === 'open' && b.tableId === 'T1')!.billId;
  const expectedDiscount = benefit === 'coupon' ? 1000 : 300;
  expect([billId, other].reduce((n, id) => n + quotePaymentBill(h.pos.read(), id).discount, 0)).toBe(expectedDiscount);
  expect(h.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', amount: 100 } })).toMatchObject({ ok: false, reason: 'BILL_LOCKED' });
  const paymentIds: string[] = [];
  for (const id of [billId, other]) {
    const q = quotePaymentBill(h.pos.read(), id);
    expect(q.canSubmit).toBe(true);
    const approval=h.pos.beginApproval({ billId: id, quoteRevision: q.revision, splits: [{ method: 'card', amount: q.payable }], meta: h.meta() });expect(approval.ok,JSON.stringify(approval)).toBe(true);
    expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
    paymentIds.push(h.pos.read().pos.payments.at(-1)!.paymentId);
    if (benefit === 'coupon') expect(selectPosCouponPerformance(h.data.getSnapshot()).find(c => c.codeId === cafeCode.codeId)?.usedDelta).toBe(1);
    else expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === membershipId)?.usesLeft).toBe(usesBefore! - 1);
  }
  if (benefit === 'coupon') expect(selectPosCouponPerformance(h.data.getSnapshot()).find(c => c.codeId === cafeCode.codeId)).toMatchObject({ usedDelta: 1, revenueDelta: 10400, discountDelta: 1000 });
  expect(selectMembers(h.data.getSnapshot(), {}).rows.find(m => m.memberId === 'M-0012')?.recentVisits).toBe(9);
  for (const [i, paymentId] of paymentIds.entries()) {
    const quoted = quoteReversal(h.pos.read(), { paymentId, kind: 'cancel' });
    expect(quoted.canSubmit).toBe(true);
    expect(h.execute({ type: 'payment.reverse', quoteToken: quoted.quoteToken, confirmed: true }).ok).toBe(true);
    if (benefit === 'coupon') expect(selectPosCouponPerformance(h.data.getSnapshot()).find(c => c.codeId === cafeCode.codeId)?.usedDelta).toBe(i === 0 ? 1 : 0);
    else expect(h.data.getSnapshot().tables.membership.find(p => p.membershipId === membershipId)?.usesLeft).toBe(i === 0 ? usesBefore! - 1 : usesBefore);
  }
  expect(readModel(h.data.getSnapshot(), 'ledger').sales.net).toBe(seedToday.rollup.net);
});

it('preserves original coupon contributions and member linkage after merging into an unrelated bill', () => {
  const h = setup(), source = h.order('T2', 'm-cafe-latte', 2), target = h.order('T3', 'm-americano');
  h.execute({ type: 'bill.member', billId: source, memberId: 'M-0012' });
  h.execute({ type: 'bill.setDiscount', billId: source, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId } });
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: source, targetBillId: target }).ok).toBe(true);
  const q = quotePaymentBill(h.pos.read(), target);
  expect(q).toMatchObject({ discount: 1000, payable: 9600 });
  expect(h.pos.beginApproval({ billId: target, quoteRevision: q.revision, splits: [{ method: 'card', amount: 9600 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true);
  expect(selectPosCouponPerformance(h.data.getSnapshot()).find(c => c.codeId === cafeCode.codeId)).toMatchObject({ usedDelta: 1, revenueDelta: 6600, discountDelta: 1000 });
  expect(selectMembers(h.data.getSnapshot(), {}).rows.find(m => m.memberId === 'M-0012')).toMatchObject({ recentVisits: 9, lastPayment: { billId: target } });
});

it('freezes the current quote when a percent-discounted bill gained another order before transfer', () => {
  const h = setup(), billId = h.order('T2');
  h.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', percent: 10 } });
  h.order('T2', 'm-cafe-latte');
  expect(quotePaymentBill(h.pos.read(), billId)).toMatchObject({ discount: 680, payable: 6120 });
  const target = h.order('T1');
  expect(h.execute({ type: 'bill.mergeTables', sourceBillId: billId, targetBillId: target }).ok).toBe(true);
  expect(quotePaymentBill(h.pos.read(), target)).toMatchObject({ canSubmit: true, discount: 680, payable: 9120 });
});
