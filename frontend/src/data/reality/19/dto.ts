/**
 * F19 · wire types of B19's owner-only reads (`backend/services/marketing/reality/19/README.md`) and the `realGroups` table the adapter fills.
 * Parsing is strict about shapes the screens rely on and says `BAD_RESPONSE` for anything else; it never invents a number.
 */
import { PortError } from '../00';

export const GROUP_IDS = ['churn-risk', 'first-visit', 'regular'] as const;
export type GroupId = typeof GROUP_IDS[number];

export interface GroupCustomerDto {
  readonly memberId: string;
  readonly customerId: string;
  /** One masked initial (`김○○`), or null when the service holds none. Never a full name or contact. */
  readonly displayName: string | null;
  readonly groupId: GroupId | null;
  readonly visitCount: number;
  readonly recentVisits: number;
  readonly firstVisitOn: string;
  readonly lastVisitOn: string;
  readonly daysSinceLast: number;
  readonly usualCycleDays: number | null;
  readonly contactAllowed: boolean;
  readonly marketingAllowed: boolean;
  readonly selectable: boolean;
  readonly blockedReason: 'NO_MARKETING_CONSENT' | null;
}

export interface GroupsDto {
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly businessDate: string;
  readonly state: 'ready' | 'empty';
  readonly rule: { readonly businessType: string; readonly regularVisits: number; readonly regularDays: number; readonly churnGapDays: number };
  readonly counts: Readonly<Record<GroupId, number>>;
  readonly reachOut: { readonly groupId: 'churn-risk'; readonly recipientIds: readonly string[]; readonly blockedIds: readonly string[]; readonly count: number };
  readonly coverage: { readonly activeMembers: number; readonly visitedMembers: number; readonly ungroupedMembers: number; readonly pendingMembers: number };
}

export interface PeriodDto { readonly from: string; readonly to: string }
export interface CouponLineDto { readonly codeId: string; readonly couponId: string; readonly name: string; readonly status: 'active' | 'paused' | 'ended'; readonly issued: number; readonly used: number }
export interface CouponOutcomeDto {
  readonly issued: number;
  readonly used: number;
  readonly rate: number | null;
  readonly payment: {
    readonly paidAmount: number; readonly discount: number; readonly cost: number | null; readonly knownCost: number; readonly profit: number | null;
    readonly costIncomplete: boolean; readonly settlements: number; readonly pendingSettlements: number;
  };
  readonly repeat: { readonly windowDays: number; readonly matured: number; readonly returned: number; readonly immature: number; readonly unlinked: number; readonly rate: number | null };
  readonly routes: readonly { readonly route: string; readonly issued: number; readonly used: number; readonly rate: number | null; readonly lines: readonly CouponLineDto[] }[];
  readonly byCoupon: readonly { readonly couponId: string; readonly name: string; readonly status: 'active' | 'paused' | 'ended'; readonly issued: number; readonly used: number; readonly rate: number | null; readonly paidAmount: number }[];
}
export interface PerformanceDto {
  readonly asOf: string;
  readonly sourceRevision: number;
  readonly businessDate: string;
  readonly period: PeriodDto & { readonly kind: 'this-month' | 'last-month' | 'custom' };
  readonly state: 'ready' | 'empty' | 'partial';
  readonly missing: readonly string[];
  /** null = the coupon ledger could not be read (not zero). */
  readonly coupons: CouponOutcomeDto | null;
  readonly comparison: { readonly period: PeriodDto; readonly issued: number; readonly used: number; readonly rate: number | null } | null;
  readonly rateDelta: number | null;
}

export type ReportChannel = 'place' | 'blog' | 'clip' | 'search-ads';
export interface ReportPeriodDto { readonly startDate: string; readonly endDate: string }
export interface ChannelCardDto { readonly metric: string; readonly value: number; readonly changeRate?: number; readonly period?: ReportPeriodDto }
export interface ChannelItemDto { readonly channel: ReportChannel; readonly state: 'ready' | 'unavailable'; readonly source: string; readonly period: ReportPeriodDto | null; readonly cards: readonly ChannelCardDto[] }
export interface ChannelReportsDto { readonly asOf: string; readonly businessDate: string; readonly items: readonly ChannelItemDto[] }

