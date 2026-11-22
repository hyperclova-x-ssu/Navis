export type CustomStage = 'received' | 'quote_pending' | 'approval_pending' | 'revision_requested' | 'payment_pending' | 'in_production' | 'production_complete' | 'received_by_customer' | 'canceled';
export type CustomerDecision = 'pending' | 'approved' | 'rejected' | 'revision_requested';
export type PaymentTiming = 'advance' | 'on_pickup';
export type RealMethod = 'card' | 'easy_pay' | 'cash';
export interface CustomTemplateField {
  readonly fieldId: string; readonly label: string; readonly input: 'text' | 'single' | 'multiple' | 'datetime'; readonly required: boolean;
  readonly options: readonly { readonly optionId: string; readonly label: string; readonly extraAmount: number }[];
}
export interface CustomTemplate {
  readonly templateId: string; readonly name: string; readonly revision: number; readonly fields: readonly CustomTemplateField[]; readonly archivedAt: string | null;
}
export type CustomAnswers = Readonly<Record<string, string | readonly string[]>>;
export interface CustomReceipt {
  readonly answers: CustomAnswers; readonly productLabel: string; readonly options: readonly string[]; readonly quantity: number;
  readonly request: string; readonly referencePhotoKeys: readonly string[]; readonly channel: 'phone' | 'message' | 'visit';
  readonly memberId: string | null; readonly guest: { readonly name: string; readonly phone: string } | null; readonly desiredPickupAt: string;
}
export interface CustomHistory {
  readonly historyId: string; readonly at: string; readonly kind: 'created' | 'updated' | 'quoted' | 'decision' | 'stage' | 'rescheduled' | 'canceled' | 'settled' | 'received' | 'refunded';
  readonly stage: CustomStage; readonly quoteRevision: number; readonly detail: string; readonly referenceId: string | null;
}
export interface CustomOrder extends CustomReceipt {
  /** Store-local order number the service assigns on HTTP builds (shown `CO-001`). Fixture rows derive it from the id. */
  readonly orderNo?: number;
  readonly customOrderId: string; readonly templateId: string; readonly templateRevision: number; readonly templateSnapshot: CustomTemplate;
  readonly proposedPickupAt: string | null; readonly productionAt: string | null; readonly quoteAmount: number | null; readonly quoteRevision: number;
  readonly customerDecision: CustomerDecision; readonly approvedQuoteRevision: number | null; readonly stage: CustomStage;
  readonly paymentTiming: PaymentTiming; readonly pickupReservationId: string | null; readonly settlementId: string | null; readonly history: readonly CustomHistory[];
}
export interface PickupReservation {
  readonly kind: 'pickup'; readonly reservationId: string; readonly customOrderId: string; readonly date: string; readonly time: string;
  readonly status: 'confirmed' | 'completed' | 'canceled'; readonly updatedAt: string;
}
/** Structural visit reference; the planner retains every original visit object and its fields. */
export interface CustomVisitReference {
  readonly kind: 'visit'; readonly reservationId: string; readonly date: string; readonly time: string; readonly status: string;
  readonly partySize?: number; readonly tableId?: string | null;
}
export interface CustomMethodAllocation { readonly allocationId?: string; readonly kind: 'method'; readonly method: RealMethod; readonly amount: number }
export interface CustomSettlement {
  readonly settlementId: string; readonly purpose: 'custom_order'; readonly sourceRef: { readonly kind: 'custom_order'; readonly id: string };
  readonly billId: null; readonly partId: null; readonly memberId: string | null; readonly at: string; readonly amount: number;
  readonly allocations: readonly CustomMethodAllocation[]; readonly status: 'paid'; readonly paymentTiming: PaymentTiming;
}
export interface CustomPayment {
  readonly paymentId: string; readonly settlementId: string; readonly purpose: 'custom_order'; readonly sourceRef: { readonly kind: 'custom_order'; readonly id: string };
  readonly at: string; readonly amount: number; readonly splits: readonly { readonly method: RealMethod; readonly amount: number }[];
}
export interface CustomSalesRecognition {
  readonly recognitionId: string; readonly source: 'custom_pickup'; readonly sourceId: string; readonly businessDate: string; readonly at: string;
  readonly amount: number; readonly cost: null; readonly settlementCategory: 'custom_pickup'; readonly originalRecognitionId: string | null;
}
export interface CustomCorrection {
  readonly correctionId: string; readonly settlementId: string; readonly customOrderId: string; readonly kind: 'cancellation' | 'refund';
  readonly at: string; readonly amount: number; readonly realMethodReturns: readonly { readonly method: RealMethod; readonly amount: number }[];
  readonly recognitionEffects: readonly CustomSalesRecognition[];
}
export interface CustomMoneyState {
  readonly settlements: readonly CustomSettlement[]; readonly payments: readonly CustomPayment[];
  readonly recognitions: readonly CustomSalesRecognition[]; readonly corrections: readonly CustomCorrection[];
}
export type CustomMoneyEffects = CustomMoneyState;
export interface CustomAppliedKey { readonly command: string; readonly result: unknown }
export interface CustomOrderTables {
  readonly customTemplate: readonly CustomTemplate[]; readonly customOrder: readonly CustomOrder[];
  readonly reservation: readonly (PickupReservation | CustomVisitReference)[];
  readonly member?: readonly { readonly memberId: string }[];
  readonly appliedKeys?: Readonly<Record<string, CustomAppliedKey>>;
}
/** money references canonical POS records; callers append returned effects in the atomic coordinator. */
export interface CustomOrderRead {
  readonly revision: number; readonly tables: CustomOrderTables; readonly money: CustomMoneyState;
  /** Canonical M3 state is supplied by the shared read adapter, never copied into this domain. */
  readonly accounting?: import('../accounting/types').MoneyState;
  readonly businessDate?: string; readonly now?: string;
  /** HTTP builds: the service's own payment view per order (it is the ledger of record; `money` stays empty there). */
  readonly payments?: Readonly<Record<string, CustomOrderPaymentView>>;
}
export interface CustomFailure {
  readonly ok: false; readonly code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'PREVIEW_FAILURE'; readonly reason: string;
  readonly field?: string; readonly messageKey: string; readonly details?: Readonly<Record<string, unknown>>;
}
export interface CustomCommandValue {
  readonly templateId?: string; readonly customOrderId?: string; readonly pickupReservationId?: string; readonly reservationId?: string;
  readonly quoteRevision?: number; readonly stage?: CustomStage; readonly settlementId?: string; readonly paymentId?: string;
  readonly recognitionId?: string; readonly correctionId?: string;
}
export type CustomPlanResult = CustomFailure | {
  readonly ok: true; readonly tables: CustomOrderTables; readonly moneyEffects: CustomMoneyEffects;
  readonly value: CustomCommandValue; readonly undoable: boolean; readonly changed: boolean;
};
type Meta = { readonly baseRevision?: number; readonly idempotencyKey?: string };
type Key = { readonly idempotencyKey: string };
type ReceiptInput = Omit<CustomReceipt, 'memberId' | 'guest' | 'request' | 'referencePhotoKeys' | 'options'> & {
  readonly memberId?: string | null; readonly guest?: CustomReceipt['guest']; readonly request?: string;
  readonly referencePhotoKeys?: readonly string[]; readonly options?: readonly string[];
};
export type CustomOrderCommand = Meta & (
  | ({ readonly type: 'customTemplate.generate'; readonly productKind: string; readonly keywords: string } & Key)
  | { readonly type: 'customTemplate.save'; readonly templateId?: string; readonly name: string; readonly fields: readonly CustomTemplateField[] }
  | ({ readonly type: 'customTemplate.delete'; readonly templateId: string } & Key)
  | ({ readonly type: 'customOrder.create'; readonly templateId: string } & ReceiptInput & Key)
  | ({ readonly type: 'customOrder.update'; readonly customOrderId: string; readonly expectedQuoteRevision: number } & Partial<CustomReceipt>)
  | ({ readonly type: 'customOrder.quote'; readonly customOrderId: string; readonly quoteAmount: number; readonly proposedPickupAt: string; readonly productionAt?: string | null } & Key)
  | ({ readonly type: 'customOrder.recordDecision'; readonly customOrderId: string; readonly quoteRevision: number; readonly decision: Exclude<CustomerDecision, 'pending'>; readonly paymentTiming: PaymentTiming } & Key)
  | ({ readonly type: 'customOrder.setStage'; readonly customOrderId: string; readonly nextStage: CustomStage } & Key)
  | ({ readonly type: 'pickup.reschedule'; readonly reservationId: string; readonly date: string; readonly time: string } & Key)
  | ({ readonly type: 'pickup.cancel'; readonly reservationId: string; readonly confirmedCorrectionQuoteId?: string } & Key)
  | ({ readonly type: 'customOrder.cancel'; readonly customOrderId: string; readonly confirmedCorrectionQuoteId?: string } & Key)
  | ({ readonly type: 'customOrder.receive'; readonly customOrderId: string } & Key)
);
export interface CustomOrderPaymentView {
  readonly status: 'unpaid' | 'paid' | 'canceled' | 'refunded'; readonly amountSettled: number; readonly amountReturned: number;
  readonly realDeposits: number; readonly chargeApplied: number; readonly receivableAmount: number;
}
export interface CustomOrderView extends CustomOrder {
  readonly pickup: PickupReservation | null; readonly confirmedPickupAt: string | null; readonly payment: CustomOrderPaymentView;
}
export interface CustomOrdersModel {
  readonly templates: readonly CustomTemplate[]; readonly orders: readonly CustomOrderView[];
  readonly summary: { readonly inProgress: number; readonly approvalPending: number; readonly todayPickup: number; readonly tomorrowPickup: number; readonly todayNotComplete: number };
}
export interface CustomOrderQuery { readonly stage?: CustomStage; readonly start?: string; readonly end?: string; readonly query?: string }
export interface CustomSettlementQuote {
  readonly quoteId: string; readonly quoteRevision: number; readonly orderQuoteRevision: number;
  readonly target: { readonly purpose: 'custom_order'; readonly customOrderId: string }; readonly amountDue: number;
  readonly allocations: readonly CustomMethodAllocation[]; readonly realMethodSplits: readonly { readonly method: RealMethod; readonly amount: number }[];
  readonly discounts: readonly never[]; readonly recognitionEffects: readonly never[]; readonly accountEffects: readonly never[]; readonly membershipEffects: readonly never[];
  readonly remaining: number; readonly canSubmit: boolean; readonly issues: readonly CustomFailure[];
}
export interface CustomReversalQuote {
  readonly quoteId: string; readonly quoteRevision: number; readonly customOrderId: string; readonly settlementId: string;
  readonly kind: 'cancellation' | 'refund'; readonly amount: number; readonly remainingRefundable: number;
  readonly realMethodReturns: readonly { readonly method: RealMethod; readonly amount: number }[];
  readonly recognitionEffects: readonly CustomSalesRecognition[]; readonly canSubmit: boolean; readonly issues: readonly CustomFailure[];
}
export interface CustomCalendarEvent {
  readonly eventId: string; readonly customOrderId: string; readonly reservationId: string; readonly source: 'pickup'; readonly category: 'store-operations';
  readonly readonly: true; readonly kind: 'pickup' | 'production'; readonly date: string; readonly time: string; readonly title: string;
  readonly detailRef: { readonly featureId: 'custom-order'; readonly customOrderId: string };
}
export interface CustomAccountingModel {
  readonly customPickup: number; readonly realDeposits: number; readonly advanceDeposits: number;
  readonly methodDeposits: Readonly<Record<RealMethod, number>>; readonly refund: number;
  readonly rows: readonly { readonly customOrderId: string; readonly productLabel: string; readonly amount: number; readonly cost: null; readonly recognitionId: string }[];
}
