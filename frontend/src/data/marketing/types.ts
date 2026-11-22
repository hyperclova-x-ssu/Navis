/**
 * plan-2 marketing tables, models and commands (DATA_MODEL 10.15, API-09 v4.1). The tables live in
 * the same store snapshot as the plan-1 tables (`DataTables.marketing`) so there is one coupon source.
 * Names follow `team/plan-2/data.md` (Q-32) in camelCase. POS paid bills add coupon use in M3 (Q-264).
 */
import type { DetailRef } from '../../contracts';
import type { DataText, UnitCode } from '../db/types';
import type { Delta, Period } from '../models/types';
import type { PROMO_REFERENCE_IDS } from '../../../shared/promo-references.mjs';

/* ───────────── 표 (DATA_MODEL 10.15.2) ───────────── */
export type CouponRoute = 'place_news' | 'blog' | 'clip' | 'sms';
export type BenefitType = 'free_item' | 'percent' | 'amount' | 'set_price';
export type CouponStatus = 'active' | 'paused' | 'ended';
export type CouponOrigin = 'slot' | 'expiry' | 'video' | 'group' | 'manual';
export type VideoMood = 'warm' | 'clean' | 'lively' | 'elegant';
export type VideoConcept = 'review-roundup' | 'behind-the-scenes' | 'todays-deal' | 'new-item' | 'day-at-shop';
/** Design reference ids of the real pipeline (DATA_MODEL 10.16.5; replaces the old two templates). */
export type PromoReferenceId = typeof PROMO_REFERENCE_IDS[number];
export type PromoLocale = 'ko' | 'en' | 'zh-Hans' | 'zh-Hant';
export type PromoStage = 'look' | 'story' | 'scenes' | 'merge';
export type PromoStageState = 'active' | 'done' | 'failed';
/** The 10 failure codes of ARCHITECTURE 12.6 (LOCALES 9.4 ‘실패 이유 10종’). */
export type PromoFailReason = 'AI_UNAVAILABLE' | 'AI_TIMEOUT' | 'AI_BAD_OUTPUT' | 'CAPTION_TOO_LONG' | 'RENDER_FAILED' | 'ENCODE_FAILED' | 'CODE_CHECK_FAILED' | 'TOOL_MISSING' | 'BUSY' | 'CANCELLED_BY_RESTART';
/** Where the owner says the video was posted; every one of them counts as the `clip` coupon route. */
export type VideoPostRoute = 'clip' | 'reels' | 'shorts';
export type SlotBenefitId = 'free-shot' | 'percent-10' | 'amount-500';
/** The ordinary benefit every sell-today coupon gives (정률 할인 · 금액 할인 · 세트 가격). Stored as `benefitType` + `benefitValue` (`set_price`), see `benefit.ts`. */
export type CouponBenefitKind = 'percent' | 'amount' | 'setPrice';
export interface CouponBenefit { readonly kind: CouponBenefitKind; readonly value: number }

