import type { PosCommandMeta, PosDrawer, PosFailure, PosMethodSplit } from '../../../contracts/pos';

export type RealMethod = 'card' | 'easy_pay' | 'cash';
export type SettlementPurpose = 'sale' | 'custom_order' | 'charge_topup' | 'receivable_collection' | 'membership_sale';
export type SettlementTarget =
  | { readonly purpose: 'sale'; readonly cartId?: string; readonly billId?: string; readonly partId?: string }
  | { readonly purpose: 'custom_order'; readonly customOrderId: string }
  | { readonly purpose: 'charge_topup'; readonly memberId: string; readonly amount: number }
  | { readonly purpose: 'receivable_collection'; readonly memberId: string; readonly amount: number; readonly receivableTxnId?: string }
  | { readonly purpose: 'membership_sale'; readonly memberId: string; readonly productId: string };
export interface SourceRef { readonly kind: string; readonly id: string }
export interface SourceAmount { readonly txnId: string; readonly amount: number }
export interface SettlementAllocation {
  readonly allocationId?: string; readonly kind: 'method' | 'charge' | 'receivable' | 'membership_count' | 'membership_period';
  readonly amount: number; readonly method?: RealMethod; readonly membershipId?: string; readonly useId?: string;
  readonly billAllocationId?: string; readonly orderLineId?: string; readonly quantity?: number;
  readonly membershipDiscount?: number;
}
export interface MoneyLine {
  readonly allocationId: string; readonly orderLineId: string; readonly menuId: string; readonly quantity: number;
  readonly name?: string | { readonly key: string } | { readonly raw: string }; readonly prepared?: boolean;
  readonly category?: string;
  readonly unitPrice: number; readonly unitCost: number | null;
  readonly discountBySource?: Readonly<Record<'direct' | 'coupon' | 'membership', number>>;
  readonly recipe?: readonly { readonly itemId: string; readonly quantityBase: number }[];
}
/** An adapter supplies the current POS/custom quote, including its stock/price fingerprint. */
export interface MoneySource {
  readonly sourceRef: SourceRef; readonly purpose: 'sale' | 'custom_order'; readonly billId?: string; readonly cartId?: string;
  readonly memberId: string | null; readonly amountDue: number; readonly fingerprint: string;
  readonly lines: readonly MoneyLine[]; readonly orderIds: readonly string[];
  readonly parts?: readonly { readonly partId: string; readonly amount: number; readonly allocationIds?: readonly string[] }[];
  readonly canSubmit?: boolean; readonly issues?: readonly PosFailure[]; readonly prepared?: boolean;
  readonly wholeBillDiscount?: boolean;
  readonly paymentTiming?: 'advance' | 'on_pickup';
  /** Frozen benefit fragments from existing POS split/transfer allocation identities. */
  readonly membershipContributions?: readonly { readonly useId: string; readonly membershipId: string; readonly allocationId: string;
    readonly quantity: number; readonly recognizedAmount: number; readonly membershipDiscount: number }[];
}
export interface Settlement {
  readonly settlementId: string; readonly purpose: SettlementPurpose; readonly sourceRef: SourceRef;
  readonly billId: string | null; readonly partId: string | null; readonly memberId: string | null;
  readonly at: string; readonly amount: number; readonly allocations: readonly SettlementAllocation[];
  readonly status: 'paid'; readonly sourceSnapshot?: MoneySource;
}
export interface MoneyPayment {
  readonly paymentId: string; readonly settlementId: string; readonly purpose: SettlementPurpose; readonly sourceRef: SourceRef;
  readonly at: string; readonly amount: number; readonly splits: readonly PosMethodSplit[];
}
export type RecognitionSource = 'menu' | 'membership_count' | 'subscription_day' | 'membership_expiry' | 'custom_pickup';
export interface SalesRecognition {
  readonly recognitionId: string; readonly source: RecognitionSource; readonly sourceId: string;
  readonly businessDate: string; readonly at: string; readonly amount: number; readonly cost: number | null;
  readonly settlementCategory: RealMethod | 'charge' | 'receivable' | 'membership_count' | 'subscription_day' | 'membership_expiry' | 'custom_pickup';
  readonly settlementId?: string; readonly settlementAllocationId?: string; readonly membershipId?: string; readonly useId?: string;
  readonly billAllocationId?: string; readonly orderLineId?: string; readonly menuId?: string;
  readonly quantity?: number; readonly gross?: number; readonly discountBySource?: Readonly<Record<'direct' | 'coupon' | 'membership', number>>;
  readonly originalRecognitionId: string | null;
}
export interface MemberAccountTxn {
  readonly txnId: string; readonly memberId: string; readonly account: 'charge' | 'receivable';
  readonly kind: 'opening' | 'topup' | 'use' | 'sale' | 'collection' | 'reversal' | 'adjustment';
  readonly amount: number; readonly at: string; readonly settlementId: string | null; readonly allocationId: string | null;
  readonly originalTxnId: string | null; readonly sourceRef: SourceRef | null; readonly reason: string;
  readonly sourceAmounts?: readonly SourceAmount[];
}
export interface MembershipProduct {
  readonly productId: string; readonly name: string; readonly kind: 'count' | 'period'; readonly soldPrice: number;
  readonly totalUses: number | null; readonly validDays: number; readonly menuIds?: readonly string[];
  readonly dailyLimit?: number | null; readonly beforeHour?: number;
}
export interface MembershipTerms extends MembershipProduct {
  readonly membershipId: string; readonly memberId: string; readonly startsOn: string; readonly endsOn: string;
  readonly saleSettlementId: string; readonly refundedAt?: string; readonly openingUses?: number;
}
export interface MembershipUse {
  readonly useId: string; readonly membershipId: string; readonly at: string; readonly sourceRef: SourceRef;
  readonly coveredQuantities: readonly { readonly allocationId: string; readonly quantity: number }[];
  readonly recognizedAmount: number; readonly membershipDiscount: number; readonly canceledAt: string | null;
}
export interface LineEffect {
  readonly allocationId: string; readonly orderLineId: string; readonly menuId: string; readonly quantity: number;
  readonly stock: readonly { readonly itemId: string; readonly deltaBase: number }[];
}
export interface MoneyCorrection {
  readonly correctionId: string; readonly settlementId: string; readonly at: string; readonly kind: 'cancel' | 'refund'; readonly amount: number;
  readonly originalAllocationEffects: readonly { readonly allocationId: string; readonly amount: number }[];
  readonly realMethodReturns: readonly PosMethodSplit[]; readonly accountEffects: readonly MemberAccountTxn[];
  readonly membershipEffects: readonly MembershipUse[]; readonly recognitionEffects: readonly SalesRecognition[];
  readonly lineEffects: readonly LineEffect[];
  readonly quantityReturns?: readonly { readonly allocationId: string; readonly quantity: number }[];
}
export interface MoneyCompletion {
  readonly settlementId?: string; readonly paymentId?: string; readonly purpose?: SettlementPurpose; readonly sourceRef?: SourceRef;
  readonly billId?: string; readonly orderIds?: readonly string[]; readonly remaining?: number; readonly settled?: boolean;
  readonly accountEffects?: readonly MemberAccountTxn[]; readonly membershipId?: string; readonly correctionId?: string;
}
export interface MoneyEffects {
  readonly settlements: readonly Settlement[]; readonly payments: readonly MoneyPayment[]; readonly recognitions: readonly SalesRecognition[];
  readonly accountTxns: readonly MemberAccountTxn[]; readonly memberships: readonly MembershipTerms[];
  readonly uses: readonly MembershipUse[]; readonly corrections: readonly MoneyCorrection[]; readonly lineEffects: readonly LineEffect[];
}
export interface SettlementQuote {
  readonly quoteId: string; readonly quoteRevision: number; readonly target: SettlementTarget; readonly amountDue: number;
  readonly allocations: readonly SettlementAllocation[]; readonly realMethodSplits: readonly PosMethodSplit[];
  readonly discounts: readonly { readonly source: 'membership'; readonly amount: number; readonly useId: string }[];
  readonly recognitionEffects: readonly SalesRecognition[]; readonly accountEffects: readonly MemberAccountTxn[];
  readonly membershipEffects: readonly MembershipUse[]; readonly remaining: number; readonly canSubmit: boolean; readonly issues: readonly PosFailure[];
  readonly sourceFingerprint: string; readonly collectionSources: readonly SourceAmount[];
}
export interface MoneyAttempt {
  readonly attemptId: string; readonly runId: string; readonly generation: number; readonly scenario: string;
  readonly meta: PosCommandMeta; readonly quote: SettlementQuote; readonly fingerprint: string;
}
export interface MoneyState {
  readonly settlements: readonly Settlement[]; readonly payments: readonly MoneyPayment[]; readonly recognitions: readonly SalesRecognition[];
  readonly accountTxns: readonly MemberAccountTxn[]; readonly memberships: readonly MembershipTerms[];
  readonly uses: readonly MembershipUse[]; readonly corrections: readonly MoneyCorrection[];
  readonly attempt: MoneyAttempt | null;
  readonly commands: readonly { readonly key: string; readonly fingerprint: string; readonly generation: number; readonly scenario: string; readonly value: MoneyCompletion; readonly attemptId?: string; readonly attemptFingerprint?: string }[];
}
export interface MoneyRead {
  readonly runId: string; readonly revision: number; readonly generation: number; readonly businessDate: string; readonly now: string;
  readonly scenario: 'normal' | 'empty' | 'error' | 'payment-failure'; readonly dayClosed: boolean;
  readonly state: MoneyState; readonly members: readonly { readonly memberId: string; readonly name: string; readonly phone: string }[];
  readonly products: readonly MembershipProduct[]; readonly sources: readonly MoneySource[];
  readonly drawer?: PosDrawer; readonly expenses?: number;
}
export type MoneyPlan = PosFailure | { readonly ok: true; readonly nextState: MoneyState; readonly effects: MoneyEffects;
  readonly value: MoneyCompletion; readonly changed: boolean; readonly duplicate?: boolean; readonly attemptId?: string };
