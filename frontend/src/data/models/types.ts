/**
 * Widget models (DATA_MODEL 10.10) and the API-09 v4 view types. Models hold numbers, unit codes,
 * ISO dates and message keys / DataText — never formatted strings. Widgets format with the i18n
 * formatters and translate keys with their translator (`resolveDataText` for DataText).
 */
import type { DetailRef, FeatureId, QueryCondition } from '../../contracts';
import type { DataWidgetId } from '../conditions';
import type { MarketingModelMap } from '../marketing/types';
import type {
  CalendarSource, CalendarVisibility, Channel, DataText, DemandBand, Evidence, ExpenseCategory, LocalChangeKind, ManualCategory, Material, Mood,
  OfferStatus, ReservationStatus, ThreadStatus, UnitCode, Zone,
} from '../db/types';

/** contracts `DetailRef` (API-13). */
export type DataDetailRef = DetailRef;

export interface StateNote { readonly messageKey: string; readonly params?: Readonly<Record<string, string | number>> }
export type WidgetView<M, F extends string = FeatureId> =
  | { readonly status: 'ready'; readonly featureId: F; readonly condition: QueryCondition; readonly variant: string; readonly model: M; readonly notes?: readonly StateNote[] }
  | { readonly status: 'empty'; readonly featureId: F; readonly variant: string; readonly messageKey: string; readonly actionKey?: string; readonly partial?: Partial<M> }
  | { readonly status: 'error'; readonly featureId: F; readonly variant: string; readonly messageKey: string };

/** Signed change for `format.delta(value, kind, unit)`; `value` is already rounded for display. */
export interface Delta { readonly value: number; readonly kind: 'percent' | 'pp' | 'count'; readonly unit?: UnitCode }
export interface Period { readonly start: string; readonly end: string }
export interface Quantity { readonly value: number; readonly unit: UnitCode }

