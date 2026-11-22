import { expect, it } from 'vitest';
import type { QueryCondition } from '../../../contracts';
import type { ModelOf, WidgetView } from '../../models/types';
import { supportedConditions } from '../../conditions';
import { createWidgetDataStore, type WidgetDataStore } from '../../db/store';
import { widgetFacts } from '../../facts';
import { selectWidget } from '../../models/select';
import { createRealPort } from '../00';
import { autoloadedAdapters } from '../00/autoload';
import { reply } from '../00/testing';
import { groupsAdapter } from './adapter';
import { checkReachOut } from './reach-out';
import { asOf, groupsService, ids, offline, outcome, person, perf, place } from './testing';

const LAST_MONTH = supportedConditions('marketing-performance')[1];
const NOW: QueryCondition = { kind: 'default' };

function session(service = groupsService(), adapters = [groupsAdapter]) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, source: domain => (domain === 'groups' ? 'http' : 'fixture'), adapters, fetch: service.backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  return { store, port };
}
const view = <F extends 'customer-groups' | 'marketing-performance' | 'marketing-today'>(store: WidgetDataStore, id: F, condition: QueryCondition = NOW): WidgetView<ModelOf<F>> => selectWidget(store.getSnapshot(), id, condition, 'normal');
const ready = <M,>(value: WidgetView<M>): M => {
  expect(value.status).toBe('ready');
  return (value as Extract<WidgetView<M>, { status: 'ready' }>).model;
};

const seed = {
  customers: {
    'churn-risk': [person(ids.stale), person(ids.refused, { displayName: null, marketingAllowed: false, selectable: false, blockedReason: 'NO_MARKETING_CONSENT' as const, lastVisitOn: '2026-10-05', daysSinceLast: 47 })],
    'first-visit': [person(ids.first, { groupId: 'first-visit' as const, visitCount: 1, usualCycleDays: null, lastVisitOn: '2026-11-20', daysSinceLast: 1 })],
    regular: [person(ids.regular, { groupId: 'regular' as const, visitCount: 9, recentVisits: 5, usualCycleDays: 3, lastVisitOn: '2026-11-19', daysSinceLast: 2 })],
  },
};

it('registers once and reads groups, customers and consent from B19 in a new session', async () => {
  const service = groupsService(seed);
  const first = session(service, autoloadedAdapters().filter(adapter => adapter.domain === 'groups'));
  expect((await first.port.load('groups')).status).toBe('ready');
  const model = ready(view(first.store, 'customer-groups'));
  expect(model.counts).toEqual({ 'churn-risk': 2, 'first-visit': 1, regular: 1 });
  expect(model.groups.map(group => [group.id, group.customers.length])).toEqual([['churn-risk', 2], ['first-visit', 1], ['regular', 1]]);
  expect(model.churnRisk.map(row => row.customerId)).toEqual([ids.stale, ids.refused]);
  expect(model.churnRisk[0]).toMatchObject({ name: { raw: '김○○' }, selectable: true, consentSms: true, reasonKey: null, usualCycleDays: 14, lastVisit: '2026-10-01' });
  expect(model.churnRisk[1]).toMatchObject({ name: { key: 'data.real.groups.noName' }, selectable: false, consentSms: false, reasonKey: 'data.real.groups.blocked.NO_MARKETING_CONSENT' });
  expect(model.reachOut).toEqual({ recipientIds: [ids.stale], blockedIds: [ids.refused], count: 1 });
  expect(model).toMatchObject({ canReachOut: true, sent: [], basisKey: 'data.real.groups.basis', real: { sourceRevision: 5, coverage: { activeMembers: 4 } } });
  expect(widgetFacts(view(first.store, 'customer-groups')).map(fact => [fact.key, fact.value])).toContainEqual(['groups.reachOut', 1]);
  // The browser keeps one masked initial and ids: no phone number, no full name.
  expect(JSON.stringify(first.store.getSnapshot().tables.realGroups)).not.toMatch(/\b01[016789]-?\d{3,4}-?\d{4}\b/u);

  const second = session(service);
  await second.port.load('groups');
  expect(ready(view(second.store, 'customer-groups'))).toEqual(model);
  expect(service.backend.callsTo('GET', '/marketing/groups').length).toBeGreaterThanOrEqual(2);
});

