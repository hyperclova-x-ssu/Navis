import { describe, expect, it, vi } from 'vitest';
import { createTrendRanker, trendDays, trendWeeks } from './trend-ranking.ts';
import type { SearchRequest } from './sources.ts';

const now = new Date('2026-11-22T09:00:00Z');
const clock = () => now;
const days = (from: string, count: number, step: number) => Array.from({ length: count }, (_, i) =>
  new Date(Date.parse(from) + i * step * 86_400_000).toISOString().slice(0, 10));

function provider(_store: string, query: SearchRequest) {
  const daily = query.timeUnit === 'date';
  const dates = days(query.startDate, daily ? 35 : 57, daily ? 1 : 7);
  const scale = query.keywordGroups.some(group => group.groupName === 'e') ? 0.1 : 1;
  return { ...query, results: query.keywordGroups.map(({ groupName }, n) => ({ title: groupName, data: dates.map((period, i) => ({
    period, ratio: scale * (n === 0 ? 80 : daily ? i < 28 ? 8 : groupName === 'e' ? 24 : 16 : groupName === 'b' && i <= 4 && i >= 3 ? 12 : 8),
  })) })) };
}

describe('D-425 anchor-normalized ranking', () => {
  it('uses 35 completed Seoul calendar dates and 57 completed Monday-start weeks', () => {
    expect(trendDays(now)).toEqual({ from: '2026-10-18', to: '2026-11-21' });
    expect(trendWeeks(now)).toEqual({ from: '2025-10-13', to: '2026-11-15' });
  });

  it('puts the fixed anchor first in both periods, uses four candidates per call, and compares percentages across normalized batches', async () => {
    const search = vi.fn(async (store: string, query: SearchRequest) => provider(store, query));
    const rank = createTrendRanker(search, clock);
    const names = ['e', 'a', 'b', 'c', 'd'];
    const result = await rank('one', names);
    expect(search.mock.calls).toHaveLength(4);
    for (const [, query] of search.mock.calls) {
      expect(query.keywordGroups.length).toBeLessThanOrEqual(5);
      expect(query.keywordGroups[0].keywords).toEqual(['아메리카노', '카페라떼', '카페']);
    }
    expect(result.items[0]).toMatchObject({ keyword: 'e', changePercent: expect.closeTo(200), changePoints: expect.closeTo(20),
      anchorLevel: expect.closeTo(30), classification: 'rising' });
    expect(result.items.find(row => row.keyword === 'b')).toMatchObject({ classification: 'rising', sameWeekChangePercent: expect.closeTo(-20) });
    expect(result.items[0].points).toHaveLength(35);
    expect(await rank('one', [...names].reverse())).toEqual(result);
    expect(search.mock.calls).toHaveLength(4);
  });

  it('uses the seasonal label when the displayed comparisons are both positive and last year also rose', async () => {
    const rank = createTrendRanker(async (store, query) => {
      const wire = provider(store, query);
      if (query.timeUnit === 'week') wire.results[1].data.slice(-8).forEach(point => { point.ratio = 16; });
      return wire;
    }, clock);
    expect((await rank('store', ['b'])).items[0]).toMatchObject({ classification: 'annual', changePercent: expect.closeTo(100),
      sameWeekChangePercent: expect.closeTo(60) });
  });

  it('labels quiet measured terms without hiding them and excludes terms on a missing anchor', async () => {
    const rank = createTrendRanker(async (store, query) => {
      const result = provider(store, query);
      if (store === 'missing') result.results[0].data[3].ratio = 0;
      for (const [index, item] of result.results.slice(1).entries()) item.data.forEach((point, i) => {
        point.ratio = index * 3 + (query.timeUnit === 'date' ? i < 28 ? 8 : 8.1 : i % 2 ? 4 : 12);
      });
      return result;
    }, clock);
    const result = await rank('normal', ['a', 'b', 'c', 'd']);
    expect(result.items).toHaveLength(4);
    expect(result.items.map(row => row.classification)).toEqual(['steady', 'steady', 'steady', 'steady']);
    expect(result.items.map(row => row.changePercent)).toEqual(result.items.map(row => row.changePercent).sort((a, b) => b - a));
    expect(await rank('missing', ['a'])).toMatchObject({ status: 'empty', items: [] });
  });

  it('keeps candidate names distinct when one equals the internal anchor title', async () => {
    const rank = createTrendRanker(async (store, query) => provider(store, query), clock);
    await expect(rank('store', ['__cafe_anchor__'])).resolves.toMatchObject({ status: 'ready', items: [{ keyword: '__cafe_anchor__' }] });
  });
});
