import type { RefObject } from 'react';
import type { DetailRef, QueryCondition } from '../../../contracts';
import type { SettlementTarget } from '../../../data/iteration7/accounting/types';

/** Presentation boundary: composition maps the API-276/277 selectors into these values. */
export interface OriginalMoneyTransaction {
  readonly fundingId?: string;
  readonly txnId?: string;
  readonly settlementId?: string | null;
  readonly originalTxnId?: string | null;
  readonly sourceRef?: { readonly kind: string; readonly id: string } | null;
  readonly membershipId?: string;
  readonly useId?: string;
}
export interface AccountTransaction extends OriginalMoneyTransaction {
  readonly txnId: string;
  readonly memberId: string;
  readonly account: 'charge' | 'receivable';
  readonly kind: 'opening' | 'topup' | 'use' | 'sale' | 'collection' | 'reversal' | 'adjustment';
  readonly amount: number;
  readonly at: string;
  readonly originalLabel?: string;
  readonly reason?: string | null;
  readonly sourceAmounts?: readonly { readonly txnId: string; readonly amount: number }[];
}
export interface AccountMember {
  readonly memberId: string;
  readonly name: string;
  readonly phone: string;
  readonly chargeBalance: number;
  readonly receivableBalance: number;
  readonly transactions: readonly AccountTransaction[];
}
export interface MemberAccountsModel {
  readonly members: readonly AccountMember[];
  readonly transactions: readonly AccountTransaction[];
  readonly chargeBalance: number;
  readonly receivableBalance: number;
  readonly chargeHolders: number;
  readonly receivableHolders: number;
}
export type CreditView = { readonly status: 'ready'; readonly model: MemberAccountsModel }
  | { readonly status: 'empty' | 'error' };
export interface PassProduct {
  readonly productId: string;
  readonly label: string;
  readonly kind: 'count' | 'period';
  readonly price: number;
  readonly totalUses?: number;
  readonly validDays: number;
}
export interface MemberPass {
  readonly membershipId: string;
  readonly memberId: string;
  readonly productLabel: string;
  readonly kind: 'count' | 'period';
  readonly soldPrice: number;
  readonly totalUses?: number;
  readonly validDays: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly usesRemaining: number | null;
  readonly recognizedValue: number | null;
  readonly unrecognizedValue: number | null;
  readonly refundedValue: number | null;
  readonly status: 'active' | 'expired' | 'refunded' | 'exhausted' | 'canceled';
  readonly saleSettlementId?: string | null;
  readonly uses: readonly { readonly useId: string; readonly usedAt: string; readonly canceledAt?: string | null; readonly settlementId?: string | null; readonly sourceRef?: { readonly kind: string; readonly id: string } }[];
}
export type MemberSettlementTarget = Extract<SettlementTarget, { readonly purpose: 'charge_topup' | 'receivable_collection' | 'membership_sale' }>;
export interface MemberReturnContext {
  readonly detailRef: DetailRef;
  readonly selectedId: string;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}
export interface CreditPort {
  /** Opens the app-hosted quote/approval flow; opening never writes money. */
  readonly openSettlement: (target: MemberSettlementTarget, context: MemberReturnContext) => void;
  readonly openOriginalTransaction: (transaction: OriginalMoneyTransaction, context: MemberReturnContext) => void;
  readonly openAccounts: (memberId: string, context: MemberReturnContext) => void;
  /** API-277 requires POS menu/quantity context for every use. */
  readonly openMembershipUse: (memberId: string, membershipId: string, context: MemberReturnContext) => void;
}
export interface CreditBinding {
  readonly today?: string;
  readonly view: CreditView;
  readonly port: CreditPort;
  readonly products: readonly PassProduct[];
  readonly memberships: readonly MemberPass[];
}
export type UseCreditBinding = (condition: QueryCondition) => CreditBinding;
