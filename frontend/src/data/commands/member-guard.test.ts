/** F-1: `members.delete` never archives a member who still holds money or an active pass. */
import manifest from '../db/generated/manifest.json';
import { seedSupplement } from '../db/generated/supplement';
import { cafeMemberId } from '../db/cafe-identity';
import { NOW, TODAY, addDays } from '../db/time';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, selectMembers, type DataCommandResult } from '../widget-data';
import type { DataSnapshot } from '../db/types';
import type { MemberAccountTxn } from '../iteration7/accounting/types';
import { selectMemberAccounts } from '../iteration7/accounts';
import { moneyReadBase } from '../pos/projection';
import { handlers } from './handlers';
import { selectMemberDeleteBlockers } from './member-guard';

const [charged, debtor, bothAccounts] = seedSupplement.balances;
const [countPass] = seedSupplement.activePasses;
const FREE = 'M-0008';
const txn = (memberId: string, account: MemberAccountTxn['account'], amount: number, id: string): MemberAccountTxn => ({
  txnId: id, memberId, account, kind: amount > 0 ? 'topup' : 'use', amount, at: NOW, settlementId: null, allocationId: null, originalTxnId: null, sourceRef: null, reason: 'test',
});
/** Same seed, plus extra ledger rows, so one blocker can be tested without the seed's other holdings. */
function withTxns(base: DataSnapshot, rows: readonly MemberAccountTxn[]): DataSnapshot {
  const pos = base.pos!;
  return { ...base, pos: { ...pos, money: { ...pos.money!, accountTxns: [...pos.money!.accountTxns, ...rows] } } };
}
function runDelete(snapshot: DataSnapshot, memberId: string) {
  let seq = 0;
  return handlers['members.delete']({ snapshot, tables: snapshot.tables, nextId: prefix => `${prefix}-${++seq}` }, { type: 'members.delete', memberId });
}
function failed(result: DataCommandResult | ReturnType<typeof runDelete>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  return result;
}
const seed = () => createWidgetDataStore().getSnapshot();

