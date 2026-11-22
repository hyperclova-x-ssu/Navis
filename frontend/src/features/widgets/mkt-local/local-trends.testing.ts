import { createWidgetDataStore } from '../../../data/db/store';
import type { TrendRankRow } from '../../../data/reality/13/trend-ranking';

export const testTrendRows: readonly TrendRankRow[] = [
  '카페라떼', '소금빵', '아메리카노', '말차 라떼', '마들렌', '드립 커피', '아인슈페너', '에스프레소',
].map((keyword, index) => ({
  id: `trend-${index}`, rank: index + 1, keyword, isMenu: index % 2 === 0, changePercent: 30 - index, classification: 'new',
  points: Array.from({ length: 14 }, (_, day) => ({ period: `2026-11-${String(day + 8).padStart(2, '0')}`, ratio: 40 + day })),
}));

export function trendTestStore(status: 'ready' | 'disabled' = 'ready') {
  return createWidgetDataStore({ exampleLocalTrends: {
    candidates: testTrendRows.map(row => ({ id: row.id, keyword: row.keyword, suggested: true })),
    ranking: { status, period: { from: '2026-11-08', to: '2026-11-21' }, fetchedAt: status === 'ready' ? '2026-11-22T06:45:00Z' : null,
      items: status === 'ready' ? testTrendRows : [] },
  } });
}
