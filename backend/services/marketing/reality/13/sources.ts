import type { GeocodeResult, SearchItems } from '../../../../packages/naver/contracts/pn10/index.ts';

export type Period = { from: string; to: string };
export type Sale = { settlementId: string; occurredAt: string; businessDate: string; menuId: string; quantity: number };
export type SearchRequest = {
  startDate: string; endDate: string; timeUnit: 'date' | 'week';
  keywordGroups: { groupName: string; keywords: string[] }[];
};
export type SearchResult = {
  startDate: string; endDate: string; timeUnit: string;
  results: { title: string; data: { period: string; ratio: number }[] }[];
};
export type Sources = {
  sales?(storeId: string, period: Period): Promise<Sale[]>;
  searchLinks?: SearchLinks;
  searchInterest?(storeId: string, query: SearchRequest): Promise<SearchResult>;
  trendProvider?: 'fake' | 'live';
  searchNews?(storeId: string, query: string): Promise<{ items: SearchItems['news'][] } | undefined>;
  searchPlaces?(storeId: string, query: string): Promise<{ items: SearchItems['local'][] } | undefined>;
  geocodeStore?(storeId: string): Promise<GeocodeResult | undefined>;
};

type Pn10Port = { trend(input: { request: SearchRequest; signal?: AbortSignal }): Promise<{ result: unknown }> };

/** Bind the PN10 search port to the configured store and project its trend response. */
export function pn10SearchInterest(portForStore: (storeId: string) => Pn10Port): NonNullable<Sources['searchInterest']> {
  return async (storeId, request) => {
    const { result } = await portForStore(storeId).trend({ request, signal: AbortSignal.timeout(4000) });
    if (!result || typeof result !== 'object') throw new Error('Invalid PN10 search result');
    const response = result as Partial<SearchResult>;
    if (typeof response.startDate !== 'string' || typeof response.endDate !== 'string' ||
      typeof response.timeUnit !== 'string' || !Array.isArray(response.results) ||
      response.results.length > request.keywordGroups.length || response.results.some(series =>
        typeof series?.title !== 'string' || !Array.isArray(series.data) || series.data.length > 367 ||
        series.data.some(point => typeof point?.period !== 'string' || typeof point?.ratio !== 'number'))) {
      throw new Error('Invalid PN10 search result');
    }
    return { startDate: response.startDate, endDate: response.endDate, timeUnit: response.timeUnit, results: response.results };
  };
}

type SearchChannel = 'blog' | 'cafearticle';
export type SearchLinks = (storeId: string, channel: SearchChannel, query: string) =>
  Promise<{ items: { title: string; link: string }[] }>;
type DisplayResult<T> = { status: 'available' | 'empty' | 'unavailable'; reason?: 'not-connected' | 'provider-failed'; items: T[] };
type DisplayLink = { title: string; url: string };
type NewsLink = DisplayLink & { publishedAt: string };
type Place = { title: string; address: string; category: string; url?: string };
type Location = { address: string; longitude: number; latitude: number };

function displayed<T>(items: T[] | undefined): DisplayResult<T> {
  if (!items) return { status: 'unavailable', reason: 'provider-failed', items: [] };
  return { status: items.length ? 'available' : 'empty', items };
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/**
 * Search API titles carry `<b>` highlight markup and HTML entities
 * ([blog search](https://api.ncloud-docs.com/docs/naver-api-hub-search-blog)). Show plain text: drop every tag,
 * decode named and numeric entities, then collapse whitespace (RV-GAP-B-N1).
 */
export function plainTitle(value: string) {
  return value.replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
      const code = name[0] !== '#' ? undefined : name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code === undefined) return entities[name.toLowerCase()] ?? whole;
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
    })
    .replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

function httpsLink(value: string) {
  if (value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Unusable provider link. */ }
  return undefined;
}

export async function readSearchLinks(search: SearchLinks | undefined, storeId: string, keyword: string) {
  async function channel(kind: SearchChannel): Promise<DisplayResult<DisplayLink>> {
    // An unbound search port is "not connected", which the widget shows differently from a failed provider call.
    if (!search) return { status: 'unavailable', reason: 'not-connected', items: [] };
    const response = await search(storeId, kind, keyword).catch(() => undefined);
    const items = response?.items.slice(0, 10).flatMap(({ title, link }) => {
      const url = httpsLink(link);
      return url ? [{ title: plainTitle(title).slice(0, 300), url }] : [];
    });
    return displayed(items);
  }
  const [blog, cafearticle] = await Promise.all([channel('blog'), channel('cafearticle')]);
  return { source: 'naver-search', use: 'display-only', blog, cafearticle } as const;
}

async function readNews(sources: Sources, storeId: string, query: string, range?: Period): Promise<DisplayResult<NewsLink> | undefined> {
  if (!sources.searchNews) return undefined;
  try {
    const response = await sources.searchNews(storeId, query);
    if (!response) return undefined;
    return displayed(response.items.slice(0, 10).flatMap(item => {
      const title = plainTitle(item.title).slice(0, 300);
      const url = httpsLink(item.originallink) ?? httpsLink(item.link);
      const timestamp = Date.parse(item.pubDate);
      if (!title || !url || !Number.isFinite(timestamp)) return [];
      const businessDay = new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 10);
      if (range && (businessDay < range.from || businessDay > range.to)) return [];
      return [{ title, url, publishedAt: new Date(timestamp).toISOString() }];
    }));
  } catch { return displayed<NewsLink>(undefined); }
}