describe('members.delete guard', () => {
  it('the guard reads the same balances the 충전금·외상 widget shows', () => {
    const snapshot = seed(), accounts = selectMemberAccounts(moneyReadBase(snapshot));
    for (const row of accounts.members) {
      const blockers = selectMemberDeleteBlockers(snapshot, row.memberId);
      expect([blockers.charge, blockers.receivable]).toEqual([Math.max(0, row.chargeBalance), Math.max(0, row.receivableBalance)]);
    }
  });

  it('refuses a member who still has prepaid (충전금) balance', () => {
    const snapshot = withTxns(seed(), [txn(FREE, 'charge', 20_000, 'tx-charge')]);
    const result = failed(runDelete(snapshot, FREE));
    expect(result).toMatchObject({ code: 'CONFLICT', reason: 'MEMBER_HAS_OPEN_BALANCE', field: 'memberId', messageKey: 'data.management.error.MEMBER_HAS_OPEN_BALANCE' });
    expect((result as { details?: unknown }).details).toMatchObject({ charge: 20_000, receivable: 0, passes: 0 });
  });

  it('refuses a member who still has an open receivable (외상)', () => {
    const snapshot = withTxns(seed(), [txn(FREE, 'receivable', 12_000, 'tx-debt')]);
    const result = failed(runDelete(snapshot, FREE));
    expect(result).toMatchObject({ code: 'CONFLICT', reason: 'MEMBER_HAS_OPEN_BALANCE' });
    expect((result as { details?: unknown }).details).toMatchObject({ charge: 0, receivable: 12_000, passes: 0 });
  });

  it('refuses a member who holds an active count pass with uses left', () => {
    const result = failed(runDelete(seed(), cafeMemberId(countPass.memberId)));
    expect(result).toMatchObject({ code: 'CONFLICT', reason: 'MEMBER_HAS_OPEN_BALANCE' });
    expect((result as { details?: unknown }).details).toMatchObject({ charge: charged.chargeBalance, receivable: 0, passes: 1 });
  });

  it('refuses a member who holds an active subscription', () => {
    const snapshot = seed(), pos = snapshot.pos!, money = pos.money!;
    const period = {
      membershipId: 'test-period', productId: 'test-monthly', memberId: FREE, name: 'Monthly',
      kind: 'period' as const, soldPrice: 30_000, totalUses: null, validDays: 30,
      startsOn: TODAY, endsOn: addDays(TODAY, 29), saleSettlementId: 'test-period-sale',
    };
    const withSubscription = { ...snapshot, pos: { ...pos, money: { ...money, memberships: [...money.memberships, period] } } };
    const result = failed(runDelete(withSubscription, FREE));
    expect((result as { details?: unknown }).details).toMatchObject({ charge: 0, receivable: 0, passes: 1 });
  });

  it('lists every blocking reason at once', () => {
    expect((failed(runDelete(seed(), cafeMemberId(debtor.memberId))) as { details?: unknown }).details)
      .toMatchObject({ charge: 0, receivable: debtor.receivableBalance, passes: 1 });
    expect((failed(runDelete(seed(), cafeMemberId(bothAccounts.memberId))) as { details?: unknown }).details)
      .toMatchObject({ charge: bothAccounts.chargeBalance, receivable: bothAccounts.receivableBalance, passes: 1 });
    const both = withTxns(seed(), [txn(FREE, 'charge', 5_000, 'a'), txn(FREE, 'receivable', 7_000, 'b')]);
    expect((failed(runDelete(both, FREE)) as { details?: unknown }).details).toMatchObject({ charge: 5_000, receivable: 7_000, passes: 0 });
  });

  it('refuses through the store and leaves the data unchanged', () => {
    const store = createWidgetDataStore(), before = store.getSnapshot();
    const result = failed(store.dispatch({ type: 'members.delete', memberId: cafeMemberId(charged.memberId) }));
    expect(result).toMatchObject({ reason: 'MEMBER_HAS_OPEN_BALANCE', code: 'CONFLICT' });
    expect((result as { details?: { charge?: number } }).details?.charge).toBeGreaterThan(0);
    expect(store.getSnapshot()).toBe(before);
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(manifest.counts.members);
  });

  it('a settled balance (net 0) and an exhausted pass do not block', () => {
    const settled = withTxns(seed(), [txn(FREE, 'charge', 20_000, 'in'), txn(FREE, 'charge', -20_000, 'out')]);
    expect(selectMemberDeleteBlockers(settled, FREE)).toMatchObject({ charge: 0, receivable: 0, passes: 0, blocked: false });
    const pos = settled.pos!, money = pos.money!;
    const exhausted = { ...money.memberships.find(row => row.membershipId === countPass.membershipId)!,
      membershipId: 'test-exhausted', memberId: FREE, openingUses: 10 };
    const snapshot = { ...settled, pos: { ...pos, money: { ...money, memberships: [...money.memberships, exhausted] } } };
    expect(selectMemberDeleteBlockers(snapshot, FREE)).toMatchObject({ passes: 0, blocked: false });
  });

  it('deletes a member with nothing outstanding as before, and undo restores them', () => {
    const store = createWidgetDataStore();
    const removed = store.dispatch({ type: 'members.delete', memberId: FREE });
    expect(removed).toMatchObject({ ok: true, noticeKey: 'data.management.notice.deleted' });
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(manifest.counts.members - 1);
    if (!removed.ok) throw new Error('unreachable');
    expect(store.undo(removed.undoToken!).ok).toBe(true);
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(manifest.counts.members);
  });

  it('unknown members still report NOT_FOUND, and the guard is never reached for them', () => {
    expect(failed(runDelete(seed(), 'M-9999'))).toMatchObject({ code: 'NOT_FOUND', reason: 'NOT_FOUND' });
  });
});
