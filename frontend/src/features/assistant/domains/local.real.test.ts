import { expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/widget-data';
import type { RealLocal } from '../../../data/reality/13/dto';
import type { TrendRanking } from '../../../data/reality/13/trend-ranking';
import { localDomain, routeClassifiedTrendOverview } from './local';

const period = { from: '2026-11-11', to: '2026-11-17' };
const band = (startHour: number, estimate: number) => ({
  region: '상도동', quarter: '2026-Q4', weekday: 2, startHour, endHour: startHour + 1, estimate,
  referenceDate: '2026-11-01', refreshedAt: '2026-11-17T06:45:00Z', sourceUrl: 'https://data.seoul.go.kr',
});
const realLocal: RealLocal = {
  storeId: 'store', period, changes: [], coverage: null, unreadCount: 0, offers: [], peers: [], peersAvailable: true,
  trade: {
    period, asOf: '2026-11-17T06:45:00Z',
    population: { weekday: 2, quarter: '2026-Q4', status: 'available', items: [band(11, 990), band(12, 300), band(13, 350)] },
    sales: { status: 'available', items: [{ hour: 12, quantity: 9, settlementIds: [] }] },
  },
  trends: {
    period, asOf: '2026-11-17T06:45:00Z', sales: { status: 'empty', items: [] },
    search: { status: 'available', query: { startDate: period.from, endDate: period.to, keywordGroups: [{ groupName: '상도동 카공' }] },
      items: [{ period: period.from, ratio: 20 }, { period: period.to, ratio: 50 }] },
  },
};
const snapshot = (data = realLocal) => createWidgetDataStore({ realLocal: data }).getSnapshot();
const defaultCondition = { kind: 'default' } as const;
const ranking: TrendRanking = {
  status: 'ready', period: { from: '2026-10-13', to: '2026-11-16' }, fetchedAt: '2026-11-17T06:45:00Z',
  items: [
    { id: 'trend-barley', rank: 1, keyword: '보리 라테', changePercent: 25.4, sameWeekChangePercent: 12.6, classification: 'rising',
      isMenu: true, menuName: '아이스 보리 라테',
      points: [{ period: '2026-11-15', ratio: 62 }, { period: '2026-11-16', ratio: 75.1 }] },
    { id: 'trend-tart', rank: 2, keyword: '꿀밤 타르트', changePercent: -5.2, isMenu: false,
      points: [{ period: '2026-11-16', ratio: 40 }] },
    { id: 'trend-tea', rank: 3, keyword: '배 생강차', changePercent: -8.1, isMenu: false, points: [] },
    { id: 'trend-scone', rank: 4, keyword: '밤 스콘', changePercent: -11.2, isMenu: false, points: [] },
  ],
};
const withRanking = (result = ranking) => snapshot({ ...realLocal, trends: { ...realLocal.trends, ranking: result } });
const trendFacts = (state: ReturnType<typeof snapshot>) => {
  const result = localDomain.projectWidget?.(state, 'local-trends', defaultCondition, 'ko');
  if (!result || !('facts' in result)) throw new Error('Missing search-trend facts');
  return result.facts;
};
const tradeFacts = (data = realLocal) => {
  const result = localDomain.projectWidget?.(snapshot(data), 'trade-area', defaultCondition, 'ko');
  if (!result || !('facts' in result)) throw new Error('Missing trade-area facts');
  return result.facts;
};

it('reports the lunch average with its Seoul source and keeps POS quantities separate', () => {
  const route = localDomain.route?.('유동인구 점심때 몇 명이야?', snapshot(), 'ko');
  expect(route).toMatchObject({ factKeys: ['tradeArea.lunch.average', 'tradeArea.sales.12', 'tradeArea.sales.13'] });
  const facts = tradeFacts();
  expect(facts.find(fact => fact.key === 'tradeArea.lunch.average')).toMatchObject({
    value: 325, source: '서울 공개 자료', date: '2026-11-01', display: expect.stringContaining('12시~14시'),
  });
  expect(facts.find(fact => fact.key === 'tradeArea.sales.12')).toMatchObject({ value: 9, source: 'POS', start: period.from, end: period.to });
  expect(facts.find(fact => fact.key === 'tradeArea.sales.13')?.display).toContain('자료가 없어요');
});

it('leaves the lunch average unavailable when an hour has no coverage', () => {
  const trade = { ...realLocal.trade, population: { ...realLocal.trade.population, items: [band(12, 300)] } };
  expect(tradeFacts({ ...realLocal, trade }).find(fact => fact.key === 'tradeArea.lunch.average'))
    .toMatchObject({ value: 'unavailable', display: expect.stringContaining('자료가 없어요') });
});

it('projects identical stored W20 ranking facts in both modes without POS or standalone lookup data', () => {
  const operating = trendFacts(withRanking());
  const example = createWidgetDataStore({ exampleLocalTrends: { candidates: [], ranking } }).getSnapshot();
  expect(trendFacts(example)).toEqual(operating);
  expect(operating).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'localTrends.top', value: 25.4, display: expect.stringContaining('1위 보리 라테 · 4주 대비 +25.4%'),
      source: '네이버 검색어 트렌드 · 전국 · 상대값', start: ranking.period.from, end: ranking.period.to }),
    expect.objectContaining({ key: 'localTrends.period', display: expect.stringContaining('이전 4주') }),
    expect.objectContaining({ key: 'localTrends.definition', display: expect.stringContaining('앞선 28일 일평균') }),
    expect.objectContaining({ key: 'localTrends.source', display: '네이버 검색어 트렌드 · 전국 · 상대값 · 2026-11-17' }),
    expect.objectContaining({ key: 'localTrends.keyword.0.menu', value: '아이스 보리 라테' }),
    expect.objectContaining({ key: 'localTrends.keyword.1.menu', display: expect.stringContaining('우리 메뉴에 없음') }),
    expect.objectContaining({ key: 'localTrends.keyword.0.year', value: 12.6, unit: 'percent' }),
  ]));
  expect(operating.some(item => item.key.includes('.sales.') || item.value === '상도동 카공')).toBe(false);
});

