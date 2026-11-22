import { readSecret } from '../../../../packages/db/index.ts';
import { createMarketingProvider, type OperationId } from '../../naver/binding.ts';
import { isAdapterError, NaverAdapterError } from '../../naver/errors.ts';
import { createSearchPort } from '../../naver/pn10-search.ts';
import { isUuid } from '../../promo/contracts.ts';
import { pn10SearchInterest, type Sources } from './sources.ts';

const hubOperations = ['pn10.blog', 'pn10.cafearticle', 'pn10.local', 'pn10.news', 'pn10.trend'] as const;
const hubFiles = [
  '/run/navis-ncp/apihub/NCP_APIHUB_CLIENT_ID', '/run/navis-ncp/apihub/NCP_APIHUB_CLIENT_SECRET',
] as const;
const mapsFiles = [
  '/run/navis-ncp/maps/NCP_MAPS_CLIENT_ID', '/run/navis-ncp/maps/NCP_MAPS_CLIENT_SECRET',
] as const;
const cacheLimit = 128;
const searchTtl = 5 * 60_000;
const trendTtl = 15 * 60_000;
const mapsTtl = 60 * 60_000;

type Dependencies = { fetcher?: typeof fetch; readCredential?: (path: string) => string; now?: () => number };
type SearchSources = Omit<Sources, 'sales'>;
type CredentialFiles = readonly [string, string];

function keyPair(files: CredentialFiles, read: (path: string) => string) {
  const [keyId, key] = files.map(path => read(path).trim());
  if (![keyId, key].every(value => /^[\x21-\x7e]{1,512}$/.test(value))) throw new Error('Invalid NCP search credentials');
  return JSON.stringify({ keyId, key });
}

function available(files: CredentialFiles, read: (path: string) => string) {
  try { keyPair(files, read); return true; } catch { return false; }
}

export function createNcpSearchPort(config: { storeId: string; apiHub: boolean; maps: boolean }, dependencies: Dependencies = {}) {
  if (!isUuid(config.storeId)) return undefined;
  const read = dependencies.readCredential ?? readSecret;
  const apiHub = config.apiHub && available(hubFiles, read);
  const maps = config.maps && available(mapsFiles, read);
  if (!apiHub && !maps) return undefined;

  const operations: OperationId[] = apiHub ? [...hubOperations] : [];
  if (maps) operations.push('pn10.geocode');
  const operationCredentialFiles = Object.fromEntries(operations.map(operation => [operation,
    operation === 'pn10.geocode' ? mapsFiles[0] : hubFiles[0],
  ]));
  const provider = createMarketingProvider({
    storeId: config.storeId, providerAccount: 'ncp-search', mode: 'live', operations, operationCredentialFiles,
    approve: request => request.storeId === config.storeId,
    fetcher: dependencies.fetcher,
    // The shared transport reads at dispatch, so a removed or malformed mount stops egress and rotation can take effect.
    readCredential(path) { return keyPair(path === mapsFiles[0] ? mapsFiles : hubFiles, read); },
  });
  return { apiHub, maps, port: createSearchPort(provider) };
}

function createReadCache(now: () => number) {
  const entries = new Map<string, { value: Promise<unknown>; expiresAt: number }>();
  let throttledUntil = 0;

  return function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const currentTime = now();
    const current = entries.get(key);
    if (current && current.expiresAt > currentTime) return current.value as Promise<T>;
    if (throttledUntil > currentTime) return Promise.reject(new NaverAdapterError('RATE_LIMITED'));
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= currentTime) entries.delete(entryKey);
    if (entries.size >= cacheLimit) {
      const completed = [...entries].find(([, entry]) => Number.isFinite(entry.expiresAt));
      if (!completed) return Promise.reject(new NaverAdapterError('UNAVAILABLE'));
      entries.delete(completed[0]);
    }
    const entry = { expiresAt: Infinity, value: Promise.resolve().then(load).then(value => {
      entry.expiresAt = now() + ttl;
      return value;
    }, error => {
      entry.expiresAt = now() + 30_000;
      if (isAdapterError(error, 'RATE_LIMITED')) throttledUntil = now() + 60_000;
      throw error;
    }) };
    entries.set(key, entry);
    return entry.value;
  };
}

/** Production selection for W18–W20. Fixture ports are accepted only when explicitly selected. */
export function createLiveSearchSources(env: NodeJS.ProcessEnv, fixture: SearchSources = {}, dependencies: Dependencies = {}): SearchSources {
  const sources: SearchSources = env.NAVIS_NCP_APIHUB_PROVIDER === 'fake' ? { ...fixture, trendProvider: 'fake' } : {};
  const storeId = env.NAVIS_NCP_SEARCH_STORE_ID ?? '';
  const address = env.NAVIS_NCP_MAPS_STORE_ADDRESS?.trim();
  const binding = createNcpSearchPort({
    storeId,
    apiHub: env.NAVIS_NCP_APIHUB_PROVIDER === 'live',
    maps: env.NAVIS_NCP_MAPS_PROVIDER === 'live' && !!address && address.length <= 200 && !/\p{Cc}/u.test(address),
  }, dependencies);
  if (!binding) return sources;

  const { port } = binding;
  const now = dependencies.now ?? Date.now;
  const hub = createReadCache(now);
  const maps = createReadCache(now);
  const signal = () => AbortSignal.timeout(3500);
  const forStore = (scope: string) => {
    if (scope !== storeId) throw new NaverAdapterError('NOT_CONFIGURED');
    return port;
  };
  if (binding.apiHub) {
    sources.trendProvider = 'live';
    const trend = pn10SearchInterest(forStore);
    sources.searchInterest = async (scope, request) => {
      forStore(scope);
      return hub(`trend:${JSON.stringify(request)}`, trendTtl, () => trend(scope, request));
    };
    sources.searchLinks = async (scope, channel, query) => {
      const search = forStore(scope);
      return hub(`${channel}:${query}`, searchTtl, async () =>
        (await search.search(channel, { query, display: 10, signal: signal() })).result);
    };
    sources.searchNews = async (scope, query) => scope !== storeId ? undefined : hub(`news:${query}`, searchTtl, async () =>
      (await port.search('news', { query, display: 10, sort: 'date', signal: signal() })).result);
    sources.searchPlaces = async (scope, query) => scope !== storeId ? undefined : hub(`local:${query}`, searchTtl, async () =>
      (await port.search('local', { query, display: 5, signal: signal() })).result);
  }
  if (binding.maps && address) {
    sources.geocodeStore = async scope => scope !== storeId ? undefined : maps(address, mapsTtl, async () =>
      (await port.geocode({ query: address, count: 2, signal: signal() })).result);
  }
  return sources;
}
