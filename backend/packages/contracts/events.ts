export type EventProducer = 'account' | 'pos' | 'inventory' | 'customer' | 'marketing' | 'insight';

export interface EventEnvelope<Producer extends EventProducer, Type extends string, Payload> {
  readonly eventId: string;
  readonly producer: Producer;
  readonly storeId: string | null;
  readonly scopeKey: string;
  /** A decimal bigint string. Redis and JavaScript number coercion must not round it. */
  readonly storeSeq: string;
  readonly eventType: Type;
  readonly schemaVersion: 1;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Payload;
}

export interface SaleUsageLine {
  readonly allocationId: string;
  readonly orderLineId: string;
  readonly menuId: string;
  readonly recipeVersion: string;
  readonly options: readonly { optionId: string; recipeVersion: string }[];
  readonly quantity: number;
}

interface PosSale {
  readonly billId: string;
  readonly orderId: string;
  readonly paymentId: string;
  readonly settlementId: string;
  readonly businessDate: string;
  readonly lines: readonly SaleUsageLine[];
}

/** Always use settlementId for the original sale's business identity. */
export type PosSaleRecognized = EventEnvelope<'pos', 'pos.sale_recognized.v1', PosSale & {
  /** UUID of the customer claim bound to this store and approval command. */
  readonly claimId?: string;
  /** Covered quantities by allocation. For a count-based membership claim in the single-settlement fixture, omission uses all sale lines. */
  readonly membershipContributions?: readonly { allocationId: string; quantity: number }[];
  readonly amount: number;
  readonly cost: number | null;
  readonly incompleteMarginCoverage: boolean;
}>;

export type PosSaleCorrected = EventEnvelope<'pos', 'pos.sale_corrected.v1', PosSale & {
  readonly correctionId: string;
  readonly kind: 'cancel' | 'refund';
  readonly target: 'recognized_sale';
  readonly usageEffect: 'restore' | 'keep';
  readonly amountDelta: number;
  readonly costDelta: number | null;
  readonly incompleteMarginCoverage: boolean;
}>;

export type PosEvent = PosSaleRecognized | PosSaleCorrected;

export type InventoryReceiptRecorded = EventEnvelope<'inventory', 'inventory.receipt_recorded.v1', {
  readonly receiptId: string;
  readonly supplierId: string;
  readonly businessDate: string;
  readonly amount: number;
}>;