export type TodaySource = 'coupons' | 'replies' | 'assets';
export interface TodayRefDto { readonly featureId: string; readonly view?: string; readonly itemId?: string; readonly focus?: 'action' }
export type TodayCellDto =
  | { readonly slot: 'now'; readonly kind: 'quiet-hours'; readonly sourceFeatureId: 'slot-coupon'; readonly params: { readonly regulars: number };
    readonly quietSlot: { readonly slotId: string; readonly date: string; readonly weekday: number; readonly startHour: number; readonly endHour: number }; readonly ref: TodayRefDto }
  | { readonly slot: 'now'; readonly kind: 'expiry'; readonly sourceFeatureId: 'expiry-coupon'; readonly params: { readonly count: number; readonly itemName: string }; readonly ref: TodayRefDto }
  | { readonly slot: 'today'; readonly kind: 'replies'; readonly sourceFeatureId: 'ai-response'; readonly params: { readonly count: number; readonly drafted: number }; readonly ref: TodayRefDto }
  | { readonly slot: 'week'; readonly kind: 'video'; readonly sourceFeatureId: 'promo-video'; readonly params: { readonly photos: number }; readonly ref: TodayRefDto };
export interface RecommendationsDto {
  readonly asOf: string;
  readonly businessDate: string;
  readonly state: 'ready' | 'empty' | 'partial';
  readonly missing: readonly TodaySource[];
  readonly cells: readonly TodayCellDto[];
  readonly folded: readonly ('now' | 'today' | 'week')[];
  readonly tapTarget: { readonly featureId: string; readonly view?: string } | null;
}

export interface ReachOutCheckDto {
  readonly groupId: 'churn-risk';
  readonly eligibleIds: readonly string[];
  readonly blocked: readonly { readonly memberId: string; readonly reason: 'NOT_IN_GROUP' | 'NO_MARKETING_CONSENT' }[];
  readonly sourceRevision: number;
  readonly asOf: string;
}

/** The sections load (and fail) independently; a failed one is `null` here and named in `failed`, so its widget shows a retryable error while the others stay usable. */
export type GroupsSection = 'groups' | 'performance' | 'channels' | 'today';
export interface RealGroupsSnapshot {
  readonly storeId: string;
  readonly groups: GroupsDto | null;
  readonly customers: Readonly<Record<GroupId, readonly GroupCustomerDto[]>>;
  /** false when a page bound cut a group's list short. */
  readonly customersComplete: boolean;
  readonly performance: { readonly 'this-month': PerformanceDto | null; readonly 'last-month': PerformanceDto | null };
  readonly channels: ChannelReportsDto | null;
  readonly today: RecommendationsDto | null;
  readonly failed: readonly GroupsSection[];
}

/* ── strict parsing ────────────────────────────────────────────────────────────────────────────────────── */
const bad = (): never => { throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE'); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : bad());
const money = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) ? value : bad());
const nullable = <T,>(value: unknown, read: (value: unknown) => T): T | null => (value === null || value === undefined ? null : read(value));
const text = (value: unknown, max = 200): string => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : bad());
const flag = (value: unknown): boolean => (typeof value === 'boolean' ? value : bad());
const day = (value: unknown): string => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : bad());
const instant = (value: unknown): string => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : bad());
const rate = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : bad());
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : bad());
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : bad());
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => (allowed.includes(value as T) ? value as T : bad());
const hour = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 ? value : bad());

export function parseGroupCustomer(value: unknown): GroupCustomerDto {
  const row = record(value);
  return {
    memberId: text(row.memberId), customerId: text(row.customerId), displayName: nullable(row.displayName, v => text(v, 40)),
    groupId: nullable(row.groupId, v => oneOf(v, GROUP_IDS)), visitCount: count(row.visitCount), recentVisits: count(row.recentVisits),
    firstVisitOn: day(row.firstVisitOn), lastVisitOn: day(row.lastVisitOn), daysSinceLast: count(row.daysSinceLast),
    usualCycleDays: nullable(row.usualCycleDays, count), contactAllowed: flag(row.contactAllowed), marketingAllowed: flag(row.marketingAllowed),
    selectable: flag(row.selectable), blockedReason: nullable(row.blockedReason, v => oneOf(v, ['NO_MARKETING_CONSENT'] as const)),
  };
}

