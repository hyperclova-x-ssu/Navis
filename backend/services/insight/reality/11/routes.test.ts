import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { InsightError } from '../../scope.ts';
import { bizinfoProvider, matchNotices, parseBizinfo } from './bizinfo.ts';
import { grantSync } from './grant-refresh.ts';
import { registerManualsGrants } from './routes.ts';

const sample = JSON.parse(readFileSync(new URL('./bizinfo.fixture.json', import.meta.url), 'utf8'));

describe('manual and grant transport', () => {
  it('rejects unauthenticated requests and non-owner scope before touching storage', async () => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (!(error instanceof InsightError)) throw error;
      return reply.code(error.status).send({ code: error.code });
    });
    const connect = vi.fn();
    registerManualsGrants(app, { connect } as unknown as Pool, { gatewayToken: 'gateway' });
    const store = 'aa000000-0000-0000-0000-000000000001';
    const url = `/internal/v1/insight/stores/${store}/insight/manuals`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: 'Bearer gateway',
      'x-navis-store-id': store, 'x-navis-store-role': 'staff', 'x-navis-user-id': store } })).statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('normalizes the official envelope and requires both profile tags', () => {
    const notices = parseBizinfo(sample);
    expect(notices[0]).toMatchObject({ providerId: 'PBLN_000000000080236', deadline: '2022-09-30',
      agency: '중소벤처기업부', source: 'bizinfo' });
    expect(matchNotices(notices, '서울', '카페')).toHaveLength(1);
    expect(matchNotices(notices, '서울', '제조업')).toEqual([]);
    expect(matchNotices(notices, '경기', '카페')).toEqual([]);
  });

  it('reads the legacy official field aliases and rejects a broken nonempty payload', () => {
    const link = 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000080236';
    const row = { seq: 'PBLN_000000000080236', title: '서울 소상공인 지원', author: '서울특별시', link,
      reqstDt: '20261120 ~ 20261130', hashTags: '서울,카페' };
    expect(parseBizinfo({ jsonArray: { item: [row] } })).toMatchObject([{ providerId: row.seq,
      agency: '서울특별시', officialUrl: link, startsOn: '2026-11-20', deadline: '2026-11-30' }]);
    expect(() => parseBizinfo({ jsonArray: { item: [{ title: '인증 오류' }] } })).toThrow();
    expect(parseBizinfo({ jsonArray: { item: [] } })).toEqual([]);
  });

  it('accepts the jsonArray list returned by the live JSON endpoint', () => {
    const [row] = sample.jsonArray.item;
    expect(parseBizinfo({ jsonArray: [{ ...row, hashTags: undefined, hashtags: '경영,서울,카페' }] }))
      .toMatchObject([{ providerId: 'PBLN_000000000080236', tags: ['경영', '서울', '카페'] }]);
  });

  it('finds Seoul and nationwide café candidates from public fields and excludes explicitly local notices', () => {
    const [notice] = parseBizinfo(sample);
    const row = (providerId: string, title: string, tags: string[], target = '') =>
      ({ ...notice!, providerId, title, tags, target });
    const rows = [
      row('near', '[서울] 소상공인 지원', []),
      row('local', '[경남] 소상공인 지원', ['서울', '카페']),
      row('nationwide', '경영 개선 지원', ['전 지역'], '음식점'),
      row('digital', '디지털전환 지원', ['서울']),
      row('exact', '특정 카페 공고', ['서울', '카페']),
      row('unrelated', '중소기업 수출 지원', ['서울']),
      row('foreign', '외식업 지원', ['부산']),
      row('other-city', '2026년 세종시 소상공인 디지털전환 안내', ['서울', '창업']),
      row('other-district', '2026년 강원혁신도시 창업 공유오피스 모집', ['서울', '창업']),
    ];
    expect(matchNotices(rows, '서울', '카페', true)).toMatchObject([
      { providerId: 'exact', matchTier: 'exact', matchReason: '서울 · 카페' },
      { providerId: 'near', matchTier: 'related', matchReason: '서울 · 소상공인' },
      { providerId: 'nationwide', matchTier: 'related', matchReason: '전국 · 음식점' },
      { providerId: 'digital', matchTier: 'related', matchReason: '서울 · 디지털 전환' },
    ]);
    expect(matchNotices(rows, '서울', '제조업', true)).toEqual([]);
    expect(matchNotices([rows[0]!], '서울', '카페')).toEqual([]);
  });

  it('withdraws a previously matched notice when a successful feed now shows a different jurisdiction', async () => {
    const [original] = parseBizinfo(sample);
    const replacement = { ...original!, title: '[경남] 카페 지원', deadline: '2026-11-30' };
    const profile = { region: '서울', industry: '카페' };
    const previous = { id: replacement.noticeId, kind: 'notice', archived: false, parentId: null, businessDay: null,
      data: { ...profile, deadline: replacement.deadline, sourceMode: 'live' } };
    const db = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM insight.manuals_grants_record') ? [previous] : [] })) };
    const changes = await grantSync({ storeId: 'scope', actorId: 'actor', db: db as unknown as PoolClient,
      now: new Date('2026-11-22T00:00:00.000Z'), businessDay: '2026-11-22' }, profile, 'live', [replacement]);
    expect(changes.changes).toMatchObject([{ id: replacement.noticeId, archived: true }]);
  });

  it('uses the fixture without fetch and requires A6, terms and a key for live access', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(sample)));
    await expect(bizinfoProvider({ fetch: transport }).load('서울')).resolves.toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
    expect(() => bizinfoProvider({ mode: 'live', a6: true, key: 'fixture-key', fetch: transport })).toThrow();
    expect(() => bizinfoProvider({ mode: 'live', a6: true, termsAccepted: true,
      key: 'API key: "fixture-key"', fetch: transport })).toThrow();
    await expect(bizinfoProvider({ mode: 'live', a6: true, termsAccepted: true, key: 'fixture-key',
      fetch: transport }).load('서울')).resolves.toHaveLength(1);
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toContain('dataType=json');
    expect(options?.redirect).toBe('error');
  });
});
