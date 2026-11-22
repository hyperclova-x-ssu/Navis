/**
 * REAL-PLAN F02 — the POS service wire (B02: `.evidence/r1-b02/report.md`, `backend/services/pos/reality/02/README.md`).
 * Types only. Amounts are integer won, times are ISO instants, ids are service UUIDs.
 */
import type { PosMethod } from '../../../contracts/pos';

export interface PosProviderLinks {
  readonly source?: 'naver' | 'connect' | null;
  readonly naverPayPaymentId?: string | null;
  readonly smartstoreProductOrderId?: string | null;
}

export interface PosOptionDto {
  readonly optionId: string; readonly name: string; readonly extraPrice: number; readonly extraCost: number | null; readonly recipeVersion: string;
}
export interface PosSaleLineDto {
  readonly orderLineId: string; readonly allocationId: string; readonly menuId: string; readonly name: string; readonly qty: number;
  readonly basePrice: number; readonly baseCost: number | null; readonly optionPrice: number; readonly optionCost: number | null;
  readonly recipeVersion: string; readonly options: readonly PosOptionDto[];
  readonly gross: number; readonly discount: number; readonly amount: number;
}
export interface PosQuoteDto {
  readonly quoteRevision: number; readonly lines: readonly PosSaleLineDto[]; readonly gross: number; readonly discount: number; readonly payable: number;
}
export interface PosBillDto extends PosProviderLinks {
  readonly billId: string; readonly businessDate: string; readonly status: 'open' | 'paid' | 'void'; readonly revision: number;
  readonly type: 'dine_in' | 'takeout'; readonly createdAt: string; readonly recognizedAt: string | null; readonly tableId: string | null;
  readonly quote: PosQuoteDto;
  readonly orderIds?: readonly string[];
  readonly paymentId?: string | null; readonly settlementId?: string | null; readonly remaining?: number;
}
export interface PosOrderDto extends PosProviderLinks {
  readonly orderId: string; readonly orderNo: number; readonly billId: string; readonly businessDate: string; readonly orderedAt: string;
  readonly revision: number; readonly preparation: 'accepted' | 'preparing' | 'completed'; readonly tableId: string | null;
  readonly settlementId: string | null; readonly paymentId: string | null; readonly amount: number; readonly remaining: number;
  readonly tableIds?: readonly string[]; readonly preparingAt?: string | null; readonly completedAt?: string | null;
  readonly billIds?: readonly string[]; readonly status?: 'open' | 'paid' | 'void';
  readonly lines: readonly PosSaleLineDto[];
}
export interface PosTerminalDto { readonly approvalNo: string | null; readonly receiptNo: string | null; readonly occurredAt: string }
export interface PosMethodAmountDto { readonly method: PosMethod; readonly amount: number }
export interface PosCorrectionDto {
  readonly correctionId: string; readonly kind: 'cancel' | 'refund'; readonly at: string; readonly seq: number; readonly amount: number;
  readonly methods: readonly PosMethodAmountDto[]; readonly restockRetail: boolean; readonly terminal?: PosTerminalDto;
  readonly lines?: readonly { readonly allocationId: string; readonly orderLineId: string; readonly qty: number; readonly gross: number; readonly discount: number; readonly amount: number }[];
}
export type PosMemberAllocation =
  | ({ readonly kind: 'method' } & PosMethodAmountDto)
  | { readonly kind: 'charge' | 'receivable'; readonly amount: number }
  | { readonly kind: 'membership_count' | 'membership_period'; readonly membershipId: string; readonly allocationId: string; readonly quantity: number; readonly amount: number; readonly membershipDiscount: number };
export interface PosReceiptDto extends PosProviderLinks {
  readonly paymentId: string | null; readonly settlementId: string; readonly billId: string; readonly storeName: string | null;
  readonly orderNos: readonly number[]; readonly transactionNo: string | null; readonly approvalNo: string | null; readonly at: string;
  readonly memberId?: string; readonly realAmount?: number; readonly containsMemberValue?: boolean;
  readonly memberAllocations?: readonly PosMemberAllocation[];
  readonly channel?: 'cash_record' | 'terminal_record' | 'fixture'; readonly terminal?: PosTerminalDto | null; readonly revision?: number;
  readonly amount: number; readonly gross: number; readonly discount: number; readonly remaining: number;
  readonly status: 'paid' | 'partially_canceled' | 'canceled' | 'partially_refunded' | 'refunded';
  readonly splits: readonly PosMethodAmountDto[];
  readonly lines: readonly { readonly orderLineId: string; readonly menuId: string; readonly name: string; readonly qty: number;
    readonly options: readonly PosOptionDto[]; readonly request: string; readonly gross: number; readonly discount: number; readonly amount: number }[];
  readonly currentPrepared: boolean;
  readonly reversalLines: readonly { readonly allocationId: string; readonly orderLineId: string; readonly menuId: string; readonly name: string; readonly quantity: number; readonly prepared: boolean }[];
  readonly corrections: readonly PosCorrectionDto[];
}
export interface PosReversalQuoteDto {
  readonly quoteToken: string; readonly kind: 'cancel' | 'refund'; readonly amount: number; readonly remaining: number;
  readonly methods: readonly PosMethodAmountDto[]; readonly canSubmit?: boolean;
  readonly lines?: readonly { readonly orderLineId: string; readonly menuId?: string; readonly name?: string; readonly qty?: number; readonly quantity?: number; readonly amount?: number }[];
  readonly issues?: readonly { readonly reason: string }[];
  readonly [key: string]: unknown;
}
export interface PosTableDto {
  readonly tableId: string; readonly label: string; readonly seats: number; readonly revision: number;
  readonly state: 'empty' | 'occupied' | 'cleaning' | 'archived'; readonly billId: string | null; readonly openedAt: string | null;
  readonly layoutTableId?: string | null; readonly lastBillId?: string | null;
}
export interface PosMemberChoice { readonly memberId: string; readonly memberCode?: string; readonly customerId?: string; readonly name: string; readonly phoneMasked: string }
export interface PosMemberQuote { readonly quoteRevision: number; readonly accountRevision: number }
/** Receipt of a command: `{resourceId,revision,receiptId,affectedSources}` plus the route fields (README). */
export interface PosCommandReceiptDto {
  readonly resourceId: string; readonly revision: number; readonly receiptId: string; readonly affectedSources: readonly string[];
  readonly undoUntil?: string;
}
/** R1-F06-2: what a table bill says about the booking whose first order it is. */
export interface PosBillLinkDto {
  /** Present when the bill was the first order of a claimed reservation (the visit completes from its event). */
  readonly reservationId?: string;
  readonly reservationLink?: { readonly billId: string; readonly orderId: string; readonly tableId: string | null };
  /** Browser-side note, never from the service: the booking claim was refused for good, so the order went in as an ordinary table bill. */
  readonly reservationSkipped?: string;
}
export interface PosBillReceiptDto extends PosCommandReceiptDto, PosBillLinkDto { readonly quote: PosQuoteDto }
export interface PosPaymentReceiptDto extends PosCommandReceiptDto {
  readonly billId: string; readonly orderId: string; readonly paymentId?: string; readonly settlementId: string;
}