export function parseGroups(value: unknown): GroupsDto {
  const row = record(value), rule = record(row.rule), counts = record(row.counts), reach = record(row.reachOut), coverage = record(row.coverage);
  return {
    asOf: instant(row.asOf), sourceRevision: count(row.sourceRevision), businessDate: day(row.businessDate), state: oneOf(row.state, ['ready', 'empty'] as const),
    rule: { businessType: text(rule.businessType, 40), regularVisits: count(rule.regularVisits), regularDays: count(rule.regularDays), churnGapDays: count(rule.churnGapDays) },
    counts: { 'churn-risk': count(counts['churn-risk']), 'first-visit': count(counts['first-visit']), regular: count(counts.regular) },
    reachOut: { groupId: 'churn-risk', recipientIds: list(reach.recipientIds).map(id => text(id, 64)), blockedIds: list(reach.blockedIds).map(id => text(id, 64)), count: count(reach.count) },
    coverage: { activeMembers: count(coverage.activeMembers), visitedMembers: count(coverage.visitedMembers), ungroupedMembers: count(coverage.ungroupedMembers), pendingMembers: count(coverage.pendingMembers) },
  };
}

const period = (value: unknown): PeriodDto => { const row = record(value); return { from: day(row.from), to: day(row.to) }; };
const status = (value: unknown) => oneOf(value, ['active', 'paused', 'ended'] as const);

function parseOutcome(value: unknown): CouponOutcomeDto {
  const row = record(value), pay = record(row.payment), rep = record(row.repeat);
  return {
    issued: count(row.issued), used: count(row.used), rate: nullable(row.rate, rate),
    payment: {
      paidAmount: money(pay.paidAmount), discount: count(pay.discount), cost: nullable(pay.cost, money), knownCost: money(pay.knownCost), profit: nullable(pay.profit, money),
      costIncomplete: flag(pay.costIncomplete), settlements: count(pay.settlements), pendingSettlements: count(pay.pendingSettlements),
    },
    repeat: { windowDays: count(rep.windowDays), matured: count(rep.matured), returned: count(rep.returned), immature: count(rep.immature), unlinked: count(rep.unlinked), rate: nullable(rep.rate, rate) },
    routes: list(row.routes).map(item => {
      const route = record(item);
      return { route: text(route.route, 40), issued: count(route.issued), used: count(route.used), rate: nullable(route.rate, rate),
        lines: list(route.lines).map(line => { const l = record(line); return { codeId: text(l.codeId), couponId: text(l.couponId), name: text(l.name), status: status(l.status), issued: count(l.issued), used: count(l.used) }; }) };
    }),
    byCoupon: list(row.byCoupon).map(item => {
      const c = record(item);
      return { couponId: text(c.couponId), name: text(c.name), status: status(c.status), issued: count(c.issued), used: count(c.used), rate: nullable(c.rate, rate), paidAmount: money(c.paidAmount) };
    }),
  };
}

export function parsePerformance(value: unknown): PerformanceDto {
  const row = record(value), range = record(row.period);
  const coupons = nullable(row.coupons, parseOutcome);
  return {
    asOf: instant(row.asOf), sourceRevision: count(row.sourceRevision), businessDate: day(row.businessDate),
    period: { ...period(range), kind: oneOf(range.kind, ['this-month', 'last-month', 'custom'] as const) },
    state: oneOf(row.state, ['ready', 'empty', 'partial'] as const), missing: list(row.missing).map(item => text(item, 40)), coupons,
    comparison: nullable(row.comparison, v => { const c = record(v); return { period: period(c.period), issued: count(c.issued), used: count(c.used), rate: nullable(c.rate, rate) }; }),
    rateDelta: nullable(row.rateDelta, v => (typeof v === 'number' && Number.isFinite(v) ? v : bad())),
  };
}

const reportPeriod = (value: unknown): ReportPeriodDto => { const row = record(value); return { startDate: day(row.startDate), endDate: day(row.endDate) }; };
const NAVER_HOST = /(^|\.)naver\.com$/u;
/** The owner-screen source of a card must be an https NAVER address: anything else is shown as unavailable, never as a source. */
export function naverSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && NAVER_HOST.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

