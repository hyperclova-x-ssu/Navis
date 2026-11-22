import type { GeocodeResult, SearchItems, SearchResult, SearchTrendRequest, SearchTrendResult } from '../../../packages/naver/contracts/pn10/index.ts';
import type { OperationId, Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { arr, check, int, isoDate, num, obj, oneOf, opt, project, str, type Shape } from './schema.ts';
import { call, parseJson, type CallResult } from './transport.ts';

/**
 * PN10 published W wires for marketing B13: NAVER API HUB Search and Search Trend, Maps Geocoding.
 * Contract: packages/naver/contracts/pn10 · persona capability pn10.
 *
 * Sources (read 2026-11-21 KST): common headers and errors https://api.ncloud-docs.com/docs/naver-api-hub-overview ·
 * blog/cafearticle/local/news https://api.ncloud-docs.com/docs/naver-api-hub-search-{blog,cafearticle,local,news} ·
 * trend https://api.ncloud-docs.com/docs/naver-api-hub-search-trend · geocoding
 * https://api.ncloud-docs.com/docs/application-maps-geocoding.
 *
 * Search terms (WIDGET_IMPOSSIBLE_CONSENSUS §2): results are shown independently, unaltered and attributed
 * with their links; never stored as history, fed to HCX or blended into a local mention KPI.
 */
const channelItem = {
  blog: obj({ title: str(), link: str(), description: str(), bloggername: str(), bloggerlink: str(), postdate: str() }),
  cafearticle: obj({ title: str(), link: str(), description: str(), cafename: str(), cafeurl: str() }),
  // `telephone` returns no value and exists for compatibility (official local item table).
  local: obj({ title: str(), link: str(), category: str(), description: str(), telephone: str(), address: str(), roadAddress: str(), mapx: str(), mapy: str() }),
  news: obj({ title: str(), originallink: str(), link: str(), description: str(), pubDate: str() }),
} as const;
export type SearchChannel = keyof typeof channelItem;

export const searchResponseShape = (channel: SearchChannel) => obj({
  lastBuildDate: str(), total: int({ min: 0 }), start: int({ min: 1 }), display: int({ min: 0 }), items: arr(channelItem[channel]),
});
export const trendRequestShape = obj({
  startDate: isoDate, endDate: isoDate, timeUnit: oneOf(['date', 'week', 'month']),
  keywordGroups: arr(obj({ groupName: str({ min: 1 }), keywords: arr(str({ min: 1 }), { min: 1, max: 20 }) }), { min: 1, max: 5 }),
  device: opt(oneOf(['pc', 'mo'])), gender: opt(oneOf(['m', 'f'])),
  ages: opt(arr(oneOf(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']), { min: 1, max: 11 })),
});
export const trendResponseShape = obj({
  startDate: str(), endDate: str(), timeUnit: str(),
  results: arr(obj({ title: str(), keywords: arr(str()), data: arr(obj({ period: str(), ratio: num() })) })),
});
const addressElement = obj({ types: arr(str()), longName: str(), shortName: str(), code: str() });
export const geocodeResponseShape = obj({
  status: str(), meta: obj({ totalCount: int({ min: 0 }), page: int({ min: 0 }), count: int({ min: 0 }) }),
  addresses: arr(obj({ roadAddress: str(), jibunAddress: str(), englishAddress: str(), addressElements: arr(addressElement), x: str(), y: str(), distance: num() })),
  errorMessage: opt(str()),
});

const limits: Record<SearchChannel, { display: [number, number]; start: [number, number]; sorts: readonly string[] }> = {
  blog: { display: [1, 100], start: [1, 1000], sorts: ['sim', 'date'] },
  cafearticle: { display: [1, 100], start: [1, 1000], sorts: ['sim', 'date'] },
  news: { display: [1, 100], start: [1, 1000], sorts: ['sim', 'date'] },
  local: { display: [1, 5], start: [1, 1], sorts: ['random', 'comment'] },
};
type Attribution = { provider: 'NAVER'; operation: OperationId; retrievedAt: string; use: 'display-only' };

function failure(result: CallResult): never {
  // Search errors are flat `{errorCode, errorMessage}`, gateway errors wrap `error.errorCode`, trend uses `errId`.
  let body: Record<string, unknown> = {};
  try { body = (parseJson(result) ?? {}) as Record<string, unknown>; } catch { /* non-JSON error body */ }
  const nested = body.error as Record<string, unknown> | undefined;
  const code = [body.errorCode, nested?.errorCode, body.status].find(value => typeof value === 'string') as string | undefined;
  const info = { providerStatus: result.status, providerCode: code?.slice(0, 32) };
  if (result.status === 401 || result.status === 403) throw new NaverAdapterError('FORBIDDEN', info);
  if (result.status === 429) throw new NaverAdapterError('RATE_LIMITED', info);
  if (result.status >= 400 && result.status < 500) throw new NaverAdapterError('REJECTED', info);
  throw new NaverAdapterError('UNAVAILABLE', info);
}

export function createSearchPort(provider: Provider, clock: { now(): Date } = { now: () => new Date() }) {
  async function read<T>(operation: OperationId, path: string, shape: Shape, init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }) {
    const result = await call(provider, operation, path, init);
    if (result.status !== 200) failure(result);
    const attribution: Attribution = { provider: 'NAVER', operation, retrievedAt: clock.now().toISOString(), use: 'display-only' };
    return { attribution, result: project<T>(shape, parseJson(result), { strict: provider.strict }) };
  }

  return {
    async search<C extends SearchChannel>(channel: C, input: { query: string; display?: number; start?: number; sort?: string; signal?: AbortSignal }) {
      const limit = limits[channel];
      if (!limit) throw new NaverAdapterError('INVALID_INPUT', { detail: 'channel' });
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 100) throw new NaverAdapterError('INVALID_INPUT', { detail: 'query' });
      const query = new URLSearchParams({ query: input.query });
      for (const [key, [min, max]] of [['display', limit.display], ['start', limit.start]] as const) {
        const value = input[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new NaverAdapterError('INVALID_INPUT', { detail: key });
        query.set(key, String(value));
      }
      if (input.sort !== undefined) {
        if (!limit.sorts.includes(input.sort)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'sort' });
        query.set('sort', input.sort);
      }
      query.set('format', 'json');
      return read<SearchResult<SearchItems[C]>>(`pn10.${channel}` as OperationId, `/search/v1/${channel}?${query}`, searchResponseShape(channel), { signal: input.signal });
    },

    /** Ratios compare groups inside one request window only; never a count or a stored history. */
    async trend(input: { request: SearchTrendRequest; signal?: AbortSignal }) {
      check(trendRequestShape, input.request, { strict: true, code: 'INVALID_INPUT' });
      if (input.request.startDate < '2016-01-01' || input.request.endDate < input.request.startDate) throw new NaverAdapterError('INVALID_INPUT', { detail: 'period' });
      return read<SearchTrendResult>('pn10.trend', '/search-trend/v1/search', trendResponseShape, {
        body: JSON.stringify(input.request), headers: { 'Content-Type': 'application/json' }, signal: input.signal,
      });
    },

    /** Location lookup used independently of search results. */
    async geocode(input: { query: string; coordinate?: string; page?: number; count?: number; signal?: AbortSignal }) {
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200) throw new NaverAdapterError('INVALID_INPUT', { detail: 'query' });
      const query = new URLSearchParams({ query: input.query });
      if (input.coordinate !== undefined) {
        if (!/^-?\d{1,3}(?:\.\d+)?,-?\d{1,2}(?:\.\d+)?$/.test(input.coordinate)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'coordinate' });
        query.set('coordinate', input.coordinate);
      }
      if (input.page !== undefined) {
        if (!Number.isSafeInteger(input.page) || input.page < 1) throw new NaverAdapterError('INVALID_INPUT', { detail: 'page' });
        query.set('page', String(input.page));
      }
      if (input.count !== undefined) {
        if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 100) throw new NaverAdapterError('INVALID_INPUT', { detail: 'count' });
        query.set('count', String(input.count));
      }
      return read<GeocodeResult>('pn10.geocode', `/map-geocode/v2/geocode?${query}`, geocodeResponseShape, { headers: { Accept: 'application/json' }, signal: input.signal });
    },
  };
}
