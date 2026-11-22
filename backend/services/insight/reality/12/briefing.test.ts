import { describe, expect, it, vi } from 'vitest';
import { arrivalDay, readSources, type BriefingContext } from './briefing.ts';
import { personaSources, recordSources } from './sources.ts';

const ctx: BriefingContext = {
  storeId: 'aa000000-0000-0000-0000-000000000001',
  actorId: 'aa000000-0000-0000-0000-000000000002',
  businessDay: '2026-11-21', now: new Date('2026-11-21T00:00:00Z'),
  timezone: 'Asia/Seoul', businessDayStart: '04:00:00',
};

describe('daily briefing sources', () => {
  it('keeps the arrival day separate from the POS day and uses weekday opening minus two hours', () => {
    const openings = ['09:00', '09:00', '09:00', '09:00', '09:00', '10:00', '11:00'];
    expect(arrivalDay({ ...ctx, now: new Date('2026-11-20T23:59:59Z') }, openings)).toBe('2026-11-20');
    expect(arrivalDay(ctx, openings)).toBe('2026-11-21');
    expect(arrivalDay(ctx, ['01:00', ...openings.slice(1)])).toBe('2026-11-21');
    expect(arrivalDay(ctx, ['09:00'])).toBeNull();
  });

  it('distinguishes empty results, failed reads and sources still being connected', async () => {
    const period = { from: ctx.businessDay, to: ctx.businessDay };
    const result = await readSources(ctx, {
      shifts: async () => ({ data: [], period }),
      finance: async () => { throw new Error('fixture failure'); },
    });
    expect(result.shifts).toEqual({ state: 'ready', origin: 'customer', period, data: [] });
    expect(result.finance).toMatchObject({ state: 'unavailable', data: null });
    expect(result.reservations).toMatchObject({ state: 'not-connected', data: null });
  });

  it('retains the provider period for FAKE SmartCall and review aggregates', async () => {
    const callsPeriod = { startDate: ctx.businessDay, endDate: ctx.businessDay };
    const smartCallSummary = vi.fn(async () => ({ period: callsPeriod, daily: [], channels: [] }));
    const reviewStatistics = async () => ({
      period: { unit: 'week', from: '2026-11-15', to: ctx.businessDay }, themes: [], topKeywords: {},
    });
    const result = await readSources(ctx, personaSources({ smartCallSummary, reviewStatistics }));
    expect(smartCallSummary).toHaveBeenCalledWith(ctx.storeId, callsPeriod);
    expect(result.smartCall).toMatchObject({ state: 'ready', origin: 'naver-smartcall', data: { daily: [] } });
    expect(result.reviewStatistics.period).toEqual({ from: '2026-11-15', to: ctx.businessDay });
  });

  it('scopes record reads, labels pagination and removes pickup contact fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.searchParams.get('limit') !== '50') return Response.json({ code: 'INVALID_LIMIT' }, { status: 400 });
      return Response.json({ items: [{ reservationId: 'pickup', date: ctx.businessDay, status: 'scheduled', phone: 'fixture-pii' }],
        nextCursor: 'another', sourceRevision: 4 });
    });
    const sources = recordSources({ pos: { url: 'http://pos:8080', token: 'test-only' } }, fetch);
    await expect(readSources(ctx, sources)).resolves.toMatchObject({ pickups: {
      state: 'partial', sourceRevision: 4, data: [{ reservationId: 'pickup', date: ctx.businessDay, status: 'scheduled' }],
    } });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/internal/v1/pos/stores/' + ctx.storeId);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-navis-user-id')).toBe(ctx.actorId);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('reads the scoped local visit pages for today and tomorrow, keeping only safe scheduling fields', async () => {
    const first = { reservationId: 'aa000000-0000-0000-0000-000000000003', date: '2026-11-21', time: '17:00',
      status: 'confirmed', partySize: 3, revision: 2 };
    const second = { reservationId: 'aa000000-0000-0000-0000-000000000004', date: '2026-11-22', time: '18:00',
      status: 'canceled', partySize: 4, revision: 3 };
    const unknownSize = { ...second, reservationId: 'naver-1234', status: 'confirmed', partySize: null };
    const asOf = '2026-11-21T00:01:00Z';
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname !== `/internal/v1/customer/stores/${ctx.storeId}/reservations`) return new Response(null, { status: 404 });
      expect(options?.method).toBe('GET');
      expect(Object.fromEntries(new Headers(options?.headers))).toMatchObject({ authorization: 'Bearer customer-read',
        'x-navis-store-id': ctx.storeId, 'x-navis-user-id': ctx.actorId, 'x-navis-store-role': 'owner' });
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ source: 'local', startDate: '2026-11-21', endDate: '2026-11-22', limit: '100' });
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) return Response.json({ items: [{ ...first, guestName: 'guest', phone: 'fixture-pii' }],
        nextCursor: first.reservationId, asOf, sourceRevision: 8, sourceStatus: { naver: 'ready' } });
      expect(cursor).toBe(first.reservationId);
      return Response.json({ items: [{ ...second, memberId: 'member', tableId: 'table' }, { ...unknownSize, phone: 'fixture-pii' }],
        nextCursor: null, asOf, sourceRevision: 8, sourceStatus: { naver: 'ready' } });
    });
    const result = await readSources(ctx, recordSources({ customer: { url: 'http://customer:3000', token: 'customer-read' } }, fetcher));
    expect(result.reservations).toEqual({ origin: 'customer', state: 'ready', period: { from: '2026-11-21', to: '2026-11-22' },
      asOf, sourceRevision: 8, data: [first, second, unknownSize] });
  });

  it('keeps a partial reservation page when a concurrent change makes the later page inconsistent', async () => {
    const first = { reservationId: 'first', date: '2026-11-21', time: '17:00', status: 'confirmed', partySize: 3, revision: 1 };
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/reservations')) return new Response(null, { status: 404 });
      return Response.json(url.searchParams.has('cursor')
        ? { items: [{ ...first, status: 'canceled', revision: 2 }], nextCursor: null, sourceRevision: 2 }
        : { items: [first], nextCursor: first.reservationId, sourceRevision: 1 });
    });
    const result = await readSources(ctx, recordSources({ customer: { url: 'http://customer:3000', token: 'customer-read' } }, fetcher));
    expect(result.reservations).toMatchObject({ state: 'partial', sourceRevision: 1, data: [first] });
  });

  it('reads a purchase order on the next page before reporting incomplete coverage', async () => {
    const historicalOrder = { poId: 'earlier-page', dueDate: '2026-11-20', status: 'complete', lines: [] };
    const dueToday = { poId: 'next-page', dueDate: ctx.businessDay, status: 'scheduled', lines: [{ polId: 'line', remaining: 2 }] };
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/purchase-orders')) return new Response(null, { status: 404 });
      return Response.json(url.searchParams.get('cursor') === historicalOrder.poId
        ? { items: [dueToday], nextCursor: null, sourceRevision: 4 }
        : { items: [historicalOrder], nextCursor: historicalOrder.poId, sourceRevision: 4 });
    });
    const sources = recordSources({ inventory: { url: 'http://inventory:3000', token: 'inventory-read' } }, fetcher);
    const result = await readSources(ctx, sources);
    expect(result.purchasing).toMatchObject({ state: 'ready', sourceRevision: 4, data: [historicalOrder, dueToday] });
  });

  it('uses the local widget’s week and retains full-period unread totals, coverage and source links', async () => {
    const period = { from: '2026-11-16', to: '2026-11-22' };
    const coverage = { region: '동작구', referenceDate: '2026-11-21', kinds: ['festival'] };
    const row = { id: 'event', revision: 2, kind: 'festival', title: '동네 행사', region: '동작구', authority: '동작구청',
      dateKind: 'event-date', sourceUrl: 'https://example.invalid/event', referenceDate: '2026-11-21', acknowledgedAt: null,
      updatedAt: '2026-11-21T00:00:00Z' };
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname !== `/internal/v1/marketing/stores/${ctx.storeId}/local-changes`) return new Response(null, { status: 404 });
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...period, limit: '100' });
      return Response.json({ period, coverage: { ...coverage, privateNote: 'detail' }, unreadCount: 120,
        items: [{ ...row, privateNote: 'detail' }], nextCursor: 'more', asOf: row.updatedAt, sourceRevision: 7 });
    });
    const result = await readSources(ctx, recordSources({ marketing: { url: 'http://marketing:3000', token: 'marketing-read' } }, fetcher));
    expect(result.local).toEqual({ state: 'partial', origin: 'marketing', period, asOf: row.updatedAt, sourceRevision: 7,
      data: { items: [row], coverage, unreadCount: 120 } });
  });

  it('keeps notice and reply status distinct from provider effects and omits draft, reply and audience content', async () => {
    const common = { revision: 2, updatedAt: '2026-11-21T00:00:00Z' };
    const manual = { ...common, id: 'inquiry', type: 'review', source: 'manual', status: 'done',
      draft: { source: 'navis' }, reply: { state: 'recorded' } };
    const naver = { ...manual, id: 'reply', source: 'review', reply: { state: 'saved' } };
    const closure = { eventId: 'event', revision: 3 };
    const draft = { ...common, id: 'draft', status: 'draft', channel: 'place-hours', startDate: '2026-11-22',
      endDate: '2026-11-22', closure, result: null };
    const sent = { ...draft, id: 'sent', status: 'done', channel: 'talktalk', result: { state: 'accepted' } };
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      expect(options?.method).toBe('GET');
      const path = url.pathname.split('/').at(-1);
      if (path === 'inquiries') return Response.json({ waitingCount: 3, asOf: common.updatedAt, sourceRevision: 6, nextCursor: 'more',
        items: [manual, naver].map(row => ({ ...row, text: 'review body', draft: { ...row.draft, text: 'draft' },
          reply: { ...row.reply, text: 'reply' }, providerRef: 'hidden' })) });
      if (path === 'notices') return Response.json({ waitingCount: 1, asOf: common.updatedAt, sourceRevision: 4, nextCursor: null,
        items: [{ ...draft, text: 'draft', closure: { ...closure, text: 'closure' } },
          { ...sent, recipientGroupId: 'audience', result: { ...sent.result, providerRef: 'hidden' } }] });
      return new Response(null, { status: 503 });
    });
    const result = await readSources(ctx, recordSources({ marketing: { url: 'http://marketing:3000', token: 'marketing-read' } }, fetcher));
    expect(result.reviews).toEqual({ origin: 'marketing', state: 'partial', period: null, asOf: common.updatedAt, sourceRevision: 6,
      data: { items: [manual, naver], waitingCount: 3 } });
    expect(result.notices).toEqual({ origin: 'marketing', state: 'ready', period: null, asOf: common.updatedAt, sourceRevision: 4,
      data: { items: [draft, sent], waitingCount: 1 } });
    expect(result.local).toMatchObject({ origin: 'marketing', state: 'unavailable', data: null });
  });
});

