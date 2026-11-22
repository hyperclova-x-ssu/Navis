import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { personaCapability } from './index.ts';

const app = Fastify();
const headers = {
  'x-ncp-apigw-api-key-id': 'fixture-hub',
  'x-ncp-apigw-api-key': 'fixture-hub-key',
};
const name = encodeURIComponent('안숭잘부 카페');

beforeAll(async () => {
  const context = {
    now: () => new Date('2026-11-17T06:45:00Z'),
    accountId: () => 'fixture-owner',
    providerCredential: (request: FastifyRequest, field: string) => {
      const product = request.url.startsWith('/map-geocode/') ? 'maps' : 'hub';
      return field === 'keyId' ? `fixture-${product}` : `fixture-${product}-key`;
    },
    transaction: (_request: unknown, action: (client: unknown) => Promise<unknown>) => action({
      query: async () => ({ rows: [
        { keyword: '커피', day: '2026-11-15', searches: 40 },
        { keyword: '커피', day: '2026-11-16', searches: 50 },
      ] }),
    }),
  };
  await personaCapability.register(app, context as unknown as Parameters<typeof personaCapability.register>[1]);
  await app.ready();
});
afterAll(() => app.close());

describe('PN10 published Search and Maps response shapes', () => {
  test.each([
    ['blog', ['title', 'link', 'description', 'bloggername', 'bloggerlink', 'postdate']],
    ['cafearticle', ['title', 'link', 'description', 'cafename', 'cafeurl']],
    ['news', ['title', 'link', 'originallink', 'description', 'pubDate']],
    ['local', ['title', 'link', 'category', 'description', 'telephone', 'address', 'roadAddress', 'mapx', 'mapy']],
  ] as const)('%s supplies exactly its own search fields', async (channel, fields) => {
    const result = await app.inject({ url: `/search/v1/${channel}?query=${name}`, headers });
    expect(result.statusCode).toBe(200);
    const data = result.json();
    expect(Object.keys(data).sort()).toEqual(['display', 'items', 'lastBuildDate', 'start', 'total']);
    expect(Object.keys(data.items[0]).sort()).toEqual([...fields].sort());
    if (channel === 'local') expect(data.items[0].telephone).toBe('');
  });

  test('validates Local-specific limits and emits documented Search errors', async () => {
    const result = await app.inject({ url: `/search/v1/local?query=${name}&display=6`, headers });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ errorCode: 'SE02', errorMessage: 'Invalid display value (부적절한 display 값입니다.)' });
  });

  test('serves documented XML and escapes embedded search markup', async () => {
    const result = await app.inject({ url: `/search/v1/blog?query=${name}&format=xml`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('xml');
    expect(result.body).toContain('<rss version="2.0">');
    expect(result.body).toContain('&lt;b&gt;');
  });

  test('keeps trend ratios scoped to observed keywords and the same window', async () => {
    const result = await app.inject({
      method: 'POST', url: '/search-trend/v1/search', headers,
      payload: { startDate: '2026-11-15', endDate: '2026-11-16', timeUnit: 'date',
        keywordGroups: [{ groupName: '커피', keywords: ['커피'] }, { groupName: '미관측', keywords: ['관측 없음'] }] },
    });
    expect(result.statusCode).toBe(200);
    const response = result.json();
    expect(Object.keys(response).sort()).toEqual(['endDate', 'results', 'startDate', 'timeUnit']);
    expect(response.results[0].data).toEqual([
      { period: '2026-11-15', ratio: 80 }, { period: '2026-11-16', ratio: 100 },
    ]);
    expect(response.results[1].data).toEqual([]);
  });

  test('uses the Maps credentials and its published geocoding sample field spelling', async () => {
    const result = await app.inject({
      url: '/map-geocode/v2/geocode?query=' + encodeURIComponent('상도동 999-12'),
      headers: { accept: 'application/json', 'x-ncp-apigw-api-key-id': 'fixture-maps',
        'x-ncp-apigw-api-key': 'fixture-maps-key' },
    });
    expect(result.statusCode).toBe(200);
    const response = result.json();
    expect(response.meta).toEqual({ totalCount: 1, page: 1, count: 1 });
    expect(Object.keys(response.addresses[0]).sort()).toEqual([
      'addressElements', 'distance', 'englishAddress', 'jibunAddress', 'roadAddress', 'x', 'y',
    ]);
    expect(Object.keys(response.addresses[0].addressElements[0]).sort()).toEqual([
      'code', 'longName', 'shortName', 'types',
    ]);
  });

  test('returns the separate HUB Trend validation envelope', async () => {
    const response = await app.inject({
      method: 'POST', url: '/search-trend/v1/search', headers,
      payload: { startDate: '2026-02-31', endDate: '2026-03-02', timeUnit: 'date', keywordGroups: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(Object.keys(response.json()).sort()).toEqual(['errId', 'errMsg']);
  });
});
