import type { PosMethodSplit } from '../../../contracts/pos';
import type { SettlementTarget } from '../../iteration7/accounting/types';

export type MemberFundingTarget = Extract<SettlementTarget, { purpose: 'charge_topup' | 'receivable_collection' | 'membership_sale' }>;

export interface TerminalRecord {
  readonly approvalNo?: string;
  readonly receiptNo?: string;
  readonly occurredAt?: string;
}

/** HTTP-only widget actions. The existing Navis command contracts are unchanged. */
export type MemberRealCommand =
  | { readonly type: 'members.setConsent'; readonly memberId: string; readonly contactAllowed: boolean; readonly marketingAllowed: boolean }
  | { readonly type: 'memberAccounts.recordFunding'; readonly target: MemberFundingTarget; readonly splits: readonly PosMethodSplit[]; readonly terminal?: TerminalRecord; readonly expectedRevision: number }
  | { readonly type: 'memberAccounts.recordRefund'; readonly fundingId: string; readonly amount: number; readonly expectedRevision: number; readonly terminal?: TerminalRecord; readonly confirmed: true };