export interface MoneyReversalQuote {
  readonly quoteId: string; readonly quoteRevision: number; readonly settlementId: string; readonly kind: 'cancel' | 'refund';
  readonly amount: number; readonly remainingRefundable: number;
  readonly originalAllocationEffects: MoneyCorrection['originalAllocationEffects']; readonly realMethodReturns: readonly PosMethodSplit[];
  readonly accountEffects: readonly MemberAccountTxn[]; readonly membershipEffects: readonly MembershipUse[];
  readonly recognitionEffects: readonly SalesRecognition[]; readonly lineEffects: readonly LineEffect[];
  readonly quantityReturns?: readonly { readonly allocationId: string; readonly quantity: number }[];
  readonly membershipTermsEffects?: readonly MembershipTerms[];
  readonly canSubmit: boolean; readonly issues: readonly PosFailure[];
  readonly input: { readonly settlementId?: string; readonly paymentId?: string; readonly kind: 'cancel' | 'refund'; readonly amount?: number;
    readonly lines?: readonly { readonly allocationId: string; readonly quantity: number }[]; readonly methodAmounts?: readonly PosMethodSplit[] };
}
export interface SalesSummary {
  readonly total: number; readonly byRealMethodSale: Readonly<Record<RealMethod, number>>; readonly chargeUsed: number;
  readonly receivableCreated: number; readonly membershipCount: number; readonly subscriptionDaily: number; readonly membershipExpiry: number;
  readonly customPickup: number; readonly refund: number; readonly gross: number; readonly discount: number;
  readonly discountBySource: Readonly<Record<'direct' | 'coupon' | 'membership', number>>;
  /**
   * Finance service only (REAL-PLAN F09-2, B09-2 `sales.byMethod`): net recognized sales by recorded tender. `mixed` OVERLAPS the other five (sales paid with
   * two or more methods) and is never added to them or to `total`. Absent in a snapshot archived before the field existed: "not available", never zeros.
   */
  readonly byMethod?: Readonly<Record<'cash' | 'card' | 'easy_pay' | 'charge' | 'receivable' | 'mixed', number>>;
}
export interface DepositSummary {
  readonly total: number; readonly byMethod: Readonly<Record<RealMethod, number>>; readonly byPurpose: Readonly<Record<SettlementPurpose, number>>;
  readonly grossReceived: number; readonly returned: number; readonly pendingReceived: number;
}
export interface AccountingDay {
  readonly sales: SalesSummary; readonly deposits: DepositSummary;
  readonly settlementActivity: { readonly chargeTopup: number; readonly chargeUsed: number; readonly receivableCreated: number;
    readonly receivableCollected: number; readonly membershipSold: number; readonly membershipCount: number; readonly subscriptionDaily: number;
    readonly membershipExpiry: number; readonly customAdvance: number; readonly customPickup: number };
  readonly orderCount: number; readonly realPaymentCount: number; readonly discountBySource: SalesSummary['discountBySource'];
  readonly cost: number; readonly expenses: number; readonly profit: number;
  readonly unknownCostSales: readonly { readonly recognitionId: string; readonly sourceId: string; readonly amount: number; readonly cost: null }[];
}
