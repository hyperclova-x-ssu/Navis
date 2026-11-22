import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { NaverBinding, NaverRequestScope } from '../../../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../../../packages/naver/transport/index.ts';
import { createInsightNaver } from '../../naver/index.ts';
import { InsightError } from '../../scope.ts';
import { naverInsightRoutes, registerNaverInsightReads, type NaverReadOptions } from './routes.ts';
import { sources } from './reads.ts';

const storeId = 'c05409a6-f082-5964-a787-c1ed3184988b';
const otherStore = 'aa000000-0000-4000-8000-000000000002';
const actorId = 'bb000000-0000-4000-8000-000000000001';
const adsRecord = 'cmp-a001-01-000000000000001';
// 15:45 KST on 2026-11-17, the persona fixture instant.
const now = () => new Date('2026-11-17T06:45:00Z');
const recommendationPath = '/partner-assumed/v1/financial-center/recommendations';
const recommendation = {
  title: '서울 소상공인 레시피 특허 출원 후속지원',
  officialNoticeUrl: 'https://pms.ripc.org/pms/biz/applicant/notice/info.do?bizYear=2026&noticeSeq=4956',
  startDate: '2026-09-29', endDate: '2026-10-08', status: 'closed',
};
const detail = {
  ...recommendation,
  overview: '음식·음료 레시피의 국내 특허 출원을 사업체당 한 건 지원하는 서울지식재산센터 공고입니다.',
  eligibility: '2026년 서울지식재산센터의 상표출원 또는 IP창출종합패키지 지원을 받은 사업자등록 소상공인 대상입니다.',
  applicationMethod: '지역지식재산센터 사업관리시스템에서 공고를 찾아 온라인으로 신청합니다.',
  documents: ['후속지원 활용계획서'],
};
const statistics = {
  period: { unit: 'week', from: '2026-11-09', to: '2026-11-15' },
  themes: [{ theme: '메뉴', positiveCount: 2, negativeCount: 0 }, { theme: '운영', positiveCount: 0, negativeCount: 1 }],
  topKeywords: {
    positive: [{ keyword: '고소한 라떼', count: 2, relatedReviews: [{ text: '라떼가 고소했어요.' }] }],
    negative: [{ keyword: '대기 시간', count: 1, relatedReviews: [{ text: '조금 기다렸어요.' }] }],
  },
};

type Behaviour = {
  average?: number | null; statistics?: 'fail'; recommendations?: 'fail' | 'bad-link'; ads?: 'fail' | 'absent';
};

