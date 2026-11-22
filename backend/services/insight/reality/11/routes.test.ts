import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { InsightError } from '../../scope.ts';
import { bizinfoProvider, matchNotices, parseBizinfo } from './bizinfo.ts';
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

  it('uses the fixture without fetch and requires A6, terms and a key for live access', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(sample)));
    await expect(bizinfoProvider({ fetch: transport }).load('서울')).resolves.toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
    expect(() => bizinfoProvider({ mode: 'live', a6: true, key: 'fixture-key', fetch: transport })).toThrow();
    await expect(bizinfoProvider({ mode: 'live', a6: true, termsAccepted: true, key: 'fixture-key',
      fetch: transport }).load('서울')).resolves.toHaveLength(1);
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toContain('dataType=json');
    expect(options?.redirect).toBe('error');
  });
});
