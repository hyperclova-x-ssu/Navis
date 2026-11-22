import { createTranslator, type Translator } from '../../../i18n';
import { matchTrendMenu, type TrendMenuItem } from '../../../../../backend/services/marketing/reality/13/trend-menu-match';
import type { TrendRecommendations } from '../../../../../backend/services/marketing/reality/13/trend-recommendations';
import type { DataSnapshot } from '../../db/types';
import { dataBundle } from '../../messages';
import { resolveDataText } from '../../text';
import type { PeriodDto } from './dto';

export const trendCandidateLimit = 25;
export const trendSource = '네이버 검색어 트렌드 · 전국 · 상대값';
const exampleListKey = 'navis.example.local-trends.candidates.v1';
const ko = createTranslator('ko', dataBundle) as unknown as Translator;

export interface TrendCandidate { readonly id: string; readonly keyword: string; readonly suggested: boolean }
interface TrendPoint { readonly period: string; readonly ratio: number }
interface TrendGrowth { readonly rank: number; readonly keyword: string; readonly changePercent: number; readonly points: readonly TrendPoint[];
  readonly changePoints?: number; readonly anchorLevel?: number; readonly sameWeekChangePercent?: number | null;
  readonly classification?: 'new' | 'annual' | 'rising' | 'steady' | 'cooling' }
export interface TrendRankRow extends TrendGrowth { readonly id: string; readonly isMenu: boolean | null; readonly menuName?: string | null }
export interface TrendRanking {
  readonly status: 'ready' | 'empty' | 'disabled' | 'unavailable';
  readonly period: PeriodDto;
  readonly fetchedAt: string | null;
  readonly items: readonly TrendRankRow[];
  readonly noiseCount?: number;
  readonly recommendations?: TrendRecommendations;
  readonly events?: number | null;
}
export interface TrendPreview extends Omit<TrendRanking, 'items'> { readonly items: readonly TrendGrowth[]; readonly initialKeywords?: readonly string[] }
export interface ExampleLocalTrends { readonly candidates: readonly TrendCandidate[]; readonly ranking?: TrendRanking }

declare module '../../db/types' {
  interface DataTables { readonly exampleLocalTrends?: ExampleLocalTrends }
}

/** The same read used by the widget and the Navis marketing domain. */
export function getLocalTrendRanking(snapshot: DataSnapshot): TrendRanking | undefined {
  return snapshot.tables.realLocal ? snapshot.tables.realLocal.trends.ranking : snapshot.tables.exampleLocalTrends?.ranking;
}

export function cleanTrendKeyword(value: string) { return value.normalize('NFC').trim().replace(/\s+/gu, ' '); }
export function validTrendKeyword(value: string) {
  const cleaned = cleanTrendKeyword(value);
  return !!cleaned && cleaned.length <= 80 && !/\p{Cc}/u.test(value);
}
const keyOf = (value: string) => cleanTrendKeyword(value).toLowerCase();

export function exampleTrendMenu(snapshot: DataSnapshot): TrendMenuItem[] {
  return snapshot.tables.menuItem.filter(row => row.kind !== 'retail' && !row.deletedAt).map(row => ({
    name: row.name ? resolveDataText(ko.t, row.name) : ko.t(row.nameKey), category: row.category, price: row.price,
  }));
}

export function seedExampleCandidates(keywords: readonly string[]): TrendCandidate[] {
  const terms = new Map(keywords.filter(validTrendKeyword).map(value => [keyOf(value), cleanTrendKeyword(value)]));
  return [...terms].slice(0, trendCandidateLimit).map(([id, keyword]) => ({ id, keyword, suggested: true }));
}

export function addExampleCandidate(items: readonly TrendCandidate[], input: string): TrendCandidate {
  if (!validTrendKeyword(input)) throw new Error('INVALID_REQUEST');
  if (items.length >= trendCandidateLimit) throw new Error('TREND_CANDIDATE_LIMIT');
  const keyword = cleanTrendKeyword(input);
  const id = keyOf(keyword);
  if (items.some(item => item.id === id)) throw new Error('TREND_CANDIDATE_EXISTS');
  return { id, keyword, suggested: false };
}

export function replaceExampleCandidateList(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  initial: readonly TrendCandidate[], replacement?: readonly TrendCandidate[]): readonly TrendCandidate[] {
  try {
    if (replacement) { storage?.setItem(exampleListKey, JSON.stringify(replacement)); return replacement; }
    const raw = storage?.getItem(exampleListKey);
    const items: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(items) && items.length <= trendCandidateLimit && items.every(item => typeof item?.keyword === 'string' &&
      validTrendKeyword(item.keyword) && item.id === keyOf(item.keyword) && typeof item.suggested === 'boolean') &&
      new Set(items.map(item => item.id)).size === items.length) return items;
  } catch { /* The example list still works in this session when storage is unavailable. */ }
  return replacement ?? initial;
}

export function withTrendCandidates(ranking: TrendPreview, candidates: readonly TrendCandidate[], menu: readonly TrendMenuItem[]): TrendRanking {
  const ids = new Map(candidates.map(item => [item.keyword, item.id]));
  return { ...ranking, items: ranking.items.flatMap(row => {
    const id = ids.get(row.keyword);
    if (id === undefined) return [];
    const menuName = matchTrendMenu(row.keyword, menu);
    return [{ ...row, id, menuName, isMenu: menuName !== null }];
  }) };
}
