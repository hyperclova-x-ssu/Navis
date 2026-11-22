import { expect, it } from 'vitest';
import { createWidgetDataStore } from '../../db/store';
import { createRealPort } from '../00';
import { fakeBackend } from '../00/testing';
import { ensureExampleTrendRanking, trendPath } from './trend-hooks';
import { addExampleCandidate, exampleTrendMenu, replaceExampleCandidateList, seedExampleCandidates, withTrendCandidates } from './trend-ranking';

it('seeds suggestions in example mode and retains an intentionally empty list', () => {
  const items = seedExampleCandidates(['에스프레소', '카페라떼']);
  expect(items.map(item => item.keyword)).toEqual(['에스프레소', '카페라떼']);
  expect(items.every(item => item.suggested)).toBe(true);
  const state = new Map<string, string>();
  const storage = { getItem: (key: string) => state.get(key) ?? null, setItem: (key: string, value: string) => { state.set(key, value); } };
  expect(replaceExampleCandidateList(storage, items)).toEqual(items);
  expect(replaceExampleCandidateList(storage, items, [])).toEqual([]);
  expect(replaceExampleCandidateList(storage, items)).toEqual([]);
  const added = addExampleCandidate(items, '  바닐라  라떼 ');
  expect(added).toMatchObject({ keyword: '바닐라 라떼', suggested: false });
  expect(() => addExampleCandidate(items, ' 카페라떼 ')).toThrow();
});

it('retains the provider rank and adds only example candidate identity and menu status', () => {
  const items = seedExampleCandidates(['카페라떼', '라임 소금빵', '디카페인 커피', '말차 라떼', '소금빵']);
  const points = [{ period: '2026-11-08', ratio: 50 }];
  const ranking = { status: 'ready', period: { from: '2026-11-08', to: '2026-11-21' }, fetchedAt: null, items: [
    { rank: 1, keyword: '소금빵', changePercent: 26.26, points }, { rank: 2, keyword: '카페라떼', changePercent: 17, points },
    { rank: 3, keyword: '디카페인 커피', changePercent: 5, points }, { rank: 4, keyword: '말차 라떼', changePercent: 4, points },
    { rank: 5, keyword: '라임 소금빵', changePercent: 3, points },
  ] } as const;
  const menu = exampleTrendMenu(createWidgetDataStore().getSnapshot());
  expect(withTrendCandidates(ranking, items, menu).items.map(({ keyword, menuName, isMenu }) => [keyword, menuName, isMenu])).toEqual([
    ['소금빵', '겉바속촉 버터 소금빵', true], ['카페라떼', '카페라떼', true], ['디카페인 커피', '디카페인 아메리카노', true],
    ['말차 라떼', '제주 말차 라떼', true], ['라임 소금빵', null, false],
  ]);
});

it('persists the preview defaults locally and sends the saved list on the next session', async () => {
  localStorage.clear();
  try {
    const keywords = ['말차 라떼', '슈톨렌', '핫초코', '생강차', '대추차', '소금빵', '카페라떼', '티라미수', '유자차', '크로플'];
    const backend = fakeBackend();
    backend.on('POST', `${trendPath}/preview`, ({ body }) => ({ status: 'empty', items: [], fetchedAt: null,
      period: { from: '2026-10-18', to: '2026-11-21' }, ...('useDefaults' in (body as object) ? { initialKeywords: keywords } : {}) }));
    const session = () => {
      const store = createWidgetDataStore();
      store.bindReal(createRealPort({ store, fetch: backend.fetch, adapters: [], source: () => 'fixture' }));
      return store;
    };
    const first = session();
    await ensureExampleTrendRanking(first);
    expect(first.getSnapshot().tables.exampleLocalTrends?.candidates.map(({ keyword }) => keyword)).toEqual(keywords);
    await ensureExampleTrendRanking(session());
    expect(backend.callsTo('POST', `${trendPath}/preview`).map(call => call.body)).toEqual([{ keywords: [], useDefaults: true }, { keywords }]);
  } finally {
    localStorage.clear();
  }
});
