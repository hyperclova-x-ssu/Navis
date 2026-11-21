import { describe, expect, it } from 'vitest';
import { setup as setupBase } from '../../pos/loyalty/test-setup';
import { getPaymentBillId } from '../../pos/loyalty';
import { readModel, selectMembers, selectWidget } from '../widget-data';
import { selectAccountingPresentation } from './projection';
import { selectAccountingDay } from '../iteration7/accounting';
import type { SettlementAllocation } from '../iteration7/accounting';
import { selectCashReceiptTotals, selectReceipt } from '../../pos/reversals';
import { POS_BUSINESS_DATE } from '../../pos/clock';
import { LAST_MONTH_START, MONTH_START, YESTERDAY } from '../db/time';
import { seedSupplement } from '../db/generated/supplement';
import { cafeMemberId } from '../db/cafe-identity';
import { seedOperations } from '../db/generated/operations';

const cafeCoupon = seedOperations.coupons.find(coupon => coupon.status === 'active')!;

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

function pay(h: ReturnType<typeof setup>, allocations: readonly SettlementAllocation[], key = 'sale', partId?: string) {
  const billId = getPaymentBillId(h.pos.read());
  const selectedPart = partId ?? h.pos.read().pos.bills.find(b => b.billId === billId)?.splitPlan?.parts.find(p => p.status === 'unpaid')?.partId;
  const quote = h.actions.money.quoteSale({ billId, allocations, partId: selectedPart });
  expect(quote.issues).toEqual([]);
  expect(h.actions.money.beginApproval({ quote, idempotencyKey: key }).ok).toBe(true);
  const a = h.actions.money.approval()!;
  const result = h.actions.money.finishApproval({ runId: a.runId, attemptId: a.attemptId, outcome: 'approved' });
  expect(result.ok).toBe(true);
  h.actions.money.dismissApproval();
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('M3 canonical POS review regressions', () => {
  it.each(['cancel', 'refund'] as const)('RV-5 full cash %s cancels the issued cash receipt atomically', kind => {
    const h = setup(); h.add();
    const sale = pay(h, [{ kind: 'method', method: 'cash', amount: 3000 }]);
    expect(h.pos.execute({ type: 'cashReceipt.issue', paymentId: sale.paymentId!, kind: 'income', identifier: '01012345678', meta: h.meta() }).ok).toBe(true);
    if (kind === 'refund') expect(h.pos.execute({ type: 'order.start', orderId: sale.orderIds![0], meta: h.meta() }).ok).toBe(true);
    const totals = selectCashReceiptTotals(h.pos.read().pos);
    const observations: string[] = [];
    const off = h.data.subscribe(() => observations.push(h.data.getSnapshot().pos!.cashReceipts.find(r => r.paymentId === sale.paymentId)!.status));
    const quote = h.actions.money.quoteReversal({ settlementId: sale.settlementId, kind });
    expect(h.actions.money.reverse({ quote, idempotencyKey: 'reverse' }).ok).toBe(true);
    off();
    expect(observations).toEqual(['canceled']);
    expect(selectReceipt(h.pos.read(), { paymentId: sale.paymentId! })?.cashReceipt).toMatchObject({ status: 'canceled' });
    expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.cashReceipts).toEqual({ count: totals.count - 1, amount: totals.amount - 3000 });
  });

  it('RV-6 restores an account-only coupon and visit only after its last sale part is canceled', () => {
    const h = setup(); h.add();
    const billId = getPaymentBillId(h.pos.read());
    h.pos.execute({ type: 'bill.member', billId, memberId: 'M-0012', meta: h.meta() });
    h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'coupon', couponId: cafeCoupon.couponId }, meta: h.meta() });
    const before = selectMembers(h.data.getSnapshot(), {}).rows.find(m => m.memberId === 'M-0012')!.recentVisits;
    h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
    const parts = h.pos.read().pos.bills.find(b => b.billId === billId)!.splitPlan!.parts;
    const sales = parts.map((p, i) => pay(h, [{ kind: 'charge', amount: 1000 }], `part-${i}`, p.partId));
    expect(sales.every(s => !s.paymentId)).toBe(true);
    expect(readModel(h.data.getSnapshot(), 'coupon-status').monthUsed).toBe(366);
    expect(selectMembers(h.data.getSnapshot(), {}).rows.find(m => m.memberId === 'M-0012')!.recentVisits).toBe(before + 1);
    for (let i = 0; i < sales.length; i++) {
      const quote = h.actions.money.quoteReversal({ settlementId: sales[i].settlementId, kind: 'cancel' });
      const command = { quote, idempotencyKey: `reverse-${i}` };
      expect(h.actions.money.reverse(command).ok).toBe(true);
      const snapshot = h.data.getSnapshot();
      expect(h.actions.money.reverse(command)).toMatchObject({ ok: true, duplicate: true });
      expect(h.data.getSnapshot()).toBe(snapshot);
      expect(readModel(snapshot, 'coupon-status').monthUsed).toBe(i === 0 ? 366 : 365);
      expect(selectMembers(snapshot, {}).rows.find(m => m.memberId === 'M-0012')!.recentVisits).toBe(i === 0 ? before + 1 : before);
    }
  });

  it.each(['bill.confirmZero', 'bill.cancelPartial'] as const)('RV-7 validates caller run/revisions/key before %s and publishes nothing', type => {
    const h = setup(); h.add('m-americano', 2);
    const billId = getPaymentBillId(h.pos.read());
    if (type === 'bill.confirmZero') h.pos.execute({ type: 'bill.setDiscount', billId, discountInput: { source: 'direct', percent: 100 }, meta: h.meta() });
    else {
      h.pos.execute({ type: 'bill.split', billId, kind: 'equal', n: 2, meta: h.meta() });
      pay(h, [{ kind: 'method', method: 'card', amount: 3000 }]);
    }
    const current = h.pos.read(), before = h.data.getSnapshot();
    for (const [meta, reason] of [
      [{ ...h.meta(), runId: 'another-run' }, 'STALE_RUN'],
      [{ ...h.meta(), expectedPosRevision: current.posRevision - 1 }, 'STALE_REVISION'],
      [{ ...h.meta(), expectedDataRevision: current.dataRevision - 1 }, 'STALE_REVISION'],
      [{ ...h.meta(), idempotencyKey: '' }, 'IDEMPOTENCY_KEY_REQUIRED'],
    ] as const) {
      expect(h.pos.execute({ type, billId, confirmed: true, meta })).toMatchObject({ ok: false, reason });
      expect(h.pos.read().pos).toBe(current.pos);
      expect(h.data.getSnapshot()).toBe(before);
    }
  });

  it('smoke 1 reconciles tax month with ledger history and recorded deposits without duplicate backfills', () => {
    const h = setup(), read = h.actions.money.read();
    const openDay = selectAccountingDay(read, { date: POS_BUSINESS_DATE });
    const history = h.data.getSnapshot().tables.dailySales.filter(row => row.businessDate >= MONTH_START && row.businessDate < POS_BUSINESS_DATE);
    const deposits = history.reduce((sum, row) => sum + row.card + row.easyPay + row.cash, openDay.deposits.total);
    const monthly = selectAccountingPresentation(h.data.getSnapshot()).views.find(v => v.period.start === MONTH_START && v.period.end === POS_BUSINESS_DATE);
    const ledger = selectWidget(h.data.getSnapshot(), 'ledger', { kind: 'dateRange', start: MONTH_START, end: POS_BUSINESS_DATE }, 'normal');
    if (ledger.status !== 'ready') throw new Error('Monthly ledger missing');
    expect(monthly).toMatchObject({ status: 'ready', summary: { sales: { total: ledger.model.sales.net }, deposits: { total: deposits } },
      depositCoverage: { start: MONTH_START, end: POS_BUSINESS_DATE, complete: true } });
    expect(readModel(h.data.getSnapshot(), 'tax').exportPreview.salesTotal).toBe(ledger.model.sales.net);
    expect(monthly?.status === 'ready' && monthly.summary.deposits.total).toBe(16783300);
    expect(selectAccountingPresentation(h.data.getSnapshot()).views.find(v => v.period.start === LAST_MONTH_START)?.status).toBe('ready');
  });

  it('links the seeded count holder and opening receivable balance to their generated members', () => {
    const h = setup(), read = h.actions.money.read();
    const pass = seedSupplement.activePasses[0];
    const account = seedSupplement.balances.find(row => row.receivableBalance > 0)!;
    const membership = read.state.memberships.find(row => row.membershipId === pass.membershipId);
    expect(membership).toMatchObject({ memberId: cafeMemberId(pass.memberId), productId: pass.productId, startsOn: pass.startsOn });
    expect(read.members.find(row => row.memberId === membership?.memberId)?.name).toBe(pass.memberName);
    expect(read.state.accountTxns.find(row => row.memberId === cafeMemberId(account.memberId) && row.account === 'receivable'))
      .toMatchObject({ kind: 'opening', at: `${YESTERDAY}T08:00`, amount: account.receivableBalance, provenance: 'sample' });
  });
});
