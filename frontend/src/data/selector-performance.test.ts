import manifest from './db/generated/manifest.json';
import { it, expect } from 'vitest';
import { createWidgetDataStore, deriveRecipeCost, deriveStock, deriveSuggestions, selectMembers, selectPayments, selectStockHistory, selectReservations, selectBriefing, TODAY } from './widget-data';

it('카페 회원과 결제의 공용 selector cold/warm p95를 측정한다', () => {
  const seed = createWidgetDataStore().getSnapshot();
  const queries = {
    members: (s: typeof seed) => selectMembers(s, {}), payments: (s: typeof seed) => selectPayments(s, { date: TODAY, scenario: 'normal' }),
    recipe: (s: typeof seed) => deriveRecipeCost(s, 'm-cafe-latte'), stock: (s: typeof seed) => deriveStock(s, { date: TODAY }),
    suggestions: (s: typeof seed) => deriveSuggestions(s, { date: TODAY }), history: (s: typeof seed) => selectStockHistory(s, { itemId: 'i-bean-house', period: 'last7days' }),
    reservations: (s: typeof seed) => selectReservations(s, { date: TODAY }), briefing: (s: typeof seed) => selectBriefing(s, { date: TODAY }),
  };
  expect(selectMembers(seed, {}).total).toBe(manifest.counts.members);
  expect(selectPayments(seed, { date: TODAY, scenario: 'normal' }).rows).toHaveLength(manifest.counts.payments);
  const report: Record<string, { coldP95Ms: number; warmP95Ms: number }> = {};
  for (const [name, select] of Object.entries(queries)) {
    const cold: number[] = [], warm: number[] = [];
    for (let i = 0; i < 45; i++) {
      const snapshot = { ...seed, revision: i };
      const start = performance.now(); select(snapshot); cold.push(performance.now() - start);
      const warmStart = performance.now(); const result = select(snapshot); warm.push(performance.now() - warmStart);
      expect(select(snapshot)).toBe(result);
    }
    const p95 = (samples: number[]) => Number(samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1].toFixed(3));
    report[name] = { coldP95Ms: p95(cold), warmP95Ms: p95(warm) };
  }
  console.info('T-202 selector p95 (45 samples each)', JSON.stringify(report));
});
