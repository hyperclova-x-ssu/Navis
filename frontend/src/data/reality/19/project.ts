/**
 * F19 · projection of B19's reads into the existing widget models (`CustomerGroupsModel`, `MarketingPerformanceModel`,
 * `MarketingTodayModel`). Selectors, widgets, Navis facts and `projectAgent*` keep reading these models, so nothing downstream changes.
 *
 * Rules (D-347 D3 · I05 · AC-1592/1593): coupon figures are POS recognized amounts net of discount and corrections; no "sales from promotion" value exists
 * here; a missing source stays `null`/`missing` and is never turned into 0; a repeat visit is counted only for uses at least 30 days old.
 */
import type { DetailRef, FeatureId, QueryCondition } from '../../../contracts';
import { periodOf } from '../../conditions';
import { dateOf, inRange, MONTH_START, TODAY } from '../../db/time';
import type { DataSnapshot } from '../../db/types';
import type {
  CouponRoute, CustomerGroupsModel, GroupCustomer, MarketingPerformanceModel, MarketingTodayModel, PerfRouteRow, TodayCell,
} from '../../marketing/types';
import type { StateNote, WidgetView } from '../../models/types';
import { ready } from '../../models/util';
import { GROUP_IDS, type GroupCustomerDto, type GroupId, type PerformanceDto, type RealGroupsSnapshot, type RecommendationsDto, type TodayCellDto } from './dto';
import type { RealChannel } from './model';

export type RealOutcome<M> =
  | { readonly kind: 'ready'; readonly model: M; readonly notes?: readonly StateNote[] }
  | { readonly kind: 'empty'; readonly state: string; readonly messageKey?: string }
  | { readonly kind: 'error' };

const GROUP_NAME: Readonly<Record<GroupId, string>> = {
  'churn-risk': 'data.marketing.group.churnRisk', 'first-visit': 'data.marketing.group.firstVisit', regular: 'data.marketing.group.regular',
};

/** Turns an outcome into the `WidgetView` the selector returns; `emptyAs` is the projector's own sample-state empty view (message and action of the existing states). */
export function realView<F extends FeatureId, M>(
  featureId: F, outcome: RealOutcome<M>, condition: QueryCondition, variant: string, emptyAs: (state: string) => WidgetView<M, F>,
): WidgetView<M, F> {
  if (outcome.kind === 'ready') return ready(featureId as never, condition, variant, outcome.model as never, outcome.notes) as unknown as WidgetView<M, F>;
  if (outcome.kind === 'empty') {
    const view = emptyAs(outcome.state);
    return outcome.messageKey && view.status === 'empty' ? { ...view, messageKey: outcome.messageKey } : view;
  }
  return { status: 'error', featureId, variant, messageKey: 'data.real.error' };
}

/* ── 손님 그룹 ─────────────────────────────────────────────────────────────────────────────────────────── */
const customer = (c: GroupCustomerDto): GroupCustomer => ({
  customerId: c.memberId,
  name: c.displayName ? { raw: c.displayName } : { key: 'data.real.groups.noName' },
  visitCount: c.visitCount, lastVisit: c.lastVisitOn, daysSinceLast: c.daysSinceLast, usualCycleDays: c.usualCycleDays,
  consentSms: c.selectable, selectable: c.selectable, reasonKey: c.selectable ? null : 'data.real.groups.blocked.NO_MARKETING_CONSENT',
});

