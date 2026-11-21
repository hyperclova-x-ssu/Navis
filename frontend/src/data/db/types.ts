/**
 * In-memory fake DB tables (DATA_MODEL 10.9). Table names are the contract names in camelCase
 * (`daily_sales` → `dailySales`). Money is integer won, quantities are numbers + unit codes,
 * dates are store-local ISO dates, times are `HH:mm`, stamps are `YYYY-MM-DDTHH:mm` (store-local).
 * Screen names and sentences are message keys (`data.*`); only text the owner typed is raw.
 */

import type { UnitCode } from '../../i18n';
import type { ManagementTables, CalendarCategory } from './management-types';
import type { MarketingTables } from '../marketing/types';
import type { PosMenuPhotoDataUrl, PosMenuPhotoKey, PosOptionGroup, PosState } from '../../contracts/pos';
import type { NoticeTables } from '../iteration7/notices/types';
import type { EnvironmentTables } from '../iteration7/environment/types';
import type { CustomTemplate, CustomOrder, PickupReservation } from '../iteration7/custom-orders/types';
import type { StaffTables } from '../iteration7/staff/types';

/** DATA_MODEL 10.13 unit codes (single definition in src/i18n/types.ts; type-only import). */
export type { UnitCode };

export type TextParams = Readonly<Record<string, string | number>>;
/**
 * A display text: a message key (+ params, + `keyParams` whose values are message keys to translate first)
 * or raw text the owner typed (never translated). Resolve with `resolveDataText`.
 */
export type DataText =
  | { readonly key: string; readonly params?: TextParams; readonly keyParams?: Readonly<Record<string, string>> }
  | { readonly raw: string };

export type ExpenseCategory = 'ingredients' | 'operations' | 'supplies' | 'labor' | 'rent' | 'other';
export type Evidence = 'receipt' | 'tax-invoice' | 'card' | 'none';
export type Channel = 'store' | 'online';
export type DemandBand = 'morning' | 'afternoon' | 'evening';
export type CalendarSource = 'pickup' | 'delivery' | 'reservation' | 'shift' | 'deadline' | 'direct';
export type ManualCategory = 'opening' | 'closing' | 'recipe' | 'cleaning' | 'new-staff' | 'hygiene' | 'store-info';
export type Zone = 'window' | 'center' | 'bar';
export type Mood = 'warm-wood' | 'bright-white' | 'calm-gray';
export type Material = 'wood' | 'gray' | 'tile' | 'plant';
export type LocalChangeKind = 'opening' | 'closing' | 'event' | 'construction' | 'traffic';

