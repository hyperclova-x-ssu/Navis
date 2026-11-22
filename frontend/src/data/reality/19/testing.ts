/**
 * Test support (R1-F19): an in-memory B19 marketing service behind the F00 `fetch` stub, speaking the wire of
 * `backend/services/marketing/reality/19/README.md`. It models the owner-only reads, the consent partition of the
 * reach-out check and the stale-revision refusal. Not imported by app code.
 */
import { createWidgetDataStore } from '../../db/store';
import { createRealPort, type DomainAdapter } from '../00';
import { fakeBackend, reply } from '../00/testing';
import { groupsAdapter } from './adapter';
import type { ChannelItemDto, CouponOutcomeDto, GroupCustomerDto, GroupId, PerformanceDto, RecommendationsDto } from './dto';

export const asOf = '2026-11-21T06:00:00.000Z';
export const businessDate = '2026-11-21';
export const ids = {
  stale: '5a000000-0000-4000-8000-000000000001', quiet: '5a000000-0000-4000-8000-000000000002', refused: '5a000000-0000-4000-8000-000000000003',
  first: '5a000000-0000-4000-8000-000000000004', regular: '5a000000-0000-4000-8000-000000000005',
} as const;

export const person = (memberId: string, patch: Partial<GroupCustomerDto> = {}): GroupCustomerDto => ({
  memberId, customerId: memberId, displayName: '김○○', groupId: 'churn-risk', visitCount: 3, recentVisits: 1, firstVisitOn: '2026-09-01', lastVisitOn: '2026-10-01',
  daysSinceLast: 51, usualCycleDays: 14, contactAllowed: true, marketingAllowed: true, selectable: true, blockedReason: null, ...patch,
});

export const outcome = (patch: Partial<CouponOutcomeDto> = {}): CouponOutcomeDto => ({
  issued: 20, used: 5, rate: 25,
  payment: { paidAmount: 62_000, discount: 5_000, cost: 21_000, knownCost: 21_000, profit: 41_000, costIncomplete: false, settlements: 5, pendingSettlements: 0 },
  repeat: { windowDays: 30, matured: 4, returned: 1, immature: 1, unlinked: 0, rate: 25 },
  routes: [
    { route: 'sms', issued: 12, used: 4, rate: 33.3, lines: [{ codeId: 'code-sms', couponId: 'coupon-1', name: '단골 감사 쿠폰', status: 'active', issued: 12, used: 4 }] },
    { route: 'place_news', issued: 8, used: 1, rate: 12.5, lines: [{ codeId: 'code-news', couponId: 'coupon-2', name: '소식 쿠폰', status: 'ended', issued: 8, used: 1 }] },
  ],
  byCoupon: [
    { couponId: 'coupon-1', name: '단골 감사 쿠폰', status: 'active', issued: 12, used: 4, rate: 33.3, paidAmount: 50_000 },
    { couponId: 'coupon-2', name: '소식 쿠폰', status: 'ended', issued: 8, used: 1, rate: 12.5, paidAmount: 12_000 },
  ], ...patch,
});

export const perf = (patch: Partial<PerformanceDto> = {}): PerformanceDto => ({
  asOf, sourceRevision: 7, businessDate, period: { from: '2026-11-01', to: businessDate, kind: 'this-month' }, state: 'ready', missing: [], coupons: outcome(),
  comparison: { period: { from: '2026-10-01', to: '2026-10-31' }, issued: 10, used: 1, rate: 10 }, rateDelta: 15, ...patch,
});

export const place = (patch: Partial<ChannelItemDto> = {}): ChannelItemDto => ({
  channel: 'place', state: 'ready', source: 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS', period: { startDate: '2026-11-20', endDate: '2026-11-20' },
  cards: [{ metric: 'views', value: 120, changeRate: 12.5 }, { metric: 'reviews', value: 3 }], ...patch,
});
export const offline = (channel: 'blog' | 'clip'): ChannelItemDto => ({ channel, state: 'unavailable', source: '', period: null, cards: [] });

export interface GroupsSeed {
  readonly customers?: Partial<Record<GroupId, readonly GroupCustomerDto[]>>;
  readonly performance?: { readonly 'this-month'?: PerformanceDto; readonly 'last-month'?: PerformanceDto };
  readonly channels?: readonly ChannelItemDto[];
  readonly today?: Partial<RecommendationsDto>;
}