/* 돈 */
export interface LedgerExpenseRow { readonly expenseId: string; readonly date: string; readonly category: ExpenseCategory; readonly categoryKey: string; readonly amount: number; readonly supplierId: string | null; readonly supplierNameKey: string | null; readonly evidence: Evidence; readonly evidenceKey: string; readonly status: 'candidate' | 'confirmed'; readonly memo: DataText | null; readonly receiptId: string | null }
export interface LedgerTrendPoint { readonly date: string; readonly net: number; readonly expenses: number; readonly netProfit: number }
export interface LedgerModel { readonly netProfit?: number; readonly profitRate?: number | null;
  readonly period: Period;
  readonly sales: { readonly net: number; readonly gross: number; readonly discount: number; readonly refund: number; readonly byMethod: { readonly card: number; readonly cash: number; readonly easyPay: number };
    /** REAL-PLAN F09-2: over HTTP, `false` when the finance service sent no `sales.byMethod` (the rows are then hidden, never shown as zeros). Absent in fixture data. */
    readonly byMethodKnown?: boolean };
  /** Today: same weekday last week. Ranges: the previous period of the same length (null when data is missing). */
  readonly comparison: { readonly base: Period; readonly baseNet: number; readonly delta: Delta } | null;
  readonly expenses: { readonly total: number; readonly byCategory: readonly { readonly category: ExpenseCategory; readonly categoryKey: string; readonly amount: number }[]; readonly items: readonly LedgerExpenseRow[] };
  /** Expense candidates from deliveries (not in the totals until confirmed). */
  readonly candidates: readonly LedgerExpenseRow[];
  /** net sales − confirmed expenses; null only in the `no-expenses` sample state. */
  readonly remaining: number | null;
  /** Daily net sales; 7 days ending at the period end (or the whole range when longer). */
  readonly trend: readonly LedgerTrendPoint[];
  /** Daily values for precisely the selected period. */
  readonly periodTrend: readonly LedgerTrendPoint[];
  readonly missingEvidenceCount: number;
}
export interface MarginMenuRow { readonly name: DataText; readonly unitMargin: number | null; readonly contribution: number | null; readonly menuId: string; readonly nameKey: string; readonly categoryKey: string; readonly price: number; readonly unitCost: number | null; readonly qty: number; readonly netSales: number; readonly cost: number | null; readonly grossProfit: number | null; readonly rate: number | null; readonly costMissing: boolean; readonly recipe: readonly { readonly nameKey: string; /** The ingredient's own name: over HTTP it is raw text and `nameKey` only a placeholder. */ readonly name?: DataText; readonly qty: Quantity; readonly cost: number }[]; readonly costEffectiveFrom: string }
export interface MarginModel {
  readonly period: Period;
  readonly netSales: number;
  readonly cost: number | null;
  readonly grossProfit: number | null;
  /** Gross margin % rounded to one decimal; null = “계산 불가”/“원가 확인 필요”. */
  readonly rate: number | null;
  readonly comparison: { readonly base: Period; readonly baseRate: number; readonly delta: Delta } | null;
  readonly trend: readonly { readonly date: string; readonly netSales: number; readonly cost: number; readonly rate: number | null }[];
  /** Sorted by margin rate ascending (default sort), cost-missing rows first. */
  readonly menus: readonly MarginMenuRow[];
  readonly costMissing: boolean;
}
export interface TaxItemRow { readonly refType: 'expense'; readonly refId: string; readonly date: string; readonly category: ExpenseCategory; readonly categoryKey: string; readonly amount: number; readonly memo: DataText | null; readonly status: 'needs-check' | 'checked'; readonly reasonKey: string }
export interface TaxModel { readonly payments: ReturnType<typeof import('../derive/operations').selectTaxPayments>;
  readonly real?: import('../reality/18/dto').TaxExportPreviewDto;
  readonly today?: string;
  /** null = no period selected (`missing-data` sample state). */
  readonly period: Period | null;
  readonly connections: readonly { readonly source: 'sales' | 'expenses' | 'evidence'; readonly sourceKey: string; readonly status: 'connected' | 'partial' | 'missing'; readonly statusKey: string }[];
  readonly items: readonly TaxItemRow[];
  readonly reviewCount: number;
  /** Shown only when every item is checked. */
  readonly estimate: { readonly amount: number; readonly basisDate: string; readonly assumptionKey: string } | null;
  readonly exportPreview: { readonly salesTotal: number; readonly expenseTotal: number; readonly withEvidence: number; readonly missingEvidence: number; readonly cashReceipts: { readonly count: number; readonly amount: number } | null };
}
export interface GrantRow { readonly noticeId: string; readonly titleKey: string; readonly agencyKey: string; readonly regionKey: string; readonly applyStart: string; readonly applyEnd: string; readonly applyEndDate: string; readonly applyEndTime: string; readonly daysLeft: number; readonly conditionKeys: readonly string[]; readonly summaryKey: string; readonly matchStatus: 'matched' | 'needs-check'; readonly reviewStatus: 'before' | 'reviewed'; readonly isCandidate: boolean }
export interface GrantsModel { readonly applications: readonly (import('../db/management-types').GrantApplication & { readonly title: DataText })[]; readonly inProgressCount: number; readonly candidateCount: number; readonly notices: readonly GrantRow[]; readonly sourceKey: string }