describe('tax and marketing briefing records', () => {
  const endpoints = {
    pos: { url: 'http://pos:3000', token: 'pos-read' },
    marketing: { url: 'http://marketing:3000', token: 'marketing-read' },
  };
  const asOf = ctx.now.toISOString();
  const period = { from: ctx.businessDay, to: ctx.businessDay };

  it('re-reads the POS deadline and paid state with a new request scope', async () => {
    let status = 'unpaid';
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/tax-payments')) return new Response(null, { status: 404 });
      expect(url.pathname).toBe(`/internal/v1/pos/stores/${ctx.storeId}/tax-payments`);
      expect(url.search).toBe('?limit=50');
      expect(options?.method).toBe('GET');
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer pos-read');
      const unpaid = status === 'unpaid';
      const row = { taxPaymentId: 'tax', type: '원천세', dueOn: ctx.businessDay, status, amount: 20000,
        paidOn: unpaid ? null : ctx.businessDay, revision: unpaid ? 1 : 2, evidenceFiles: [{ fileId: 'private' }] };
      return Response.json({ today: ctx.businessDay, asOf, sourceRevision: row.revision, items: [row], nextCursor: 'older',
        next: unpaid ? row : null, summary: { dueSoonCount: Number(unpaid), paidCount: Number(!unpaid) } });
    });
    const readers = recordSources(endpoints, fetcher);
    const { tax } = await readSources(ctx, readers);
    expect(tax).toMatchObject({ origin: 'pos', state: 'partial', period: null, asOf, sourceRevision: 1,
      data: { next: { taxPaymentId: 'tax', status: 'unpaid' }, summary: { dueSoonCount: 1, paidCount: 0 } } });
    expect(JSON.stringify(tax)).not.toContain('evidenceFiles');
    status = 'paid';
    const fresh = await readSources({ ...ctx, actorId: 'aa000000-0000-0000-0000-000000000003' }, readers);
    expect(fresh.tax).toMatchObject({ sourceRevision: 2, data: { next: null, items: [{ status: 'paid', paidOn: ctx.businessDay }],
      summary: { dueSoonCount: 0, paidCount: 1 } } });
    const calls = fetcher.mock.calls.filter(([input]) => String(input).includes('/tax-payments'));
    expect(new Headers(calls[1]?.[1]?.headers).get('x-navis-user-id')).toBe('aa000000-0000-0000-0000-000000000003');
  });

  it('keeps channel card periods, recommendation coverage and Navis coupon expiry distinct', async () => {
    const reportPeriod = { startDate: '2026-11-20', endDate: '2026-11-20' };
    const card = { metric: 'views', value: 19, period: reportPeriod };
    const channel = { channel: 'place', state: 'ready', source: 'https://help.naver.com/place', period: reportPeriod };
    const missingChannel = { channel: 'blog', state: 'unavailable', source: 'https://help.naver.com/blog', period: null, cards: [] };
    const coupon = { couponId: 'coupon', origin: 'expiry', status: 'active', endsOn: ctx.businessDay, endingSoon: true, revision: 3 };
    const ref = { featureId: 'expiry-coupon', itemId: 'lot', focus: 'action' };
    const action = { slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: 2, itemName: '우유' }, ref };
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      expect(options?.method).toBe('GET');
      const clock = { businessDate: ctx.businessDay, asOf };
      if (url.pathname.endsWith('/channel-reports')) return Response.json({ ...clock, attributedSales: 7000,
        items: [{ ...channel, cards: [{ ...card, attributedSales: 7000, period: { ...reportPeriod, privateId: 'private' } }] }, missingChannel] });
      if (url.pathname.endsWith('/recommendations')) return Response.json({ ...clock, state: 'partial', missing: ['replies'],
        cells: [{ ...action, params: { ...action.params, text: 'private' }, ref: { ...ref, token: 'private' } }],
        folded: ['today', 'week'], tapTarget: { featureId: ref.featureId } });
      if (url.pathname.endsWith('/coupons')) {
        expect(url.search).toBe('?status=active&limit=100');
        return Response.json({ ...clock, items: [{ ...coupon, codes: ['private'], providerState: 'published' }],
          nextCursor: 'more', sourceRevision: 3 });
      }
      return new Response(null, { status: 404 });
    });
    const result = await readSources(ctx, recordSources(endpoints, fetcher));
    expect(result.channels).toEqual({ origin: 'marketing', state: 'partial', period: null, asOf,
      data: { items: [{ ...channel, cards: [card] }, missingChannel] } });
    expect(result.marketingToday).toEqual({ origin: 'marketing', state: 'partial', period, asOf,
      data: { cells: [action], missing: ['replies'], folded: ['today', 'week'], tapTarget: { featureId: ref.featureId } } });
    expect(result.coupons).toEqual({ origin: 'marketing', state: 'partial', period: null, asOf, sourceRevision: 3,
      data: [coupon] });
  });
});