async function readPlaces(sources: Sources, storeId: string, query: string): Promise<DisplayResult<Place> | undefined> {
  if (!sources.searchPlaces) return undefined;
  try {
    const response = await sources.searchPlaces(storeId, query);
    if (!response) return undefined;
    return displayed(response.items.slice(0, 5).flatMap(item => {
      const title = plainTitle(item.title).slice(0, 300);
      const address = plainTitle(item.roadAddress || item.address).slice(0, 300);
      const category = plainTitle(item.category).slice(0, 150);
      const url = httpsLink(item.link);
      if (!title || !address) return [];
      return [{ title, address, category, ...(url && { url }) }];
    }));
  } catch { return displayed<Place>(undefined); }
}

export async function readTrendLinks(sources: Sources, storeId: string, keyword: string) {
  const [links, news, local] = await Promise.all([
    readSearchLinks(sources.searchLinks, storeId, keyword), readNews(sources, storeId, keyword), readPlaces(sources, storeId, keyword),
  ]);
  return { ...links, ...(news && { news }), ...(local && { local }) };
}

export async function readNewsReferences(sources: Sources, storeId: string, region: string, period: Period) {
  const news = await readNews(sources, storeId, region, period);
  return news && { ...news, source: 'naver-search', use: 'display-only', region, period } as const;
}

export async function readStoreLocation(sources: Sources, storeId: string) {
  if (!sources.geocodeStore) return undefined;
  let result: DisplayResult<Location>;
  try {
    const response = await sources.geocodeStore(storeId);
    if (!response) return undefined;
    if (response.status !== 'OK') return { ...displayed<Location>(undefined), source: 'naver-maps' } as const;
    const match = response.meta.totalCount === 1 && response.addresses.length === 1 ? response.addresses[0] : undefined;
    const address = match && plainTitle(match.roadAddress || match.jibunAddress).slice(0, 300);
    const longitude = match?.x.trim() ? Number(match.x) : NaN;
    const latitude = match?.y.trim() ? Number(match.y) : NaN;
    result = displayed(address && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? [{ address, longitude, latitude }] : []);
  } catch { result = displayed<Location>(undefined); }
  return { ...result, source: 'naver-maps' } as const;
}

export class LocalError extends Error {
  constructor(readonly status: number, readonly code: string, readonly reason = code) { super(reason); }
}

export function invalid(): never { throw new LocalError(400, 'INVALID_REQUEST'); }
export function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalid();
  return value;
}

export function period(input: { from?: unknown; to?: unknown }): Period {
  const from = day(input.from);
  const to = day(input.to);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration < 0 || duration > 366 * 86_400_000) invalid();
  return { from, to };
}

export function parseSearch(input: { from?: unknown; to?: unknown; keyword?: unknown }): SearchRequest {
  const { from, to } = period(input);
  const keyword = input.keyword;
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 80) invalid();
  return { startDate: from, endDate: to, timeUnit: 'date',
    keywordGroups: [{ groupName: keyword.trim(), keywords: [keyword.trim()] }] };
}

export async function readSales(sources: Sources, storeId: string, range: Period) {
  const items = await sources.sales?.(storeId, range).catch(() => undefined);
  return { status: items ? items.length ? 'available' : 'empty' : 'unavailable', source: 'pos', items: items ?? [] };
}

export async function readSearch(sources: Sources, storeId: string, query: SearchRequest) {
  const data = await sources.searchInterest?.(storeId, query).catch(() => undefined);
  const series = data?.startDate === query.startDate && data.endDate === query.endDate &&
    data.timeUnit === query.timeUnit && data.results.length === 1 && data.results[0].title === query.keywordGroups[0].groupName
    ? data.results[0].data.filter(point => point.period >= query.startDate && point.period <= query.endDate
      && Number.isFinite(point.ratio) && point.ratio >= 0 && point.ratio <= 100) : undefined;
  return { status: series ? series.length ? 'available' : 'empty' : 'unavailable',
    source: 'naver-search-interest', unit: 'relative-index', query, items: series ?? [] };
}

export function salesByHour(items: Sale[], weekday: number) {
  const bands = new Map<number, { hour: number; quantity: number; settlementIds: Set<string> }>();
  for (const item of items) {
    // Seoul has a fixed UTC+09:00 offset throughout the supported POS dates.
    const timestamp = Date.parse(item.occurredAt);
    if (!Number.isFinite(timestamp)) continue;
    const local = new Date(timestamp + 9 * 3_600_000);
    if ((local.getUTCDay() || 7) !== weekday) continue;
    const hour = local.getUTCHours();
    const band = bands.get(hour) ?? { hour, quantity: 0, settlementIds: new Set<string>() };
    band.quantity += item.quantity;
    band.settlementIds.add(item.settlementId);
    bands.set(hour, band);
  }
  return [...bands.values()].sort((a, b) => a.hour - b.hour)
    .map(band => ({ ...band, settlementIds: [...band.settlementIds] }));
}

export function salesByMenuDay(items: Sale[]) {
  const days = new Map<string, Map<string, { menuId: string; businessDate: string; quantity: number }>>();
  for (const { menuId, businessDate, quantity } of items) {
    const menus = days.get(businessDate) ?? new Map();
    const line = menus.get(menuId) ?? { menuId, businessDate, quantity: 0 };
    line.quantity += quantity;
    menus.set(menuId, line);
    days.set(businessDate, menus);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, menus]) =>
    [...menus.values()].sort((a, b) => a.menuId.localeCompare(b.menuId)));
}