/* 손님 */
export interface CctvHourRow { readonly hour: number; readonly visits: number | null; readonly status: 'ok' | 'partial' | 'none'; readonly staff: number | null; readonly reviewMarked: boolean }
export interface CustomerAnalysisModel { readonly cameras: ReturnType<typeof import('../derive/operations').selectCameras>; readonly date: string; readonly coverage: { readonly startHour: number; readonly endHour: number }; readonly totalVisits: number; readonly hours: readonly CctvHourRow[]; readonly peak: CctvHourRow | null; readonly gapHours: readonly number[]; readonly trend: readonly { readonly date: string; readonly visits: number }[]; readonly staffSourceKey: string | null }
/** plan-2 (T-058): 1-hour expected vs the same weekday/hour 4-week average; `percent` = roundPercent(expected ÷ average). */
export interface DemandHourRow { readonly hour: number; readonly band: DemandBand; readonly expected: number; readonly average: number; readonly percent: number; readonly belowUsual: boolean }
export interface DemandDayRow { readonly date: string; readonly expected: number; readonly bands: readonly { readonly band: DemandBand; readonly bandKey: string; readonly expected: number }[]; readonly busy: { readonly startHour: number; readonly endHour: number }; readonly basis: { readonly baseline: number; readonly weather: number; readonly event: number; readonly weatherKey: string; readonly eventKey: string | null }; readonly lastWeek: { readonly date: string; readonly actual: number; readonly delta: Delta } | null; /** plan-2: empty when the day has no hourly forecast. */ readonly hourly: readonly DemandHourRow[] }
export interface DemandModel {
  readonly view: 'day' | 'week';
  /** The day shown on the panel (tomorrow by default). */
  readonly day: DemandDayRow;
  readonly days: readonly DemandDayRow[];
  readonly suggestions: readonly { readonly targetFeatureId: FeatureId; readonly messageKey: string; readonly params: Readonly<Record<string, number>> }[];
  readonly history: readonly { readonly date: string; readonly forecast: number; readonly actual: number }[];
  readonly basisKey: string;
  /** plan-2 (T-058): hourly rows of every forecast day (10-26 … 11-01) whatever the view, for the date picker and slot-coupon. */
  readonly hourly: readonly { readonly date: string; readonly hours: readonly DemandHourRow[] }[];
  /** ‘평소의 60% 미만’ */
  readonly quietThresholdPercent: number;
}
export interface MembershipRow { readonly membershipId: string; readonly customerKey: string; readonly productId: string; readonly productNameKey: string; readonly kind: 'count' | 'period'; readonly startsOn: string; readonly endsOn: string; readonly usesLeft: number | null; readonly lastUsedAt: string | null; readonly endingThisWeek: boolean; readonly endingSoon: boolean; readonly canUse: boolean }
export interface MembershipsModel {
  readonly activeCount: number;
  readonly byProduct: readonly { readonly productId: string; readonly nameKey: string; readonly kind: 'count' | 'period'; readonly uses: number | null; readonly validDays: number; readonly dailyLimit: number | null; readonly price: number; readonly activeCount: number }[];
  readonly endingThisWeekCount: number;
  readonly endingThisWeek: readonly MembershipRow[];
  readonly endingSoon: readonly MembershipRow[];
  /** Active memberships sorted by end date. */
  readonly memberships: readonly MembershipRow[];
  readonly uses: readonly { readonly useId: string; readonly membershipId: string; readonly customerKey: string; readonly productNameKey: string; readonly usedAt: string; readonly canceledAt: string | null; readonly cancelable: boolean }[];
  readonly month: { readonly sold: number; readonly soldAmount: number; readonly used: number };
}
export interface ReservationRow { readonly reservationId: string; readonly date: string; readonly time: string; readonly partySize: number; readonly nameKey: string; readonly requestKey: string | null; readonly source: 'phone_ai' | 'direct'; readonly status: ReservationStatus; readonly confirmedBy: 'auto' | 'person' | null; readonly callId: string | null; readonly proposedTime: string | null; readonly overSeats: boolean; readonly counts: boolean; readonly canConfirm: boolean; readonly canPropose: boolean; readonly canMarkNoShow: boolean }
export interface VoiceBookingModel { readonly pickupCount:number; readonly tomorrowPickupCount:number;
  readonly date: string;
  readonly todayCount: number;
  readonly needsCheckCount: number;
  readonly seats: number;
  readonly slots: readonly { readonly time: string; readonly count: number; readonly people: number; readonly seatsFree: number }[];
  readonly reservations: readonly ReservationRow[];
  readonly calls: readonly { readonly callId: string; readonly time: string; readonly summary: DataText; readonly extracted: { readonly date: string; readonly time: string; readonly party: number; readonly requestKey: string | null }; readonly reservationId: string | null }[];
  readonly connected: boolean;
}