it('shows an empty groups state when no member has a counted visit, and an error for a failed section only', async () => {
  const empty = session(groupsService());
  await empty.port.load('groups');
  expect(view(empty.store, 'customer-groups')).toMatchObject({ status: 'empty', messageKey: 'data.state.customer-groups.no-history' });

  const service = groupsService(seed);
  service.control.fail.add('performance');
  const partial = session(service);
  expect((await partial.port.load('groups')).status).toBe('ready');
  expect(view(partial.store, 'customer-groups').status).toBe('ready');
  expect(view(partial.store, 'marketing-performance')).toMatchObject({ status: 'error', messageKey: 'data.real.error' });
  expect(partial.store.getSnapshot().tables.realGroups?.failed).toEqual(['performance']);
  service.control.fail.clear();
  await partial.port.retry('groups');
  expect(view(partial.store, 'marketing-performance').status).toBe('ready');
});

it('reads coupon performance from the POS-based DTO without any promotion-caused amount', async () => {
  const service = groupsService(seed);
  const { store, port } = session(service);
  await port.load('groups');
  const model = ready(view(store, 'marketing-performance'));
  expect(model).toMatchObject({
    period: { start: '2026-11-01', end: '2026-11-21' }, periodKind: 'this-month', issued: 20, used: 5, rate: 25, rateDelta: { value: 15, kind: 'pp' },
    revenue: { total: 62_000, coupon: 62_000, attributed: 0 }, revenueDelta: null, cost: 21_000, discount: 5_000, profit: 41_000, returnRate: 25, insight: null,
    real: { couponsMissing: false, repeat: { matured: 4, returned: 1, immature: 1 }, payment: { paidAmount: 62_000, profit: 41_000 }, paidByCoupon: { 'coupon-1': 50_000, 'coupon-2': 12_000 } },
  });
  expect(model.routes.map(row => [row.route, row.nameKey, row.issued, row.used])).toEqual([['sms', 'data.marketing.route.sms', 12, 4], ['place_news', 'data.marketing.route.placeNews', 8, 1]]);
  expect(model.routes[0].lines).toEqual([{ codeId: 'code-sms', couponId: 'coupon-1', name: { raw: '단골 감사 쿠폰' }, status: 'active', issued: 12, used: 4 }]);
  expect(model.best?.route).toBe('sms');
  expect(model.byCoupon.map(row => row.couponId)).toEqual(['coupon-1', 'coupon-2']);
  expect(model.real?.channels?.map(row => [row.channel, row.state])).toEqual([['place', 'ready'], ['blog', 'unavailable'], ['clip', 'unavailable']]);
  expect(model.real?.channels?.[0]).toMatchObject({ source: expect.stringMatching(/^https:\/\/help\.naver\.com\//u), period: { start: '2026-11-20', end: '2026-11-20' },
    cards: [{ metric: 'views', value: 120, changeRate: 12.5, period: { start: '2026-11-20', end: '2026-11-20' } }, { metric: 'reviews', value: 3 }] });
  expect(JSON.stringify(model)).not.toMatch(/promotionSales|causal|attributedSales/u);
  const last = ready(view(store, 'marketing-performance', LAST_MONTH));
  expect(last).toMatchObject({ periodKind: 'last-month', period: { start: '2026-10-01', end: '2026-10-31' }, issued: 10, used: 1, rate: 10, rateDelta: null });
  expect(widgetFacts(view(store, 'marketing-performance')).map(fact => fact.key)).toEqual(expect.arrayContaining(['perf.rate', 'perf.revenue', 'perf.profit']));
});

it('keeps unknown cost and a missing coupon ledger visible instead of turning them into zero', async () => {
  const unknownCost = groupsService({ ...seed, performance: { 'this-month': perf({ coupons: outcome({ payment: { paidAmount: 62_000, discount: 5_000, cost: null, knownCost: 8_000, profit: null, costIncomplete: true, settlements: 5, pendingSettlements: 0 } }) }) } });
  const a = session(unknownCost);
  await a.port.load('groups');
  const model = ready(view(a.store, 'marketing-performance'));
  expect(model.real).toMatchObject({ couponsMissing: false, payment: { cost: null, profit: null, costIncomplete: true } });
  const facts = widgetFacts(view(a.store, 'marketing-performance')).map(fact => fact.key);
  expect(facts).toContain('perf.revenue');
  expect(facts).not.toContain('perf.profit');

  const missing = groupsService({ ...seed, performance: { 'this-month': perf({ state: 'partial', missing: ['coupons'], coupons: null, comparison: null, rateDelta: null }) } });
  const b = session(missing);
  await b.port.load('groups');
  const none = view(b.store, 'marketing-performance');
  expect(none).toMatchObject({ status: 'ready', notes: [{ messageKey: 'data.real.groups.perf.couponsNotYet' }], model: { rate: null, real: { couponsMissing: true, payment: null, repeat: null } } });
  expect(widgetFacts(view(b.store, 'marketing-performance'))).toEqual([]);
});

it('keeps owner-visible channel cards only with an https NAVER source and a period, and an unreadable report is unavailable', async () => {
  const service = groupsService({ ...seed, channels: [place({ source: 'https://evil.example/report' }), place({ channel: 'blog', source: 'http://help.naver.com/x' }), place({ channel: 'clip', cards: [{ metric: 'clipViews', value: 4 }] })] });
  const { store, port } = session(service);
  await port.load('groups');
  expect(ready(view(store, 'marketing-performance')).real?.channels?.map(row => [row.channel, row.state, row.cards.length])).toEqual([['place', 'unavailable', 0], ['blog', 'unavailable', 0], ['clip', 'ready', 1]]);
  service.control.fail.add('channels');
  await port.retry('groups');
  expect(ready(view(store, 'marketing-performance')).real?.channels).toBeNull();
});

it('builds today cells from the recommendations and names every missing source', async () => {
  const quiet = { slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: 3 }, quietSlot: { slotId: 'slot-2026-11-22-14', date: '2026-11-22', weekday: 7, startHour: 14, endHour: 16 }, ref: { featureId: 'slot-coupon', view: 'send', itemId: 'slot-2026-11-22-14', focus: 'action' } };
  const replies = { slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: 2, drafted: 1 }, ref: { featureId: 'ai-response', itemId: 'inq-1', focus: 'action' } };
  const service = groupsService({ ...seed, today: { state: 'partial', missing: ['assets'], cells: [quiet, replies] as never, folded: ['week'], tapTarget: { featureId: 'slot-coupon', view: 'send' } } });
  const { store, port } = session(service);
  await port.load('groups');
  const today = view(store, 'marketing-today');
  expect(today).toMatchObject({ status: 'ready', notes: [{ messageKey: 'data.real.groups.today.missing.assets' }] });
  const model = ready(today);
  expect(model.cells).toMatchObject([
    { slot: 'now', kind: 'quiet-hours', params: { regulars: 3 }, ref: { featureId: 'slot-coupon', view: 'send', itemId: 'slot-2026-11-22-14', focus: 'action' } },
    { slot: 'today', kind: 'replies', params: { count: 2, drafted: 1 }, ref: { featureId: 'ai-response', itemId: 'inq-1', focus: 'action' } },
  ]);
  expect(model).toMatchObject({ folded: ['week'], missing: ['assets'], tapTarget: { featureId: 'slot-coupon', view: 'send' } });
  expect(widgetFacts(view(store, 'marketing-today')).map(fact => [fact.key, fact.value])).toContainEqual(['todayPromo.replies.waiting', 2]);
});

