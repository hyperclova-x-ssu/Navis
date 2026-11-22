import dictionary from './data/trend-dictionary.json' with { type: 'json' };
import { matchTrendMenu, type TrendMenuItem } from './trend-menu-match.ts';

export const trendDictionary = dictionary;
type Entry = typeof dictionary.entries[number];
export type TrendRecommendations = { version: string; source: 'hcx' | 'rule'; items: readonly Entry[] };
export type TrendChoiceInput = { entries: readonly Entry[]; menu: string[]; month: number; events: number | null };
export type TrendCandidateChooser = (storeId: string, input: TrendChoiceInput) => Promise<unknown>;
const limit = 8;
const defaultCount = 10;
const commonMenuQueries = ['디카페인 커피', '말차 라떼', '소금빵', '아메리카노', '카페라떼'];
const monthOf = (now: Date) => Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', month: 'numeric' }).format(now));
const keyOf = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

function eligibleEntries(saved: readonly string[], menu: readonly TrendMenuItem[], month: number) {
  const known = new Set(saved.map(keyOf));
  return dictionary.entries.filter(entry => (entry.months.length === 0 || entry.months.includes(month))
    && !known.has(keyOf(entry.keyword)) && !matchTrendMenu(entry.keyword, menu))
    .sort((a, b) => Number(b.months.includes(month)) - Number(a.months.includes(month)) || a.id.localeCompare(b.id));
}

export function ruleTrendRecommendations(saved: readonly string[], menu: readonly TrendMenuItem[], now: Date): TrendRecommendations {
  return { version: dictionary.version, source: 'rule', items: eligibleEntries(saved, menu, monthOf(now)).slice(0, limit) };
}

export function defaultTrendKeywords(recommendations: TrendRecommendations, menu: readonly TrendMenuItem[], now: Date): string[] {
  const matches = new Map<string, string>();
  for (const keyword of [...commonMenuQueries, ...menu.map(item => item.name)]) {
    if (keyword.length > 80 || /\p{Cc}/u.test(keyword)) continue;
    const name = matchTrendMenu(keyword, menu);
    if (name && !matches.has(keyOf(name))) matches.set(keyOf(name), keyword);
    if (matches.size >= 3) break;
  }
  const ordered = [...matches.values(), ...recommendations.items.map(({ keyword }) => keyword),
    ...eligibleEntries([], menu, monthOf(now)).map(({ keyword }) => keyword)];
  return [...new Map(ordered.map(keyword => [keyOf(keyword), keyword])).values()].slice(0, defaultCount);
}

export function untrackedTrendRecommendations(recommendations: TrendRecommendations, saved: readonly string[],
  menu: readonly TrendMenuItem[], now: Date): TrendRecommendations {
  const keys = new Set(saved.map(keyOf));
  const items = recommendations.items.filter(item => !keys.has(keyOf(item.keyword)));
  return items.length ? { ...recommendations, items } : ruleTrendRecommendations(saved, menu, now);
}

function selectedEntries(output: unknown, entries: readonly Entry[]) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).join(',') !== 'pickedIds' ||
    !('pickedIds' in output) || !Array.isArray(output.pickedIds) || !output.pickedIds.length || output.pickedIds.length > limit) return null;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (new Set(output.pickedIds).size !== output.pickedIds.length || output.pickedIds.some(id => typeof id !== 'string' || !byId.has(id))) return null;
  return output.pickedIds.map(id => byId.get(id)!);
}

export function createTrendRecommendations(choose: TrendCandidateChooser | undefined, now: () => Date) {
  const cache = new Map<string, { until: number; result: Promise<TrendRecommendations> }>();
  return async function recommend(storeId: string, saved: readonly string[], menu: readonly TrendMenuItem[], events: number | null) {
    const current = now();
    const month = monthOf(current);
    const entries = eligibleEntries(saved, menu, month);
    const rule: TrendRecommendations = { version: dictionary.version, source: 'rule', items: entries.slice(0, limit) };
    if (!choose || !entries.length) return rule;
    const menuNames = menu.map(item => item.name).sort().slice(0, 80);
    const key = JSON.stringify([storeId, dictionary.version, month, events, menuNames, entries.map(entry => entry.id)]);
    const time = current.getTime();
    const cached = cache.get(key);
    if (cached && cached.until > time) return cached.result;
    for (const [id, value] of cache) if (value.until <= time) cache.delete(id);
    if (cache.size >= 128) return rule;
    const result = Promise.resolve().then(async (): Promise<TrendRecommendations> => {
      const chosen = selectedEntries(await choose(storeId, { entries, menu: menuNames, month, events }), entries);
      return chosen ? { version: dictionary.version, source: 'hcx', items: chosen } : rule;
    }).catch(() => rule);
    cache.set(key, { until: time + 3_600_000, result });
    return result;
  };
}
