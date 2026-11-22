import { hash, InsightError, isDate } from '../../scope.ts';
import type { createInsightNaver } from '../../naver/index.ts';

/**
 * Owner-visible reads that the NAVER virtual server answers through the PN-A3 Insight adapter.
 * Each DTO names its source and keeps the provider's own period. Nothing here writes, judges
 * eligibility, sums channels or infers sales.
 */
type Adapter = ReturnType<typeof createInsightNaver>;
export type NaverInsightPort = Partial<Pick<Adapter,
  'recommendations' | 'recommendation' | 'reviewStatistics' | 'reviews' | 'adsReport'>>;

// Official references for each owner-visible surface (also listed in README.md).
export const sources = {
  // NAVER Pay Financial Center recommendation service.
  financialCenter: 'https://help.admin.pay.naver.com/faq/content.help?faqId=13148',
  // SmartPlace review AI statistics: themes, positive/negative counts, keywords, two-day analysis lag.
  reviewStatistics: 'https://help.naver.com/service/30026/contents/24863?lang=ko',
  // SmartPlace stars: the venue average is shown only with the display setting and ten or more raters.
  reviewStars: 'https://help.naver.com/service/30026/contents/20497?lang=ko',
  // Search Ads Stat API: impCnt, clkCnt, salesAmt (advertising cost including VAT).
  searchAds: 'https://naver.github.io/searchad-apidoc/#/operations/GET/~2Fstats%7B%3Fid,fields,timeRange,datePreset,timeIncrement,breakdown%7D',
} as const;

export const minimumReviewers = 10;
const day = 86_400_000;

export const addDays = (value: string, days: number) => new Date(Date.parse(value) + days * day).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / day);
const revision = (value: unknown) => hash(JSON.stringify(value)).slice(0, 16);

export const invalid = () => new InsightError(400, 'INVALID_REQUEST');
export const sourceUnavailable = () => new InsightError(503, 'NAVER_SOURCE_UNAVAILABLE');

/** Accept only the listed single-valued query keys. */
export function readQuery(value: unknown, allowed: readonly string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, item]) => !allowed.includes(key) || typeof item !== 'string')) throw invalid();
  return Object.fromEntries(entries) as Record<string, string>;
}

export function pastDate(value: string | undefined, businessDate: string) {
  if (value === undefined) return undefined;
  if (!isDate(value) || value > businessDate) throw invalid();
  return value;
}

export function choice<T extends string>(value: string | undefined, options: readonly T[], fallback?: T): T | undefined {
  if (value === undefined) return fallback;
  if (!(options as readonly string[]).includes(value)) throw invalid();
  return value as T;
}

// PN09 · Financial Center recommendations (read only; no "matches you" judgement, no apply action).
export const financialSource = 'naver-financial-center';

export async function recommendationList(port: NaverInsightPort, storeId: string | null, at: Date) {
  const envelope = { source: financialSource, sourceUrl: sources.financialCenter };
  if (!storeId || !port.recommendations) {
    return { state: 'not-connected' as const, ...envelope, items: [], nextCursor: null, asOf: at.toISOString(),
      sourceRevision: revision([]) };
  }
  let result: Awaited<ReturnType<NonNullable<NaverInsightPort['recommendations']>>>;
  try {
    result = await port.recommendations(storeId);
  } catch {
    throw sourceUnavailable();
  }
  const items = result.items.map(({ ref, title, officialNoticeUrl, startDate, endDate, status }) => ({
    ref, source: financialSource, title, officialNoticeUrl,
    ...(startDate !== undefined && { startDate }), ...(endDate !== undefined && { endDate }),
    ...(status !== undefined && { status }),
  }));
  return { state: 'ready' as const, ...envelope, items, nextCursor: null, asOf: at.toISOString(), sourceRevision: revision(items) };
}