it('scopes matched candidate reads and opens the exact ranked row through the existing handoff', () => {
  const state = withRanking();
  expect(localDomain.route?.('보리 라테 검색어 얼마나 늘었어?', state, 'ko')).toMatchObject({
    factKeys: expect.arrayContaining(['localTrends.keyword.0.change', 'localTrends.keyword.0.menu', 'localTrends.source']),
  });
  expect(localDomain.navigation?.('보리 라테 검색어 상세 열어줘', state, 'ko')).toMatchObject({
    args: { featureId: 'local-trends', view: 'keywords', itemId: 'trend-barley' },
  });
  const example = createWidgetDataStore({ exampleLocalTrends: { candidates: [], ranking: { ...ranking,
    items: ranking.items.map(row => ({ ...row, id: row.keyword })) }, } }).getSnapshot();
  expect(localDomain.navigation?.('보리 라테 검색어 상세 열어줘', example, 'ko')).toEqual({
    args: { featureId: 'local-trends', view: 'keywords' },
  });
  expect(localDomain.routePresentation?.('보리 라테 오늘 몇 잔 팔렸어?', state, 'ko')).toBeUndefined();
  expect(localDomain.route?.('검색어에서 꿀밤 타르트 언급 몇 건이야?', state, 'ko')).toMatchObject({
    factKeys: ['localTrends.interest.mentions', 'localTrends.source'],
  });
});

it('summarizes three ranked rows by default and includes the source and each menu match', () => {
  const result = localDomain.route?.('최근 인기 검색어 순위를 알려 줘', withRanking(), 'ko');
  expect(result).toMatchObject({ kind: 'answer' });
  if (!result || !('kind' in result) || result.kind !== 'answer') throw new Error('The ranking overview did not produce an answer');
  expect(result.answer.split('\n')).toEqual([
    '1위 보리 라테 · 4주 대비 +25.4% · 우리 메뉴: 아이스 보리 라테',
    '2위 꿀밤 타르트 · 4주 대비 -5.2% · 우리 메뉴에 없음',
    '3위 배 생강차 · 4주 대비 -8.1% · 우리 메뉴에 없음',
    '네이버 검색어 트렌드 · 전국 · 상대값 · 2026-11-17',
  ]);
  expect(result.destination).toBeUndefined();
});