export interface ValidHours { readonly weekday: number; readonly startHour: number; readonly endHour: number }
export interface Coupon {
  readonly couponId: string;
  /** Message key (+ params / keyParams); created coupons get their name from the day's benefit and time. */
  readonly name: DataText;
  readonly benefitType: BenefitType;
  /** Percent, won, or set price; 0 for a free item (`targetMenuId` names it). */
  readonly benefitValue: number;
  readonly targetMenuId: string | null;
  readonly validHours: readonly ValidHours[] | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: CouponStatus;
  readonly origin: CouponOrigin;
  /** Evidence: slot ids (slot), item id (expiry), video id (video). The benefit lives only in `benefitType` + `benefitValue`. */
  readonly originRef: { readonly slotIds?: readonly string[]; readonly itemId?: string; readonly videoId?: string } | null;
  readonly maxDiscountRate: number | null;
  readonly createdAt: string;
  /** D-326: limit for future issue activity, separate from prior code issue counts. */
  readonly futureIssueCount?: number;
}
// D-326 protects the value and original expiry of already issued codes.
export type IssuedCouponTerms = Pick<Coupon, 'benefitType' | 'benefitValue' | 'targetMenuId' | 'endsOn'>;
export interface CouponCode {
  readonly codeId: string;
  readonly couponId: string;
  readonly code: string;
  readonly route: CouponRoute;
  /** Text: one per recipient. Public posts: the issue limit chosen when posting (10 by default, Q-41). */
  readonly issueCount: number;
  readonly videoId: string | null;
  /** Public posts count only after ‘올렸어요’; texts are active when sent. */
  readonly activatedAt: string | null;
  readonly issuedTerms?: IssuedCouponTerms;
  readonly unpublishedAt?: string;
}
export type TargetReason = 'slot-regular' | 'regular' | 'churn-risk';
export interface CouponTarget { readonly couponId: string; readonly codeId: string; readonly customerId: string; readonly reason: TargetReason; readonly sendId: string }
export interface MessageSend {
  readonly sendId: string;
  readonly customerId: string;
  readonly couponId: string;
  readonly kind: 'coupon' | 'reminder';
  /** The text body without the fixed ‘(광고)’ head and opt-out tail; owner edits are raw text. */
  readonly body: DataText;
  readonly scheduledAt: string;
  readonly isNight: boolean;
  /** Always `mock`: nothing is really sent. */
  readonly status: 'mock';
  readonly idempotencyKey: string;
}
export interface CouponReminder { readonly reminderId: string; readonly couponId: string; readonly sentAt: string; readonly recipients: number; readonly idempotencyKey: string }
/** Fixed usage per code (Q-35): the mockup never creates uses. */
export interface CouponRedemptionAgg { readonly codeId: string; readonly used: number; readonly discountSum: number }
export interface PerfFixed { readonly period: 'this-month' | 'last-month'; readonly revenueCoupon: number; readonly revenueAttributed: number; readonly cost: number; readonly discount: number; readonly returnRate: number | null }
/** Last month's route table is a fixed sample (Q-36). */
export interface PerfRouteFixed { readonly period: 'last-month'; readonly route: CouponRoute; readonly issued: number; readonly used: number }
export interface MktCustomer { readonly maskedName?: string; readonly phoneLast4?: string; readonly name?: string; readonly phone?: string; readonly deletedAt?: string; readonly customerId: string; readonly maskKey: string; readonly consentSms: boolean; readonly consentNight: boolean; readonly variant: string | null }
/** Card-based visit: one per customer per business day. */
export interface MktVisit { readonly customerId: string; readonly businessDate: string; readonly hour: number; readonly posContribution?: boolean }
export interface SegmentRule { readonly businessType: string; readonly regularVisits: number; readonly regularDays: number; readonly churnGapDays: number }
/** `promo_store` (one row, catalog values; `sourceId` is the photo source of the catalog these tables came from). */
export interface PromoStoreRow { readonly name: string; readonly location: string; readonly exteriorPhotoId?: string; readonly exteriorUrl?: string; readonly sourceId: string }
export interface PromoMenuRow { readonly menuId: string; readonly names: Readonly<Record<PromoLocale, string>>; readonly order: number }
export interface PromoPhotoRow { readonly photoId: string; readonly menuId: string; readonly url: string; readonly width: number; readonly height: number; readonly order: number }
/** `promo_video.input` (DATA_MODEL 10.16.2): fixed at accept time, a retry reuses it unchanged. */
export interface PromoVideoInput {
  readonly menuIds: readonly string[];
  readonly photoIds: readonly string[];
  readonly moods: readonly VideoMood[];
  readonly concepts: readonly VideoConcept[];
  readonly memo: string;
  readonly referenceId: PromoReferenceId;
  readonly lengthSec: 10 | 15 | 30;
  readonly locale: PromoLocale;
}
export interface PromoVideoResult {
  readonly durationSec: number;
  readonly music: { readonly trackId: string; readonly title: string; readonly artist: string; readonly licenseLabel: string };
  readonly fileUrl: string;
  readonly posterUrl?: string;
  readonly sizeBytes: number;
  readonly madeAt: string;
}
export type PromoVideoStatus = 'making' | 'done' | 'failed' | 'posted';
export interface PromoPublicationProjection {
  readonly channel: 'place-news' | VideoPostRoute;
  readonly link: string | null;
}
export interface PromoVideo {
  readonly videoId: string;
  readonly jobId: string | null;
  readonly input: PromoVideoInput;
  readonly status: PromoVideoStatus;
  readonly stage: PromoStage | null;
  readonly stageState: PromoStageState | null;
  readonly lookCount: number | null;
  readonly failReason: PromoFailReason | null;
  readonly result: PromoVideoResult | null;
  readonly postedRoute: VideoPostRoute | null;
  readonly publication?: PromoPublicationProjection;
  readonly postedAt: string | null;
  readonly createdAt: string;
  readonly retryCount: number;
}
/** API-20 response (the catalog the browser tables are synced from). */
export interface PromoCatalogInput {
  readonly sourceId: string;
  readonly store: { readonly name: string; readonly location: string; readonly exteriorPhotoId: string; readonly exteriorUrl: string };
  readonly menus: readonly { readonly menuId: string; readonly names: Readonly<Record<PromoLocale, string>>; readonly photoIds: readonly string[] }[];
  readonly photos: readonly { readonly photoId: string; readonly menuId: string | null; readonly url: string; readonly width: number; readonly height: number }[];
}
export interface ExpiryForecast { readonly quantityExpiring?: number; readonly itemId: string; readonly menuId: string; readonly expectedSalesUntilClose: number }

