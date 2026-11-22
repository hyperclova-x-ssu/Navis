import { describe, expect, it, vi } from 'vitest';
import { createLiveSearchSources } from './ncp-search.ts';
import { parseSearch, readSearch, readTrendLinks, readNewsReferences, readStoreLocation } from './sources.ts';

const store = 'c05409a6-f082-5964-a787-c1ed3184988b';
const address = '경기도 성남시 분당구 불정로 6';
const period = { from: '2026-11-01', to: '2026-11-16' };
const request = parseSearch({ ...period, keyword: '정자동 카페' });
const live = { NAVIS_NCP_APIHUB_PROVIDER: 'live', NAVIS_NCP_MAPS_PROVIDER: 'live',
  NAVIS_NCP_SEARCH_STORE_ID: store, NAVIS_NCP_MAPS_STORE_ADDRESS: address };

function fixture() {
  const secrets = new Map([
    ['/run/navis-ncp/apihub/NCP_APIHUB_CLIENT_ID', 'test-hub-id'],
    ['/run/navis-ncp/apihub/NCP_APIHUB_CLIENT_SECRET', 'test-hub-secret'],
    ['/run/navis-ncp/maps/NCP_MAPS_CLIENT_ID', 'test-maps-id'],
    ['/run/navis-ncp/maps/NCP_MAPS_CLIENT_SECRET', 'test-maps-secret'],
  ]);
  const readCredential = vi.fn((path: string) => {
    const value = secrets.get(path);
    if (!value) throw new Error('Unprovisioned fixture');
    return value;
  });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/search-trend/v1/search') {
      const query = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      return Response.json({ ...query, results: [{ title: query.keywordGroups[0].groupName,
        keywords: query.keywordGroups[0].keywords, data: [{ period: query.startDate, ratio: 12.45 }] }] });
    }
    if (url.pathname === '/map-geocode/v2/geocode') return Response.json({ status: 'OK',
      meta: { totalCount: 1, page: 1, count: 1 }, addresses: [{ roadAddress: address, jibunAddress: '정자동 1',
        englishAddress: '6 Buljeong-ro', addressElements: [{ types: ['SIDO'], longName: '경기도', shortName: '경기도', code: '' }],
        x: '127.1054', y: '37.3595', distance: 0 }], errorMessage: '' });
    const items = {
      blog: [{ title: '<b>커피</b>', description: 'snippet', link: 'https://blog.naver.com/cafe/1', bloggername: 'B', bloggerlink: '', postdate: '20261111' }],
      cafearticle: [{ title: '카페', description: '', link: 'https://cafe.naver.com/cafe/1', cafename: 'C', cafeurl: '' }],
      news: [{ title: '새 <b>소식</b>', description: '', link: 'https://n.news.naver.com/article/1', originallink: 'https://example.org/article/1', pubDate: 'Fri, 06 Nov 2026 20:00:00 +0900' },
        { title: '기간 밖', description: '', link: 'https://n.news.naver.com/article/2', originallink: '', pubDate: 'Mon, 30 Nov 2026 20:00:00 +0900' }],
      local: [{ title: '<b>동네</b> 카페', link: '', address: '정자동 1', roadAddress: '불정로 6', category: '카페', description: '', telephone: '', mapx: '1271054328', mapy: '373595963' }],
    }[url.pathname.split('/').at(-1)!];
    return Response.json({ lastBuildDate: 'Mon, 30 Nov 2026 20:00:00 +0900', total: items?.length, start: 1, display: items?.length, items });
  });
  let time = 0;
  return { secrets, readCredential, fetcher, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe('live PN10 widget sources', () => {
  it('defaults to off, requires a complete file pair and keeps fixture mode explicit', async () => {
    const deps = fixture();
    const searchInterest = vi.fn();
    expect(createLiveSearchSources({}, { searchInterest }, deps)).toEqual({});
    expect(deps.readCredential).not.toHaveBeenCalled();
    expect(createLiveSearchSources({ NAVIS_NCP_APIHUB_PROVIDER: 'fake' }, { searchInterest }, deps).searchInterest).toBe(searchInterest);
    deps.secrets.delete('/run/navis-ncp/apihub/NCP_APIHUB_CLIENT_SECRET');
    const sources = createLiveSearchSources(live, { searchInterest }, deps);
    expect((await readSearch(sources, store, request)).status).toBe('unavailable');
    expect(searchInterest).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
    expect((await readStoreLocation(sources, store))?.status).toBe('available');
  });

  it('uses official wire shapes and returns only display data with source and units', async () => {
    const deps = fixture();
    const sources = createLiveSearchSources(live, {}, deps);
    const [trend, links, location] = await Promise.all([
      readSearch(sources, store, request), readTrendLinks(sources, store, '정자동 카페'), readStoreLocation(sources, store),
    ]);
    expect(trend).toEqual({ status: 'available', source: 'naver-search-interest', unit: 'relative-index', query: request,
      items: [{ period: '2026-11-01', ratio: 12.45 }] });
    expect(links.blog.items).toEqual([{ title: '커피', url: 'https://blog.naver.com/cafe/1' }]);
    expect(links.cafearticle.items).toEqual([{ title: '카페', url: 'https://cafe.naver.com/cafe/1' }]);
    expect(links.local?.items).toEqual([{ title: '동네 카페', category: '카페', address: '불정로 6' }]);
    expect(links.news?.items[0]).toEqual({ title: '새 소식', url: 'https://example.org/article/1', publishedAt: '2026-11-06T11:00:00.000Z' });
    expect(location).toEqual({ status: 'available', source: 'naver-maps', items: [{ address, longitude: 127.1054, latitude: 37.3595 }] });

    const calls = new Map(deps.fetcher.mock.calls.map(([input, init]) => [new URL(String(input)).pathname, { url: new URL(String(input)), init }]));
    expect(calls.size).toBe(6);
    for (const [path, { url, init }] of calls) {
      const maps = path === '/map-geocode/v2/geocode';
      expect(url.origin).toBe(maps ? 'https://maps.apigw.ntruss.com' : 'https://naverapihub.apigw.ntruss.com');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-ncp-apigw-api-key-id')).toBe(maps ? 'test-maps-id' : 'test-hub-id');
      expect(headers.get('x-ncp-apigw-api-key')).toBe(maps ? 'test-maps-secret' : 'test-hub-secret');
      expect(headers.get('x-navis-naver-virtual-account')).toBeNull();
      expect(init?.redirect).toBe('manual');
      if (maps) {
        expect(headers.get('accept')).toBe('application/json');
        expect(Object.fromEntries(url.searchParams)).toEqual({ query: address, count: '2' });
      } else if (path === '/search-trend/v1/search') {
        expect(init?.method).toBe('POST');
        expect(headers.get('content-type')).toBe('application/json');
        expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual(request);
      } else {
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('query')).toBe('정자동 카페');
        expect(url.searchParams.get('display')).toBe(path.endsWith('/local') ? '5' : '10');
        expect(url.searchParams.get('format')).toBe('json');
        if (path.endsWith('/news')) expect(url.searchParams.get('sort')).toBe('date');
      }
    }
  });

  it('coalesces repeated requests, scopes cache access and filters W18 references by KST date', async () => {
    const deps = fixture();
    const sources = createLiveSearchSources(live, {}, deps);
    const [left, right] = await Promise.all([
      readNewsReferences(sources, store, '정자동', period), readNewsReferences(sources, store, '정자동', period),
    ]);
    expect(right).toEqual(left);
    expect(left).toMatchObject({ status: 'available', source: 'naver-search', use: 'display-only', period, items: [{ title: '새 소식' }] });
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
    expect(await readNewsReferences(sources, 'other-store', '정자동', period)).toBeUndefined();
    expect(await readStoreLocation(sources, 'other-store')).toBeUndefined();
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
    await readNewsReferences(sources, store, '수원', period);
    deps.advance(5 * 60_000 + 1);
    await readNewsReferences(sources, store, '정자동', period);
    expect(deps.fetcher).toHaveBeenCalledTimes(3);
  });

  it('reuses existing unavailable states for quota errors and avoids another call on immediate refresh', async () => {
    const deps = fixture();
    deps.fetcher.mockImplementation(async () => Response.json({ error: { errorCode: '400', message: 'provider detail' } }, { status: 429 }));
    const sources = createLiveSearchSources(live, {}, deps);
    const references = await readNewsReferences(sources, store, '정자동', period);
    expect(references).toMatchObject({ status: 'unavailable', reason: 'provider-failed', items: [] });
    expect((await readSearch(sources, store, request)).status).toBe('unavailable');
    expect(await readStoreLocation(sources, store)).toEqual({ status: 'unavailable', reason: 'provider-failed', source: 'naver-maps', items: [] });
    await readStoreLocation(sources, store);
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses redirects and does not reuse an ambiguous address as a store coordinate', async () => {
    const deps = fixture();
    deps.fetcher.mockImplementationOnce(async () => Response.redirect('https://example.invalid/unsafe'));
    deps.fetcher.mockImplementationOnce(async () => Response.json({ status: 'OK', meta: { totalCount: 2, page: 1, count: 0 }, addresses: [] }));
    const sources = createLiveSearchSources(live, {}, deps);
    expect((await readNewsReferences(sources, store, '정자동', period))?.status).toBe('unavailable');
    expect(await readStoreLocation(sources, store)).toEqual({ status: 'empty', source: 'naver-maps', items: [] });
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
  });
});
