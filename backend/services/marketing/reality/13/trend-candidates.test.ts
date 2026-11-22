import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { registerLocalMarketingRoutes } from './routes.ts';

const pool = dbPool('marketing', 'runtime', 'test');
const app = Fastify();
const readToken = randomUUID(), commandToken = randomUUID(), actorId = randomUUID();
const keywordPath = '/local-trends/candidates';
const menu = vi.fn(async () => [
  { name: '디카페인 아메리카노', category: 'coffee' }, { name: '카페라떼', category: 'coffee' },
]);
const search = vi.fn(async (_: string, query: Parameters<NonNullable<Parameters<typeof registerLocalMarketingRoutes>[2]['searchInterest']>>[1]) => ({
  ...query, results: query.keywordGroups.map(({ groupName }, group) => ({ title: groupName, data: Array.from({ length: query.timeUnit === 'date' ? 35 : 57 }, (_, index) => ({
    period: new Date(Date.parse(query.startDate) + index * (query.timeUnit === 'date' ? 1 : 7) * 86_400_000).toISOString().slice(0, 10),
    ratio: group === 0 && query.keywordGroups.length > 1 ? 100 : query.timeUnit === 'week' || index < 28 ? 50 : 75,
  })) })),
}));
const searchLinks = vi.fn(async () => ({ items: [{ title: 'Never used', link: 'https://example.com' }] }));

beforeAll(async () => {
  await runMigrations('marketing', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  registerLocalMarketingRoutes(app, pool, { readToken, commandToken, trendMenu: menu, searchInterest: search, searchLinks,
    now: () => new Date('2026-11-23T09:00:00Z') });
  await app.ready();
});
afterAll(async () => { await app.close(); await pool.end(); });

function call(storeId: string, method: HTTPMethods, path: string, payload?: object, headers: Record<string, string> = {}) {
  return app.inject({ method, url: `/internal/v1/marketing/stores/${storeId}${path}`, payload,
    headers: { authorization: `Bearer ${method === 'GET' ? readToken : commandToken}`,
      'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner',
      'idempotency-key': randomUUID(), ...headers } });
}

it('seeds real names once and persists the owner list, including removals, by store', async () => {
  const store = randomUUID();
  const initial = (await call(store, 'GET', keywordPath)).json();
  expect(initial.items).toHaveLength(10);
  const remove = initial.items.find((item: { keyword: string }) => item.keyword === '카페라떼');
  expect(remove).toMatchObject({ suggested: true });
  const input = { keyword: '  라임   에이드  ' };
  const replay = { 'idempotency-key': randomUUID() };
  const added = await call(store, 'POST', keywordPath, input, replay);
  expect(added.statusCode).toBe(200);
  expect((await call(store, 'POST', keywordPath, input, replay)).json()).toEqual(added.json());
  expect((await call(store, 'POST', keywordPath, { keyword: '라임 에이드' })).statusCode).toBe(409);
  expect((await call(store, 'DELETE', `${keywordPath}/${remove.id}`, { confirmed: true, expectedRevision: initial.sourceRevision })).statusCode).toBe(409);
  expect((await call(store, 'DELETE', `${keywordPath}/${remove.id}`, { expectedRevision: added.json().revision })).statusCode).toBe(400);
  expect((await call(store, 'DELETE', `${keywordPath}/${remove.id}`, { confirmed: true, expectedRevision: added.json().revision })).statusCode).toBe(200);
  const list = (await call(store, 'GET', keywordPath)).json();
  expect(list.items).toHaveLength(10);
  expect(list.items).toContainEqual(expect.objectContaining({ keyword: '라임 에이드', suggested: false }));
  expect(list.items).not.toContainEqual(expect.objectContaining({ keyword: '카페라떼' }));
  const outsider = randomUUID();
  expect((await call(outsider, 'DELETE', `${keywordPath}/${remove.id}`, { confirmed: true, expectedRevision: 1 }, { 'x-navis-store-id': store })).statusCode).toBe(403);
  expect((await call(store, 'POST', keywordPath, { keyword: '침입' }, { 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
  expect((await call(store, 'POST', keywordPath, { keyword: '침입' }, { authorization: `Bearer ${readToken}` })).statusCode).toBe(401);
});

it('uses the same comparison for the stored and local lists with no preview writes', async () => {
  const store = randomUUID();
  const stored = (await call(store, 'GET', '/local-trends?from=2026-11-10&to=2026-11-16')).json();
  const keywords = stored.candidates.map((row: { keyword: string }) => row.keyword);
  const called = search.mock.calls.length;
  const example = (await call(store, 'POST', '/local-trends/preview', { keywords })).json();
  expect(search.mock.calls.length).toBe(called);
  expect(example.items).toEqual(stored.ranking.items.map(({ id: _id, isMenu: _isMenu, menuName: _menuName, ...row }: Record<string, unknown>) => row));
  expect(stored.ranking.items).toContainEqual(expect.objectContaining({ keyword: '디카페인 커피', isMenu: true,
    menuName: '디카페인 아메리카노', changePercent: 50 }));
  expect(stored.ranking.items).toContainEqual(expect.objectContaining({ isMenu: false, menuName: null }));
  expect(stored.ranking.recommendations).toMatchObject({ source: 'rule', version: '2026-11' });
  const lookup = await call(store, 'GET', '/local-trends?from=2026-11-10&to=2026-11-16&keyword=coffee');
  expect(lookup.json()).not.toHaveProperty('links');
  expect(searchLinks).not.toHaveBeenCalled();
  await call(store, 'POST', '/local-trends/preview', { keywords: ['도넛'] });
  expect((await call(store, 'GET', keywordPath)).json().items.map((row: { keyword: string }) => row.keyword)).toEqual(keywords);
});

it('previews ten defaults without restoring removed terms or writing to the owner list', async () => {
  const store = randomUUID();
  const preview = (await call(store, 'POST', '/local-trends/preview', { keywords: [], useDefaults: true })).json();
  expect(preview.initialKeywords).toHaveLength(10);
  const list = (await call(store, 'GET', keywordPath)).json();
  expect(list.items.map(({ keyword }: { keyword: string }) => keyword).sort()).toEqual([...preview.initialKeywords].sort());
  const candidate = list.items[0];
  await call(store, 'DELETE', `${keywordPath}/${candidate.id}`, { expectedRevision: list.sourceRevision, confirmed: true });
  expect((await call(store, 'GET', keywordPath)).json().items).toHaveLength(9);
  const empty = (await call(store, 'POST', '/local-trends/preview', { keywords: [] })).json();
  expect(empty).toMatchObject({ status: 'empty', items: [] });
  expect(empty).not.toHaveProperty('initialKeywords');
});