it('says "not available yet" when no cell exists and a source is missing, and "nothing to do" only when nothing is missing', async () => {
  const missing = groupsService({ ...seed, today: { state: 'partial', missing: ['coupons', 'replies', 'assets'] } });
  const a = session(missing);
  await a.port.load('groups');
  expect(view(a.store, 'marketing-today')).toMatchObject({ status: 'empty', messageKey: 'data.real.groups.today.unavailable' });
  const one = session(groupsService({ ...seed, today: { state: 'partial', missing: ['assets'] } }));
  await one.port.load('groups');
  expect(view(one.store, 'marketing-today')).toMatchObject({ status: 'empty', messageKey: 'data.real.groups.today.unavailable.assets' });
  const none = session(groupsService(seed));
  await none.port.load('groups');
  expect(view(none.store, 'marketing-today')).toMatchObject({ status: 'empty', messageKey: 'data.state.marketing-today.none' });
  const expiry = groupsService({ ...seed, today: { state: 'ready', cells: [{ slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: 6, itemName: '크루아상' }, ref: { featureId: 'expiry-coupon', itemId: 'lot-1', focus: 'action' } }] as never } });
  const b = session(expiry);
  await b.port.load('groups');
  expect(ready(view(b.store, 'marketing-today')).cells[0]).toMatchObject({ kind: 'expiry', itemName: '크루아상', params: { count: 6 } });
  expect(widgetFacts(view(b.store, 'marketing-today')).find(fact => fact.key === 'todayPromo.expiry.qty')).toMatchObject({ value: 6, labelText: { raw: '크루아상' } });
});

it('rejects a malformed answer instead of showing it', async () => {
  const service = groupsService(seed);
  service.backend.on('GET', '/marketing/groups', () => ({ asOf, sourceRevision: 'x', businessDate: '2026-11-21' }));
  const { store, port } = session(service);
  await port.load('groups');
  expect(view(store, 'customer-groups')).toMatchObject({ status: 'error' });
  expect(view(store, 'marketing-performance').status).toBe('ready');
});

