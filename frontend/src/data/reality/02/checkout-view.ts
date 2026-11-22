import type { SettlementAllocation, SettlementTarget } from '../../iteration7/accounting/types';
import { formatMaskedCustomer, memberDisplayId } from '../../customer-display';
import type { PosMemberChoice } from './dto';

export function projectMemberChoice(member: PosMemberChoice): PosMemberChoice {
  const code = memberDisplayId(member.memberId, member.memberCode, member.name);
  return { ...member, name: formatMaskedCustomer(member.name, member.memberId, code), ...(code && { memberCode: code }) };
}

/** Reprice the selected tender for the balance after one pass use, without writing a bill. */
export function projectCheckoutQuote({
  billId, revision, amountDue, selection, canRecord, chargeBalance,
}: {
  billId: string; revision: number; amountDue: number; selection: readonly SettlementAllocation[];
  canRecord: boolean; chargeBalance?: number;
}) {
  const pass = selection.find(row => row.kind === 'membership_count' || row.kind === 'membership_period');
  const tender = selection.find(row => row.kind === 'method' || row.kind === 'charge' || row.kind === 'receivable');
  const balanceDue = amountDue - (pass?.amount ?? 0);
  const allocations = [...(pass ? [pass] : []), ...(tender && balanceDue > 0 ? [{ ...tender, amount: balanceDue }] : [])];
  const target: SettlementTarget = { purpose: 'sale', billId };
  return {
    target, quoteId: billId, quoteRevision: revision, amountDue, allocations,
    remaining: tender ? 0 : balanceDue,
    canSubmit: canRecord && (!!pass || amountDue > 0) && (balanceDue === 0 ? !!pass : balanceDue > 0 && !!tender)
      && (tender?.kind !== 'charge' || (chargeBalance ?? 0) >= balanceDue),
    issues: [],
  };
}
