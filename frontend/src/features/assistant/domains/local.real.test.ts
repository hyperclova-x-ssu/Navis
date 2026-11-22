import { expect, it } from 'vitest';
import { createWidgetDataStore } from '../../../data/widget-data';
import type { RealLocal } from '../../../data/reality/13/dto';
import { localDomain } from './local';

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

it('uses keyword-specific relative interest and excludes unrelated store sales from a mention count answer', () => {
  const route = localDomain.route?.('로컬 트렌드에서 상도동 카공 언급 몇 번이야?', snapshot(), 'ko');
  expect(route).toMatchObject({ factKeys: ['localTrends.interest.mentions', 'localTrends.interest.1'] });
  const result = localDomain.projectWidget?.(snapshot(), 'local-trends', defaultCondition, 'ko');
  expect(result).toMatchObject({ facts: expect.arrayContaining([
    expect.objectContaining({ key: 'localTrends.interest.mentions', display: '언급 횟수는 알 수 없어요' }),
    expect.objectContaining({ key: 'localTrends.interest.1', value: 50, source: '네이버 검색 관심도', start: period.from, end: period.to }),
  ]) });
  expect(localDomain.route?.('로컬 트렌드에서 숭실대 디저트는 어때?', snapshot(), 'ko'))
    .toMatchObject({ kind: 'answer', answer: expect.stringContaining('자료가 없어요') });
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
