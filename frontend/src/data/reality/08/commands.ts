import type { CustomMethodAllocation, CustomReversalQuote, CustomSettlementQuote } from '../../iteration7/custom-orders/types';

/** The store's own terminal slip, typed in by the owner. No provider is called (B08: payments are RECORDED). */
export interface CustomTerminalRecord {
  readonly approvalNo?: string;
  readonly receiptNo?: string;
  readonly occurredAt?: string;
}

/** B08-2: the linked member's prepaid balance (`charge`) or a debt the store carries for them (`receivable`) pays part or all of the order. */
export interface CustomValueAllocation { readonly kind: 'charge' | 'receivable'; readonly amount: number }
export type CustomRealAllocation = CustomMethodAllocation | CustomValueAllocation;
/** Signed won on the member's account: `use` spends the charge, `sale` creates the receivable, `reversal` gives either back (with the posting it undoes). */
export interface CustomAccountEffect {
  readonly memberId: string;
  readonly account: 'charge' | 'receivable';
  readonly kind: 'use' | 'sale' | 'reversal';
  readonly amount: number;
  readonly originalTxnId?: string;
}
/** The service's quotes with the member-value rows the fixture planner never has. */
export interface CustomRealSettlementQuote extends Omit<CustomSettlementQuote, 'allocations' | 'accountEffects'> {
  readonly allocations: readonly CustomRealAllocation[];
  readonly accountEffects: readonly CustomAccountEffect[];
}
export interface CustomRealReversalQuote extends CustomReversalQuote {
  readonly accountEffects?: readonly CustomAccountEffect[];
}

/**
 * HTTP-only widget actions. The existing Navis command names and arguments are unchanged; the payment and correction cards
 * stay widget-only (`customOrder.openPayment/openRefund`), so these never reach a card.
 * `expectedRevision` is the quote's `quoteRevision` (the order's POS revision when it was quoted).
 */
export type CustomRealCommand =
  | { readonly type: 'customOrder.recordPayment'; readonly customOrderId: string; readonly quoteId: string; readonly allocations: readonly CustomRealAllocation[];
      readonly terminal?: CustomTerminalRecord; readonly expectedRevision: number; readonly idempotencyKey: string }
  | { readonly type: 'customOrder.recordCorrection'; readonly customOrderId: string; readonly quoteId: string; readonly kind: 'cancellation' | 'refund'; readonly amount?: number;
      readonly terminal?: CustomTerminalRecord; readonly expectedRevision: number; readonly confirmed: true; readonly idempotencyKey: string };
