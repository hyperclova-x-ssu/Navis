import { describe, expect, it } from 'vitest';
import * as engine from './index';
import type { MoneyRead } from './types';

import { read, source, terms, applied, transact, method, credit, withPass, membership, reverse, sellPass } from './test-fixtures';

describe('T-281 canonical money plans', () => {
  it('separates mixed sale and real receipts and reverses original charge/card and stock once', () => {
    let r = credit(read());
    const sale = transact(r, { purpose: 'sale', billId: 'bill' }, [{ kind: 'charge', amount: 3000 }, method(1500)]);
    r = sale.read;
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 4500, chargeUsed: 3000, byRealMethodSale: { card: 1500 } }, deposits: { total: 51500 } });
    expect(engine.selectMemberAccounts(r).chargeBalance).toBe(47000);
    const p = reverse(r, sale.finish.ok ? sale.finish.value.settlementId! : '');
    expect(p).toMatchObject({ ok: true, effects: { lineEffects: [{ quantity: -1, stock: [{ deltaBase: 18 }] }] } });
    r = applied(r, p);
    expect(engine.selectMemberAccounts(r).chargeBalance).toBe(50000);
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0 }, deposits: { total: 50000 } });
    expect(reverse(r, r.state.settlements.at(-1)!.settlementId)).toMatchObject({ ok: false });
  });
  it('blocks the original consumed topup even after an unrelated new topup', () => {
    let r = credit({ ...read(), sources: [source('bill', 10000)] });
    const topupId = r.state.settlements[0].settlementId;
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [{ kind: 'charge', amount: 10000 }]).read;
    r = credit(r);
    const before = structuredClone(r);
    expect(reverse(r, topupId)).toMatchObject({ ok: false, reason: 'TOPUP_ALREADY_USED' });
    expect(r).toEqual(before);
  });
  it('reserves partial split accounts/deposits, recognizes only at completion and abandons exact shares', () => {
    let r = credit({ ...read(), sources: [source('bill', 9000, { parts: [{ partId: 'p1', amount: 4500 }, { partId: 'p2', amount: 4500 }] })] });
    r = transact(r, { purpose: 'sale', billId: 'bill', partId: 'p1' }, [{ kind: 'charge', amount: 3000 }, method(1500, 'cash')]).read;
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0 }, deposits: { total: 51500, pendingReceived: 1500 } });
    const p = engine.planAbandonSettlement(r, { sourceRef: { kind: 'bill', id: 'bill' }, meta: { runId: r.runId, idempotencyKey: 'abandon' } });
    const abandoned = applied(r, p);
    expect(engine.selectAccountingDay(abandoned, { date: r.businessDate })).toMatchObject({ sales: { total: 0 }, deposits: { total: 50000, pendingReceived: 0 } });
    expect(engine.selectMemberAccounts(abandoned).chargeBalance).toBe(50000);
    const final = transact(r, { purpose: 'sale', billId: 'bill', partId: 'p2' }, [method(4500)]).read;
    expect(engine.selectAccountingDay(final, { date: r.businessDate })).toMatchObject({ sales: { total: 9000, chargeUsed: 3000 }, deposits: { total: 56000, pendingReceived: 0 } });
  });
  it('maps partial collection to oldest debt and blocks sale reversal until collection reversal', () => {
    let r: MoneyRead = { ...read(), sources: [source('bill', 10000)] };
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [{ kind: 'receivable', amount: 10000 }]).read;
    const saleId = r.state.settlements[0].settlementId;
    const collected = transact(r, { purpose: 'receivable_collection', memberId: 'M-0001', amount: 4000 }, [method(4000, 'cash')]);
    r = collected.read;
    expect(engine.selectMemberAccounts(r).receivableBalance).toBe(6000);
    expect(engine.selectAccountingDrawer(r)).toMatchObject({ expected: 104000, difference: null });
    expect(reverse(r, saleId)).toMatchObject({ ok: false, reason: 'RECEIVABLE_ALREADY_COLLECTED', details: { collectionIds: [r.state.settlements[1].settlementId] } });
    r = applied(r, reverse(r, r.state.settlements[1].settlementId));
    expect(engine.selectMemberAccounts(r).receivableBalance).toBe(10000);
    r = applied(r, reverse(r, saleId));
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0 }, deposits: { total: 0 } });
    expect(engine.selectMemberAccounts(r).receivableBalance).toBe(0);
  });
  it('recognizes count value, caps a final use and keeps residual until expiry', () => {
    let r = withPass(read(), terms('count', { soldPrice: 5000, totalUses: 1, endsOn: '2026-10-26' }));
    const sale = transact(r, { purpose: 'sale', billId: 'bill' }, [membership(r, 'membership_count', 4500)]);
    r = sale.read;
    expect(sale.quote).toMatchObject({ amountDue: 4500, discounts: [{ amount: 0 }] });
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ usesRemaining: 0, recognizedValue: 4500, unrecognizedValue: 500 });
    const p = engine.planMembershipServiceDay(r, { date: '2026-10-26' });
    r = applied(r, p);
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 5000, membershipCount: 4500, membershipExpiry: 500 } });
    expect(engine.planMembershipServiceDay(r, { date: r.businessDate })).toMatchObject({ ok: true, changed: false });
  });
  it('uses floor shares and final division remainder, and restores count use on its last fragment', () => {
    let r = withPass(read(), terms('count', { soldPrice: 8001, totalUses: 2 }));
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [membership(r, 'membership_count', 4000)]).read;
    const first = r.state.settlements[0].settlementId;
    const q = engine.quoteMembershipUse({ ...r, sources: [source('second')] }, { membershipId: 'pass', source: source('second'), allocationId: 'line:second', quantity: 1 });
    expect(q).toMatchObject({ recognizedAmount: 4001, membershipDiscount: 499 });
    r = applied(r, reverse(r, first, 2000, 'refund'));
    expect(engine.selectMemberships(r).memberships[0].usesRemaining).toBe(1);
    r = applied(r, reverse(r, first, 2000, 'refund'));
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ usesRemaining: 2, recognizedValue: 0 });
  });
  it('subscription use gives zero revenue/receipt while retaining quantity/stock and independent delivered days', () => {
    let r = withPass({ ...read(), sources: [source('bill', 5000)] }, terms('period', { startsOn: '2026-10-26', endsOn: '2026-11-24' }));
    r = applied(r, engine.planMembershipServiceDay(r, { date: r.businessDate }));
    const sale = transact(r, { purpose: 'sale', billId: 'bill' }, [membership(r, 'membership_period', 0)]);
    r = sale.read;
    expect(sale.finish).toMatchObject({ ok: true, effects: { payments: [], lineEffects: [{ quantity: 1, stock: [{ deltaBase: -18 }] }] } });
    expect(sale.finish.ok && sale.finish.value.paymentId).toBeUndefined();
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 1833, discount: 5000 }, orderCount: 1, realPaymentCount: 0 });
    r = applied(r, engine.planMembershipServiceDay(r, { date: r.businessDate }));
    r = applied(r, reverse(r, r.state.settlements[0].settlementId));
    expect(engine.selectAccountingDay(r, { date: r.businessDate }).sales.total).toBe(1833);
    expect(r.state.uses[0].canceledAt).toBe(r.now);
  });
  it('delivers 1833 for days 1–29 and 1843 on day 30 exactly once per business day', () => {
    let r = withPass(read(), terms('period', { startsOn: '2026-09-27', endsOn: '2026-10-26' }));
    r = applied(r, engine.planMembershipServiceDay(r, { date: '2026-10-26' }));
    expect(r.state.recognitions.filter(x => x.source === 'subscription_day')).toHaveLength(30);
    expect(r.state.recognitions.filter(x => x.amount === 1833)).toHaveLength(29);
    expect(engine.selectAccountingDay(r, { date: '2026-10-26' }).sales.subscriptionDaily).toBe(1843);
    expect(r.state.recognitions.reduce((n, x) => n + x.amount, 0)).toBe(55000);
  });
  it('recognizes expired 8000 and refunds only unrecognized 12000 without erasing service', () => {
    let r = sellPass(read());
    const t = r.state.memberships[0];
    const uses = Array.from({ length: 7 }, (_, i) => ({ useId: `old:${i}`, membershipId: t.membershipId, at: '2026-10-25T10:00', sourceRef: { kind: 'bill', id: `old:${i}` }, coveredQuantities: [], recognizedAmount: 4000, membershipDiscount: 500, canceledAt: null }));
    const recognitions = uses.map(u => ({ recognitionId: u.useId, source: 'membership_count' as const, sourceId: u.useId, businessDate: '2026-10-25', at: u.at, amount: 4000, cost: 0, settlementCategory: 'membership_count' as const, membershipId: t.membershipId, useId: u.useId, originalRecognitionId: null }));
    r = { ...r, state: { ...r.state, uses, recognitions } };
    expect(engine.quoteMembershipRefund(r, { membershipId: t.membershipId })).toMatchObject({ amount: 12000, realMethodReturns: [{ method: 'card', amount: 12000 }] });
    expect(engine.quoteMoneyReversal(r, { settlementId: t.saleSettlementId, kind: 'refund' })).toMatchObject({ amount: 12000, canSubmit: true, realMethodReturns: [{ method: 'card', amount: 12000 }], recognitionEffects: [] });
    const q = engine.quoteMembershipRefund(r, { membershipId: t.membershipId });
    r = applied(r, engine.planMembershipRefund(r, { quote: q, meta: { runId: r.runId, idempotencyKey: 'pass-refund' } }));
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0 }, deposits: { total: 28000 } });
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ refundedValue: 12000, recognizedValue: 28000, status: 'refunded' });
    const expired = { ...r, state: { ...r.state, memberships: [{ ...t, endsOn: r.businessDate }], corrections: [], uses: uses.concat({ ...uses[0], useId: 'eighth' }), recognitions: recognitions.concat({ ...recognitions[0], recognitionId: 'eighth', useId: 'eighth' }) } };
    const p = engine.planMembershipServiceDay(expired, { date: r.businessDate });
    expect(p).toMatchObject({ ok: true, effects: { recognitions: [{ amount: 8000, source: 'membership_expiry' }] } });
  });
  it('rejects circular funding, nonmember, overdraft, overcollection, stale and failed approvals without side effects', () => {
    const r = read(), before = structuredClone(r);
    for (const [target, allocations, reason] of [
      [{ purpose: 'charge_topup', memberId: 'M-0001', amount: 100 }, [{ kind: 'charge', amount: 100 }], 'INVALID_SETTLEMENT_KIND'],
      [{ purpose: 'charge_topup', memberId: 'missing', amount: 100 }, [method(100)], 'NOT_FOUND'],
      [{ purpose: 'sale', billId: 'bill' }, [{ kind: 'charge', amount: 4500 }], 'CHARGE_BALANCE_EXCEEDED'],
      [{ purpose: 'receivable_collection', memberId: 'M-0001', amount: 100 }, [method(100)], 'RECEIVABLE_LIMIT'],
    ] as const) expect(engine.quoteSettlement(r, { target, allocations }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason })]));
    const q = engine.quoteSettlement(r, { target: { purpose: 'sale', billId: 'bill' }, allocations: [method(4500)] });
    expect(engine.planBeginSettlementApproval({ ...r, dayClosed: true }, { quote: q, meta: { runId: r.runId, idempotencyKey: 'closed' } })).toMatchObject({ ok: false, reason: 'DAY_CLOSED' });
    const begin = engine.planBeginSettlementApproval(r, { quote: q, meta: { runId: r.runId, idempotencyKey: 'a' } });
    if (!begin.ok) throw new Error('begin');
    const pending = applied(r, begin), args = { runId: r.runId, attemptId: begin.attemptId!, expectedQuoteFingerprint: pending.state.attempt!.fingerprint, outcome: 'approved' as const };
    expect(engine.planFinishSettlementApproval(pending, { ...args, outcome: 'failed' })).toMatchObject({ ok: false, reason: 'APPROVAL_FAILED' });
    expect(engine.planFinishSettlementApproval({ ...pending, sources: [source('bill', 5000)] }, args)).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    expect(engine.planFinishSettlementApproval({ ...pending, generation: 1 }, args)).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    const p = engine.planFinishSettlementApproval(pending, args), done = applied(pending, p);
    expect(engine.planFinishSettlementApproval(done, args)).toMatchObject({ ok: true, duplicate: true, changed: false, effects: { payments: [], recognitions: [] } });
    expect(engine.planFinishSettlementApproval(done, { ...args, expectedQuoteFingerprint: 'different' })).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    expect(r).toEqual(before);
    expect(pending.state.payments).toHaveLength(0);
  });
  it('previews account and recognition effects before committing and rejects missing menu context', () => {
    const r = credit(read());
    const q = engine.quoteSettlement(r, { target: { purpose: 'sale', billId: 'bill' }, allocations: [{ kind: 'charge', amount: 3000 }, method(1500)] });
    expect(q.accountEffects).toEqual([expect.objectContaining({ account: 'charge', kind: 'use', amount: -3000 })]);
    expect(q.recognitionEffects.map(x => x.amount).sort((a, b) => a - b)).toEqual([1500, 3000]);
    const bad = { ...r, sources: [source('bill', 4500, { lines: [] })] };
    expect(engine.quoteSettlement(bad, { target: { purpose: 'sale', billId: 'bill' }, allocations: [{ kind: 'receivable', amount: 4500 }] })).toMatchObject({ canSubmit: false });
  });
  it('rejects ineligible retail subscription use', () => {
    const r = withPass({ ...read(), sources: [source('bill', 5000, { lines: [{ allocationId: 'retail', orderLineId: 'retail', menuId: 'm-beans200', quantity: 1, unitPrice: 5000, unitCost: 2000 }] })] }, terms('period'));
    expect(engine.quoteMembershipUse(r, { membershipId: 'pass', source: r.sources[0], allocationId: 'retail', quantity: 1 })).toMatchObject({ canSubmit: false, issues: [{ reason: 'PASS_MENU_REQUIRED' }] });
  });
  it('returns only selected line allocations and restores a zero-value use only when its quantity returns', () => {
    const s = source('bill', 10000, { lines: [
      { allocationId: 'covered', orderLineId: 'covered', menuId: 'm-latte', quantity: 1, unitPrice: 5000, unitCost: 1500 },
      { allocationId: 'paid', orderLineId: 'paid', menuId: 'm-americano', quantity: 1, unitPrice: 5000, unitCost: 1000 },
    ] });
    let r = withPass({ ...read(), sources: [s] }, terms('period'));
    r = transact(r, { purpose: 'sale', billId: 'bill' }, [{ kind: 'membership_period', membershipId: 'pass', billAllocationId: 'covered', quantity: 1, amount: 0 }, method(5000)]).read;
    const id = r.state.settlements[0].settlementId;
    let q = engine.quoteMoneyReversal(r, { settlementId: id, kind: 'cancel', lines: [{ allocationId: 'paid', quantity: 1 }] });
    expect(q).toMatchObject({ amount: 5000, membershipEffects: [], lineEffects: [{ allocationId: 'paid', quantity: -1 }] });
    r = applied(r, engine.planMoneyReversal(r, { quote: q, meta: { runId: r.runId, idempotencyKey: 'paid-return' } }));
    q = engine.quoteMoneyReversal(r, { settlementId: id, kind: 'cancel', lines: [{ allocationId: 'covered', quantity: 1 }] });
    expect(q).toMatchObject({ canSubmit: true, amount: 0, membershipEffects: [{ canceledAt: r.now }] });
    r = applied(r, engine.planMoneyReversal(r, { quote: q, meta: { runId: r.runId, idempotencyKey: 'covered-return' } }));
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, gross: 0, discount: 0 }, cost: 0, orderCount: 0 });
    expect(engine.quoteMoneyReversal(r, { settlementId: id, kind: 'cancel', lines: [{ allocationId: 'covered', quantity: 1 }] })).toMatchObject({ canSubmit: false });
  });
  it('keeps one count use across frozen transfer fragments and restores it after the last fragment', () => {
    const fragment = (id: string) => source(id, 4500, { membershipContributions: [{ useId: 'original-use', membershipId: 'pass', allocationId: `line:${id}`, quantity: 1, recognizedAmount: 2000, membershipDiscount: 250 }] });
    let r = withPass({ ...read(), sources: [fragment('first'), fragment('second')] }, terms('count', { totalUses: 1, soldPrice: 4000 }));
    for (const id of ['first', 'second']) r = transact(r, { purpose: 'sale', billId: id }, [{ kind: 'membership_count', amount: 2000, membershipId: 'pass', useId: 'original-use', billAllocationId: `line:${id}`, quantity: 1 }, method(2250)]).read;
    expect(r.state.uses).toHaveLength(1);
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ usesRemaining: 0, recognizedValue: 4000 });
    const [first, second] = r.state.settlements;
    r = applied(r, reverse(r, first.settlementId));
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ usesRemaining: 0, recognizedValue: 2000 });
    r = applied(r, reverse(r, second.settlementId));
    expect(engine.selectMemberships(r).memberships[0]).toMatchObject({ usesRemaining: 1, recognizedValue: 0 });
  });
  it('uses current preparation state and keeps stock/cost for a prepared refund', () => {
    let r = transact(read(), { purpose: 'sale', billId: 'bill' }, [method(4500)]).read;
    r = { ...r, sources: [source('bill', 4500, { prepared: true })] };
    const id = r.state.settlements[0].settlementId;
    expect(engine.quoteMoneyReversal(r, { settlementId: id, kind: 'cancel' })).toMatchObject({ canSubmit: false, issues: [{ reason: 'USE_REFUND' }] });
    r = applied(r, reverse(r, id, undefined, 'refund'));
    expect(engine.selectAccountingDay(r, { date: r.businessDate })).toMatchObject({ sales: { total: 0, refund: 4500 }, cost: 1500, orderCount: 1 });
    expect(r.state.corrections[0].lineEffects).toEqual([]);
  });
  it.each(['charge_topup', 'receivable_collection'] as const)('failed %s commits no balances, receipts, uses or recognition', purpose => {
    const initial = read();
    const r = { ...initial, scenario: 'payment-failure' as const, state: { ...initial.state, accountTxns: [{ txnId: 'old', memberId: 'M-0001', account: 'receivable' as const, kind: 'opening' as const, amount: 5000, at: '2026-10-25T10:00', settlementId: null, allocationId: null, originalTxnId: null, sourceRef: null, reason: '' }] } };
    const q = engine.quoteSettlement(r, { target: { purpose, memberId: 'M-0001', amount: 5000 }, allocations: [method(5000)] });
    const p = engine.planBeginSettlementApproval(r, { quote: q, meta: { runId: r.runId, idempotencyKey: 'fail' } });
    if (!p.ok) throw new Error('begin');
    const pending = applied(r, p), before = structuredClone(pending);
    expect(engine.planFinishSettlementApproval(pending, { attemptId: p.attemptId!, runId: r.runId, outcome: 'approved', expectedQuoteFingerprint: pending.state.attempt!.fingerprint })).toMatchObject({ ok: false, reason: 'APPROVAL_FAILED' });
    expect(pending).toEqual(before);
  });
});