it('clears every group row when access ends and when the domain fails entirely', async () => {
  const service = groupsService(seed);
  const { store, port } = session(service);
  await port.load('groups');
  expect(store.getSnapshot().tables.realGroups).toBeDefined();
  service.backend.on('GET', '/marketing/groups', () => reply(403, { code: 'STORE_FORBIDDEN' }));
  await port.retry('groups');
  expect(store.getSnapshot().tables.realGroups).toBeUndefined();
  expect(port.state('groups').status).toBe('error');
  const down = groupsService(seed);
  for (const name of ['groups', 'performance', 'channels', 'today']) down.control.fail.add(name);
  const other = session(down);
  expect((await other.port.load('groups')).status).toBe('error');
  expect(offline('blog').state).toBe('unavailable');
});

it('checks consent before a reach-out, removes blocked members and re-reads on a stale revision', async () => {
  const service = groupsService(seed);
  const { store, port } = session(service);
  await port.load('groups');
  const revision = store.getSnapshot().tables.realGroups!.groups!.sourceRevision;
  expect(await checkReachOut(port, [ids.stale, ids.refused, ids.regular, ids.stale], revision)).toEqual({
    ok: true, eligibleIds: [ids.stale], blocked: [{ memberId: ids.refused, reason: 'NO_MARKETING_CONSENT' }, { memberId: ids.regular, reason: 'NOT_IN_GROUP' }],
  });
  const [call] = service.backend.callsTo('POST', '/marketing/groups/churn-risk/reach-out-check');
  expect(call.body).toEqual({ recipientIds: [ids.stale, ids.refused, ids.regular], expectedSourceRevision: revision });
  expect(service.backend.callsTo('POST', /marketing/u).every(entry => entry.path.endsWith('/reach-out-check'))).toBe(true);
  service.control.revision = 6;
  const reads = service.backend.callsTo('GET', '/marketing/groups').length;
  expect(await checkReachOut(port, [ids.stale], revision)).toEqual({ ok: false, reason: 'STALE_REVISION' });
  await port.load('groups', { force: true });
  expect(service.backend.callsTo('GET', '/marketing/groups').length).toBeGreaterThan(reads);
  expect(store.getSnapshot().tables.realGroups!.groups!.sourceRevision).toBe(6);
  service.backend.on('POST', '/marketing/groups/churn-risk/reach-out-check', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
  expect(await checkReachOut(port, [ids.stale], 6)).toEqual({ ok: false, reason: 'UNAVAILABLE' });
  service.backend.on('POST', '/marketing/groups/churn-risk/reach-out-check', () => ({ groupId: 'churn-risk', eligibleIds: ['ffffffff-0000-4000-8000-000000000000'], blocked: [], sourceRevision: 6, asOf }));
  expect(await checkReachOut(port, [ids.stale], 6)).toEqual({ ok: false, reason: 'UNAVAILABLE' });
});

it('checks a long recipient list in requests of at most 200 and merges the answers', async () => {
  const service = groupsService(seed);
  const { store, port } = session(service);
  await port.load('groups');
  const revision = store.getSnapshot().tables.realGroups!.groups!.sourceRevision;
  const many = Array.from({ length: 450 }, (_, index) => `5b000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  const asked: number[] = [];
  service.backend.on('POST', '/marketing/groups/churn-risk/reach-out-check', ({ body }) => {
    const { recipientIds } = body as { recipientIds: string[] };
    asked.push(recipientIds.length);
    return { groupId: 'churn-risk', eligibleIds: recipientIds.filter((_, index) => index % 2 === 0), blocked: recipientIds.filter((_, index) => index % 2 === 1).map(memberId => ({ memberId, reason: 'NO_MARKETING_CONSENT' })), sourceRevision: revision, asOf };
  });
  const result = await checkReachOut(port, many, revision);
  expect(asked).toEqual([200, 200, 50]);
  expect(result).toMatchObject({ ok: true });
  if (result.ok) expect(result.eligibleIds.length + result.blocked.length).toBe(450);
  // A stale answer on any request is a stale check, not a partial one.
  let calls = 0;
  service.backend.on('POST', '/marketing/groups/churn-risk/reach-out-check', () => (++calls === 2 ? reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }) : { groupId: 'churn-risk', eligibleIds: [], blocked: [], sourceRevision: revision, asOf }));
  expect(await checkReachOut(port, many, revision)).toEqual({ ok: false, reason: 'STALE_REVISION' });
});

it('has no command binding: the reach-out send is never faked by this domain', () => {
  expect(groupsAdapter.commands).toEqual([]);
  const { port } = session();
  expect(port.route({ type: 'coupon.sendReachOut', recipientIds: [], idempotencyKey: 'probe' })).toBeNull();
});