/* 운영 */
export interface CalendarEntry { readonly sourceFeatureId?: FeatureId; readonly categoryId: import('../db/management-types').CalendarCategory; readonly id: string; readonly source: CalendarSource; readonly sourceId: string; readonly kind: 'event' | 'todo'; readonly date: string; readonly time: string | null; readonly title: DataText; readonly memo: DataText | null; readonly ref: DataDetailRef | null; readonly editable: boolean }
export interface CalendarModel {
  readonly pickupEntries: readonly CalendarEntry[]; readonly pickupCount: number; readonly tomorrowPickupCount: number;
  /** Staff/off detail rows are separate from the single daily handoff summary. */
  readonly staffEntries: readonly CalendarEntry[];
  readonly today: string;
  readonly week: Period;
  readonly month: { readonly month: string; readonly gridStart: string; readonly gridEnd: string };
  readonly todayEntries: readonly CalendarEntry[];
  readonly todayCount: number;
  readonly weekEntries: readonly CalendarEntry[];
  readonly weekCount: number;
  readonly monthEntries: readonly CalendarEntry[];
  /** Entries from now (15:00) on, in order — for “다가오는 일정”. */
  readonly upcoming: readonly CalendarEntry[];
  readonly visibility: CalendarVisibility;
  readonly connected: boolean;
}
export interface IncomingDelivery { readonly poId: string; readonly polId: string; readonly date: string | null; readonly time: string | null; readonly remaining: Quantity; readonly supplierNameKey: string }
export interface IngredientRow {
  readonly name?: DataText;
  readonly sku?: string;
  readonly raw: number;
  readonly display: number;
  readonly deficit: number;
  readonly usedToday: number;
  readonly expectedUsageRemaining: number;
  readonly projectedRaw: number;
  readonly projectedDeficit: number;
  readonly usingMenus: ReturnType<typeof import('../derive/stock').deriveStock>['rows'][number]['usingMenus'];
  readonly itemId: string;
  readonly nameKey: string;
  readonly unit: UnitCode;
  readonly stock: number | null;
  readonly threshold: number | null;
  readonly trackRestock: boolean;
  readonly needsRestock: boolean;
  readonly outOfStock: boolean;
  readonly needsReview: boolean;
  readonly updatedAt: string;
  readonly nextDelivery: IncomingDelivery | null;
  /** plan-2 (T-058): ‘당일 소진 · 오늘까지’ row (크루아상). */
  readonly trackExpiry: boolean;
  readonly expiresOn: string | null;
}
export interface ProductRow { readonly itemId: string; readonly nameKey: string; readonly unit: UnitCode; readonly store: number; readonly online: number; readonly total: number; readonly lowThreshold: number; readonly lowChannels: readonly Channel[]; readonly sales7d: { readonly store: number; readonly online: number; readonly total: number } }
export interface InventoryModel {
  readonly asOf: string;
  readonly restockCount: number;
  readonly outOfStockCount: number;
  /** Out of stock first, then stock÷threshold ascending, then name key. Untracked/needs-review rows last. */
  readonly ingredients: readonly IngredientRow[];
  readonly restockItems: readonly IngredientRow[];
  readonly reviewCount: number;
  readonly products: { readonly total: number; readonly byChannel: { readonly store: number; readonly online: number }; readonly items: readonly ProductRow[]; readonly lowCount: number };
}
export interface OrderLineRow { readonly polId: string; readonly itemId: string; readonly itemNameKey: string; readonly unit: UnitCode; readonly ordered: number; readonly received: number; readonly remaining: number; readonly unitPrice: number }
export interface OrderRow { readonly poId: string; readonly supplierId: string; readonly supplierNameKey: string; readonly phoneMask: string; readonly contactKey: string; readonly dueDate: string | null; readonly expectedTime: string | null; readonly status: 'scheduled' | 'partial' | 'complete' | 'canceled'; readonly overdue: boolean; readonly lines: readonly OrderLineRow[] }
export interface SuppliersModel { readonly suggestions: ReturnType<typeof import('../derive/stock').deriveSuggestions>; readonly monthCount: number; readonly monthTotal: number; readonly purchaseItems: import('../db/types').DataTables['purchaseItem'];
  readonly window: Period;
  readonly upcomingCount: number;
  readonly overdueCount: number;
  readonly undatedCount: number;
  /** Due date ascending, then order id. */
  readonly upcoming: readonly OrderRow[];
  readonly overdue: readonly OrderRow[];
  readonly undated: readonly OrderRow[];
  readonly past: readonly OrderRow[];
  readonly orders: readonly OrderRow[];
  readonly suppliers: readonly Omit<import('../db/types').Supplier, 'phone'>[];
}
export interface HiringDraftFields { readonly days: readonly number[]; readonly start: string; readonly end: string; readonly tasks: readonly DataText[]; readonly hourlyWage: number; readonly contact: DataText }
export interface HiringModel {
  readonly basisWeeks: number;
  readonly basis: Period;
  readonly helpHours: { readonly weekdays: readonly number[]; readonly startHour: number; readonly endHour: number; readonly level: number } | null;
  readonly grid: readonly { readonly weekday: number; readonly hour: number; readonly level: number }[];
  readonly weekdayLevels: readonly { readonly weekday: number; readonly level: number }[];
  readonly staffOnHelpHours: number | null;
  /** Roster staff per hour (8–21시) for this week's dates that have shifts. */
  readonly roster: readonly { readonly date: string; readonly hour: number; readonly staff: number }[];
  readonly draft: (HiringDraftFields & { readonly status: 'draft' | 'copied' }) | null;
  readonly draftStatus: 'none' | 'draft' | 'copied';
  /** Prefill for “공고 초안 만들기”. */
  readonly suggestion: HiringDraftFields;
  readonly minimumWage: number;
}
export interface ManualRow { readonly body: DataText | null; readonly section: 'handover' | 'store-info'; readonly cautions: DataText;  readonly manualId: string; readonly title: DataText; readonly category: ManualCategory; readonly categoryKey: string; readonly updatedAt: string; readonly checklist: boolean; readonly steps: readonly { readonly stepNo: number; readonly body: DataText; readonly checkedToday: boolean }[] }
export interface ManualsModel { readonly storeInfoCount: number; readonly storeInfo: readonly ManualRow[];
  readonly publishedCount: number;
  readonly byCategory: readonly { readonly category: ManualCategory; readonly categoryKey: string; readonly count: number }[];
  readonly manuals: readonly ManualRow[];
  readonly recent: readonly ManualRow[];
  readonly todayChecklist: readonly { readonly manualId: string; readonly title: DataText; readonly done: number; readonly total: number }[];
  readonly drafts: readonly { readonly draftId: string; readonly memo: string; readonly title: DataText; readonly category: ManualCategory; readonly steps: readonly DataText[] }[];
}
export interface InteriorModel { readonly mood: Mood; readonly moodKey: string; readonly materials: readonly { readonly id: Material; readonly nameKey: string }[]; readonly memo: DataText | null; readonly previewAssetKey: string; readonly moods: readonly { readonly id: Mood; readonly nameKey: string; readonly assetKey: string }[]; readonly materialOptions: readonly { readonly id: Material; readonly nameKey: string }[]; readonly photoKeys: readonly string[] }
export interface LayoutRow { readonly layoutId: string; readonly name: DataText; readonly isCurrent: boolean; readonly aisleCm: number; readonly aisleWarning: boolean; readonly tableCount: number; readonly seatCount: number; readonly zones: readonly { readonly zone: Zone; readonly nameKey: string; readonly tables: number; readonly seats: number }[] }
export interface FloorPlanModel { readonly current: LayoutRow; readonly layouts: readonly LayoutRow[]; readonly tableCount: number; readonly seatCount: number; readonly zones: LayoutRow['zones']; readonly photoKeys: readonly string[]; readonly planGenerated: boolean; readonly aisleMinCm: number; readonly noteKey: string; readonly posConnected: boolean }

