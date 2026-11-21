import { expect } from 'vitest';
import * as engine from './index';
import type { MoneyPlan, MoneyRead, MoneySource, MoneyState, SettlementAllocation, SettlementTarget, MembershipTerms } from './types';

const emptyState = (): MoneyState => ({ settlements: [], payments: [], recognitions: [], accountTxns: [], memberships: [], uses: [], corrections: [], commands: [], attempt: null });
const terms = (kind: 'count' | 'period' = 'count', changes: Partial<MembershipTerms> = {}): MembershipTerms => ({
  membershipId: 'pass', productId: kind, memberId: 'M-0001', name: kind, kind, soldPrice: kind === 'count' ? 40000 : 55000,
  totalUses: kind === 'count' ? 10 : null, validDays: kind === 'count' ? 90 : 30, startsOn: '2026-10-01', endsOn: '2026-12-29',
  saleSettlementId: 'pass-sale', ...changes,
});
const source = (id = 'bill', price = 4500, changes: Partial<MoneySource> = {}): MoneySource => ({
  sourceRef: { kind: 'bill', id }, billId: id, purpose: 'sale', amountDue: price, fingerprint: id, memberId: 'M-0001', orderIds: [`order:${id}`],
  lines: [{ allocationId: `line:${id}`, orderLineId: `orderline:${id}`, menuId: price === 4500 ? 'm-americano' : 'm-latte', quantity: 1,
    unitPrice: price, unitCost: 1500, recipe: [{ itemId: 'beans', quantityBase: 18 }] }], ...changes,
});
function read(): MoneyRead {
  return { runId: 'run', revision: 0, generation: 0, businessDate: '2026-10-26', now: '2026-10-26T15:45', scenario: 'normal', dayClosed: false,
    state: emptyState(), sources: [source()], members: Array.from({ length: 8 }, (_, i) => ({ memberId: `M-000${i + 1}`, name: `Member ${i + 1}`, phone: `010-****-000${i + 1}` })),
    products: [{ productId: 'count', name: '10 uses', kind: 'count', soldPrice: 40000, totalUses: 10, validDays: 90 }],
    drawer: { opening: 100000, actual: null, memo: '', movements: [] }, expenses: 462000 };
}
function applied(r: MoneyRead, p: MoneyPlan): MoneyRead {
  if (!p.ok) throw new Error(p.reason);
  return { ...r, revision: r.revision + Number(p.changed), state: p.nextState };
}
function transact(r: MoneyRead, target: SettlementTarget, allocations: readonly SettlementAllocation[], key = `k${r.revision}`) {
  const quote = engine.quoteSettlement(r, { target, allocations });
  expect(quote.issues).toEqual([]);
  const begin = engine.planBeginSettlementApproval(r, { quote, meta: { runId: r.runId, idempotencyKey: key } });
  if (!begin.ok || !begin.attemptId) throw new Error(JSON.stringify(begin));
  const pending = applied(r, begin);
  const finish = engine.planFinishSettlementApproval(pending, { attemptId: begin.attemptId, runId: r.runId, outcome: 'approved', expectedQuoteFingerprint: pending.state.attempt!.fingerprint });
  return { read: applied(pending, finish), finish, quote };
}
const method = (amount: number, m: 'card' | 'easy_pay' | 'cash' = 'card'): SettlementAllocation => ({ kind: 'method', amount, method: m });
function credit(r: MoneyRead, amount = 50000) { return transact(r, { purpose: 'charge_topup', memberId: 'M-0001', amount }, [method(amount)]).read; }
function reverse(r: MoneyRead, settlementId: string, amount?: number, kind: 'cancel' | 'refund' = 'cancel') {
  const quote = engine.quoteMoneyReversal(r, { settlementId, kind, ...(amount === undefined ? {} : { amount }) });
  return engine.planMoneyReversal(r, { quote, meta: { runId: r.runId, idempotencyKey: `reverse:${r.revision}` } });
}
function sellPass(r: MoneyRead, kind: 'count' | 'period' = 'count') {
  const product = kind === 'count' ? r.products[0] : { productId: 'period', name: 'Monthly', kind: 'period' as const, soldPrice: 55000, totalUses: null, validDays: 30 };
  const next = { ...r, products: [product] };
  return transact(next, { purpose: 'membership_sale', memberId: 'M-0001', productId: product.productId }, [method(product.soldPrice)]).read;
}
function withPass(r: MoneyRead, t = terms()): MoneyRead { return { ...r, state: { ...r.state, memberships: [t] } }; }
const membership = (r: MoneyRead, kind: 'membership_count' | 'membership_period', amount: number): SettlementAllocation => ({ kind, amount, membershipId: r.state.memberships[0].membershipId, billAllocationId: r.sources[0].lines[0].allocationId, quantity: 1 });


export { read, source, emptyState, terms, applied, transact, method, credit, withPass, membership, reverse, sellPass };
