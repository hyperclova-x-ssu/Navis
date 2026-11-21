import { expect, it } from 'vitest';
import { setup as setupBase } from '../loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../loyalty';
import { selectPosDrawer } from './index';
import { quoteReversal } from '../reversals';
import { seedToday } from '../../data/db/generated/today';

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


it('validates drawer edits, deduplicates movements and reverses removal without changing expenses', () => {
  const h = setup(), expenses = h.data.getSnapshot().tables.expense;
  for (const amount of [-1, NaN, 1.5, 'abc']) {
    const before = h.pos.read().pos;
    expect(h.pos.execute({ type: 'drawer.set', actual: amount as number, meta: h.meta() })).toMatchObject({ ok: false, reason: 'INVALID_AMOUNT' });
    expect(h.pos.read().pos).toBe(before);
  }
  expect(h.pos.execute({ type: 'drawer.addMovement', kind: 'out', amount: 0, meta: h.meta() })).toMatchObject({ ok: false });
  const command = { type: 'drawer.addMovement' as const, kind: 'out' as const, amount: 20000, memo: '우유 사러', meta: h.meta() };
  expect(h.pos.execute(command).ok).toBe(true);
  expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
  expect(selectPosDrawer(h.pos.read().pos)).toMatchObject({ expected: 236900, out: 20000, difference: null });
  const removal = h.pos.execute({ type: 'drawer.removeMovement', movementId: h.pos.read().pos.drawer.movements[0].movementId, meta: h.meta() });
  expect(removal.ok).toBe(true);
  expect(selectPosDrawer(h.pos.read().pos).expected).toBe(seedToday.rollup.expectedDrawer);
  expect(removal.ok && h.pos.undo(removal.undoToken!)).toMatchObject({ ok: true });
  expect(h.pos.execute({ type: 'drawer.set', actual: 236900, memo: '잔돈 확인', meta: h.meta() }).ok).toBe(true);
  expect(selectPosDrawer(h.pos.read().pos)).toMatchObject({ expected: 236900, difference: 0, memo: '잔돈 확인' });
  expect(h.data.getSnapshot().tables.expense).toEqual(expenses);
});

it('includes partial cash and subtracts each returned cash amount once, retaining original splits', () => {
  const h = setup(); h.add('m-cafe-latte', 2); const billId = getPaymentBillId(h.pos.read());
  h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
  let q = quotePaymentBill(h.pos.read(), billId);
  h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: 3800 }], meta: h.meta() });
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  expect(selectPosDrawer(h.pos.read().pos)).toMatchObject({ approvedCash: 60700, cashPayments: 56900, pendingCash: 3800, expected: 260700 });
  h.pos.execute({ type: 'bill.cancelPartial', billId, confirmed: true, meta: h.meta() });
  expect(selectPosDrawer(h.pos.read().pos)).toMatchObject({ approvedCash: 60700, cashPayments: 60700, pendingCash: 0, cashReturned: 3800, expected: seedToday.rollup.expectedDrawer });
  h.add('m-americano');
  q = quotePaymentBill(h.pos.read());
  expect(q.payable).toBe(10600);
  h.pos.beginApproval({ billId: q.billId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: q.payable }], meta: h.meta() });
  h.finish(); h.pos.dismissApproval();
  const payment = h.pos.read().pos.payments.at(-1)!;
  const cancel = quoteReversal(h.pos.read(), { paymentId: payment.paymentId, kind: 'cancel' });
  expect(cancel.canSubmit).toBe(true);
  expect(h.pos.execute({ type: 'payment.reverse', quoteToken: cancel.quoteToken, confirmed: true, meta: h.meta() }).ok).toBe(true);
  expect(h.pos.read().pos.payments.at(-1)?.splits).toEqual(payment.splits);
  expect(selectPosDrawer(h.pos.read().pos).expected).toBe(seedToday.rollup.expectedDrawer);
  h.add('m-americano'); q = quotePaymentBill(h.pos.read());
  expect(h.pos.beginApproval({ billId: q.billId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: 3000 }], meta: h.meta() }).ok).toBe(true);
  expect(h.finish().ok).toBe(true); h.pos.dismissApproval();
  const refundPayment = h.pos.read().pos.payments.at(-1)!;
  expect(h.pos.execute({ type: 'order.start', orderId: h.pos.read().pos.orders.at(-1)!.orderId, meta: h.meta() }).ok).toBe(true);
  const refund = quoteReversal(h.pos.read(), { paymentId: refundPayment.paymentId, kind: 'refund' });
  expect(refund.canSubmit).toBe(true);
  expect(h.pos.execute({ type: 'payment.reverse', quoteToken: refund.quoteToken, confirmed: true, meta: h.meta() }).ok).toBe(true);
  expect(selectPosDrawer(h.pos.read().pos)).toMatchObject({ cashRefunded: 3000, cashReturned: 17400, expected: seedToday.rollup.expectedDrawer });
});