it('offers one existing promotion widget only when classified shop use has a rising menu match', () => {
  const shopUse = ['가게 활용'];
  const result = routeClassifiedTrendOverview(withRanking(), 'ko', shopUse, '상승 중인 것 중 매장에서 활용할 후보도 추천해 줄래?');
  expect(result).toMatchObject({ kind: 'answer', answer: expect.stringContaining('아이스 보리 라테'),
    destination: { featureId: 'promo-video', step: 'place-video' } });
  const withoutMatch = withRanking({ ...ranking, items: ranking.items.map(row => ({ ...row, isMenu: false, menuName: null })) });
  expect(routeClassifiedTrendOverview(withoutMatch, 'ko', shopUse, '가게에서 써볼 만한 재료가 있을까?'))
    .toMatchObject({ kind: 'answer', answer: expect.stringContaining('우리 메뉴와 연결된 상승 검색어가 없어요') });
  expect(routeClassifiedTrendOverview(withRanking(), 'ko', [], '어떤 검색어가 인기야?')?.destination).toBeUndefined();
  expect(routeClassifiedTrendOverview(withRanking(), 'ko', ['보리 라테'], '보리 라테 검색 관심도는 어때?')).toBeUndefined();
  expect(routeClassifiedTrendOverview(withRanking(), 'ko', ['보리 라테'], '그 메뉴의 관심도는?')).toBeUndefined();
});

it('keeps display requests on each local data source and preserves an explicit open', () => {
  const state = withRanking();
  for (const [question, featureId] of [
    ['보리 라테 검색어 상세 보여줘', 'local-trends'],
    ['상권 유동인구 보여줘', 'trade-area'],
    ['이번 주 동네 변화 보여줘', 'local-changes'],
  ]) {
    expect(localDomain.route?.(question, state, 'ko')).toMatchObject({ intent: { kind: 'read', featureId } });
  }
  expect(localDomain.navigation?.('보리 라테 검색어 상세 열어줘', state, 'ko')).toMatchObject({
    args: { featureId: 'local-trends', view: 'keywords', itemId: 'trend-barley' },
  });
});

it('keeps unavailable, disabled and empty rankings separate from the retired lists', () => {
  expect(localDomain.projectWidget?.(snapshot(), 'local-trends', defaultCondition, 'ko')).toEqual({ status: 'unavailable' });
  expect(localDomain.route?.('요즘 뜨는 검색어 알려줘', withRanking({ ...ranking, status: 'disabled', items: [] }), 'ko'))
    .toMatchObject({ kind: 'answer', answer: expect.stringContaining('네이버 검색이 꺼져 있어요') });
  expect(localDomain.projectWidget?.(withRanking({ ...ranking, status: 'empty', items: [] }), 'local-trends', defaultCondition, 'ko'))
    .toEqual({ status: 'missing' });
  expect(localDomain.projectWidget?.(withRanking(), 'local-trends', { kind: 'dateRange', start: '2026-10-01', end: '2026-10-31' }, 'ko'))
    .toEqual({ status: 'unsupported_period' });
});

it('reports the saved Café publication and sends the owner to its receipt link', () => {
  const post = { id: 'post', receiptId: 'receipt', revision: 1, state: 'published' as const, subject: '공동 스탬프 행사',
    articleId: '42', articleUrl: 'https://cafe.naver.com/ca-fe/cafes/1/articles/42', updatedAt: '2026-11-17T06:45:00Z' };
  const state = snapshot({ ...realLocal, cafePosts: { status: 'available', sourceRevision: 1, items: [post] } });
  expect(localDomain.routePresentation?.('카페에 올린 글 확인해 줘', state, 'ko')).toMatchObject({
    kind: 'answer', answer: expect.stringContaining('공동 스탬프 행사 · 올렸어요'),
  });
  expect(localDomain.routePresentation?.('카페에 올린 글 영수증 열어줘', state, 'ko')).toMatchObject({
    kind: 'refusal', reason: 'widget_only', alternative: { featureId: 'community', step: 'cafe-post' },
  });
});

it('keeps unverified publication outcomes distinct from published posts', () => {
  const post = { id: 'post', receiptId: 'receipt', revision: 1, state: 'pending-reconciliation' as const, subject: '공동 스탬프 행사',
    articleId: null, articleUrl: null, updatedAt: '2026-11-17T06:45:00Z' };
  const state = snapshot({ ...realLocal, cafePosts: { status: 'available', sourceRevision: 1, items: [post] } });
  const result = localDomain.routePresentation?.('카페에 올린 글 확인해 줘', state, 'ko');
  expect(result).toMatchObject({ kind: 'answer', answer: expect.stringContaining('공동 스탬프 행사 · 확인 중') });
  expect(result).not.toMatchObject({ answer: expect.stringContaining('올렸어요') });
});