export interface MarketingTables {
  readonly coupon: readonly Coupon[];
  readonly couponCode: readonly CouponCode[];
  readonly couponTarget: readonly CouponTarget[];
  readonly messageSend: readonly MessageSend[];
  readonly couponReminder: readonly CouponReminder[];
  readonly couponRedemptionAgg: readonly CouponRedemptionAgg[];
  readonly couponUsageBeforeMonth?: Readonly<Record<string, number>>;
  readonly perfFixed: readonly PerfFixed[];
  readonly perfRouteFixed: readonly PerfRouteFixed[];
  readonly mktCustomer: readonly MktCustomer[];
  readonly mktVisit: readonly MktVisit[];
  readonly slotConsentSampleVisits?: readonly MktVisit[];
  readonly segmentRule: readonly SegmentRule[];
  readonly promoDrafts?: readonly (typeof import('../db/generated/supplement').seedSupplement.promos)[number][];
  readonly promoStore: readonly PromoStoreRow[];
  readonly promoMenu: readonly PromoMenuRow[];
  readonly promoPhoto: readonly PromoPhotoRow[];
  readonly promoVideo: readonly PromoVideo[];
  readonly expiryForecast: readonly ExpiryForecast[];
}

/* ───────────── 모델 (DATA_MODEL 10.15.3) ───────────── */
export interface HourValue { readonly hour: number; readonly expected: number; readonly average: number; readonly percent: number }
export interface QuietSlot {
  /** `slot-{date}-{startHour}` */
  readonly slotId: string;
  readonly date: string;
  /** 1 = Monday … 7 = Sunday */
  readonly weekday: number;
  readonly startHour: number;
  readonly endHour: number;
  /** Sum of the demand model's 1-hour values in the slot (same numbers as 손님예측). */
  readonly expected: number;
  readonly average: number;
  /** expected ÷ average, `roundPercent` */
  readonly percent: number;
  readonly hours: readonly HourValue[];
  /** A slot coupon was already sent for it. */
  readonly handled: boolean;
  /** Customers with marketing consent who came ≥ 2 times in this weekday/hours in the last 4 weeks. */
  readonly regularIds: readonly string[];
}
export interface SlotRecipient {
  readonly customerId: string;
  /** The one display alias of this customer (`customerAlias`): the same text the 회원 views show. */
  readonly name: DataText;
  readonly consentSms: boolean;
  readonly consentNight: boolean;
  /** False for customers without marketing consent (shown with the reason, never selected). */
  readonly selectable: boolean;
  readonly reasonKey: string | null;
  readonly slotIds: readonly string[];
  readonly lastVisit: string | null;
}
export interface BenefitOption {
  readonly id: SlotBenefitId;
  readonly type: BenefitType;
  readonly value: number;
  readonly name: DataText;
  /** Won kept per coupon on the base menu (price − discount − menu cost − extra cost). */
  readonly marginPerCoupon: number;
  readonly recommended: boolean;
}
export interface BenefitComparison {
  readonly options: readonly BenefitOption[];
  readonly recommendedId: SlotBenefitId;
  /** How much more the recommended benefit keeps than the next best (“200원 더 남아요”). */
  readonly differenceVsNext: number;
}
export interface CouponRouteRow { readonly codeId: string; readonly code: string; readonly route: CouponRoute; readonly routeNameKey: string; readonly issued: number; readonly used: number; readonly active: boolean; readonly videoId: string | null }
export interface CouponRow {
  readonly couponId: string;
  readonly name: DataText;
  readonly status: CouponStatus;
  readonly origin: CouponOrigin;
  readonly benefitType: BenefitType;
  readonly benefitValue: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly daysLeft: number;
  /** Active and ending within 3 days. */
  readonly endingSoon: boolean;
  /** Activated codes only. */
  readonly issued: number;
  /** null only in the `partial` sample state (missing usage data). */
  readonly used: number | null;
  readonly routes: readonly CouponRouteRow[];
  /** Customers an ending reminder reaches: the coupon's text targets who still consent (`reminderAudience`). 0 blocks the reminder. */
  readonly reminderRecipients: number;
  readonly canNotify: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canExtend: boolean;
}
export interface SlotCouponModel {
  /** The slot window: tomorrow and the six days after it (10-27~11-02). It is not a calendar week, so no label calls it ‘다음 주’. */
  readonly window: Period;
  readonly thresholdPercent: number;
  /** Every quiet slot of the window, handled ones included. */
  readonly slots: readonly QuietSlot[];
  /** Quiet slots without a coupon yet (panel “3칸”). */
  readonly openSlots: readonly QuietSlot[];
  readonly slotCount: number;
  /** Selectable recipients over the open slots (panel “맞춤 단골 5명”). */
  readonly regularsCount: number;
  readonly recipients: readonly SlotRecipient[];
  readonly menu: { readonly menuId: string; readonly nameKey: string; readonly name?: DataText; readonly price: number; readonly unitCost: number; readonly shotCost: number };
  readonly benefits: BenefitComparison;
  readonly message: { readonly body: DataText; readonly bodies: Readonly<Record<SlotBenefitId, DataText>> };
  readonly endsOn: string;
  readonly sent: readonly CouponRow[];
  readonly canSend: boolean;
}
export interface ExpiryDiscount {
  readonly rate: number;
  readonly price: number;
  readonly discountedPrice: number;
  readonly marginEach: number;
  readonly qty: number;
  readonly ifAllSold: number;
  readonly lossIfDiscarded: number;
  /** 1 − cost ÷ price as a percent with one decimal (65.7). */
  readonly maxRatePercent: number;
  /** Integer slider limit (65). */
  readonly maxSliderRate: number;
  readonly withinLimit: boolean;
}
export interface ExpiryItem {
  readonly itemId: string;
  readonly lotId?: string;
  readonly name?: DataText;
  readonly menuName?: string;
  readonly issueLimit?: number;
  readonly nameKey: string;
  readonly unit: UnitCode;
  readonly stock: number;
  /** Left to sell today: stock − expected sales until close. */
  readonly qty: number;
  readonly expiresOn: string;
  readonly menuId: string;
  readonly price: number;
  /** null in the `partial` sample state (cost needs checking). */
  readonly unitCost: number | null;
  readonly maxRatePercent: number | null;
  readonly maxSliderRate: number | null;
  readonly recommendedRate: number | null;
  readonly atRecommended: ExpiryDiscount | null;
  /** A sell-today coupon was already made for it today. */
  readonly handled: boolean;
}
export interface ExpiryCouponModel {
  readonly items: readonly ExpiryItem[];
  readonly target: ExpiryItem | null;
  readonly routes: { readonly sms: { readonly recipients: number }; readonly placeNews: { readonly issueLimit: number } };
  readonly secondDiscountHoursBeforeClose: number;
  readonly created: readonly CouponRow[];
  /** Public-post codes waiting for ‘올렸어요’. */
  readonly pendingPosts: readonly { readonly codeId: string; readonly couponId: string; readonly code: string; readonly route: CouponRoute; readonly post: DataText }[];
  readonly canCreate: boolean;
}
export interface PromoMenuModel { readonly menuId: string; readonly name: DataText; readonly names: Readonly<Record<PromoLocale, string>>; readonly photos: readonly PromoPhotoRow[]; readonly hasPhotos: boolean }
export type PromoWidgetState = 'before' | 'making' | 'done' | 'failed' | 'posted' | 'few-photos';
export interface PromoCurrent {
  readonly videoId: string;
  readonly jobId: string | null;
  readonly status: PromoVideoStatus;
  readonly stage: PromoStage | null;
  readonly stageState: PromoStageState | null;
  readonly lookCount: number | null;
  readonly lengthSec: number;
  readonly photoCount: number;
  readonly failReason: PromoFailReason | null;
  readonly result: PromoVideoResult | null;
  readonly retryCount: number;
}
export interface PromoVideoModel {
  /** = `photoCount`: widget “재료 {n}개”, 2×1 “사진 {n}장”, today's “리뷰 사진 {n}장” all read this one number (AC-324). */
  readonly materialsCount: number;
  readonly praiseCount: number;
  readonly photoCount: number;
  readonly canMake: boolean;
  readonly minPhotos: number;
  readonly menus: readonly PromoMenuModel[];
  /** First menu that has photos (2×1 “사진 {n}장 준비됨 · {menu}”). */
  readonly firstMenu: PromoMenuModel | null;
  readonly store: PromoStoreRow | null;
  readonly state: PromoWidgetState;
  readonly current: PromoCurrent | null;
  readonly postedCount: number;
  readonly lastPostedRoute: VideoPostRoute | null;
  readonly lastPublication?: PromoPublicationProjection;
  /** The clip route adds “· 쿠폰 코드 세는 중” after the place. */
  readonly lastPostedCounting: boolean;
  readonly moods: readonly VideoMood[];
  readonly concepts: readonly VideoConcept[];
  readonly postRoutes: readonly VideoPostRoute[];
  readonly videos: readonly PromoVideoRowModel[];
}
export interface PromoVideoRowModel extends PromoCurrent { readonly input: PromoVideoInput; readonly postedRoute: VideoPostRoute | null; readonly postedAt: string | null; readonly createdAt: string; readonly publication?: PromoPublicationProjection }
export interface CouponStatusModel {
  /** Coupons that are running right now (status ‘active’). Paused coupons are in `rows` but are counted in `pausedCount`. */
  readonly activeCount: number;
  /** Paused coupons: still listed so they can be resumed, never part of the running count. */
  readonly pausedCount: number;
  readonly endingSoonCount: number;
  /** Running and paused coupons, end date ascending. */
  readonly rows: readonly CouponRow[];
  /** Ended this month. */
  readonly ended: readonly CouponRow[];
  readonly runningUsed: number;
  readonly runningIssued: number;
  readonly endedUsed: number | null;
  readonly endedIssued: number;
  /** runningUsed + endedUsed (28); null when part of the data is missing. */
  readonly monthUsed: number | null;
  readonly monthIssued: number;
}
export type CustomerGroupId = 'churn-risk' | 'first-visit' | 'regular';
export interface GroupCustomer {
  readonly customerId: string;
  readonly memberCode?: string;
  /** The one display alias of this customer (`customerAlias`): the same text the 회원 views show. */
  readonly name: DataText;
  readonly visitCount: number;
  readonly lastVisit: string;
  readonly daysSinceLast: number;
  /** Average days between visits; null with a single visit. */
  readonly usualCycleDays: number | null;
  readonly consentSms: boolean;
  readonly selectable: boolean;
  readonly reasonKey: string | null;
}
export interface CustomerGroupsModel {
  readonly rule: { readonly businessType: string; readonly regularVisits: number; readonly regularDays: number; readonly churnGapDays: number };
  readonly groups: readonly { readonly id: CustomerGroupId; readonly nameKey: string; readonly count: number; readonly customers: readonly GroupCustomer[] }[];
  readonly counts: Readonly<Record<CustomerGroupId, number>>;
  /** Customers who may leave, oldest last visit first. */
  readonly churnRisk: readonly GroupCustomer[];
  readonly reachOut: { readonly recipientIds: readonly string[]; readonly blockedIds: readonly string[]; readonly count: number };
  readonly basisKey: string;
  readonly sent: readonly CouponRow[];
  readonly canReachOut: boolean;
  /** REAL-PLAN F19: present only when the model came from B19's HTTP reads. */
  readonly real?: import('../reality/19/model').RealGroupsInfo;
}
/** One coupon code behind a route row: the same records (activated in the period, ended coupons included) that add up to the route's issued and used. */
export interface PerfRouteLine { readonly codeId: string; readonly couponId: string; readonly name: DataText; readonly status: CouponStatus; readonly issued: number; readonly used: number }
export interface PerfRouteRow {
  readonly route: CouponRoute; readonly nameKey: string; readonly issued: number; readonly used: number; readonly rate: number | null;
  /** Per-code lines of this route; their sums equal `issued` and `used`. Empty for last month (a fixed sample with no coupon records). */
  readonly lines: readonly PerfRouteLine[];
}
export interface MarketingPerformanceModel {
  readonly period: Period;
  readonly periodKind: 'this-month' | 'last-month';
  readonly issued: number;
  readonly used: number;
  readonly rate: number | null;
  readonly rateDelta: Delta | null;
  readonly revenue: { readonly total: number; readonly coupon: number; readonly attributed: number };
  readonly revenueDelta: Delta | null;
  /** The widget's comparison uses only coupon-code payments. */
  readonly couponRevenueDelta?: Delta | null;
  readonly cost: number;
  readonly discount: number;
  /** revenue − cost − discount */
  readonly profit: number;
  readonly returnRate: number | null;
  readonly returnRateDelta: Delta | null;
  readonly routes: readonly PerfRouteRow[];
  readonly missingRoutes: readonly CouponRoute[];
  readonly best: PerfRouteRow | null;
  readonly byCoupon: readonly { readonly couponId: string; readonly name: DataText; readonly status: CouponStatus; readonly issued: number; readonly used: number; readonly rate: number | null }[];
  readonly byVideo: readonly { readonly videoId: string; readonly couponId: string | null; readonly postedRoute: VideoPostRoute | null; readonly issued: number; readonly used: number; readonly rate: number | null; readonly publication?: PromoPublicationProjection }[];
  /** Fixed insight (Q-36): best route vs regular texts. */
  readonly insight: { readonly bestRoute: CouponRoute; readonly compareRoute: CouponRoute } | null;
  /** Coupons issued today (for “방금 보낸 쿠폰 {n}장이 발행에 더해졌어요”). */
  readonly recentIssued: number;
  readonly basisKey: string;
  /** REAL-PLAN F19: present only when the model came from B19's HTTP reads (coupon figures may be "not available yet", channel cards carry source and period). */
  readonly real?: import('../reality/19/model').RealPerformanceInfo;
}
export type TodayCell =
  | { readonly slot: 'now'; readonly kind: 'quiet-hours'; readonly sourceFeatureId: 'slot-coupon'; readonly params: { readonly regulars: number }; readonly quietSlot: { readonly slotId: string; readonly date: string; readonly weekday: number; readonly startHour: number; readonly endHour: number }; readonly ref: DetailRef }
  | { readonly slot: 'now'; readonly kind: 'expiry'; readonly sourceFeatureId: 'expiry-coupon'; readonly params: { readonly count: number }; readonly itemNameKey: string; /** HTTP: the lot's own item name (`itemNameKey` is then empty). */ readonly itemName?: string; readonly ref: DetailRef }
  | { readonly slot: 'today'; readonly kind: 'replies'; readonly sourceFeatureId: 'ai-response'; readonly params: { readonly count: number; readonly drafted?: number }; readonly ref: DetailRef }
  | { readonly slot: 'week'; readonly kind: 'video'; readonly sourceFeatureId: 'promo-video'; readonly params: { readonly photos: number }; readonly ref: DetailRef };