const validAdsSource = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://naver.github.io' && url.pathname === '/searchad-apidoc/'
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export function parseChannelReports(value: unknown, searchAds = false): ChannelReportsDto {
  const row = record(value);
  return {
    asOf: instant(row.asOf), businessDate: day(row.businessDate),
    items: list(row.items).map((item): ChannelItemDto => {
      const entry = record(item);
      const channel = oneOf(entry.channel, searchAds ? ['search-ads'] as const : ['place', 'blog', 'clip'] as const);
      const state = oneOf(entry.state, ['ready', 'unavailable', 'not-connected'] as const);
      const source = searchAds ? validAdsSource(entry.source) : naverSource(entry.source);
      if (state !== 'ready' || source === null) return { channel, state: 'unavailable', source: source ?? '', period: null, cards: [] };
      return {
        channel, state, source, period: nullable(entry.period, reportPeriod),
        cards: list(entry.cards).map(card => {
          const c = record(card);
          return { metric: text(c.metric, 60), value: count(c.value),
            ...(c.changeRate !== undefined ? { changeRate: typeof c.changeRate === 'number' && Number.isFinite(c.changeRate) ? c.changeRate : bad() } : {}),
            ...(c.period !== undefined ? { period: reportPeriod(c.period) } : {}) };
        }),
      };
    }),
  };
}

const ref = (value: unknown): TodayRefDto => {
  const row = record(value);
  return { featureId: text(row.featureId, 60), ...(row.view !== undefined ? { view: text(row.view, 60) } : {}), ...(row.itemId !== undefined ? { itemId: text(row.itemId, 160) } : {}),
    ...(row.focus === 'action' ? { focus: 'action' as const } : {}) };
};

export function parseRecommendations(value: unknown): RecommendationsDto {
  const row = record(value);
  const cells = list(row.cells).map((item): TodayCellDto => {
    const cell = record(item), params = record(cell.params);
    if (cell.slot === 'now' && cell.kind === 'quiet-hours') {
      const slot = record(cell.quietSlot);
      return { slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: count(params.regulars) },
        quietSlot: { slotId: text(slot.slotId, 160), date: day(slot.date), weekday: count(slot.weekday), startHour: hour(slot.startHour), endHour: hour(slot.endHour) }, ref: ref(cell.ref) };
    }
    if (cell.slot === 'now' && cell.kind === 'expiry') return { slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: count(params.count), itemName: text(params.itemName) }, ref: ref(cell.ref) };
    if (cell.slot === 'today' && cell.kind === 'replies') return { slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: count(params.count), drafted: count(params.drafted) }, ref: ref(cell.ref) };
    if (cell.slot === 'week' && cell.kind === 'video') return { slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: count(params.photos) }, ref: ref(cell.ref) };
    return bad();
  });
  const tap = nullable(row.tapTarget, v => { const t = record(v); return { featureId: text(t.featureId, 60), ...(t.view !== undefined ? { view: text(t.view, 60) } : {}) }; });
  return {
    asOf: instant(row.asOf), businessDate: day(row.businessDate), state: oneOf(row.state, ['ready', 'empty', 'partial'] as const),
    missing: list(row.missing).map(item => oneOf(item, ['coupons', 'replies', 'assets'] as const)), cells,
    folded: list(row.folded).map(item => oneOf(item, ['now', 'today', 'week'] as const)), tapTarget: tap,
  };
}

export function parseReachOutCheck(value: unknown): ReachOutCheckDto {
  const row = record(value);
  return {
    groupId: 'churn-risk', eligibleIds: list(row.eligibleIds).map(id => text(id, 64)),
    blocked: list(row.blocked).map(item => { const b = record(item); return { memberId: text(b.memberId, 64), reason: oneOf(b.reason, ['NOT_IN_GROUP', 'NO_MARKETING_CONSENT'] as const) }; }),
    sourceRevision: count(row.sourceRevision), asOf: instant(row.asOf),
  };
}

/** `…/marketing` is the public prefix B19 registers (`/api/v1/stores/{storeId}/marketing`). */
export const marketingPath = '/marketing';
export const NAVER_BENEFIT_ADMIN_URL = 'https://new.smartplace.naver.com/';