export interface DailySales { readonly recognizedNet?: number; readonly businessDate: string; readonly gross: number; readonly discount: number; readonly refund: number; readonly card: number; readonly cash: number; readonly easyPay: number }
export interface MenuItem { readonly prepMin?: number; readonly saleStatus?: 'selling' | 'sold_out'; readonly photoKey?: PosMenuPhotoKey | null; readonly customPhotoUrl?: PosMenuPhotoDataUrl | null; readonly optionGroups?: readonly PosOptionGroup[]; readonly kind?: 'menu' | 'retail'; readonly sku?: string; readonly itemId?: string; readonly name?: DataText; readonly category?: 'drink' | 'dessert' | 'retail'; readonly memo?: DataText | null; readonly deletedAt?: string; readonly menuId: string; readonly nameKey: string; readonly price: number; readonly categoryKey: string; readonly recipe: readonly RecipePart[]; readonly costEffectiveFrom: string }
export interface RecipePart { readonly nameKey: string; readonly qty: number; readonly unit: UnitCode; readonly cost: number }
/** plan-2 (T-058): menu options with a cost only (샷 추가 원가 300, Q-41). */
export interface MenuOption { readonly optionId: string; readonly nameKey: string; readonly cost: number }
export interface MenuDaily { readonly totalCost?: number; readonly businessDate: string; readonly menuId: string; readonly qty: number; readonly netSales: number; readonly unitCost: number | null }
export interface Expense { readonly expenseId: string; readonly businessDate: string; readonly category: ExpenseCategory; readonly amount: number; readonly supplierId: string | null; readonly receiptId: string | null; readonly evidence: Evidence; readonly status: 'candidate' | 'confirmed' | 'canceled'; readonly memo: DataText | null }
export interface TaxReview { readonly refType: 'expense'; readonly refId: string; readonly status: 'needs-check' | 'checked' }
export interface GrantNotice { readonly template?: DataText; readonly guide?: DataText; readonly noticeId: string; readonly titleKey: string; readonly agencyKey: string; readonly regionKey: string; readonly applyStart: string; readonly applyEnd: string; readonly conditionKeys: readonly string[]; readonly summaryKey: string; readonly matchStatus: 'matched' | 'needs-check' }
export interface GrantReview { readonly noticeId: string; readonly reviewStatus: 'before' | 'reviewed' }
export interface CctvHourly { readonly dwellMinutes?: number; readonly provenance?: 'sample'; readonly businessDate: string; readonly hour: number; readonly entries: number | null; readonly status: 'ok' | 'partial' | 'none'; readonly reviewMarked: boolean }
export interface Shift { readonly shiftId: string; readonly staffKey: string; readonly date: string; readonly start: string; readonly end: string; readonly source: 'roster' }
export interface DemandForecast { readonly targetDate: string; readonly band: DemandBand; readonly expected: number; readonly baseline: number; readonly adjWeather: number; readonly adjEvent: number }
export interface DemandDay { readonly targetDate: string; readonly busyStart: number; readonly busyEnd: number; readonly weatherKey: string; readonly eventKey: string | null }
export interface DemandActual { readonly date: string; readonly total: number }
/** plan-2 (T-058): 1-hour forecast and the same weekday/hour average of the last 4 weeks; band sums equal `demandForecast`. */
export interface DemandHourly { readonly targetDate: string; readonly hour: number; readonly expected: number; readonly average: number }
export interface HiringLoad { readonly weekday: number; readonly hour: number; readonly level: number }
export interface JobPostDraft { readonly days: readonly number[]; readonly start: string; readonly end: string; readonly tasks: readonly DataText[]; readonly hourlyWage: number; readonly contact: DataText; readonly status: 'draft' | 'copied' }
export interface MembershipProduct { readonly productId: string; readonly nameKey: string; readonly kind: 'count' | 'period'; readonly uses: number | null; readonly validDays: number; readonly dailyLimit: number | null; readonly price: number }
export interface Membership { readonly customerId?: string; readonly membershipId: string; readonly customerKey: string; readonly productId: string; readonly startsOn: string; readonly endsOn: string; readonly usesLeft: number | null; readonly status: 'active' | 'ended' | 'refunded' | 'paused' }
export interface MembershipUse { readonly useId: string; readonly membershipId: string; readonly usedAt: string; readonly canceledAt: string | null }
export type ReservationStatus = 'needs-check' | 'confirmed' | 'proposed' | 'canceled' | 'no-show' | 'completed';
export interface Reservation { readonly kind?: 'visit'; readonly memberId?: string; readonly guestName?: DataText; readonly phone?: DataText; readonly request?: DataText | null; readonly tableId?: string | null; readonly assignmentMode?: 'auto' | 'manual'; readonly allocationWarning?: string; readonly capacityOverride?: boolean; readonly reservationId: string; readonly date: string; readonly time: string; readonly partySize: number; readonly nameKey: string; readonly requestKey: string | null; readonly source: 'phone_ai' | 'direct'; readonly status: ReservationStatus; readonly confirmedBy: 'auto' | 'person' | null; readonly callId: string | null; readonly proposedTime: string | null; readonly variant: string | null }
export interface CallLog { readonly callId: string; readonly time: string; readonly summary: DataText; readonly extracted: { readonly date: string; readonly time: string; readonly party: number; readonly requestKey: string | null }; readonly status: 'processed' | 'needs-contact' | 'contacted'; readonly variant: string | null }
export interface CalendarEvent { readonly revision?: number; readonly storeClosure?: { readonly kind: 'regular' | 'temporary'; readonly endDate: string } | null; readonly categoryId?: CalendarCategory; readonly eventId: string; readonly kind: 'event' | 'todo'; readonly title: DataText; readonly date: string; readonly time: string | null; readonly memo: DataText | null }
export type CalendarVisibility = Readonly<Record<Exclude<CalendarSource, 'pickup'>, boolean>> & { readonly pickup?: boolean };
export interface InventoryItem { readonly sku?: string; readonly name?: DataText; readonly deletedAt?: string; readonly itemId: string; readonly nameKey: string; readonly kind: 'ingredient' | 'retail'; readonly unit: UnitCode; readonly restockThreshold: number | null; readonly trackRestock: boolean; readonly lowStockPerChannel: number | null; readonly sales7d: Readonly<Record<Channel, number>> | null; readonly updatedAt: string; /** plan-2 (T-058): sold out by its expiry date (크루아상, 오늘까지). */ readonly trackExpiry: boolean; readonly expiresOn: string | null }
export interface InventoryStock { readonly itemId: string; readonly channel: Channel; readonly qty: number | null }
export interface InventoryTxn { readonly txnId: string; readonly itemId: string; readonly type: 'receive' | 'move' | 'adjust'; readonly qty: number; readonly channel: Channel; readonly ref: string | null; readonly idempotencyKey: string | null; readonly at: string }
export interface Supplier { readonly name?: DataText; readonly contact?: DataText; readonly phone?: string; readonly memo?: DataText | null; readonly deletedAt?: string; readonly supplierId: string; readonly nameKey: string; readonly phoneMask: string; readonly contactKey: string }
export interface PurchaseOrder { readonly orderedOn?: string; readonly poId: string; readonly supplierId: string; readonly dueDate: string | null; readonly expectedTime: string | null; readonly status: 'scheduled' | 'partial' | 'complete' | 'canceled'; readonly variant: string | null }
export interface PurchaseOrderLine { readonly basePerUnit?: number; readonly itemNameSnapshot?: DataText; readonly unitSnapshot?: UnitCode; readonly polId: string; readonly poId: string; readonly itemId: string; readonly qtyOrdered: number; readonly unitPrice: number }
export interface Receipt { readonly seq?: number; readonly receiptId: string; readonly polId: string; readonly qty: number; readonly receivedAt: string; readonly idempotencyKey: string | null }
export interface Manual { readonly section?: 'handover' | 'store-info'; readonly cautions?: DataText;  readonly manualId: string; readonly title: DataText; readonly category: ManualCategory; readonly isPublished: boolean; readonly updatedAt: string }
export interface ManualStep { readonly photoKey?: string; readonly manualId: string; readonly stepNo: number; readonly body: DataText }
export interface ChecklistLog { readonly date: string; readonly manualId: string; readonly stepNo: number }
export interface ManualDraft { readonly section?: 'handover' | 'store-info'; readonly cautions?: DataText; readonly draftId: string; readonly memo: string; readonly title: DataText; readonly category: ManualCategory; readonly steps: readonly DataText[]; readonly status: 'draft' | 'saved' }
export interface FloorSpace { readonly photoKeys: readonly string[]; readonly planGenerated: boolean }
export interface FloorLayout { readonly layoutId: string; readonly name: DataText; readonly isCurrent: boolean; readonly aisleCm: number }
export interface TableSpot { readonly tableId: string; readonly layoutId: string; readonly zone: Zone; readonly seats: number }
export interface InteriorPlan { readonly mood: Mood; readonly materials: readonly Material[]; readonly memo: DataText | null }
export interface LocalChange { readonly changeId: string; readonly kind: LocalChangeKind; readonly titleKey: string; readonly whenKey: string; readonly startDate: string; readonly endDate: string | null; readonly distanceM: number; readonly sameCategory: boolean; readonly sourceKey: string; readonly updatedAt: string; readonly ackedAt: string | null }
export interface FootTraffic { readonly hour: number; readonly estPeople: number }
export interface TrendKeyword { readonly keywordId: string; readonly keywordKey: string; readonly categoryKey: string; readonly mentions: number; readonly prevMentions: number | null }
export type ThreadStatus = 'waiting' | 'draft-ready' | 'send-failed' | 'done';
// N17 keeps saved drafts and their source evidence on the thread.
export interface ReplyDraft {
  readonly body: string;
  readonly sourceText: string;
  readonly grounding: readonly string[];
  readonly revision: number;
  readonly origin: 'generated' | 'edited';
}
// End N17 draft evidence.
export interface InquiryThread { readonly threadId: string; readonly type: 'message' | 'review' | 'call'; readonly channelKey: string; readonly isPublic: boolean; readonly receivedAt: string; readonly status: ThreadStatus; readonly needsPersonReason: 'refund' | 'complaint' | 'privacy' | 'no-ground' | null; readonly bodyKey: string; readonly draftKey: string | null; readonly groundKeys: readonly string[]; readonly rating: number | null; /** plan-2 (T-058, D-64): review classification; null for messages and calls. */ readonly sentiment: 'positive' | 'negative' | 'neutral' | null ; /** plan-2 AC-318 follow-up: full fake reviewer name (reviews only); screens show only the masked form from the model. */ readonly author?: string | null; readonly replyDraft?: ReplyDraft; readonly sentReplyBody?: string }
export interface AutoReplyRule { readonly channelKey: string; readonly topic: 'hours' | 'location' | 'parking'; readonly enabled: boolean }
export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
export interface PartnershipOffer { readonly offerId: string; readonly fromStoreKey: string; readonly visibility: 'direct' | 'public'; readonly titleKey: string; readonly categoryKey: string; readonly termsKey: string; readonly periodStart: string; readonly periodEnd: string; readonly respondBy: string; readonly status: OfferStatus; readonly sharedContactKey: string | null }
export interface OfferInterest { readonly offerId: string; readonly sentAt: string }
export interface Integration { readonly calendar: boolean; readonly phone: boolean; readonly pos: boolean; readonly channels: boolean }
export interface AppliedKey { readonly command: string; readonly result: unknown }