/** One service: `fail` makes a section answer 503; `revision` moves the projection (a member or a sale changed). */
export function groupsService(seed: GroupsSeed = {}) {
  const backend = fakeBackend();
  const control = { revision: 5, fail: new Set<string>(), customers: { 'churn-risk': [...(seed.customers?.['churn-risk'] ?? [])], 'first-visit': [...(seed.customers?.['first-visit'] ?? [])], regular: [...(seed.customers?.regular ?? [])] } as Record<GroupId, GroupCustomerDto[]> };
  const failing = (name: string) => control.fail.has(name);
  const unavailable = () => reply(503, { code: 'SERVICE_UNAVAILABLE', reason: 'SOURCE_UNAVAILABLE' });
  const members = () => Object.values(control.customers).flat();
  backend.on('GET', '/marketing/groups', () => {
    if (failing('groups')) return unavailable();
    const churn = control.customers['churn-risk'];
    return {
      asOf, sourceRevision: control.revision, businessDate, state: members().length ? 'ready' : 'empty',
      rule: { businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14, visitBasis: 'member-business-day', source: 'customer-consent+pos-recognized-sales' },
      counts: { 'churn-risk': churn.length, 'first-visit': control.customers['first-visit'].length, regular: control.customers.regular.length },
      preview: {}, reachOut: { groupId: 'churn-risk', recipientIds: churn.filter(row => row.selectable).map(row => row.memberId), blockedIds: churn.filter(row => !row.selectable).map(row => row.memberId), count: churn.filter(row => row.selectable).length },
      coverage: { activeMembers: members().length, visitedMembers: members().length, ungroupedMembers: 0, pendingMembers: 0 },
    };
  });
  backend.on('GET', /^\/marketing\/groups\/(churn-risk|first-visit|regular)\/customers$/u, ({ path }) => {
    if (failing('groups')) return unavailable();
    const id = path.split('/')[3] as GroupId;
    return { groupId: id, count: control.customers[id].length, items: control.customers[id], nextCursor: null, asOf, sourceRevision: control.revision, businessDate };
  });
  backend.on('POST', '/marketing/groups/churn-risk/reach-out-check', ({ body }) => {
    const { recipientIds, expectedSourceRevision } = body as { recipientIds: string[]; expectedSourceRevision?: number };
    if (expectedSourceRevision !== undefined && expectedSourceRevision !== control.revision) return reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION', field: 'expectedSourceRevision', details: { sourceRevision: control.revision } });
    const byId = new Map(control.customers['churn-risk'].map(row => [row.memberId, row]));
    const blocked = recipientIds.flatMap(memberId => { const row = byId.get(memberId); return !row ? [{ memberId, reason: 'NOT_IN_GROUP' }] : row.selectable ? [] : [{ memberId, reason: 'NO_MARKETING_CONSENT' }]; });
    return { groupId: 'churn-risk', eligibleIds: recipientIds.filter(id => byId.get(id)?.selectable), blocked, sourceRevision: control.revision, asOf };
  });
  backend.on('GET', '/marketing/performance', ({ query }) => {
    if (failing('performance')) return unavailable();
    const last = query.period === 'last-month';
    const found = seed.performance?.[last ? 'last-month' : 'this-month'];
    return found ?? (last ? perf({ period: { from: '2026-10-01', to: '2026-10-31', kind: 'last-month' }, comparison: null, rateDelta: null, coupons: outcome({ issued: 10, used: 1, rate: 10 }) }) : perf());
  });
  backend.on('GET', '/marketing/channel-reports', () => {
    if (failing('channels')) return unavailable();
    return { asOf, businessDate, items: seed.channels ?? [place(), offline('blog'), offline('clip')] };
  });
  backend.on('GET', '/marketing/recommendations', () => {
    if (failing('today')) return unavailable();
    return { asOf, businessDate, state: 'ready', missing: [], cells: [], folded: ['now', 'today', 'week'], tapTarget: null, ...seed.today };
  });
  return { backend, control };
}

/** A browser session over the service: the groups domain runs over HTTP, `extra` adapters (e.g. a stand-in for B14's reach-out send) too, every other domain stays on the fixture. */
export function groupsSession(service = groupsService(), extra: readonly DomainAdapter[] = []) {
  const adapters = [groupsAdapter, ...extra];
  const http = new Set(adapters.map(adapter => adapter.domain));
  const store = createWidgetDataStore();
  const port = createRealPort({ store, adapters, source: domain => (http.has(domain) ? 'http' : 'fixture'), fetch: service.backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  return { store, port, service };
}