export function projectRealGroups(real: RealGroupsSnapshot): RealOutcome<CustomerGroupsModel> {
  const dto = real.groups;
  if (!dto) return { kind: 'error' };
  if (dto.state === 'empty') return { kind: 'empty', state: 'no-history' };
  const lists = Object.fromEntries(GROUP_IDS.map(id => [id, real.customers[id].map(customer)])) as Record<GroupId, GroupCustomer[]>;
  const model: CustomerGroupsModel = {
    rule: dto.rule,
    groups: GROUP_IDS.map(id => ({ id, nameKey: GROUP_NAME[id], count: dto.counts[id], customers: lists[id] })),
    counts: dto.counts,
    churnRisk: lists['churn-risk'],
    reachOut: { recipientIds: dto.reachOut.recipientIds, blockedIds: dto.reachOut.blockedIds, count: dto.reachOut.count },
    basisKey: 'data.real.groups.basis',
    // Coupons already sent come from the coupon ledger (B14); until it is wired the list is empty, not invented.
    sent: [],
    canReachOut: dto.reachOut.count > 0,
    real: { asOf: dto.asOf, sourceRevision: dto.sourceRevision, businessDate: dto.businessDate, coverage: dto.coverage },
  };
  // A sale whose member row has not arrived yet is not in any group; say so instead of hiding the gap.
  return { kind: 'ready', model, ...(dto.coverage.pendingMembers > 0 ? { notes: [{ messageKey: 'data.real.groups.pending', params: { n: dto.coverage.pendingMembers } }] } : {}) };
}

/* ── 마케팅 성과 ───────────────────────────────────────────────────────────────────────────────────────── */
const KNOWN_ROUTES: Readonly<Record<string, string>> = {
  place_news: 'data.marketing.route.placeNews', blog: 'data.marketing.route.blog', clip: 'data.marketing.route.clip', sms: 'data.marketing.route.sms',
  talktalk: 'data.real.groups.route.talktalk',
};
const routeKey = (route: string) => KNOWN_ROUTES[route] ?? 'data.real.groups.route.other';
const range = (period: { readonly startDate: string; readonly endDate: string }) => ({ start: period.startDate, end: period.endDate });

function channelsOf(real: RealGroupsSnapshot): readonly RealChannel[] | null {
  if (!real.channels) return null;
  return real.channels.items.map((item): RealChannel => ({
    channel: item.channel, state: item.state, source: item.source, period: item.period ? range(item.period) : null,
    cards: item.cards.flatMap(card => {
      const period = card.period ?? item.period;
      return period ? [{ metric: card.metric, value: card.value, ...(card.changeRate !== undefined ? { changeRate: card.changeRate } : {}), period: range(period) }] : [];
    }),
  }));
}

function bestOf(rows: readonly PerfRouteRow[]): PerfRouteRow | null {
  return rows.reduce<PerfRouteRow | null>((best, row) => (row.rate !== null && (best === null || (best.rate ?? -1) < row.rate) ? row : best), null);
}

