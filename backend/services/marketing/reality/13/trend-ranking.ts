import { invalid, type Period, type SearchRequest, type SearchResult, type Sources } from './sources.ts';

export const maxTrendCandidates = 25;
export const trendAlgorithm = 'd425-anchor-v3';
const anchorKeywords = ['아메리카노', '카페라떼', '카페'];
const batchSize = 4;
const dayMs = 86_400_000;
const seoulOffset = 9 * 3_600_000;
const cacheSize = 128;

export type TrendPoint = { period: string; ratio: number };
export type TrendClassification = 'new' | 'annual' | 'rising' | 'steady' | 'cooling';
type Measurement = { keyword: string; changePercent: number; changePoints: number; anchorLevel: number;
  sameWeekChangePercent: number | null; noisePoints: number; annualRise: boolean | null; points: TrendPoint[] };
type Growth = Omit<Measurement, 'annualRise'> & { classification: TrendClassification; rank: number };
export type TrendRanking = { status: 'ready' | 'empty' | 'disabled' | 'unavailable'; period: Period;
  fetchedAt: string | null; items: Growth[]; noiseCount: number };

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const seoulDaysAgo = (now: Date, days: number) => isoDay(now.getTime() + seoulOffset - days * dayMs);
export function trendDays(now: Date): Period { return { from: seoulDaysAgo(now, 35), to: seoulDaysAgo(now, 1) }; }
export function trendWeeks(now: Date): Period {
  const daysSinceMonday = (new Date(now.getTime() + seoulOffset).getUTCDay() + 6) % 7;
  return { from: seoulDaysAgo(now, daysSinceMonday + 57 * 7), to: seoulDaysAgo(now, daysSinceMonday + 1) };
}

export function trendKeyword(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) invalid();
  const clean = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!clean || clean.length > 80) invalid();
  return clean;
}

export function trendKeywordKey(keyword: string): string { return keyword.toLowerCase(); }

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function deviation(values: readonly number[]) {
  const center = mean(values);
  return Math.sqrt(mean(values.map(value => (value - center) ** 2)));
}

/** Normalize each bucket against the anchor in that same provider response. */
function normalizedSeries(query: SearchRequest, response: SearchResult) {
  const titles = new Set(query.keywordGroups.map(group => group.groupName));
  if (response.startDate !== query.startDate || response.endDate !== query.endDate || response.timeUnit !== query.timeUnit ||
    response.results.some(result => !titles.delete(result.title))) throw new Error('Unexpected search trend response');
  const anchorName = query.keywordGroups[0].groupName;
  const anchorData = response.results.find(row => row.title === anchorName)?.data ?? [];
  const anchors = new Map(anchorData.map(row => [row.period, row.ratio]));
  const values = [...anchors.values()].filter(value => Number.isFinite(value) && value > 0 && value <= 100).sort((a, b) => a - b);
  // Do not divide by gaps, or by a value far below the anchor's measured typical level.
  const floor = (values[Math.floor(values.length / 2)] ?? 0) / 10;
  const all = new Map<string, Map<string, number>>();
  for (const { title, data } of response.results) {
    if (title === anchorName) continue;
    const points = new Map<string, number>();
    if (anchors.size === anchorData.length && new Set(data.map(row => row.period)).size === data.length) {
      for (const { period, ratio } of data) {
        const baseline = anchors.get(period);
        if (baseline !== undefined && baseline > 0 && baseline >= floor && baseline <= 100 && Number.isFinite(ratio) && ratio >= 0 && ratio <= 100) {
          points.set(period, ratio / baseline * 100);
        }
      }
    }
    all.set(title, points);
  }
  return all;
}

function sequence(days: readonly string[], ratios: Map<string, number> | undefined) {
  if (!ratios || days.some(day => !ratios.has(day))) return null;
  return days.map(day => ratios.get(day)!);
}

function dates(period: Period, length: number, step: number) {
  return Array.from({ length }, (_, index) => isoDay(Date.parse(period.from) + index * step * dayMs));
}