export interface DataTables extends ManagementTables, StaffTables, NoticeTables, EnvironmentTables {
  readonly customTemplate: readonly CustomTemplate[];
  readonly customOrder: readonly CustomOrder[];
  readonly dailySales: readonly DailySales[];
  readonly menuItem: readonly MenuItem[];
  readonly menuDaily: readonly MenuDaily[];
  readonly menuOption: readonly MenuOption[];
  readonly expense: readonly Expense[];
  readonly taxReview: readonly TaxReview[];
  readonly grantNotice: readonly GrantNotice[];
  readonly grantReview: readonly GrantReview[];
  readonly cctvHourly: readonly CctvHourly[];
  readonly shift: readonly Shift[];
  readonly demandForecast: readonly DemandForecast[];
  readonly demandDay: readonly DemandDay[];
  readonly demandActual: readonly DemandActual[];
  readonly demandHourly: readonly DemandHourly[];
  readonly hiringLoad: readonly HiringLoad[];
  readonly jobPostDraft: JobPostDraft | null;
  readonly membershipProduct: readonly MembershipProduct[];
  readonly membership: readonly Membership[];
  readonly membershipUse: readonly MembershipUse[];
  readonly reservation: readonly (Reservation | PickupReservation)[];
  readonly callLog: readonly CallLog[];
  readonly calendarEvent: readonly CalendarEvent[];
  readonly calendarSettings: CalendarVisibility;
  readonly inventoryItem: readonly InventoryItem[];
  readonly inventoryStock: readonly InventoryStock[];
  readonly inventoryTxn: readonly InventoryTxn[];
  readonly supplier: readonly Supplier[];
  readonly purchaseOrder: readonly PurchaseOrder[];
  readonly purchaseOrderLine: readonly PurchaseOrderLine[];
  readonly receipt: readonly Receipt[];
  readonly manual: readonly Manual[];
  readonly manualStep: readonly ManualStep[];
  readonly checklistLog: readonly ChecklistLog[];
  readonly manualDraft: readonly ManualDraft[];
  readonly floorSpace: FloorSpace;
  readonly floorLayout: readonly FloorLayout[];
  readonly tableSpot: readonly TableSpot[];
  readonly interiorPlan: InteriorPlan;
  readonly localChange: readonly LocalChange[];
  readonly footTraffic: readonly FootTraffic[];
  readonly trendKeyword: readonly TrendKeyword[];
  readonly inquiryThread: readonly InquiryThread[];
  readonly autoReplyRule: readonly AutoReplyRule[];
  readonly partnershipOffer: readonly PartnershipOffer[];
  readonly offerInterest: readonly OfferInterest[];
  readonly integration: Integration;
  /** plan-2 marketing tables in the same snapshot (one coupon source, T-058). */
  readonly marketing: MarketingTables;
  /** idempotency key → first result (ADR-0003). */
  readonly appliedKeys: Readonly<Record<string, AppliedKey>>;
}

/** Immutable snapshot; a new object for every successful change. */
export interface DataSnapshot { readonly pos?: PosState; readonly runId?: string; readonly transactionId?: string;
  readonly revision: number;
  /** Deterministic id counter for rows created by commands. */
  readonly seq: number;
  readonly tables: DataTables;
}

/** Test/dev overrides: replace whole tables of the seed. */
export type SeedOverrides = Partial<DataTables>;