/** A FAKE-mode persona: no socket, no NAVER, no CLOVA. Every call is recorded. */
function persona(behaviour: Behaviour = {}) {
  const calls: { operation: string; path: string; storeId: string }[] = [];
  const handler = (scope: NaverRequestScope) => {
    const path = scope.url.pathname;
    const query = scope.url.searchParams;
    calls.push({ operation: scope.operation, path: path + scope.url.search, storeId: scope.storeId });
    switch (scope.operation) {
      case 'pn09.financial-center.list':
        if (behaviour.recommendations === 'fail') return new Response(null, { status: 500 });
        return Response.json([recommendation], { headers: { link: behaviour.recommendations === 'bad-link'
          ? '<https://elsewhere.invalid/x>; rel="item"' : `<${recommendationPath}/recipe-patent-2026>; rel="item"` } });
      case 'pn09.financial-center.read':
        return path.endsWith('/recipe-patent-2026') ? Response.json({ ...detail, internalScore: 9 })
          : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
      case 'pn03.stats.read': {
        if (behaviour.statistics === 'fail') return new Response(null, { status: 503 });
        const unit = query.get('period') ?? 'week';
        const to = '2026-11-15';
        const from = unit === 'day' ? to : unit === 'month' ? '2026-11-01' : '2026-11-09';
        return Response.json({ ...statistics, period: { unit, from, to } });
      }
      case 'pn03.reviews.list':
        return Response.json({ items: [{ ref: 'review-01', text: '라떼가 고소했어요.', keywords: [], media: [],
          stars: 5, reply: null, hasReply: false, reviewer: '실명' }], averageStars: behaviour.average === undefined ? 4.3 : behaviour.average });
      case 'pn12.ads': {
        if (behaviour.ads === 'fail') return Response.json({ code: 1002 }, { status: 400 });
        if (behaviour.ads === 'absent') return Response.json({ data: [] });
        return Response.json({ data: [{ id: query.get('ids'), impCnt: 735, clkCnt: 56, salesAmt: 7800, ctr: 7.6, convAmt: 99000 }] });
      }
      default:
        throw new Error('Unexpected operation ' + scope.operation);
    }
  };
  const operations: [string, NaverBinding['grade'], RegExp][] = [
    ['pn09.financial-center.list', 'O', /^\/partner-assumed\/v1\/financial-center\/recommendations$/],
    ['pn09.financial-center.read', 'O', /^\/partner-assumed\/v1\/financial-center\/recommendations\/[\w-]+$/],
    ['pn03.stats.read', 'O', /^\/partner-assumed\/v1\/review-statistics$/],
    ['pn03.reviews.list', 'P', /^\/partner-assumed\/v1\/reviews$/],
    ['pn12.ads', 'W', /^\/stats$/],
  ];
  const transport = createNaverTransport({
    fakeOnly: true,
    bindings: operations.map(([operation, grade, route]) => ({
      operation, grade, route, method: 'GET', storeId, providerAccount: 'ansungjalbu-cafe', mode: 'fake', handler,
    })),
  });
  return { calls, naver: createInsightNaver(transport) };
}

