import { useEffect, useSyncExternalStore } from 'react';
import type { WidgetDataStore } from '../../db/store';
import { useRealPort, useWidgetDataStore } from '../../react';
import { PortError, type CommandReceipt, type PortTransport } from '../00';
import { appTransport } from '../00/app-port';
import { defaultTrendKeywords, ruleTrendRecommendations, untrackedTrendRecommendations } from '../../../../../backend/services/marketing/reality/13/trend-recommendations';
import { exampleTrendMenu, getLocalTrendRanking, replaceExampleCandidateList, seedExampleCandidates, withTrendCandidates,
  type ExampleLocalTrends, type TrendCandidate, type TrendPreview } from './trend-ranking';
import type { PeriodDto } from './dto';

export const trendPath = '/marketing/local-trends';
const listPath = `${trendPath}/candidates`;
const running = new WeakMap<WidgetDataStore, { candidates?: ExampleLocalTrends['candidates']; request: Promise<void> }>();
const emptyCandidates: readonly TrendCandidate[] = [];

function storage() { try { return globalThis.localStorage; } catch { return undefined; } }
export function lastCompleteTrendDays(): PeriodDto {
  const seoul = Date.now() + 9 * 3_600_000;
  const day = (ago: number) => new Date(seoul - ago * 86_400_000).toISOString().slice(0, 10);
  return { from: day(35), to: day(1) };
}

export function ensureExampleTrendRanking(store: WidgetDataStore, { force = false }: { force?: boolean } = {}): Promise<void> {
  let data = store.getSnapshot().tables.exampleLocalTrends;
  if (!data) {
    const saved = replaceExampleCandidateList(storage(), emptyCandidates);
    if (saved !== emptyCandidates) {
      store.hydrate({ exampleLocalTrends: { candidates: saved } });
      data = store.getSnapshot().tables.exampleLocalTrends;
    }
  }
  const candidates = data?.candidates;
  if (data?.ranking && !force) return Promise.resolve();
  const pending = running.get(store);
  if (pending && pending.candidates === candidates) return pending.request;
  const period = lastCompleteTrendDays();
  const transport = store.real?.transport ?? appTransport();
  const keywords = candidates?.map(item => item.keyword) ?? [];
  const request = transport.request<TrendPreview>({ method: 'POST', path: `${trendPath}/preview`, body: candidates ? { keywords } : { keywords, useDefaults: true } })
    .catch((error): TrendPreview => ({ status: error instanceof PortError && [401, 403, 404].includes(error.status) ? 'disabled' : 'unavailable',
      items: [], fetchedAt: null, period, recommendations: ruleTrendRecommendations(keywords, exampleTrendMenu(store.getSnapshot()), new Date()) }))
    .then(result => {
      const current = store.getSnapshot();
      if (current.tables.exampleLocalTrends?.candidates !== candidates) return;
      const menu = exampleTrendMenu(current);
      const now = new Date();
      const suggestions = result.recommendations ?? ruleTrendRecommendations(keywords, menu, now);
      const selected = candidates ?? replaceExampleCandidateList(storage(), emptyCandidates,
        seedExampleCandidates(result.initialKeywords ?? defaultTrendKeywords(suggestions, menu, now)));
      const display = { ...result, recommendations: untrackedTrendRecommendations(suggestions, selected.map(item => item.keyword), menu, now) };
      store.hydrate({ exampleLocalTrends: { candidates: selected, ranking: withTrendCandidates(display, selected, menu) } });
    }).finally(() => { if (running.get(store)?.request === request) running.delete(store); });
  running.set(store, { candidates, request });
  return request;
}

export function editExampleTrendCandidates(store: WidgetDataStore, replacement: readonly TrendCandidate[]) {
  const latest = store.getSnapshot().tables.exampleLocalTrends;
  const candidates = replaceExampleCandidateList(storage(), latest?.candidates ?? [], replacement);
  store.hydrate({ exampleLocalTrends: { candidates } });
  void ensureExampleTrendRanking(store);
}

export async function writeTrendCandidate(transport: PortTransport, input: { keyword: string } | { id: string; expectedRevision: number }) {
  const idempotencyKey = globalThis.crypto.randomUUID();
  const options = 'keyword' in input
    ? { method: 'POST' as const, path: listPath, body: input, idempotencyKey }
    : { method: 'DELETE' as const, path: `${listPath}/${encodeURIComponent(input.id)}`,
      body: { expectedRevision: input.expectedRevision, confirmed: true }, idempotencyKey };
  try { return await transport.request<CommandReceipt>(options); }
  catch (error) {
    if (!(error instanceof PortError) || !error.outcomeUnknown) throw error;
    return transport.request<CommandReceipt>(options);
  }
}

export function useTrendData(enabled: boolean) {
  const store = useWidgetDataStore();
  const port = useRealPort();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const http = port?.state('local').mode === 'http';
  const real = snapshot.tables.realLocal?.trends;
  useEffect(() => { if (enabled && !http) void ensureExampleTrendRanking(store); }, [enabled, http, store]);
  return {
    store, port, http,
    ranking: getLocalTrendRanking(snapshot),
    candidates: (http ? real?.candidates : snapshot.tables.exampleLocalTrends?.candidates) ?? emptyCandidates,
    sourceRevision: real?.sourceRevision,
    retry: () => http ? void port?.retry('local') : void ensureExampleTrendRanking(store, { force: true }),
  };
}