function compareWindows(keyword: string, dailyDates: string[], weeklyDates: string[], daily?: Map<string, number>, weekly?: Map<string, number>): Measurement | null {
  const dayValues = sequence(dailyDates, daily);
  const recentWeeks = sequence(weeklyDates.slice(-8), weekly);
  if (!dayValues || !recentWeeks) return null;
  const anchorLevel = mean(dayValues.slice(-7));
  const prior = mean(dayValues.slice(0, 28));
  if (prior <= 0) return null;
  const changePoints = anchorLevel - prior;
  const lastYear = sequence(weeklyDates.slice(-56, -52), weekly);
  const yearBasis = lastYear ? mean(lastYear) : 0;
  return { keyword, changePoints, changePercent: changePoints / prior * 100, anchorLevel,
    sameWeekChangePercent: yearBasis > 0 ? (mean(recentWeeks.slice(-4)) - yearBasis) / yearBasis * 100 : null,
    noisePoints: deviation(recentWeeks), annualRise: lastYear && mean(lastYear.slice(2)) - mean(lastYear.slice(0, 2)) > deviation(lastYear),
    points: dailyDates.map((period, index) => ({ period, ratio: dayValues[index] })) };
}

function rankMeasurements(measured: Measurement[]) {
  const ranked = measured.map(({ annualRise, ...row }) => {
    const steady = Math.abs(row.changePoints) <= row.noisePoints || Math.abs(row.changePercent) < 0.05;
    const aboveLastYear = row.sameWeekChangePercent != null && row.sameWeekChangePercent >= 0.05;
    const classification: TrendClassification = steady ? 'steady' : row.changePercent < 0 ? 'cooling'
      : aboveLastYear && annualRise === true ? 'annual' : aboveLastYear && annualRise === false ? 'new' : 'rising';
    return { ...row, classification };
  }).sort((a, b) => b.changePercent - a.changePercent || a.keyword.localeCompare(b.keyword, 'ko'));
  return { items: ranked.map((row, index) => ({ ...row, rank: index + 1 })), noiseCount: 0 };
}

/** Cache a store's measurement inputs until midnight in Seoul. */
export function createTrendRanker(search: Sources['searchInterest'], now: () => Date) {
  const cache = new Map<string, { expiresAt: number; result: Promise<TrendRanking> }>();
  return async function rank(storeId: string, keywords: readonly string[]): Promise<TrendRanking> {
    const requestedAt = now();
    const period = trendDays(requestedAt);
    const weeks = trendWeeks(requestedAt);
    const answer = (status: TrendRanking['status'], items: Growth[] = [], fetchedAt: string | null = null, noiseCount = 0) =>
      ({ status, period, fetchedAt, items, noiseCount });
    if (!keywords.length) return answer('empty');
    if (!search) return answer('disabled');
    const names = [...new Set(keywords)].sort();
    const key = JSON.stringify([storeId, period.to, names]);
    const time = requestedAt.getTime();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > time) return cached.result;
    for (const [id, entry] of cache) if (entry.expiresAt <= time) cache.delete(id);
    if (cache.size >= cacheSize) return answer('unavailable');

    const batches = Array.from({ length: Math.ceil(names.length / batchSize) }, (_, index) =>
      names.slice(index * batchSize, (index + 1) * batchSize));
    const expiresAt = Math.floor((time + seoulOffset) / dayMs + 1) * dayMs - seoulOffset;
    const result = Promise.resolve().then(async () => {
      const dailyDates = dates(period, 35, 1);
      const weeklyDates = dates(weeks, 57, 7);
      const measurements = await Promise.all(batches.map(async batch => {
        let anchorName = '__cafe_anchor__';
        while (batch.includes(anchorName)) anchorName += '_';
        const keywordGroups = [{ groupName: anchorName, keywords: anchorKeywords }, ...batch.map(keyword => ({ groupName: keyword, keywords: [keyword] }))];
        const measure = async ({ from, to }: Period, timeUnit: SearchRequest['timeUnit']) => {
          const query: SearchRequest = { startDate: from, endDate: to, timeUnit, keywordGroups };
          return normalizedSeries(query, await search(storeId, query));
        };
        const [daily, weekly] = await Promise.all([measure(period, 'date'), measure(weeks, 'week')]);
        return batch.flatMap(keyword => compareWindows(keyword, dailyDates, weeklyDates, daily.get(keyword), weekly.get(keyword)) ?? []);
      }));
      const { items, noiseCount } = rankMeasurements(measurements.flat());
      return answer(items.length ? 'ready' : 'empty', items, now().toISOString(), noiseCount);
    }).catch(() => {
      const entry = cache.get(key);
      if (entry) entry.expiresAt = Math.min(expiresAt, now().getTime() + 30_000);
      return answer('unavailable');
    });
    cache.set(key, { expiresAt, result });
    return result;
  };
}
