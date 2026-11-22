import type { SettlementAllocation, SettlementTarget } from '../../iteration7/accounting/types';
import { maskCustomer } from '../../derive/members';
import type { PosMemberChoice } from './dto';

export function projectMemberChoice(member: PosMemberChoice): PosMemberChoice {
  const { name } = maskCustomer({ name: member.name, maskKey: 'data.management.guest' });
  return { ...member, name: typeof name === 'string' ? name : '회원' };
}

/** Reprice the one selected tender together with the authoritative amount, without writing a bill. */
export function projectCheckoutQuote({
  billId, revision, amountDue, selection, canRecord, chargeBalance,
}: {
  billId: string; revision: number; amountDue: number; selection: readonly SettlementAllocation[];
  canRecord: boolean; chargeBalance?: number;
}) {
  const tender = selection[0];
  const allocations = tender ? [{ ...tender, amount: amountDue }] : [];
  const target: SettlementTarget = { purpose: 'sale', billId };
  return {
    target, quoteId: billId, quoteRevision: revision, amountDue, allocations,
    remaining: tender ? 0 : amountDue,
    canSubmit: canRecord && amountDue > 0 && !!tender && (tender.kind !== 'charge' || (chargeBalance ?? 0) >= amountDue),
    issues: [],
  };
}