/* 마케팅 */
export interface LocalChangeRow { readonly changeId: string; readonly kind: LocalChangeKind; readonly kindKey: string; readonly titleKey: string; readonly whenKey: string; readonly startDate: string; readonly endDate: string | null; readonly distanceM: number; readonly sameCategory: boolean; readonly sourceKey: string; readonly updatedAt: string; readonly acked: boolean; readonly ackedAt: string | null; readonly inDemandForecast: boolean }
export interface LocalChangesModel { readonly week: Period; readonly count: number; readonly changes: readonly LocalChangeRow[]; readonly openChanges: readonly LocalChangeRow[]; readonly foldedCount: number; readonly radiusM: number }
export interface TradeAreaModel { readonly regionKey: string; readonly periodKey: string; readonly sourceKey: string; readonly updatedAt: string; readonly peak: { readonly hour: number; readonly people: number }; readonly top: readonly { readonly hour: number; readonly people: number }[]; readonly hours: readonly { readonly hour: number; readonly people: number }[] }
export interface KeywordRow { readonly keywordId: string; readonly keywordKey: string; readonly categoryKey: string; readonly mentions: number; readonly previous: number | null; readonly changePercent: number | null; readonly notable: boolean; readonly noComparison: boolean }
export interface LocalTrendsModel { readonly period: Period; readonly previousPeriod: Period; readonly regionKey: string; readonly sourceKey: string; readonly updatedAt: string; readonly notableCount: number; readonly notable: readonly KeywordRow[]; readonly keywords: readonly KeywordRow[] }
export interface ThreadRow { readonly threadId: string; readonly type: 'message' | 'review' | 'call'; readonly channelKey: string; readonly isPublic: boolean; readonly receivedAt: string; readonly status: ThreadStatus; readonly needsPersonReason: string | null; readonly needsPersonKey: string | null; readonly body: DataText; readonly draft: DataText | null; readonly groundKeys: readonly string[]; readonly rating: number | null; readonly waiting: boolean; /** plan-2 (T-058): review classification (positive·negative·neutral), null for messages. */ readonly sentiment: 'positive' | 'negative' | 'neutral' | null; /** AC-318: the reviewer's first letter + '**' (null for messages and unnamed); the full name never leaves the data layer. */ readonly authorMasked: string | null }
export interface AiResponseModel {
  readonly shopGuidance: { readonly closures: readonly import('../iteration7/notices').StoreClosure[]; readonly manuals: readonly { readonly title: DataText; readonly body: DataText | null }[] };
  readonly waitingCount: number;
  readonly byType: { readonly message: number; readonly review: number; readonly call: number };
  readonly byChannel: readonly { readonly channelKey: string; readonly count: number }[];
  /** Waiting items: needs-person first, then oldest first. */
  readonly priority: readonly ThreadRow[];
  readonly threads: readonly ThreadRow[];
  readonly autoReply: readonly { readonly channelKey: string; readonly topicKey: string; readonly enabled: boolean }[];
  readonly connected: boolean;
  /** plan-2 (T-058): reviews classified positive (칭찬 리뷰), answered or not — replying never changes it. */
  readonly praiseCount: number;
  /**
   * HTTP only: visible NAVER reviews and TalkTalk consultations that wait for a reply and are not in the queue yet. They are counted in `waitingCount`,
   * `byType` and `byChannel` (one rule for the panel, the window header and the list) but are not threads: `threads` and `priority` stay the service's records.
   */
  readonly imports?: readonly ImportRow[];
}
/** A visible NAVER item waiting for a reply that the owner can take into the queue (one press, `inquiry.import`). */
export interface ImportRow {
  readonly importId: string;
  readonly source: 'review' | 'talktalk';
  readonly providerRef: string;
  readonly type: 'message' | 'review';
  readonly channelKey: string;
  readonly text: string | null;
  readonly stars: number | null;
}
export interface OfferRow { readonly offerId: string; readonly fromStoreKey: string; readonly visibility: 'direct' | 'public'; readonly titleKey: string; readonly categoryKey: string; readonly termsKey: string; readonly period: Period; readonly respondBy: string; readonly status: OfferStatus; readonly sharedContactKey: string | null; readonly interestSent: boolean }
export interface CommunityModel { readonly pendingCount: number; readonly received: readonly OfferRow[]; readonly pending: readonly OfferRow[]; readonly publicOffers: readonly OfferRow[]; readonly inProgress: readonly OfferRow[] }