export interface MarketingTodayModel {
  /** Remaining cells in order (지금 · 오늘 · 이번 주); handled cells are folded away. */
  readonly cells: readonly TodayCell[];
  readonly folded: readonly ('now' | 'today' | 'week')[];
  /** Panel tap target: the first visible cell's detail (DetailRef without focus). */
  readonly tapTarget: DetailRef;
  /** REAL-PLAN F19 (HTTP): sources the service could not read yet. A missing source never reads as "nothing to do". */
  readonly missing?: readonly ('coupons' | 'replies' | 'assets')[];
}

export interface MarketingModelMap {
  'marketing-today': MarketingTodayModel;
  'slot-coupon': SlotCouponModel;
  'expiry-coupon': ExpiryCouponModel;
  'promo-video': PromoVideoModel;
  'coupon-status': CouponStatusModel;
  'customer-groups': CustomerGroupsModel;
  'marketing-performance': MarketingPerformanceModel;
}

/* ───────────── 명령 (DATA_MODEL 10.15.4) ───────────── */
export type MarketingCommand =
  | { readonly type: 'coupon.sendSlot'; readonly slotIds: readonly string[]; readonly recipientIds: readonly string[]; readonly benefit: SlotBenefitId; readonly messageEdits?: string; readonly sendAt?: string; readonly idempotencyKey: string }
  | { readonly type: 'coupon.createExpiry'; readonly itemId: string; readonly benefit: CouponBenefit; readonly route: 'sms' | 'place_news'; readonly idempotencyKey: string }
  | { readonly type: 'coupon.markPosted'; readonly codeId: string; readonly idempotencyKey: string }
  | { readonly type: 'coupon.sendReachOut'; readonly recipientIds: readonly string[]; readonly messageEdits?: string; readonly idempotencyKey: string }
  | { readonly type: 'coupon.notifyEnding'; readonly couponId: string; readonly idempotencyKey: string }
  | { readonly type: 'coupon.pause'; readonly couponId: string }
  | { readonly type: 'coupon.resume'; readonly couponId: string }
  | { readonly type: 'coupon.extend'; readonly couponId: string }
  // D-326 coupon lifecycle.
  | { readonly type: 'coupon.update'; readonly couponId: string; readonly benefitValue?: number; readonly quantity?: number; readonly idempotencyKey: string }
  | { readonly type: 'coupon.endEarly'; readonly couponId: string; readonly idempotencyKey: string }
  | { readonly type: 'coupon.unpublish'; readonly codeId: string; readonly idempotencyKey: string }
  // End D-326.
  | { readonly type: 'promo.syncCatalog'; readonly catalog: PromoCatalogInput }
  | { readonly type: 'video.make'; readonly input: PromoVideoInput; readonly idempotencyKey: string }
  | { readonly type: 'video.attachJob'; readonly videoId: string; readonly jobId: string }
  | { readonly type: 'video.progress'; readonly videoId: string; readonly stage: PromoStage; readonly stageState: PromoStageState; readonly lookCount?: number }
  | { readonly type: 'video.settle'; readonly videoId: string; readonly outcome: { readonly kind: 'done'; readonly result: PromoVideoResult } | { readonly kind: 'failed'; readonly reason: PromoFailReason } }
  | { readonly type: 'video.retry'; readonly videoId: string; readonly idempotencyKey: string }
  | { readonly type: 'video.save'; readonly videoId: string }
  | { readonly type: 'video.markPosted'; readonly videoId: string; readonly route: VideoPostRoute; readonly idempotencyKey: string };
export type MarketingCommandType = MarketingCommand['type'];
