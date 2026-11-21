import type { PosPreferences, PosTab, ShopSettings, TableLayout } from './session';

/** API-240~242. All amounts are integer KRW; recipes use integer g/mL/pcs. */
export type PosMethod = 'card' | 'easy_pay' | 'cash';
export type PosOrderType = 'dine_in' | 'takeout';
export type PosScenario = 'normal' | 'empty' | 'error' | 'payment-failure';
export type PosUnitDimension = 'g' | 'mL' | 'pcs';
export type PosMenuPhotoKey = `menu-photo-0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
/** PNG encoded by the browser after resizing a menu photo for the current demo run. */
export type PosMenuPhotoDataUrl = `data:image/png;base64,${string}`;
export type PosMenuPhotoSelection =
  | { readonly photoKey: PosMenuPhotoKey | null; readonly customPhotoUrl?: never }
  | { readonly photoKey: null; readonly customPhotoUrl?: PosMenuPhotoDataUrl };
export interface PosRecipePart { readonly itemId: string; readonly quantityBase: number; readonly unitDimension: PosUnitDimension }
export interface PosIngredient { readonly itemId: string; readonly unitDimension: PosUnitDimension }
export interface PosOption {
  readonly optionId: string; readonly groupId: string; readonly name: string;
  readonly extraPrice: number; readonly extraCost: number | null;
  readonly extraRecipe: readonly PosRecipePart[]; readonly archivedAt?: string;
}
export interface PosOptionGroup {
  readonly groupId: string; readonly menuId: string; readonly name: string;
  readonly required: boolean; readonly options: readonly PosOption[];
  readonly archivedAt?: string;
}
export interface PosCatalogItem {
  readonly menuId: string; readonly name: string; readonly category: string;
  readonly kind: 'menu' | 'retail'; readonly itemId?: string; readonly price: number;
  readonly prepMin: number;
  readonly unitCost: number | null; readonly photoKey: PosMenuPhotoKey | null;
  readonly customPhotoUrl?: PosMenuPhotoDataUrl;
  readonly saleStatus: 'selling' | 'sold_out'; readonly deletedAt?: string;
  readonly shortageItems: readonly string[]; readonly recipeBase: readonly PosRecipePart[];
  readonly groups: readonly PosOptionGroup[];
}
export interface PosCatalog { readonly items: readonly PosCatalogItem[]; readonly ingredients: readonly PosIngredient[] }
/** Display fallback captured when adding/replacing a line; live catalog values take precedence. */
export interface PosCartLineSnapshot {
  readonly name: string; readonly basePrice: number; readonly baseCost: number | null;
  readonly options: readonly PosOption[];
}
export interface PosCartLine {
  readonly lineId: string; readonly menuId: string; readonly selectedOptionIds: readonly string[];
  readonly qty: number; readonly request: string;
  /** Optional for existing callers that construct an option-dialog quote before adding. */
  readonly snapshot?: PosCartLineSnapshot;
}
export interface PosCart {
  readonly cartId: string; readonly revision: number; readonly type: PosOrderType;
  readonly targetBillId?: string; readonly tableId?: string; readonly memo: string;
  readonly lines: readonly PosCartLine[]; readonly lock: string | null;
}
export interface PosOrderOption {
  readonly optionId: string; readonly name: string; readonly extraPrice: number;
  readonly extraRecipe: readonly PosRecipePart[];
}
export interface PosOrderLine {
  readonly orderLineId: string; readonly menuId: string; readonly nameAtOrder: string;
  readonly qty: number; readonly unitPriceAtOrder: number;
  readonly optionsAtOrder: readonly PosOrderOption[]; readonly request: string; readonly canceledQty: number;
}
export interface PosOrderTransferEvent {
  readonly eventId: string; readonly kind: 'move' | 'merge' | 'separate'; readonly at: string;
  readonly fromTableId: string; readonly toTableId: string; readonly sourceBillId: string; readonly targetBillId: string;
}
export interface PosOrder {
  readonly orderId: string; readonly orderNo: number; readonly orderedAt: string; readonly seq: number;
  readonly type: PosOrderType; readonly originBillId: string; readonly lines: readonly PosOrderLine[];
  readonly memo: string; readonly preparation: 'accepted' | 'preparing' | 'completed' | 'canceled';
  readonly preparedAt: string | null; readonly completedAt: string | null; readonly completedInRun: boolean;
  readonly reservationId?: string; readonly partyId?: string;
  readonly statusHistory?: readonly PosOrderTransferEvent[];
}
export interface PosDiscount {
  readonly discountId: string; readonly billId: string; readonly source: 'direct' | 'coupon' | 'membership';
  readonly scope: 'bill' | 'line'; readonly amount: number; readonly percent?: number;
  readonly couponId?: string; readonly codeId?: string; readonly membershipId?: string; readonly useId?: string;
  readonly allocationId?: string; readonly fallbackFrom?: string; readonly baselineIncluded?: boolean; readonly reason?: string;
  readonly targetAllocationIds?: readonly string[]; readonly memo?: string;
  /** API-244: fixed won amounts travel with quantities, never re-quote a transferred benefit. */
  /** Original benefit scope follows all its quantities, including zero-discount fragments. */
  readonly contributionAllocationIds?: readonly string[];
  readonly contributionMemberId?: string;
  readonly fixedAllocations?: readonly { readonly allocationId: string; readonly amount: number }[];
}
export interface PosDiscountAllocation { readonly discountId: string; readonly amount: number }
export interface PosSettlementLine {
  readonly allocationId: string; readonly menuId: string; readonly qty: number;
  readonly basePriceAtSale: number; readonly optionPriceAtSale: number;
  readonly unitCostAtSale: number | null; readonly optionCostAtSale: number | null;
  readonly discountAllocations: readonly PosDiscountAllocation[]; readonly recognizedQty: number;
}
export interface PosBill {
  readonly billId: string; readonly originOrderNo: number; readonly tableId: string | null;
  readonly status: 'open' | 'partial' | 'paid' | 'void'; readonly memberId?: string; readonly reservationId?: string;
  readonly requestedAt?: string; readonly settledAt?: string; readonly recognizedAt?: string;
  readonly discounts: readonly PosDiscount[]; readonly settlementLines: readonly PosSettlementLine[];
  /** A prepaid draft has no order/allocations until final recognition. */
  readonly cartId?: string; readonly splitPlan?: PosSplitPlan;
  readonly memberLinkChosen?: boolean;
}
export interface PosBillAllocation { readonly allocationId: string; readonly billId: string; readonly orderLineId: string; readonly qty: number }
export interface PosMethodSplit { readonly method: PosMethod; readonly amount: number }
export interface PosPayment {
  readonly paymentId: string; readonly billId: string; readonly partId?: string; readonly at: string; readonly seq: number;
  readonly transactionNo: string; readonly approvalNo: string; readonly amount: number;
  readonly splits: readonly PosMethodSplit[]; readonly countedMethod: PosMethod;
  readonly status: 'paid' | 'canceled'; readonly recognizedAt: string | null;
  readonly seedIncluded?: boolean; readonly fixedTag?: string | null;
}
export interface PosRefund {
  readonly refundId: string; readonly paymentId: string; readonly billId: string; readonly at: string; readonly seq: number;
  readonly amount: number; readonly methodAmounts: readonly PosMethodSplit[];
  readonly lineAmounts: readonly { readonly orderLineId: string; readonly qty: number; readonly amount: number }[];
  readonly reason: string; readonly seedIncluded?: boolean;
}
export interface PosCancellation {
  readonly cancellationId: string; readonly paymentId: string; readonly billId: string; readonly at: string; readonly seq: number;
  readonly amount: number; readonly methodAmounts: readonly PosMethodSplit[];
  readonly allocations: readonly { readonly lineId: string; readonly allocationId?: string; readonly qty: number; readonly gross: number; readonly discount: number; readonly cost: number | null; readonly discountAllocations?: readonly PosDiscountAllocation[] }[];
  readonly reason: string; readonly restockRetail: boolean;
}
export interface PosCashReceipt {
  readonly cashReceiptId: string; readonly paymentId: string; readonly kind: 'income' | 'business';
  readonly maskedIdentifier: string; readonly cashAmount: number; readonly status: 'issued' | 'canceled'; readonly issuedAt: string;
}
export interface PosReceipt { readonly paymentId: string; readonly billId: string }
export interface PosCashMovement { readonly movementId: string; readonly at: string; readonly seq: number; readonly kind: 'in' | 'out'; readonly amount: number; readonly memo: string }
export interface PosDrawer { readonly opening: number; readonly actual: number | null; readonly memo: string; readonly movements: readonly PosCashMovement[] }
export interface PosDrawerSnapshot extends PosDrawer {
  readonly approvedCash: number; readonly cashPayments: number; readonly pendingCash: number;
  readonly cashCanceled: number; readonly cashRefunded: number; readonly cashReturned: number; readonly cashNet: number;
  readonly in: number; readonly out: number; readonly expected: number; readonly difference: number | null;
}
export type PosDrawerCommand =
  | { readonly type: 'drawer.set'; readonly opening?: number; readonly actual?: number | null; readonly memo?: string; readonly meta: PosCommandMeta }
  | { readonly type: 'drawer.addMovement'; readonly kind: 'in' | 'out'; readonly amount: number; readonly memo?: string; readonly meta: PosCommandMeta }
  | { readonly type: 'drawer.removeMovement'; readonly movementId: string; readonly meta: PosCommandMeta };
export interface PosDrawerUndo {
  readonly token: string; readonly commandKey: string; readonly closingGeneration: number;
  readonly before: PosDrawer; readonly after: PosDrawer;
}
export interface PosTableSession { readonly tableId: string; readonly billId?: string; readonly requestedAt?: string; readonly cleaning: boolean }
export interface PosReservationPrompt { readonly reservationId: string; readonly billId: string; readonly firstOrderId: string; readonly decision: 'pending' | 'accepted' | 'declined' }
export interface PosCommandMeta {
  readonly runId: string; readonly idempotencyKey: string; readonly expectedPosRevision?: number; readonly expectedDataRevision?: number;
}
export type PosFailure = {
  readonly ok: false; readonly code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'PREVIEW_FAILURE';
  readonly reason: string; readonly field?: string; readonly messageKey: string; readonly details?: Readonly<Record<string, unknown>>;
};
export interface PosSuccess<T> {
  readonly ok: true; readonly status: 'applied' | 'unchanged' | 'pending'; readonly transactionId?: string;
  readonly posRevision: number; readonly dataRevision: number; readonly value: T;
  readonly duplicate?: boolean; readonly undoToken?: string; readonly noticeKey?: string;
}
export type PosResult<T> = PosSuccess<T> | PosFailure;
export interface PosApprovalPending { readonly attemptId: string; readonly status: 'pending' }
export interface PosApprovalCompletion { readonly paymentId?: string; readonly billId: string; readonly orderIds: readonly string[]; readonly remaining: number; readonly settled: boolean }
export type PosCommandValue = PosCart | PosApprovalPending | PosApprovalCompletion | PosReversalCompletion | PosCashReceiptCompletion | null;
export interface PosCommandRecord {
  readonly key: string; readonly fingerprint: string; readonly scenario: PosScenario; readonly closingGeneration: number;
  readonly result: PosSuccess<PosCommandValue>; readonly undone: boolean;
}
export interface PosState {
  /** Iteration 7's one canonical money source, published with the POS reference. */
  readonly money?: import('../data/iteration7/accounting/types').MoneyState;
  readonly customSettlements?: readonly import('../data/iteration7/custom-orders').CustomSettlement[];
  readonly customPayments?: readonly import('../data/iteration7/custom-orders').CustomPayment[];
  readonly customRecognitions?: readonly import('../data/iteration7/custom-orders').CustomSalesRecognition[];
  readonly customCorrections?: readonly import('../data/iteration7/custom-orders').CustomCorrection[];
  readonly businessDate: string; readonly revision: number; readonly seq: number; readonly cart: PosCart;
  readonly orders: readonly PosOrder[]; readonly bills: readonly PosBill[]; readonly billAllocations: readonly PosBillAllocation[];
  readonly payments: readonly PosPayment[]; readonly refunds: readonly PosRefund[]; readonly cancellations: readonly PosCancellation[];
  readonly receipts: readonly PosReceipt[]; readonly cashReceipts: readonly PosCashReceipt[];
  readonly tableSessions: readonly PosTableSession[]; readonly reservationPrompts: readonly PosReservationPrompt[];
  readonly drawer: PosDrawer; readonly commandLedger: readonly PosCommandRecord[];
}
export interface PosCartUndo { readonly token: string; readonly commandKey: string; readonly before: PosCart; readonly after: PosCart }
export interface PosApprovalAttempt {
  readonly attemptId: string; readonly runId: string; readonly meta: PosCommandMeta;
  readonly cartId: string; readonly splits: readonly PosMethodSplit[]; readonly quoteFingerprint: string;
  readonly payloadFingerprint: string; readonly scenario: PosScenario; readonly closingGeneration: number;
  readonly status: 'pending' | 'succeeded' | 'failed'; readonly result?: PosResult<PosApprovalCompletion>;
  readonly billId?: string;
  readonly quoteRevision?: number;
  readonly partId?: string;
  readonly approvalInput?: PosApprovalInput;
}
export interface PosUiState {
  readonly tab: PosTab; readonly approval: PosApprovalAttempt | null; readonly cartUndo: PosCartUndo | null;
  readonly tablesUndo?: PosTableUndo | null;
  readonly drawerUndo?: PosDrawerUndo | null;
  readonly orderUndo?: import('../orders').OrderUndo | null;
  readonly orderAlert?: import('../orders').OrderAlert;
  readonly statusFilter?: 'open' | 'done' | 'canceled' | 'all';
  readonly selectedOrderId?: string | null;
  readonly forceStatusVisible?: boolean;
  readonly orderHighlight?: { readonly orderId: string; readonly token: string };
}
/** T-242 adapts its current immutable DataSnapshot to this domain-only read model. */
export interface PosDataRead {
  /** API-248 uses the existing store profile's name (marketing.promoStore), without a second stored label. */
  readonly storeDisplayName?: string;
  readonly revision: number; readonly catalog: PosCatalog; readonly dayClosed: boolean; readonly closingGeneration: number;
  /** The adapter may retain its original immutable snapshot here; the domain never reads it. */
  readonly source?: unknown;
  readonly reservations?: readonly PosReservationRead[];
  readonly loyalty?: PosLoyaltyRead;
}
export interface PosReadSnapshot {
  readonly runId: string; readonly runRevision: number; readonly pos: PosState; readonly posRevision: number;
  readonly posUi: PosUiState; readonly dataRevision: number; readonly settings: ShopSettings;
  readonly scenario: PosScenario; readonly data: PosDataRead;
}
export type PosCartCommand =
  | { readonly type: 'cart.add'; readonly meta: PosCommandMeta; readonly menuId: string; readonly optionIds: readonly string[]; readonly qty?: number; readonly request?: string }
  | { readonly type: 'cart.replaceOptions'; readonly meta: PosCommandMeta; readonly lineId: string; readonly optionIds: readonly string[]; readonly qty?: number; readonly request?: string }
  | { readonly type: 'cart.quantity'; readonly meta: PosCommandMeta; readonly lineId: string; readonly qty: number }
  | { readonly type: 'cart.remove'; readonly meta: PosCommandMeta; readonly lineId: string }
  | { readonly type: 'cart.clear'; readonly meta: PosCommandMeta }
  | { readonly type: 'cart.note'; readonly meta: PosCommandMeta; readonly lineId?: string; readonly text: string }
  | { readonly type: 'cart.type'; readonly meta: PosCommandMeta; readonly orderType: PosOrderType };
export interface PosBeginApproval {
  readonly meta: PosCommandMeta; readonly cartId: string; readonly splits: readonly PosMethodSplit[]; readonly quoteRevision: number;
  readonly partId?: string;
}
export interface PosFinishApproval {
  readonly runId: string; readonly attemptId: string; readonly expectedQuoteFingerprint: string; readonly outcome: 'approved' | 'failed';
}
export type PosCommand = PosCartCommand | (PosBeginApproval & { readonly type: 'approval.begin' }) | (PosFinishApproval & { readonly type: 'approval.finish' });
/** The data owner projects nextPos and applies explicit M2 settings/attendance writes atomically. */
export interface PosPlan { readonly nextPos: PosState; readonly nextUi: PosUiState; readonly result: PosSuccess<PosCommandValue>; readonly dataChanges?: PosDataChanges }
export type PosPlanningResult = { readonly ok: true; readonly plan: PosPlan } | PosFailure;
export interface PosQuoteIssue { readonly reason: string; readonly lineId?: string; readonly groupId?: string; readonly messageKey: string; readonly details?: Readonly<Record<string, unknown>> }
export interface PosQuotedLine {
  readonly lineId: string; readonly menuId: string; readonly name: string; readonly qty: number;
  readonly basePrice: number; readonly optionPrice: number; readonly unitPrice: number; readonly gross: number;
  readonly unitCost: number | null; readonly baseCost: number | null; readonly optionCost: number | null;
  readonly options: readonly PosOption[]; readonly request: string; readonly shortageItems: readonly string[];
}
export interface PosCartQuote {
  readonly cartId: string; readonly revision: number; readonly fingerprint: string; readonly lines: readonly PosQuotedLine[];
  readonly totalQty: number; readonly gross: number; readonly discount: number; readonly payable: number;
  readonly canSubmit: boolean; readonly issues: readonly PosQuoteIssue[];
}
export interface PosDayTotals {
  readonly gross: number; readonly discount: number; readonly discountBySource: Readonly<Record<PosDiscount['source'], number>>;
  readonly charged: number; readonly refund: number; readonly canceled: number; readonly revenue: number;
  readonly paymentCount: number; readonly refundCount: number; readonly cancelCount: number;
  readonly byMethod: Readonly<Record<PosMethod, number>>; readonly methodCounts: Readonly<Record<PosMethod, number>>;
  readonly pendingReceived: number; readonly pendingBillCount: number;
}
export interface PosSession {
  execute(command: PosSessionCommand): PosResult<PosCommandValue>;
  readonly undo: (token: string) => PosResult<unknown>;
  readonly read: () => PosReadSnapshot;
}

/** M2 commands are composed explicitly in runtime; the M1 domain keeps its narrow command union. */
export type PosTableCommand =
  | { readonly type: 'bill.moveTable'; readonly meta: PosCommandMeta; readonly billId: string; readonly targetTableId: string }
  | { readonly type: 'bill.mergeTables'; readonly meta: PosCommandMeta; readonly sourceBillId: string; readonly targetBillId: string }
  | { readonly type: 'bill.separateTable'; readonly meta: PosCommandMeta; readonly billId: string; readonly targetTableId: string; readonly lines: readonly { readonly orderLineId: string; readonly qty: number }[] }
  | { readonly type: 'bill.submitOrder'; readonly meta: PosCommandMeta; readonly cartId: string; readonly tableId?: string; readonly billId?: string }
  | { readonly type: 'bill.requestPayment'; readonly meta: PosCommandMeta; readonly billId: string }
  | { readonly type: 'table.clean'; readonly meta: PosCommandMeta; readonly tableId: string }
  | { readonly type: 'table.saveLayout'; readonly meta: PosCommandMeta; readonly layout: TableLayout; readonly expectedSettingsRevision: number }
  | { readonly type: 'reservation.respond'; readonly meta: PosCommandMeta; readonly reservationId: string; readonly billId: string; readonly decision: 'accept' | 'defer' }
  | { readonly type: 'pos.setPreferences'; readonly meta: PosCommandMeta; readonly startTab?: PosTab; readonly showStatus?: boolean; readonly showTables?: boolean }
  | { readonly type: 'order.cancelUnpaid'; readonly meta: PosCommandMeta; readonly orderId: string };
export interface PosBillBeginApproval {
  readonly meta: PosCommandMeta; readonly billId: string; readonly quoteRevision: number; readonly splits: readonly PosMethodSplit[];
  readonly partId?: string;
}
export type PosApprovalInput = PosBeginApproval | PosBillBeginApproval;
export type PosStatusCommand =
  | { readonly type: 'order.start' | 'order.complete' | 'order.reopen'; readonly orderId: string; readonly meta: PosCommandMeta }
  | { readonly type: 'order.undo'; readonly token: string; readonly meta: PosCommandMeta }
  | { readonly type: 'orderAlert.seen' | 'orderAlert.dismiss'; readonly ids: readonly string[]; readonly meta: PosCommandMeta };
export type PosSessionCommand = PosCommand | PosTableCommand | PosStatusCommand | PosLoyaltyCommand | PosReversalCommand | PosDrawerCommand | (PosBillBeginApproval & { readonly type: 'approval.begin' });
export interface PosReservationRead {
  readonly reservationId: string; readonly date: string; readonly time: string; readonly partySize: number;
  readonly tableId: string | null; readonly status: string; readonly memberId?: string;
  readonly name: string | { readonly key: string }; readonly allocationWarning?: string;
  /** Fingerprints cover the full source row, so attendance undo cannot erase a later edit. */
  readonly fingerprint: string; readonly completedFingerprint: string;
}
export interface PosReservationWrite {
  readonly reservationId: string; readonly expectedFingerprint: string; readonly status: 'confirmed' | 'completed';
  readonly changeId: string; readonly at: string; readonly undo?: boolean;
}
export interface PosDataChanges {
  readonly settings?: ShopSettings; readonly reservation?: PosReservationWrite; readonly custom?: import('../data/iteration7/custom-orders').CustomPlanResult;
  readonly customLedger?: { readonly key: string; readonly fingerprint: string; readonly result: unknown };
  readonly pickupUndo?: { readonly token: string; readonly recognitionId: string }; // D-326.
}
export type PosTableCollection = 'orders' | 'bills' | 'billAllocations' | 'tableSessions' | 'reservationPrompts';
export interface PosTablePatch { readonly collection: PosTableCollection | 'cart'; readonly id: string; readonly before: unknown; readonly after: unknown }
export interface PosTableUndo {
  readonly token: string; readonly commandKey: string; readonly closingGeneration: number; readonly financial: boolean;
  readonly patches: readonly PosTablePatch[]; readonly reservation?: PosReservationWrite;
}
export interface PosBillQuote {
  readonly billId: string; readonly revision: number; readonly fingerprint: string; readonly orderIds: readonly string[];
  readonly lines: readonly PosQuotedLine[]; readonly totalQty: number; readonly gross: number; readonly discount: number;
  readonly payable: number; readonly received: number; readonly remaining: number; readonly canSubmit: boolean; readonly issues: readonly PosQuoteIssue[];
}
export type PosTableState = 'empty' | 'reserved' | 'occupied' | 'payment_pending' | 'cleaning';
export interface PosTableView {
  readonly tableId: string; readonly number: number; readonly seats: number; readonly state: PosTableState;
  readonly billIds: readonly string[]; readonly total: number; readonly elapsed: number; readonly orderCount: number;
  readonly reservation: PosReservationRead | null;
}
export interface PosTableMap {
  readonly enabled: boolean; readonly layout: TableLayout | null; readonly tables: readonly PosTableView[];
  readonly unpaidBills: readonly PosBillQuote[];
}
export type { PosPreferences, PosTab };

export type PosDiscountInput =
  | { readonly source: 'direct'; readonly amount?: number; readonly percent?: number; readonly memo?: string }
  | { readonly source: 'coupon'; readonly couponId: string; readonly codeId?: string }
  | { readonly source: 'membership'; readonly membershipId: string };
export interface PosItemPartInput { readonly lineQtyAllocations: readonly { readonly allocationId: string; readonly qty: number }[] }
export type PosSplitInput = { readonly kind: 'equal'; readonly n: number } | { readonly kind: 'items'; readonly parts: readonly PosItemPartInput[] };
export interface PosPaymentPart {
  readonly partId: string; readonly amount: number; readonly status: 'unpaid' | 'paid';
  readonly lineQtyAllocations?: PosItemPartInput['lineQtyAllocations'];
}
export interface PosSplitPlan {
  readonly planId: string; readonly billId: string; readonly kind: 'equal' | 'items';
  readonly parts: readonly PosPaymentPart[]; readonly lines: readonly PosQuotedLine[];
  readonly settlementLines: readonly PosSettlementLine[];
}
export type PosLoyaltyCommand =
  | { readonly type: 'bill.member'; readonly billId: string; readonly memberId: string | null; readonly meta: PosCommandMeta }
  | { readonly type: 'bill.setDiscount'; readonly billId: string; readonly discountInput: PosDiscountInput; readonly meta: PosCommandMeta }
  | { readonly type: 'bill.removeDiscount'; readonly billId: string; readonly discountId: string; readonly meta: PosCommandMeta }
  | ({ readonly type: 'bill.split'; readonly billId: string; readonly meta: PosCommandMeta } & PosSplitInput)
  | { readonly type: 'bill.clearSplit'; readonly billId: string; readonly meta: PosCommandMeta }
  | { readonly type: 'bill.confirmZero'; readonly billId: string; readonly meta: PosCommandMeta }
  | { readonly type: 'bill.cancelPartial'; readonly billId: string; readonly confirmed: boolean; readonly meta: PosCommandMeta };
export interface PosMemberRead {
  readonly memberId: string; readonly customerId: string; readonly name: string | { readonly key: string } | { readonly raw: string };
  readonly phone: string; readonly grade: 'regular' | 'frequent' | 'occasional' | 'inactive'; readonly recentVisits: number;
}
export interface PosPassRead {
  readonly membershipId: string; readonly memberId?: string; readonly nameKey: string;
  readonly kind: 'americano' | 'morning' | 'monthly' | 'unsupported'; readonly startsOn: string; readonly endsOn: string;
  readonly active: boolean; readonly usesLeft: number | null; readonly dailyLimit: number | null; readonly usedToday: number;
}
export interface PosCouponRead {
  readonly couponId: string; readonly name: string | { readonly key: string } | { readonly raw: string }; readonly benefitType: 'percent' | 'amount' | 'free_item' | 'set_price';
  readonly benefitValue: number; readonly targetMenuId: string | null; readonly startsOn: string; readonly endsOn: string; readonly status: string;
  readonly validHours: readonly { readonly weekday: number; readonly startHour: number; readonly endHour: number }[] | null;
  // D-326: old issued codes retain their benefit and expiry after campaign changes.
  readonly codes: readonly { readonly codeId: string; readonly active: boolean; readonly used: number; readonly issueCount: number; readonly customerIds: readonly string[];
    readonly issuedTerms?: import('../data/marketing/types').IssuedCouponTerms; readonly unpublished?: boolean }[];
}
export interface PosLoyaltyRead { readonly members: readonly PosMemberRead[]; readonly passes: readonly PosPassRead[]; readonly coupons: readonly PosCouponRead[] }
export interface PosLoyaltyQuote extends PosBillQuote {
  readonly memberId?: string; readonly discounts: readonly PosDiscount[]; readonly settlementLines: readonly PosSettlementLine[];
  readonly parts: readonly PosPaymentPart[];
}

/** API-247/248. Quote tokens are opaque, run/revision-bound and recalculated at confirmation. */
export interface PosReversalInput {
  readonly paymentId: string; readonly kind: 'cancel' | 'refund';
  readonly lines?: readonly { readonly orderLineId: string; readonly qty: number }[];
  readonly amount?: number; readonly methodAmounts?: readonly PosMethodSplit[]; readonly restockRetail?: boolean;
}
export interface PosReversalQuote {
  readonly quoteToken: string; readonly amount: number; readonly methods: readonly PosMethodSplit[];
  readonly kind: 'cancel' | 'refund'; readonly remaining: number;
  readonly salesEffect: 'restore' | 'keep'; readonly stockEffect: 'restore' | 'keep';
  readonly couponEffect: 'restore' | 'keep'; readonly membershipEffect: 'restore' | 'keep';
  readonly canSubmit: boolean; readonly issues: readonly PosQuoteIssue[];
  readonly lines: readonly { readonly orderLineId: string; readonly menuId: string; readonly name: string; readonly qty: number; readonly amount: number }[];
}
export interface PosReversalCompletion { readonly correctionId: string; readonly paymentId: string }
export interface PosCashReceiptCompletion { readonly cashReceiptId: string; readonly paymentId: string }
export type PosReversalCommand =
  | { readonly type: 'payment.reverse'; readonly quoteToken: string; readonly confirmed: boolean; readonly meta: PosCommandMeta }
  | { readonly type: 'receipt.showAgain'; readonly paymentId: string; readonly meta: PosCommandMeta }
  | { readonly type: 'cashReceipt.issue'; readonly paymentId: string; readonly kind: 'income' | 'business'; readonly identifier: string; readonly meta: PosCommandMeta }
  | { readonly type: 'cashReceipt.cancel'; readonly cashReceiptId: string; readonly meta: PosCommandMeta };
export interface PosReceiptView {
  readonly paymentId: string; readonly billId: string; readonly storeName: string | null; readonly at: string;
  readonly orderNos: readonly number[]; readonly transactionNo: string; readonly approvalNo: string;
  readonly amount: number; readonly gross: number; readonly discount: number; readonly remaining: number;
  readonly status: 'paid' | 'partially_canceled' | 'canceled' | 'partially_refunded' | 'refunded';
  readonly splits: readonly PosMethodSplit[];
  readonly lines: readonly { readonly orderLineId: string; readonly menuId: string; readonly name: string; readonly options: readonly PosOrderOption[]; readonly request: string; readonly qty: number; readonly gross: number; readonly discount: number; readonly amount: number }[];
  readonly discounts: readonly { readonly source: PosDiscount['source']; readonly amount: number }[];
  readonly member: { readonly memberId: string; readonly name: PosMemberRead['name']; readonly phone: string } | null;
  readonly cashReceipt: PosCashReceipt | null; readonly canIssueCashReceipt: boolean;
  readonly corrections: readonly { readonly correctionId: string; readonly kind: 'cancel' | 'refund'; readonly at: string; readonly seq: number; readonly amount: number; readonly methods: readonly PosMethodSplit[]; readonly restockRetail: boolean }[];
}