async function service(behaviour: Behaviour = {}, options: Partial<NaverReadOptions> = {}) {
  const fake = persona(behaviour);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InsightError) return reply.code(error.status).send({ code: error.code });
    throw error;
  });
  registerNaverInsightReads(app, { gatewayToken: 'gateway', naver: fake.naver, linkedStores: [storeId], adsRecord, now, ...options });
  await app.ready();
  const get = (suffix: string, { store = storeId, role = 'owner', clock = true, token = 'gateway' } = {}) => app.inject({
    url: `/internal/v1/insight/stores/${store}/insight${suffix}`,
    headers: {
      authorization: `Bearer ${token}`, 'x-navis-store-id': store, 'x-navis-store-role': role, 'x-navis-user-id': actorId,
      ...(clock && { 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00' }),
    },
  });
  return { app, get, calls: fake.calls };
}

describe('GAP-INS owner reads of the NAVER virtual server', () => {
  it('rejects missing workload credentials and non-owner scope before any provider call', async () => {
    const { app, get, calls } = await service();
    for (const [, path] of naverInsightRoutes) {
      const suffix = path.replace('/insight', '').replace(':ref', 'recipe-patent-2026');
      expect((await get(suffix, { token: 'other' })).statusCode).toBe(401);
      expect((await get(suffix, { role: 'staff' })).statusCode).toBe(403);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it('registers read routes only, exactly as published for the gateway allowlist', async () => {
    const { app } = await service();
    expect(naverInsightRoutes.every(([method]) => method === 'GET')).toBe(true);
    for (const [method, path] of naverInsightRoutes) {
      const url = '/internal/v1/insight/stores/:storeId' + path;
      expect(app.hasRoute({ method, url })).toBe(true);
      for (const write of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) expect(app.hasRoute({ method: write, url })).toBe(false);
    }
    await app.close();
  });

  it('lists Financial Center recommendations read-only with the source and the provider status', async () => {
    const { app, get, calls } = await service();
    const first = await get('/financial-center/recommendations');
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toEqual({
      state: 'ready', source: 'naver-financial-center', sourceUrl: sources.financialCenter,
      items: [{ ref: 'recipe-patent-2026', source: 'naver-financial-center', ...recommendation }],
      nextCursor: null, asOf: now().toISOString(), sourceRevision: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(body.items[0]).not.toHaveProperty('matches');
    expect((await get('/financial-center/recommendations')).json().sourceRevision).toBe(body.sourceRevision);
    expect(calls.map(call => call.operation)).toEqual(['pn09.financial-center.list', 'pn09.financial-center.list']);
    await app.close();
  });

  it('reads one recommendation with overview, eligibility text, method, documents and official link only', async () => {
    const { app, get } = await service();
    const response = await get('/financial-center/recommendations/recipe-patent-2026');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ref: 'recipe-patent-2026', source: 'naver-financial-center', sourceUrl: sources.financialCenter, ...detail,
      asOf: now().toISOString(),
    });
    expect((await get('/financial-center/recommendations/unknown-ref')).statusCode).toBe(404);
    expect((await get('/financial-center/recommendations/bad.ref')).statusCode).toBe(400);
    expect((await get('/financial-center/recommendations?limit=1')).statusCode).toBe(400);
    await app.close();
  });

  it('fails closed on provider errors and selector mismatches instead of showing partial recommendations', async () => {
    for (const recommendations of ['fail', 'bad-link'] as const) {
      const { app, get } = await service({ recommendations });
      const response = await get('/financial-center/recommendations');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: 'NAVER_SOURCE_UNAVAILABLE' });
      await app.close();
    }
  });

  it('reports stores without a linked NAVER account as not connected without calling the provider', async () => {
    const { app, get, calls } = await service();
    expect((await get('/financial-center/recommendations', { store: otherStore })).json())
      .toMatchObject({ state: 'not-connected', items: [] });
    expect((await get('/financial-center/recommendations/recipe-patent-2026', { store: otherStore })).statusCode).toBe(404);
    expect((await get('/review-insights', { store: otherStore })).json()).toMatchObject({
      state: 'not-connected', statistics: { state: 'not-connected' }, averageRating: { state: 'not-connected', value: null },
    });
    expect((await get('/channel-reports/search-ads', { store: otherStore })).json().items)
      .toEqual([{ channel: 'search-ads', state: 'not-connected', source: sources.searchAds, period: null, cards: [] }]);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('returns review AI statistics with the provider coverage (two-day lag) and the official average', async () => {
    const { app, get, calls } = await service();
    const response = await get('/review-insights');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state: 'ready', asOf: now().toISOString(), businessDate: '2026-11-17',
      statistics: {
        state: 'ready', source: 'naver-review-statistics', sourceUrl: sources.reviewStatistics,
        period: { unit: 'week', from: '2026-11-09', to: '2026-11-15' },
        coverage: { requestedTo: '2026-11-17', dataThrough: '2026-11-15', lagDays: 2 },
        themes: statistics.themes, topKeywords: statistics.topKeywords,
      },
      averageRating: {
        state: 'shown', source: 'naver-place-visitor-reviews', sourceUrl: sources.reviewStars, value: 4.3, minimumReviewers: 10,
      },
    });
    expect(calls.map(call => call.path).sort()).toEqual([
      '/partner-assumed/v1/review-statistics?period=week&to=2026-11-17',
      '/partner-assumed/v1/reviews?scope=venue&limit=1',
    ]);
    const month = (await get('/review-insights?unit=month&to=2026-11-16')).json();
    expect(month.statistics.period).toEqual({ unit: 'month', from: '2026-11-01', to: '2026-11-15' });
    expect(month.statistics.coverage).toEqual({ requestedTo: '2026-11-16', dataThrough: '2026-11-15', lagDays: 1 });
    await app.close();
  });

  it('hides the average below the official reviewer minimum and keeps each part independent', async () => {
    const hidden = await service({ average: null });
    expect((await hidden.get('/review-insights')).json().averageRating)
      .toEqual({ state: 'hidden', source: 'naver-place-visitor-reviews', sourceUrl: sources.reviewStars, value: null, minimumReviewers: 10 });
    await hidden.app.close();

    const partial = await service({ statistics: 'fail' });
    const body = (await partial.get('/review-insights')).json();
    expect(body.statistics).toEqual({ state: 'unavailable', source: 'naver-review-statistics', sourceUrl: sources.reviewStatistics });
    expect(body.averageRating).toMatchObject({ state: 'shown', value: 4.3 });
    await partial.app.close();

    const invalid = await service({ average: 7 as unknown as number });
    expect((await invalid.get('/review-insights')).json().averageRating).toMatchObject({ state: 'unavailable', value: null });
    await invalid.app.close();
  });

  it('validates review statistics inputs and needs the store operating clock', async () => {
    const { app, get, calls } = await service();
    expect((await get('/review-insights?unit=year')).statusCode).toBe(400);
    expect((await get('/review-insights?to=2026-11-18')).statusCode).toBe(400);
    expect((await get('/review-insights?to=2026-02-30')).statusCode).toBe(400);
    expect((await get('/review-insights?sentiment=1')).statusCode).toBe(400);
    expect((await get('/review-insights?unit=day&unit=week')).statusCode).toBe(400);
    const clockless = await get('/review-insights', { clock: false });
    expect(clockless.statusCode).toBe(503);
    expect(clockless.json()).toEqual({ code: 'STORE_CLOCK_UNAVAILABLE' });
    expect(calls).toEqual([]);
    await app.close();
  });

  it('reads the Search Ads card in the channel-report shape with impressions, clicks and cost only', async () => {
    const { app, get, calls } = await service();
    const response = await get('/channel-reports/search-ads');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asOf: now().toISOString(), businessDate: '2026-11-17',
      items: [{ channel: 'search-ads', state: 'ready', source: sources.searchAds,
        period: { startDate: '2026-11-16', endDate: '2026-11-16' },
        cards: [{ metric: 'impressions', value: 735 }, { metric: 'clicks', value: 56 }, { metric: 'cost', value: 7800 }] }],
    });
    const week = (await get('/channel-reports/search-ads?date=2026-11-15&unit=week')).json();
    expect(week.items[0].period).toEqual({ startDate: '2026-11-09', endDate: '2026-11-15' });
    const wire = new URL('https://x.invalid' + calls[1]!.path).searchParams;
    expect(wire.get('ids')).toBe(adsRecord);
    expect(JSON.parse(wire.get('fields')!)).toEqual(['impCnt', 'clkCnt', 'salesAmt']);
    expect(JSON.parse(wire.get('timeRange')!)).toEqual({ since: '2026-11-09', until: '2026-11-15' });
    await app.close();
  });

  it('keeps absent Search Ads cards absent, marks failures unavailable and needs a linked Ads record', async () => {
    const absent = await service({ ads: 'absent' });
    expect((await absent.get('/channel-reports/search-ads')).json().items[0])
      .toMatchObject({ state: 'ready', period: { startDate: '2026-11-16', endDate: '2026-11-16' }, cards: [] });
    await absent.app.close();
    const failed = await service({ ads: 'fail' });
    expect((await failed.get('/channel-reports/search-ads')).json().items[0])
      .toEqual({ channel: 'search-ads', state: 'unavailable', source: sources.searchAds, period: null, cards: [] });
    await failed.app.close();
    const unlinked = await service({}, { adsRecord: undefined });
    expect((await unlinked.get('/channel-reports/search-ads')).json().items[0]).toMatchObject({ state: 'not-connected' });
    expect(unlinked.calls).toEqual([]);
    await unlinked.app.close();
  });

  it('validates Search Ads dates against the business day', async () => {
    const { app, get, calls } = await service();
    expect((await get('/channel-reports/search-ads?date=2026-11-18')).statusCode).toBe(400);
    expect((await get('/channel-reports/search-ads?unit=month')).statusCode).toBe(400);
    expect((await get('/channel-reports/search-ads?date=11/15')).statusCode).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });
});
