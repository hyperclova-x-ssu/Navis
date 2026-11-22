import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { PermanentStreamError } from '../../../../packages/streams/index.ts';
import type { StreamEnvelope } from '../../../../packages/streams/envelope.ts';
import { inStore } from '../../transaction.ts';
import type { ChannelReportPort, CouponLedger, TodaySources } from './ports.ts';

// 2026-11-21 12:00 KST. The café business day starts at 05:00, so today is 2026-11-21.
const clock = new Date('2026-11-21T03:00:00Z');
const token = randomUUID();
const actorId = randomUUID();
const pool = dbPool('marketing', 'runtime', 'test');
type Routes = typeof import('./routes.ts');
type Projection = typeof import('./projection.ts');
let routes: Routes;
let projection: Projection;
const apps: ReturnType<typeof Fastify>[] = [];
const seq = new Map<string, number>();

beforeAll(async () => {
  await runMigrations('marketing', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  routes = await import('./routes.ts');
  projection = await import('./projection.ts');
});

afterAll(async () => {
  await Promise.all(apps.map(app => app.close()));
  await pool.end();
});

async function server(options: Partial<Parameters<Routes['registerGroupsPerformanceRoutes']>[2]> = {}) {
  const app = Fastify();
  routes.registerGroupsPerformanceRoutes(app, pool, { gatewayToken: token, now: () => clock, ...options });
  await app.ready();
  apps.push(app);
  return (store: string, method: HTTPMethods, path: string, payload?: object,
    headers: Record<string, string> = {}) => app.inject({
    method, url: `/internal/v1/marketing/stores/${store}${path}`, payload,
    headers: { authorization: `Bearer ${token}`, 'x-navis-store-id': store, 'x-navis-user-id': actorId,
      'x-navis-store-role': 'owner', 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00',
      ...headers },
  });
}

function envelope(storeId: string, producer: 'customer' | 'pos', eventType: string, aggregateId: string,
  payload: Record<string, unknown>, occurredAt = clock.toISOString()): StreamEnvelope {
  const key = `${producer}:${storeId}`;
  const next = (seq.get(key) ?? 0) + 1;
  seq.set(key, next);
  return { eventId: randomUUID(), producer, storeId, scopeKey: storeId, storeSeq: String(next), eventType,
    schemaVersion: 1, aggregateId, occurredAt, payload } as StreamEnvelope;
}

async function deliver(event: StreamEnvelope) {
  const handlers: Record<string, (db: never, event: StreamEnvelope) => Promise<void>> =
    event.producer === 'customer' ? projection.groupCustomerHandlers : projection.performancePosHandlers;
  await inStore(pool, event.storeId!, db => handlers[event.eventType](db as never, event));
}

const member = (store: string, memberId: string, revision: number, consent: boolean, active = true, nameInitial?: string) =>
  deliver(envelope(store, 'customer', 'customer.contact_state_changed.v1', memberId,
    { memberId, revision, active, contactAllowed: consent || active, marketingAllowed: consent,
      ...(nameInitial && { nameInitial }) }));

async function sale(store: string, input: { day: string; memberId?: string; amount?: number; cost?: number | null;
  hour?: number; settlementId?: string; incomplete?: boolean }) {
  const settlementId = input.settlementId ?? randomUUID();
  const occurredAt = new Date(`${input.day}T${String(input.hour ?? 10).padStart(2, '0')}:00:00+09:00`).toISOString();
  await deliver(envelope(store, 'pos', 'pos.sale_recognized.v1', settlementId, {
    settlementId, billId: randomUUID(), orderId: randomUUID(), businessDate: input.day, lines: [],
    amount: input.amount ?? 4500, cost: input.cost === undefined ? 1500 : input.cost,
    incompleteMarginCoverage: input.incomplete ?? false, ...(input.memberId && { memberId: input.memberId }),
  }, occurredAt));
  return settlementId;
}

const correction = (store: string, settlementId: string, day: string, amountDelta: number, voided: boolean,
  costDelta: number | null = 0) => {
  const correctionId = randomUUID();
  return deliver(envelope(store, 'pos', 'pos.sale_corrected.v1', correctionId, {
    settlementId, billId: randomUUID(), orderId: randomUUID(), businessDate: day, lines: [], correctionId,
    kind: voided ? 'cancel' : 'refund', target: 'recognized_sale', usageEffect: voided ? 'restore' : 'keep',
    amountDelta, costDelta, incompleteMarginCoverage: false, ...(voided && { memberVisitVoided: true }),
  }));
};

describe('customer groups', () => {
  it('splits real member visits into non-overlapping groups by business day and keeps CCTV-free sources', async () => {
    const call = await server();
    const store = randomUUID();
    const [regular, first, quiet, lapsed, archived, steady] = Array.from({ length: 6 }, () => randomUUID());
    await member(store, regular, 1, true, true, '김');
    await member(store, first, 1, true);
    await member(store, quiet, 2, false, true, '박');
    await member(store, lapsed, 1, true, true, '이');
    await member(store, archived, 3, true, false);
    await member(store, steady, 1, true);
    for (const day of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-20']) await sale(store, { day, memberId: regular });
    await sale(store, { day: '2026-11-20', memberId: regular, hour: 15 }); // the same business day counts once
    await sale(store, { day: '2026-11-19', memberId: first });
    for (const day of ['2026-09-01', '2026-09-11', '2026-09-21']) await sale(store, { day, memberId: quiet });
    for (const day of ['2026-09-05', '2026-09-26']) await sale(store, { day, memberId: lapsed });
    for (const day of ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07']) await sale(store, { day, memberId: archived });
    for (const day of ['2026-11-12', '2026-11-19']) await sale(store, { day, memberId: steady });
    await sale(store, { day: '2026-11-20' }); // anonymous sale: not a member visit

    const read = await call(store, 'GET', '/groups');
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    const groups = read.json();
    expect(groups).toMatchObject({
      businessDate: '2026-11-21', state: 'ready',
      rule: { businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14 },
      counts: { 'churn-risk': 2, 'first-visit': 1, regular: 1 },
      reachOut: { groupId: 'churn-risk', recipientIds: [lapsed], blockedIds: [quiet], count: 1 },
      coverage: { activeMembers: 5, visitedMembers: 5, ungroupedMembers: 1 },
    });
    expect(groups.preview['churn-risk']).toEqual([
      expect.objectContaining({ memberId: quiet, customerId: quiet, displayName: null, visitCount: 3,
        lastVisitOn: '2026-09-21', usualCycleDays: 10, daysSinceLast: 61, selectable: false, blockedReason: 'NO_MARKETING_CONSENT' }),
      expect.objectContaining({ memberId: lapsed, displayName: '이○○', usualCycleDays: 21, selectable: true, blockedReason: null }),
    ]);
    expect(groups.preview.regular[0]).toMatchObject({ memberId: regular, visitCount: 4, recentVisits: 4, displayName: '김○○' });
    expect(groups.preview['first-visit'][0]).toMatchObject({ memberId: first, visitCount: 1, usualCycleDays: null, displayName: null });
    expect(read.body).not.toContain(archived);

    const page1 = (await call(store, 'GET', '/groups/churn-risk/customers?limit=1')).json();
    expect(page1).toMatchObject({ items: [{ memberId: quiet }], sourceRevision: groups.sourceRevision });
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (await call(store, 'GET', `/groups/churn-risk/customers?limit=1&cursor=${page1.nextCursor}`)).json();
    expect(page2).toMatchObject({ items: [{ memberId: lapsed }], nextCursor: null });

    // A cancelled member payment removes that visit, and consent revocation leaves the reach-out list.
    const voided = await sale(store, { day: '2026-11-21', memberId: first });
    expect((await call(store, 'GET', '/groups')).json().counts).toMatchObject({ 'first-visit': 0 });
    await correction(store, voided, '2026-11-21', -4500, true);
    await member(store, lapsed, 2, false);
    await member(store, lapsed, 1, true); // a stale revision changes nothing
    const after = (await call(store, 'GET', '/groups')).json();
    expect(after.counts).toMatchObject({ 'first-visit': 1, 'churn-risk': 2 });
    expect(after.reachOut).toMatchObject({ recipientIds: [], count: 0 });
    expect(after.sourceRevision).toBeGreaterThan(groups.sourceRevision);
  });

  it('isolates stores, requires the owner and validates inputs', async () => {
    const call = await server();
    const store = randomUUID();
    const memberId = randomUUID();
    await member(store, memberId, 1, true);
    await sale(store, { day: '2026-11-20', memberId });
    const other = (await call(randomUUID(), 'GET', '/groups')).json();
    expect(other).toMatchObject({ state: 'empty', counts: { 'churn-risk': 0, 'first-visit': 0, regular: 0 } });
    expect((await call(store, 'GET', '/groups', undefined, { 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
    expect((await call(store, 'GET', '/groups', undefined, { authorization: `Bearer ${randomUUID()}` })).statusCode).toBe(401);
    expect((await call(store, 'GET', '/groups', undefined, { 'x-navis-store-id': randomUUID() })).statusCode).toBe(403);
    expect((await call(store, 'GET', '/groups/unknown/customers')).json()).toMatchObject({ code: 'VALIDATION', reason: 'INVALID_GROUP' });
    expect((await call(store, 'GET', '/groups/regular/customers?limit=0')).statusCode).toBe(400);
    expect((await call(store, 'GET', '/groups/regular/customers?cursor=bad')).statusCode).toBe(400);
    const rows = await pool.query('SELECT 1 FROM marketing.r19_sale');
    expect(rows.rows).toEqual([]); // runtime role without store context reads nothing
  });

  it('replays the same source event once and quarantines a conflicting one', async () => {
    const store = randomUUID();
    const memberId = randomUUID();
    const settlementId = randomUUID();
    const event = envelope(store, 'pos', 'pos.sale_recognized.v1', settlementId, { settlementId, billId: randomUUID(),
      orderId: randomUUID(), businessDate: '2026-11-20', lines: [], amount: 4500, cost: 1500,
      incompleteMarginCoverage: false, memberId });
    await deliver(event);
    await deliver(event);
    const conflicting = { ...event, eventId: randomUUID(), payload: { ...event.payload, amount: 9000 } };
    await expect(deliver(conflicting)).rejects.toBeInstanceOf(PermanentStreamError);
    await expect(deliver(envelope(store, 'pos', 'pos.sale_recognized.v1', settlementId, { settlementId: 'x' })))
      .rejects.toBeInstanceOf(PermanentStreamError);
    await expect(deliver(envelope(store, 'customer', 'customer.contact_state_changed.v1', memberId,
      { memberId, revision: 1, active: true, contactAllowed: false, marketingAllowed: true })))
      .rejects.toBeInstanceOf(PermanentStreamError);
    // Note-only member changes carry no contact state and are ignored.
    await deliver(envelope(store, 'customer', 'customer.member_changed.v1', memberId, { memberId, noteId: randomUUID(), noteRevision: 1 }));
    const { rows } = await inStore(pool, store, db => db.query('SELECT amount FROM marketing.r19_sale'));
    expect(rows).toEqual([{ amount: '4500' }]);
  });
});

describe('reach-out eligibility', () => {
  it('clears a projected initial on a newer contact snapshot and ignores a stale grant', async () => {
    const call = await server();
    const store = randomUUID();
    const memberId = randomUUID();
    const path = '/groups/first-visit/customers';
    await member(store, memberId, 1, true, true, '김');
    await sale(store, { day: '2026-11-20', memberId });
    expect((await call(store, 'GET', path)).json().items).toMatchObject([{ memberId, displayName: '김○○', selectable: true }]);
    await member(store, memberId, 2, false);
    await member(store, memberId, 1, true, true, '김');
    expect((await call(store, 'GET', path)).json().items).toMatchObject([{ memberId, displayName: null, selectable: false }]);
    await member(store, memberId, 3, true, true, '박');
    await member(store, memberId, 4, true);
    expect((await call(store, 'GET', path)).json().items).toMatchObject([{ memberId, displayName: null, selectable: true }]);
  });

  it('returns only consented churn-risk members at the current revision and rechecks at commit', async () => {
    const call = await server();
    const store = randomUUID();
    const [consented, refused, regular] = [randomUUID(), randomUUID(), randomUUID()];
    await member(store, consented, 1, true);
    await member(store, refused, 1, false);
    await member(store, regular, 1, true);
    for (const id of [consented, refused]) for (const day of ['2026-09-01', '2026-09-15']) await sale(store, { day, memberId: id });
    for (const day of ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-20']) await sale(store, { day, memberId: regular });
    const { sourceRevision } = (await call(store, 'GET', '/groups')).json();
    const check = await call(store, 'POST', '/groups/churn-risk/reach-out-check',
      { recipientIds: [consented, refused, regular, consented], expectedSourceRevision: sourceRevision });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toEqual({ groupId: 'churn-risk', eligibleIds: [consented], blocked: [
      { memberId: refused, reason: 'NO_MARKETING_CONSENT' }, { memberId: regular, reason: 'NOT_IN_GROUP' },
    ], sourceRevision, asOf: clock.toISOString() });
    const stale = await call(store, 'POST', '/groups/churn-risk/reach-out-check',
      { recipientIds: [consented], expectedSourceRevision: sourceRevision - 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'CONFLICT', reason: 'STALE_REVISION', details: { sourceRevision } });
    expect((await call(store, 'POST', '/groups/churn-risk/reach-out-check', { recipientIds: [] })).statusCode).toBe(400);
    expect((await call(store, 'POST', '/groups/regular/reach-out-check', { recipientIds: [regular] })).statusCode).toBe(400);
    const commit = (ids: string[]) => inStore(pool, store, db => routes.assertReachOutRecipients(db, store, ids, clock));
    await expect(commit([consented])).resolves.toEqual([consented]);
    await expect(commit([refused])).rejects.toMatchObject({ status: 409, reason: 'RECIPIENT_NOT_ELIGIBLE' });
  });
});

function ledger(store: string, codes: Awaited<ReturnType<CouponLedger['codes']>>,
  redemptions: Awaited<ReturnType<CouponLedger['redemptions']>>): CouponLedger {
  return {
    async codes(_db, storeId, period) {
      return storeId === store ? codes.filter(code => code.activatedOn !== null
        && code.activatedOn >= period.from && code.activatedOn <= period.to) : [];
    },
    async redemptions(_db, storeId, codeIds, until) {
      return storeId === store ? redemptions.filter(row => codeIds.includes(row.codeId) && row.businessDate <= until) : [];
    },
  };
}

describe('marketing performance', () => {
  it('reconciles code issuance and use with POS payments, margin and matured repeat visits', async () => {
    const store = randomUUID();
    const [a, b] = [randomUUID(), randomUUID()];
    await member(store, a, 1, true);
    await member(store, b, 1, true);
    const s1 = await sale(store, { day: '2026-11-05', memberId: a, amount: 4300, cost: 1500 });
    const s2 = await sale(store, { day: '2026-11-10', amount: 9000, cost: null, incomplete: true });
    const s3 = await sale(store, { day: '2026-11-12', amount: 3000, cost: 900 });
    const s4 = await sale(store, { day: '2026-10-21', memberId: b, amount: 5000, cost: 2000 });
    await sale(store, { day: '2026-11-01', memberId: b }); // B came back within 30 days of the October use
    await correction(store, s1, '2026-11-06', -300, false);
    const codes = [
      { codeId: 'code-sms', couponId: 'c-reach', couponName: '다시 와 주셔서 고마워요', route: 'sms', issued: 5, activatedOn: '2026-11-03', status: 'active' as const },
      { codeId: 'code-place', couponId: 'c-slot', couponName: '빈 시간 쿠폰', route: 'place_news', issued: 10, activatedOn: '2026-11-05', status: 'paused' as const },
      { codeId: 'code-old', couponId: 'c-old', couponName: '지난 쿠폰', route: 'blog', issued: 4, activatedOn: '2026-10-20', status: 'ended' as const },
    ];
    const redemptions = [
      { redemptionId: 'r1', codeId: 'code-sms', couponId: 'c-reach', settlementId: s1, memberId: a, businessDate: '2026-11-05', discount: 500, reversed: false },
      { redemptionId: 'r2', codeId: 'code-place', couponId: 'c-slot', settlementId: s2, memberId: null, businessDate: '2026-11-10', discount: 1000, reversed: false },
      { redemptionId: 'r3', codeId: 'code-place', couponId: 'c-slot', settlementId: s3, memberId: null, businessDate: '2026-11-12', discount: 1000, reversed: true },
      { redemptionId: 'r4', codeId: 'code-old', couponId: 'c-old', settlementId: s4, memberId: b, businessDate: '2026-10-21', discount: 700, reversed: false },
    ];
    const call = await server({ coupons: ledger(store, codes, redemptions) });
    const month = await call(store, 'GET', '/performance');
    expect(month.statusCode, month.body).toBe(200);
    const body = month.json();
    expect(body).toMatchObject({
      period: { from: '2026-11-01', to: '2026-11-21', kind: 'this-month' }, state: 'ready', missing: [],
      coupons: {
        issued: 15, used: 2, rate: 13.3,
        payment: { paidAmount: 13000, discount: 1500, cost: null, knownCost: 1500, profit: null, costIncomplete: true,
          settlements: 2, pendingSettlements: 0 },
        repeat: { windowDays: 30, matured: 0, returned: 0, immature: 1, unlinked: 1, rate: null },
        routes: [
          { route: 'place_news', issued: 10, used: 1, rate: 10 },
          { route: 'sms', issued: 5, used: 1, rate: 20 },
        ],
        byCoupon: [
          expect.objectContaining({ couponId: 'c-reach', status: 'active', issued: 5, used: 1, rate: 20, paidAmount: 4000 }),
          expect.objectContaining({ couponId: 'c-slot', status: 'paused', issued: 10, used: 1, rate: 10, paidAmount: 9000 }),
        ],
      },
      comparison: { period: { from: '2026-10-01', to: '2026-10-31', kind: 'last-month' }, issued: 4, used: 1, rate: 25 },
      rateDelta: -11.7,
    });
    expect(month.body).not.toMatch(/attributed|revenueAttributed/);

    const last = (await call(store, 'GET', '/performance?period=last-month')).json();
    expect(last.coupons).toMatchObject({ issued: 4, used: 1,
      payment: { paidAmount: 5000, cost: 2000, profit: 3000, costIncomplete: false },
      repeat: { matured: 1, returned: 1, immature: 0, rate: 100 } });
    const custom = (await call(store, 'GET', '/performance?from=2026-11-10&to=2026-11-12')).json();
    expect(custom.period).toEqual({ from: '2026-11-10', to: '2026-11-12', kind: 'custom' });
    expect((await call(store, 'GET', '/performance?from=2026-11-12&to=2026-11-10')).statusCode).toBe(400);
    expect((await call(store, 'GET', '/performance?from=2026-01-01&to=2026-11-10')).json().reason).toBe('PERIOD_TOO_LONG');
    expect((await call(store, 'GET', '/performance?period=year')).statusCode).toBe(400);
  });

  it('marks the coupon ledger as missing instead of inventing numbers', async () => {
    const call = await server();
    const body = (await call(randomUUID(), 'GET', '/performance')).json();
    expect(body).toMatchObject({ state: 'partial', missing: ['coupons'], coupons: null, comparison: null, rateDelta: null });
    const failing = await server({ coupons: { codes: async () => { throw new Error('down'); }, redemptions: async () => [] } });
    expect((await failing(randomUUID(), 'GET', '/performance')).json()).toMatchObject({ missing: ['coupons'], coupons: null });
  });
});

describe('channel reports', () => {
  it('returns owner-visible cards with each source and period and never adds a total', async () => {
    const place = 'https://help.naver.com/service/30026/contents/20524?lang=ko&osType=COMMONOS';
    const blog = 'https://help.naver.com/service/5593/contents/15314?lang=ko&osType=COMMONOS';
    const calls: unknown[] = [];
    const channels: ChannelReportPort = {
      async channelReport(storeId, channel, options) {
        calls.push([storeId, channel, options]);
        if (channel === 'clip') throw new Error('provider unavailable');
        if (channel === 'blog') return { source: blog, period: { startDate: '2026-11-20', endDate: '2026-11-20' },
          cards: [{ metric: 'dailyViews', value: 31 }, { metric: 'cumulativeViews', value: 480,
            period: { startDate: '2026-10-02', endDate: '2026-11-20' } }] };
        return { source: place, period: { startDate: '2026-11-14', endDate: '2026-11-20' },
          cards: [{ metric: 'views', value: 1200, changeRate: 4.5 }, { metric: 'smartCallCalls', value: 6 },
            { metric: 'demographics', value: 1 }] };
      },
    };
    const call = await server({ channels });
    const store = randomUUID();
    const result = await call(store, 'GET', '/channel-reports?unit=week');
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ asOf: clock.toISOString(), businessDate: '2026-11-21', items: [
      { channel: 'place', state: 'ready', source: place, period: { startDate: '2026-11-14', endDate: '2026-11-20' },
        cards: [{ metric: 'views', value: 1200, changeRate: 4.5 }, { metric: 'smartCallCalls', value: 6 }] },
      { channel: 'blog', state: 'ready', source: blog, period: { startDate: '2026-11-20', endDate: '2026-11-20' },
        cards: [{ metric: 'dailyViews', value: 31 }, { metric: 'cumulativeViews', value: 480,
          period: { startDate: '2026-10-02', endDate: '2026-11-20' } }] },
      { channel: 'clip', state: 'unavailable', source: 'https://help.naver.com/service/30048/contents/25170?osType=PC', period: null, cards: [] },
    ] });
    expect(calls).toEqual([[store, 'place', { date: '2026-11-20', unit: 'week' }], [store, 'blog', { date: '2026-11-20' }],
      [store, 'clip', {}]]);
    expect(result.body).not.toMatch(/total|sum|attributed/i);
    const mismatched = await server({ channels: { channelReport: async () => ({ source: 'https://example.invalid',
      period: { startDate: '2026-11-20', endDate: '2026-11-20' }, cards: [] }) } });
    expect((await mismatched(store, 'GET', '/channel-reports')).json().items.map((item: { state: string }) => item.state))
      .toEqual(['unavailable', 'unavailable', 'unavailable']);
    const none = await server();
    expect((await none(store, 'GET', '/channel-reports')).json().items.every((item: { state: string }) => item.state === 'unavailable')).toBe(true);
    expect((await none(store, 'GET', '/channel-reports?unit=month')).statusCode).toBe(400);
  });
});

describe("today's actions", () => {
  it('orders real cells now, today, week, folds handled ones and names missing sources', async () => {
    const sources: TodaySources = {
      async quietSlots() {
        return [{ slotId: 'slot-a', date: '2026-11-24', startHour: 14, endHour: 16, regulars: 3, handled: true },
          { slotId: 'slot-b', date: '2026-11-25', startHour: 15, endHour: 17, regulars: 2, handled: false }];
      },
      async expiringLots() { return [{ lotId: randomUUID(), itemName: '버터 소금빵', quantity: 6, expiresOn: '2026-11-21', handled: false }]; },
      async replies() { return { waiting: 4, withDraft: 2, firstWaitingId: 'inq-1', firstDraftId: 'inq-2' }; },
      async assets() { return { eligiblePhotos: 39, postedVideos: 0, firstAssetId: 'photo-1' }; },
    };
    const call = await server({ today: sources });
    const store = randomUUID();
    const today = (await call(store, 'GET', '/recommendations')).json();
    expect(today).toMatchObject({ businessDate: '2026-11-21', state: 'ready', missing: [], folded: [], cells: [
      { slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: 2 },
        quietSlot: { slotId: 'slot-b', date: '2026-11-25', weekday: 3, startHour: 15, endHour: 17 },
        ref: { featureId: 'slot-coupon', view: 'send', itemId: 'slot-b', focus: 'action' } },
      { slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: 4, drafted: 2 },
        ref: { featureId: 'ai-response', itemId: 'inq-2', focus: 'action' } },
      { slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: 39 },
        ref: { featureId: 'promo-video', view: 'create', focus: 'action' } },
    ], tapTarget: { featureId: 'slot-coupon', view: 'send' } });

    const handled = await server({ today: { ...sources, quietSlots: async () => [],
      replies: async () => ({ waiting: 0, withDraft: 0, firstWaitingId: null, firstDraftId: null }),
      assets: async () => { throw new Error('down'); } } });
    const partial = (await handled(store, 'GET', '/recommendations')).json();
    expect(partial).toMatchObject({ state: 'partial', missing: ['assets'], folded: ['today', 'week'],
      cells: [{ slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: 6, itemName: '버터 소금빵' } }] });
    const none = await server();
    expect((await none(store, 'GET', '/recommendations')).json()).toMatchObject({ state: 'partial', cells: [],
      missing: ['coupons', 'replies', 'assets'], folded: ['now', 'today', 'week'], tapTarget: null });
    const empty = await server({ today: { quietSlots: async () => [], expiringLots: async () => [],
      replies: async () => ({ waiting: 0, withDraft: 0, firstWaitingId: null, firstDraftId: null }),
      assets: async () => ({ eligiblePhotos: 0, postedVideos: 0, firstAssetId: null }) } });
    expect((await empty(store, 'GET', '/recommendations')).json()).toMatchObject({ state: 'empty', cells: [] });
  });
});

describe('shared reads for composition and B14', () => {
  it('lists consented slot regulars from real visit hours and merges same-type handlers in order', async () => {
    const store = randomUUID();
    const [twice, once, refused] = [randomUUID(), randomUUID(), randomUUID()];
    await member(store, twice, 1, true);
    await member(store, once, 1, true);
    await member(store, refused, 1, false);
    // Tuesdays 2026-11-10 and 2026-11-17 at 15:00 KST; one visit outside the hours does not count.
    for (const day of ['2026-11-10', '2026-11-17']) {
      await sale(store, { day, memberId: twice, hour: 15 });
      await sale(store, { day, memberId: refused, hour: 15 });
    }
    await sale(store, { day: '2026-11-10', memberId: once, hour: 15 });
    await sale(store, { day: '2026-11-17', memberId: once, hour: 18 });
    const regulars = await inStore(pool, store, db => routes.slotRegulars(db, store,
      { day: '2026-11-21', weekday: 2, startHour: 14, endHour: 16 }));
    expect(regulars).toEqual([twice]);
    const { mergeStreamHandlers } = await import('./consumers.ts');
    const order: string[] = [];
    const merged = mergeStreamHandlers({ 'pos.sale_recognized.v1': async () => { order.push('b13'); } },
      { 'pos.sale_recognized.v1': async () => { order.push('b19'); }, 'pos.sale_corrected.v1': async () => { order.push('c'); } });
    await merged['pos.sale_recognized.v1']({} as never, {} as never);
    expect(order).toEqual(['b13', 'b19']);
    expect(Object.keys(merged).sort()).toEqual(['pos.sale_corrected.v1', 'pos.sale_recognized.v1']);
  });
});
