import { describe, expect, it } from 'vitest';
import { createPosSeed } from '../../../pos/seed/legacy';
import type { MemberAccountTxn, MoneyRead, SalesRecognition, Settlement } from './types';
import { applied, credit, membership, method, read, source, terms, transact } from './test-fixtures';
import { planMembershipServiceDay, planRecognizeCustomPickup, selectAccountingClosing, selectAccountingDay, selectMemberAccounts, selectMemberships } from './index';

/** Replay the original PRD 12.6 examples with their recorded POS events. */
function prd(): MoneyRead {
  let r = read();
  const seed = createPosSeed(), bills = seed.bills.filter(b => b.recognizedAt);
  const metrics = bills.flatMap(b => b.settlementLines.map((l, i): SalesRecognition => ({ recognitionId: `metric:${b.billId}:${i}`, source: 'menu', sourceId: b.billId,
    businessDate: r.businessDate, at: r.now, amount: 0, cost: (l.unitCostAtSale! + l.optionCostAtSale!) * l.qty, settlementCategory: 'card',
    quantity: l.qty, gross: (l.basePriceAtSale + l.optionPriceAtSale) * l.qty, menuId: l.menuId, originalRecognitionId: null })));
  const distribution = [
    { method: 'card' as const, count: 58, total: 874336 }, { method: 'easy_pay' as const, count: 22, total: 298000 }, { method: 'cash' as const, count: 6, total: 74000 },
  ];
  const settlements: Settlement[] = distribution.flatMap(({ method, count, total }) => Array.from({ length: count }, (_, i) => {
    const amount = Math.floor(total / count) + (i === count - 1 ? total % count : 0), settlementId = `recorded:${method}:${i}`;
    return { settlementId, purpose: 'sale' as const, sourceRef: { kind: 'bill', id: bills[i].billId }, billId: bills[i].billId, partId: null, memberId: null,
      at: r.now, amount, allocations: [{ allocationId: settlementId, kind: 'method' as const, method, amount }], status: 'paid' as const };
  }));
  const recognized = settlements.map((s): SalesRecognition => ({ recognitionId: s.settlementId, source: 'menu', sourceId: s.sourceRef.id, businessDate: r.businessDate, at: r.now,
    amount: s.amount, cost: 0, settlementCategory: s.allocations[0].method!, settlementId: s.settlementId, originalRecognitionId: null }));
  const discount = { direct: 17664, coupon: 2500, membership: 15500 };
  metrics[0] = { ...metrics[0], discountBySource: discount };
  const accounts: MemberAccountTxn[] = [
    { txnId: 'opening-charge', memberId: 'M-0003', account: 'charge', kind: 'opening', amount: 20000, at: '2026-10-25T09:00', settlementId: null, allocationId: null, originalTxnId: null, sourceRef: null, reason: '' },
    { txnId: 'opening-debt', memberId: 'M-0005', account: 'receivable', kind: 'opening', amount: 15000, at: '2026-10-25T09:00', settlementId: null, allocationId: null, originalTxnId: null, sourceRef: null, reason: '' },
  ];
  r = { ...r, state: { ...r.state, settlements, payments: settlements.map(s => ({ paymentId: `payment:${s.settlementId}`, settlementId: s.settlementId, purpose: s.purpose, sourceRef: s.sourceRef, at: s.at, amount: s.amount, splits: [{ method: s.allocations[0].method!, amount: s.amount }] })),
    recognitions: [...recognized, ...metrics, { recognitionId: 'recorded-charge', source: 'menu', sourceId: 'charge', businessDate: r.businessDate, at: r.now, amount: 15000, cost: 0, settlementCategory: 'charge', originalRecognitionId: null },
      { recognitionId: 'recorded-debt', source: 'menu', sourceId: 'debt', businessDate: r.businessDate, at: r.now, amount: 10000, cost: 0, settlementCategory: 'receivable', originalRecognitionId: null },
      { recognitionId: 'recorded-count', source: 'membership_count', sourceId: 'count', businessDate: r.businessDate, at: r.now, amount: 8000, cost: 0, settlementCategory: 'membership_count', originalRecognitionId: null }], accountTxns: accounts } };
  r = credit(r);
  r = transact(r, { purpose: 'receivable_collection', memberId: 'M-0005', amount: 15000 }, [method(15000, 'cash')]).read;
  r = transact(r, { purpose: 'membership_sale', memberId: 'M-0002', productId: 'count' }, [method(40000, 'easy_pay')]).read;
  const custom = source('CO-001', 45000, { purpose: 'custom_order', sourceRef: { kind: 'custom_order', id: 'CO-001' }, billId: undefined, lines: [], paymentTiming: 'advance' });
  r = { ...r, sources: [source(), custom] };
  r = transact(r, { purpose: 'custom_order', customOrderId: 'CO-001' }, [method(45000)]).read;
  const accountRows: MemberAccountTxn[] = [
    { txnId: 'charge-use1', memberId: 'M-0001', account: 'charge', kind: 'use', amount: -10000, at: r.now, settlementId: null, allocationId: null, originalTxnId: null, sourceRef: { kind: 'bill', id: 'charge1' }, reason: '', sourceAmounts: [{ txnId: r.state.accountTxns.find(t => t.kind === 'topup')!.txnId, amount: 10000 }] },
    { txnId: 'charge-use2', memberId: 'M-0003', account: 'charge', kind: 'use', amount: -5000, at: r.now, settlementId: null, allocationId: null, originalTxnId: null, sourceRef: { kind: 'bill', id: 'charge2' }, reason: '', sourceAmounts: [{ txnId: 'opening-charge', amount: 5000 }] },
    { txnId: 'new-debt', memberId: 'M-0005', account: 'receivable', kind: 'sale', amount: 10000, at: r.now, settlementId: null, allocationId: null, originalTxnId: null, sourceRef: { kind: 'bill', id: 'debt' }, reason: '' },
  ];
  const subscriptions = Array.from({ length: 8 }, (_, i) => terms('period', { membershipId: `period:${i}`, memberId: `M-000${i + 1}`, startsOn: r.businessDate, endsOn: '2026-11-24' }));
  const countPass = terms('count', { membershipId: 'existing-count', memberId: 'M-0006' });
  const otherPasses = Array.from({ length: 28 }, (_, i) => terms('count', { membershipId: `other:${i}` }));
  const original = r.state.recognitions[0];
  const refundRecognition: SalesRecognition = { ...original, recognitionId: 'recorded-refund', amount: -10000, originalRecognitionId: original.recognitionId };
  r = { ...r, state: { ...r.state, accountTxns: [...r.state.accountTxns, ...accountRows], memberships: [...r.state.memberships, ...subscriptions, countPass, ...otherPasses],
    recognitions: [...r.state.recognitions, refundRecognition], corrections: [{ correctionId: 'recorded-refund', settlementId: settlements[0].settlementId, at: r.now, kind: 'refund', amount: 10000,
      originalAllocationEffects: [{ allocationId: settlements[0].allocations[0].allocationId!, amount: 10000 }], realMethodReturns: [{ method: 'card', amount: 10000 }], accountEffects: [], membershipEffects: [], recognitionEffects: [refundRecognition], lineEffects: [] }] } };
  return applied(r, planMembershipServiceDay(r, { date: r.businessDate }));
}
describe('PRD 12.6 replay of recorded events and action deltas', () => {
  it('reconciles both axes, counts, baseline quantities/cost/profit and distinct balances', () => {
    const r = prd(), summary = selectAccountingDay(r, { date: r.businessDate });
    expect(summary).toMatchObject({ sales: { total: 1284000, gross: 1315000, discount: 35664, refund: 10000, byRealMethodSale: { card: 864336, easy_pay: 298000, cash: 74000 }, chargeUsed: 15000, receivableCreated: 10000, membershipCount: 8000, subscriptionDaily: 14664, customPickup: 0 },
      deposits: { total: 1386336, byMethod: { card: 959336, easy_pay: 338000, cash: 89000 }, byPurpose: { sale: 1236336, charge_topup: 50000, receivable_collection: 15000, membership_sale: 40000, custom_order: 45000 } },
      orderCount: 94, realPaymentCount: 90, cost: 413000, expenses: 462000, profit: 822000 });
    // Product net-profit baseline also subtracts non-COGS operating costs already in expenses.
    expect(summary.sales.total - summary.expenses).toBe(822000);
    expect(summary.discountBySource).toEqual({ direct: 17664, coupon: 2500, membership: 15500 });
    expect(selectAccountingClosing(r).drawer).toMatchObject({ expected: 189000, actual: null, difference: null });
    expect(selectMemberAccounts(r)).toMatchObject({ chargeBalance: 55000, receivableBalance: 10000, chargeHolders: 2, receivableHolders: 1 });
    expect(selectMemberships(r).activeCount).toBe(38);
    const quantities: Record<string, number> = {};
    for (const x of r.state.recognitions) if (x.menuId) quantities[x.menuId] = (quantities[x.menuId] ?? 0) + (x.quantity ?? 0);
    expect(quantities).toEqual({ 'm-americano': 85, 'm-latte': 78, 'm-vanilla': 30, 'm-croissant': 35, 'm-financier': 25, 'm-beans200': 5, 'm-dripbag': 8 });
  });
  it.each([
    ['topup', 0, 50000, 189000], ['charge', 4500, 0, 189000], ['receivable', 5000, 0, 189000], ['collection', 0, 10000, 199000],
    ['count', 4000, 0, 189000], ['period', 0, 0, 189000], ['custom', 45000, 0, 189000],
  ] as const)('independent %s action changes sales by %i and deposits by %i', (action, sales, deposits, drawer) => {
    const r = runAction(prd(), action), day = selectAccountingDay(r, { date: r.businessDate });
    expect(day.sales.total).toBe(1284000 + sales); expect(day.deposits.total).toBe(1386336 + deposits);
    expect(selectAccountingClosing(r).drawer.expected).toBe(drawer);
    if (action === 'count') expect(day.sales.discountBySource.membership).toBe(16000);
    if (action === 'period') expect(day.sales.discountBySource.membership).toBe(20500);
    if (action === 'custom') { expect(day.unknownCostSales).toEqual([expect.objectContaining({ sourceId: 'CO-001', amount: 45000, cost: null })]); expect(day.cost).toBe(413000); }
  });
  it('keeps AC-1484 five actions cumulative and freezes both axes in the closing value', () => {
    let r = prd();
    const before = selectAccountingClosing(r);
    for (const [action, sales, deposits] of [['topup', 1284000, 1436336], ['charge', 1288500, 1436336], ['receivable', 1293500, 1436336], ['collection', 1293500, 1446336], ['custom', 1338500, 1446336]] as const) {
      r = runAction(r, action);
      expect(selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: sales }, deposits: { total: deposits } });
    }
    expect(before.sales.total).toBe(1284000); expect(before.deposits.total).toBe(1386336); expect(before.drawer.expected).toBe(189000);
    expect(selectAccountingClosing(r).drawer.expected).toBe(199000);
  });
});
function runAction(r: MoneyRead, action: string): MoneyRead {
  if (action === 'topup') return credit(r);
  if (action === 'collection') return transact(r, { purpose: 'receivable_collection', memberId: 'M-0005', amount: 10000 }, [method(10000, 'cash')]).read;
  if (action === 'custom') return applied(r, planRecognizeCustomPickup(r, { customOrderId: 'CO-001', meta: { runId: r.runId, idempotencyKey: 'receive' } }));
  const s = source(`action:${action}`, ['receivable', 'period'].includes(action) ? 5000 : 4500, { memberId: action === 'count' ? 'M-0006' : action === 'period' ? 'M-0004' : 'M-0001' });
  r = { ...r, sources: [s, ...r.sources.filter(x => x.purpose === 'custom_order')] };
  if (action === 'count' || action === 'period') {
    const t = r.state.memberships.find(m => m.memberId === s.memberId && m.kind === (action === 'count' ? 'count' : 'period'))!;
    const a = membership({ ...r, state: { ...r.state, memberships: [t] } }, action === 'count' ? 'membership_count' : 'membership_period', action === 'count' ? 4000 : 0);
    return transact(r, { purpose: 'sale', billId: s.billId }, [a]).read;
  }
  return transact(r, { purpose: 'sale', billId: s.billId }, [{ kind: action === 'charge' ? 'charge' : 'receivable', amount: s.amountDue }]).read;
}