export function projectRealPerformance(snapshot: DataSnapshot, real: RealGroupsSnapshot, condition: QueryCondition): RealOutcome<MarketingPerformanceModel> {
  const range0 = periodOf('marketing-performance', condition) ?? { start: MONTH_START, end: TODAY };
  const last = range0.start !== MONTH_START;
  const dto: PerformanceDto | null = real.performance[last ? 'last-month' : 'this-month'];
  if (!dto) return { kind: 'error' };
  const coupons = dto.coupons;
  const channels = channelsOf(real);
  const period = { start: dto.period.from, end: dto.period.to };
  // Videos the owner marked as posted, from the promo records (F16); their own coupon use is not a B19 figure, so the rows carry no counts.
  const byVideo = snapshot.tables.marketing.promoVideo.filter(video => video.status === 'posted' && (!video.postedAt || inRange(dateOf(video.postedAt), period.start, period.end)))
    .map(video => ({ videoId: video.videoId, couponId: null, postedRoute: video.postedRoute, issued: 0, used: 0, rate: null,
      ...(video.publication ? { publication: video.publication } : {}) }));
  const routes: PerfRouteRow[] = (coupons?.routes ?? []).map(row => ({
    route: row.route as CouponRoute, nameKey: routeKey(row.route), issued: row.issued, used: row.used, rate: row.rate,
    lines: row.lines.map(line => ({ codeId: line.codeId, couponId: line.couponId, name: { raw: line.name }, status: line.status, issued: line.issued, used: line.used })),
  }));
  const pay = coupons?.payment ?? null;
  const model: MarketingPerformanceModel = {
    period, periodKind: last ? 'last-month' : 'this-month', issued: coupons?.issued ?? 0, used: coupons?.used ?? 0, rate: coupons?.rate ?? null,
    rateDelta: dto.rateDelta === null ? null : { value: dto.rateDelta, kind: 'pp' },
    // POS recognized amount of the coupon-used settlements. There is no attributed (promotion-caused) amount in this model.
    revenue: { total: pay?.paidAmount ?? 0, coupon: pay?.paidAmount ?? 0, attributed: 0 }, revenueDelta: null,
    cost: pay?.knownCost ?? 0, discount: pay?.discount ?? 0, profit: pay?.profit ?? 0,
    returnRate: coupons?.repeat.rate ?? null, returnRateDelta: null,
    routes, missingRoutes: [], best: bestOf(routes),
    byCoupon: (coupons?.byCoupon ?? []).map(row => ({ couponId: row.couponId, name: { raw: row.name }, status: row.status, issued: row.issued, used: row.used, rate: row.rate })),
    byVideo, insight: null, recentIssued: 0, basisKey: 'data.real.groups.perf.basis',
    real: {
      asOf: dto.asOf, sourceRevision: dto.sourceRevision, couponsMissing: coupons === null, payment: pay, repeat: coupons?.repeat ?? null, channels,
      paidByCoupon: Object.fromEntries((coupons?.byCoupon ?? []).map(row => [row.couponId, row.paidAmount])),
    },
  };
  const hasCards = channels?.some(item => item.state === 'ready' && item.cards.length > 0) ?? false;
  if (coupons && coupons.issued === 0 && coupons.used === 0 && !byVideo.some(row => row.publication) && !hasCards) return { kind: 'empty', state: 'no-redemptions' };
  return { kind: 'ready', model, ...(coupons === null ? { notes: [{ messageKey: 'data.real.groups.perf.couponsNotYet' }] } : {}) };
}

/* ── 오늘 할 홍보 ───────────────────────────────────────────────────────────────────────────────────────── */
const refOf = (cell: TodayCellDto): DetailRef => ({
  featureId: cell.sourceFeatureId, ...(cell.ref.view ? { view: cell.ref.view } : {}), ...(cell.ref.itemId ? { itemId: cell.ref.itemId } : {}), focus: 'action',
});

function cellOf(cell: TodayCellDto): TodayCell {
  switch (cell.kind) {
    case 'quiet-hours': return { slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: cell.params.regulars }, quietSlot: cell.quietSlot, ref: refOf(cell) };
    case 'expiry': return { slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: cell.params.count }, itemNameKey: '', itemName: cell.params.itemName, ref: refOf(cell) };
    case 'replies': return { slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: cell.params.count, drafted: cell.params.drafted }, ref: refOf(cell) };
    case 'video': return { slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: cell.params.photos }, ref: refOf(cell) };
  }
}

const MISSING_KEY = { coupons: 'data.real.groups.today.missing.coupons', replies: 'data.real.groups.today.missing.replies', assets: 'data.real.groups.today.missing.assets' } as const;

export function projectRealToday(real: RealGroupsSnapshot): RealOutcome<MarketingTodayModel> {
  const dto: RecommendationsDto | null = real.today;
  if (!dto) return { kind: 'error' };
  if (dto.cells.length === 0) {
    // A source that is not wired yet must not read as "nothing to do": one missing source is named, several are said together.
    return dto.missing.length
      ? { kind: 'empty', state: 'unavailable', messageKey: dto.missing.length === 1 ? `data.real.groups.today.unavailable.${dto.missing[0]}` : 'data.real.groups.today.unavailable' }
      : { kind: 'empty', state: 'none' };
  }
  const cells = dto.cells.map(cellOf);
  const first = cells[0].ref;
  const model: MarketingTodayModel = {
    cells, folded: dto.folded, missing: dto.missing,
    tapTarget: first.view ? { featureId: first.featureId, view: first.view } : { featureId: first.featureId },
  };
  return { kind: 'ready', model, ...(dto.missing.length ? { notes: dto.missing.map(source => ({ messageKey: MISSING_KEY[source] })) } : {}) };
}