/* 소식 */
export interface BriefingItem { readonly featureId: DataWidgetId; readonly tier: 'today' | 'loss' | 'good'; readonly value: number; readonly unit: UnitCode; readonly messageKey: string; readonly params: Readonly<Record<string, number>>; readonly hint: DataText | null; readonly ref: DataDetailRef }
export interface BriefingModel extends ReturnType<typeof import('../derive/operations').selectBriefing> {
  /** Up to 3 arrival items in priority order; sources with value 0 are skipped. */
  readonly arrival: readonly BriefingItem[];
  readonly closing: { readonly netSales: number; readonly remaining: number | null; };
  readonly yesterday: { readonly date: string; readonly netSales: number; readonly delta: Delta | null };
  /** REAL-PLAN F12: present only over HTTP: the service's business day, acknowledgement and per-source state/period (alerts of a withheld source are already dropped). */
  readonly real?: import('../reality/12/overlay').BriefingRealView;
}

export interface ModelMap extends MarketingModelMap {
  readonly 'credit-receivable': ReturnType<typeof import('../iteration7/accounts').selectMemberAccounts>;
  'notice-send': import('../iteration7/notices').NoticesModel;
  'store-environment': import('../iteration7/environment').StoreEnvironmentModel;
  'custom-order': import('../iteration7/custom-orders').CustomOrdersModel;
  'staff-schedule': import('../iteration7/staff/types').StaffScheduleModel;
  menu: import('../derive/menu').MenuModel; members: ReturnType<typeof import('../derive/members').selectMembers>;
  briefing: BriefingModel; ledger: LedgerModel; margin: MarginModel; tax: TaxModel; grants: GrantsModel;
  'customer-analysis': CustomerAnalysisModel; demand: DemandModel; memberships: MembershipsModel; 'voice-booking': VoiceBookingModel;
  calendar: CalendarModel; 'inventory-booking': InventoryModel; hiring: HiringModel; suppliers: SuppliersModel; manuals: ManualsModel; interior: InteriorModel; 'floor-plan': FloorPlanModel;
  'local-changes': LocalChangesModel; 'trade-area': TradeAreaModel; 'local-trends': LocalTrendsModel; 'ai-response': AiResponseModel; community: CommunityModel;
}
/** Model type of a widget (`never` for ids outside the 28). */
export type ModelOf<F extends string> = F extends keyof ModelMap ? ModelMap[F] : never;

/** Reads another widget's normal-variant ready model from the same snapshot (memoized). */
export type ModelReader = <F extends keyof ModelMap>(id: F) => ModelMap[F];
