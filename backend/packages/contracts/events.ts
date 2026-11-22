export type EventProducer = 'account' | 'pos' | 'inventory' | 'customer' | 'marketing' | 'insight';

export type AccountEventPayloads = {
  'account.store_changed.v1': { storeId: string; revision: number };
  'account.store_membership_changed.v1': { storeId: string; userId: string; role: 'owner' | 'staff' };
  'account.preferences_changed.v1': { storeId: string; userId: string; revision: number };
  'account.panel_changed.v1': { storeId: string; boardId: string; revision: number };
  'account.widget_changed.v1': { storeId: string; boardId: string; pageId: string; featureId: string; revision: number };
  'account.file_changed.v1': { storeId: string; fileId: string; purpose: string; state: 'complete' | 'revoked' };
};
export type AccountEvent = {
  [T in keyof AccountEventPayloads]: EventEnvelope<'account', T, AccountEventPayloads[T]>;
}[keyof AccountEventPayloads];

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
  readonly settlementId: string;
  readonly businessDate: string;
  readonly lines: readonly SaleUsageLine[];
}

/** Always use settlementId for the original sale's business identity. */
export type PosSaleRecognized = EventEnvelope<'pos', 'pos.sale_recognized.v1', PosSale & {
  /** Noncash member value has a settlement without a deposit payment. */
  readonly paymentId?: string;
  readonly memberId?: string;
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
  /** Noncash member corrections are tied to their original member and settlement. */
  readonly paymentId?: string;
  readonly memberId?: string;
  readonly kind: 'cancel' | 'refund';
  readonly target: 'recognized_sale';
  readonly usageEffect: 'restore' | 'keep';
  readonly amountDelta: number;
  readonly costDelta: number | null;
  readonly incompleteMarginCoverage: boolean;
}>;

export type PosTableChanged = EventEnvelope<'pos', 'pos.table_changed.v1', {
  tableId: string; label: string; seats: number; state: string; revision: number;
}>;
export type PosTableSessionChanged = EventEnvelope<'pos', 'pos.table_session_changed.v1', {
  tableId: string; billId: string; state: string; revision: number;
}>;
export type PosMemberBalanceChanged = EventEnvelope<'pos', 'pos.member_balance_changed.v1', {
  memberId: string; settlementId: string; revision: number; chargeBalance: number; receivableBalance: number;
}>;
export type PosMemberFundingRecorded = EventEnvelope<'pos', 'pos.member_funding_recorded.v1', {
  memberId: string; settlementId: string; paymentId: string;
  purpose: 'charge_topup' | 'receivable_collection' | 'membership_sale';
  amount: number; businessDate: string; membershipId: string | null; productId?: string; productRevision?: number;
}>;
export type PosEvent = PosSaleRecognized | PosSaleCorrected | PosTableChanged | PosTableSessionChanged
  | PosMemberBalanceChanged | PosMemberFundingRecorded;

export type InventoryCatalogChanged = EventEnvelope<'inventory', 'inventory.catalog_changed.v1', {
  storeId: string; menuId: string; revision: number; operation: string;
}>;

export type InventoryStockChanged = EventEnvelope<'inventory', 'inventory.stock_changed.v1', {
  storeId: string; businessDate: string; sourceId: string; operation: string; itemIds: readonly string[];
}>;

export type InventoryReceiptRecorded = EventEnvelope<'inventory', 'inventory.receipt_recorded.v1', {
  readonly receiptId: string;
  readonly supplierId: string;
  readonly businessDate: string;
  readonly amount: number;
}>;

type CustomerScheduleChange = {
  readonly resourceId: string;
  readonly revision: number;
  readonly sourceRevision: number;
  readonly operation: 'create' | 'update' | 'delete' | 'handoff' | 'preferences' | 'undo';
  readonly affectedSources: readonly string[];
};
export type CustomerCalendarChanged = EventEnvelope<'customer', 'customer.calendar_changed.v1', CustomerScheduleChange>;
export type CustomerStaffScheduleChanged = EventEnvelope<'customer', 'customer.staff_schedule_changed.v1', CustomerScheduleChange>;

export type CustomerMemberChanged = EventEnvelope<'customer', 'customer.member_changed.v1', {
  memberId?: string; revision?: number; noteId?: string; noteRevision?: number;
  productId?: string; membershipId?: string; active?: boolean; contactAllowed?: boolean; marketingAllowed?: boolean; nameInitial?: string;
}>;
export type CustomerContactStateChanged = EventEnvelope<'customer', 'customer.contact_state_changed.v1', {
  memberId: string; revision: number; active: boolean; contactAllowed: boolean; marketingAllowed: boolean; nameInitial?: string;
}>;
export type CustomerVisitChanged = EventEnvelope<'customer', 'customer.visit_changed.v1', {
  memberId: string; settlementId: string; operation: string;
}>;

export type MarketingPromoJobQueued = EventEnvelope<'marketing', 'marketing.promo_job_queued.v1', {
  readonly jobId: string;
}>;

export type MarketingTestMessageQueued = EventEnvelope<'marketing', 'marketing.message_queued.v1', {
  readonly receiptId: string;
}>;