export async function recommendationDetail(port: NaverInsightPort, storeId: string | null, ref: string, at: Date) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw invalid();
  if (!storeId || !port.recommendation) throw new InsightError(404, 'NOT_FOUND');
  let row: Awaited<ReturnType<NonNullable<NaverInsightPort['recommendation']>>>;
  try {
    row = await port.recommendation(storeId, ref);
  } catch (error) {
    if (error instanceof InsightError && error.status === 404) throw error;
    throw sourceUnavailable();
  }
  const { title, officialNoticeUrl, startDate, endDate, status, overview, eligibility, applicationMethod, documents } = row;
  return {
    ref, source: financialSource, sourceUrl: sources.financialCenter, title, officialNoticeUrl,
    ...(startDate !== undefined && { startDate }), ...(endDate !== undefined && { endDate }),
    ...(status !== undefined && { status }),
    overview, eligibility, applicationMethod, ...(documents !== undefined && { documents }), asOf: at.toISOString(),
  };
}

// PN03 · review AI statistics and the official venue average (≥ 10 raters).
type Unit = 'day' | 'week' | 'month';
const statisticsSource = { source: 'naver-review-statistics', sourceUrl: sources.reviewStatistics } as const;
const averageSource = { source: 'naver-place-visitor-reviews', sourceUrl: sources.reviewStars } as const;

async function statisticsPart(port: NaverInsightPort, storeId: string, unit: Unit, requestedTo: string) {
  if (!port.reviewStatistics) return { state: 'not-connected' as const, ...statisticsSource };
  try {
    const { period, themes, topKeywords } = await port.reviewStatistics(storeId, { period: unit, to: requestedTo });
    return { state: 'ready' as const, ...statisticsSource, period,
      // The provider returns its own analysed range (two days behind for the current day).
      coverage: { requestedTo, dataThrough: period.to, lagDays: daysBetween(period.to, requestedTo) },
      themes, topKeywords };
  } catch {
    return { state: 'unavailable' as const, ...statisticsSource };
  }
}

async function averagePart(port: NaverInsightPort, storeId: string) {
  if (!port.reviews) return { state: 'not-connected' as const, ...averageSource, value: null, minimumReviewers };
  try {
    // The provider computes the venue average independent of paging; one row keeps the read small.
    const { averageStars } = await port.reviews(storeId, { scope: 'venue', limit: 1 });
    if (typeof averageStars === 'number') return { state: 'shown' as const, ...averageSource, value: averageStars, minimumReviewers };
    return { state: 'hidden' as const, ...averageSource, value: null, minimumReviewers };
  } catch {
    return { state: 'unavailable' as const, ...averageSource, value: null, minimumReviewers };
  }
}

export async function reviewInsights(port: NaverInsightPort, storeId: string | null, query: Record<string, string>,
  businessDate: string, at: Date) {
  const unit = choice(query.unit, ['day', 'week', 'month'] as const, 'week')!;
  const requestedTo = pastDate(query.to, businessDate) ?? businessDate;
  const base = { asOf: at.toISOString(), businessDate };
  if (!storeId) {
    return { state: 'not-connected' as const, ...base, statistics: { state: 'not-connected' as const, ...statisticsSource },
      averageRating: { state: 'not-connected' as const, ...averageSource, value: null, minimumReviewers } };
  }
  const [statistics, averageRating] = await Promise.all([
    statisticsPart(port, storeId, unit, requestedTo), averagePart(port, storeId)]);
  return { state: 'ready' as const, ...base, statistics, averageRating };
}

// PN12 · Search Ads owner stat card, same item shape as marketing `/channel-reports`.
export async function searchAdsReport(port: NaverInsightPort, storeId: string | null, adsRecord: string | undefined,
  query: Record<string, string>, businessDate: string, at: Date) {
  const end = pastDate(query.date, businessDate) ?? addDays(businessDate, -1);
  const unit = choice(query.unit, ['day', 'week'] as const, 'day')!;
  const period = { startDate: unit === 'week' ? addDays(end, -6) : end, endDate: end };
  const empty = { channel: 'search-ads' as const, source: sources.searchAds, period: null, cards: [] };
  const base = { asOf: at.toISOString(), businessDate };
  if (!storeId || !adsRecord || !port.adsReport) return { ...base, items: [{ ...empty, state: 'not-connected' as const }] };
  try {
    const report = await port.adsReport(storeId, adsRecord, period);
    return { ...base, items: [{ channel: 'search-ads' as const, state: 'ready' as const, source: report.source,
      period: report.period, cards: report.cards }] };
  } catch {
    return { ...base, items: [{ ...empty, state: 'unavailable' as const }] };
  }
}
