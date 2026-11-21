import { describe, expect, it } from 'vitest';
import { readModel } from '../../data/widget-data';
import { setup as setupBase } from '../loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../loyalty';
import { selectReceipt, selectCashReceiptTotals } from './index';
import { POS_BUSINESS_DATE } from '../clock';

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


describe('T-251 receipt state and tax amounts', () => {
  it('issues only masked cash identifiers, updates tax once, and cancels without changing revenue', () => {
    const h = setup(); h.add(); const billId = getPaymentBillId(h.pos.read()), q = quotePaymentBill(h.pos.read(), billId);
    h.pos.beginApproval({ billId, quoteRevision: q.revision, splits: [{ method: 'cash', amount: 3000 }], meta: h.meta() });
    h.finish(); h.pos.dismissApproval(); const paymentId = h.pos.read().pos.payments.at(-1)!.paymentId;
    expect(selectCashReceiptTotals(h.pos.read().pos)).toEqual({ count: 0, amount: 0 });
    const command = { type: 'cashReceipt.issue' as const, paymentId, kind: 'income' as const, identifier: '01012345678', meta: h.meta('issue') };
    expect(h.pos.execute(command)).toMatchObject({ ok: true });
    expect(h.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(h.pos.execute({ ...command, meta: h.meta() })).toMatchObject({ ok: false, reason: 'ALREADY_ISSUED' });
    expect(selectReceipt(h.pos.read(), { paymentId })).toMatchObject({ amount: 3000, cashReceipt: { maskedIdentifier: '010-****-5678', cashAmount: 3000, status: 'issued' } });
    expect(JSON.stringify(h.pos.read().pos)).not.toContain('01012345678');
    expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.cashReceipts).toEqual({ count: 1, amount: 3000 });
    const cashReceiptId = h.pos.read().pos.cashReceipts.at(-1)!.cashReceiptId;
    expect(h.pos.execute({ type: 'cashReceipt.cancel', cashReceiptId, meta: h.meta() }).ok).toBe(true);
    expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.cashReceipts).toEqual({ count: 0, amount: 0 });
    expect(h.data.getSnapshot().tables.dailySales.find(d => d.businessDate === POS_BUSINESS_DATE)!.cash).toBe(59900);
  });

  it('rejects invalid identifiers and non-cash payments with no state change', () => {
    const h = setup(), before = h.pos.read().pos, paymentId = before.payments.find(p => p.splits.some(split => split.method === 'cash'))!.paymentId;
    for (const [kind, identifier] of [['income', '123456789'], ['business', '12345678901'], ['income', '010-1234-5678']] as const) {
      expect(h.pos.execute({ type: 'cashReceipt.issue', paymentId, kind, identifier, meta: h.meta() })).toMatchObject({ ok: false, reason: 'IDENTIFIER_INVALID' });
    }
    expect(h.pos.execute({ type: 'cashReceipt.issue', paymentId: before.payments.find(p => p.splits.every(split => split.method !== 'cash'))!.paymentId, kind: 'income', identifier: '01012345678', meta: h.meta() })).toMatchObject({ ok: false, reason: 'NO_CASH_PORTION' });
    expect(h.pos.read().pos).toBe(before);
  });

  it('allows receipt issue/cancel after closing and shows the original frozen line/discount/member data', () => {
    const h = setup(), p = h.pos.read().pos.payments.find(p => p.splits.some(s => s.method === 'cash') && !h.pos.read().pos.cashReceipts.some(r => r.paymentId === p.paymentId))!;
    h.data.dispatch({ type: 'closing.closeDay', date: POS_BUSINESS_DATE, scenario: 'normal', expectedGeneration: 0, idempotencyKey: 'close' });
    expect(h.pos.execute({ type: 'cashReceipt.issue', paymentId: p.paymentId, kind: 'business', identifier: '1234567890', meta: h.meta() }).ok).toBe(true);
    const receipt = selectReceipt(h.pos.read(), { paymentId: p.paymentId });
    expect(receipt!.cashReceipt).toMatchObject({ maskedIdentifier: '123-**-**890' });
    expect(h.pos.execute({ type: 'cashReceipt.cancel', cashReceiptId: receipt!.cashReceipt!.cashReceiptId, meta: h.meta() }).ok).toBe(true);
    const before = h.pos.read().pos;
    expect(h.pos.execute({ type: 'receipt.showAgain', paymentId: p.paymentId, meta: h.meta() })).toMatchObject({ ok: true, status: 'unchanged', noticeKey: 'order.receipt.showAgainDone' });
    expect(h.pos.read().pos).toBe(before);
    expect(selectReceipt(h.pos.read(), { paymentId: 'unknown' })).toBeNull();
    const memberPayment = before.payments.find(p => before.bills.find(b => b.billId === p.billId)?.memberId)!;
    const member = selectReceipt(h.pos.read(), { paymentId: memberPayment.paymentId })!.member!;
    expect(member.name).toContain('○'); expect(member.phone).toContain('****');
  });

  it('reads the existing store profile and masks raw member text supplied by an adapter', () => {
    const h = setup(), read = h.pos.read();
    const payment = read.pos.payments.find(p => read.pos.bills.find(b => b.billId === p.billId)?.memberId)!;
    const bill = read.pos.bills.find(b => b.billId === payment.billId)!;
    expect(selectReceipt(read, { paymentId: payment.paymentId })!.storeName).toBe(h.data.getSnapshot().tables.marketing.promoStore[0].name);
    const rawRead = { ...read, data: { ...read.data, loyalty: { ...read.data.loyalty!, members: read.data.loyalty!.members.map(m => m.memberId === bill.memberId ? { ...m, name: { raw: '이선우' }, phone: '01012345678' } : m) } } };
    expect(selectReceipt(rawRead, { paymentId: payment.paymentId })!.member).toMatchObject({ name: '이○우', phone: '010-****-5678' });
  });
});
