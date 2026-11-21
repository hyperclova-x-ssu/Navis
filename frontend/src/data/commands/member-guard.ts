/**
 * F-1 delete guard: what a member still holds that archiving would hide from the operator
 * (prepaid 충전금, open receivable 외상, active passes). The balances use the selectors the
 * 충전금·외상 관리 widget reads (`accountBalance` over the canonical money state), so the
 * widget, the member list and the `members.delete` command always agree.
 */
import type { DataSnapshot } from '../db/types';
import { accountBalance } from '../iteration7/accounts';
import { selectMemberships } from '../iteration7/memberships';
import type { MoneyRead } from '../iteration7/accounting/types';
import { membershipActive } from '../derive/members';
import { moneyReadBase } from '../pos/projection';

export interface MemberDeleteBlockers {
  /** Prepaid (충전금) balance in won; 0 when none. */
  readonly charge: number;
  /** Open receivable (외상) in won; 0 when none. */
  readonly receivable: number;
  /** Active passes: count passes with uses left, or period subscriptions still running. */
  readonly passes: number;
  readonly blocked: boolean;
}

const reads = new WeakMap<DataSnapshot, MoneyRead>();
/** One money read per snapshot, so a 126-row grid does not rebuild it per row. */
function moneyOf(snapshot: DataSnapshot): MoneyRead {
  let read = reads.get(snapshot);
  if (!read) reads.set(snapshot, read = moneyReadBase(snapshot));
  return read;
}

export function selectMemberDeleteBlockers(snapshot: DataSnapshot, memberId: string): MemberDeleteBlockers {
  const money = moneyOf(snapshot);
  const charge = Math.max(0, accountBalance(money, memberId, 'charge'));
  const receivable = Math.max(0, accountBalance(money, memberId, 'receivable'));
  // The money state is canonical; the legacy membership table mirrors it, so count a pass once.
  const canonical = selectMemberships(money, { memberId }).memberships
    .filter(pass => pass.status === 'active' && (pass.usesRemaining === null || pass.usesRemaining > 0));
  const known = new Set(money.state.memberships.map(pass => pass.membershipId));
  const customerId = snapshot.tables.memberProfile.find(profile => profile.memberId === memberId)?.customerId;
  const legacy = customerId === undefined ? [] : snapshot.tables.membership
    .filter(pass => pass.customerId === customerId && !known.has(pass.membershipId) && membershipActive(snapshot, pass.membershipId));
  const passes = canonical.length + legacy.length;
  return { charge, receivable, passes, blocked: charge > 0 || receivable > 0 || passes > 0 };
}
