import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbConfig, dbPool } from '../../../../packages/db/index.ts';
import { inStore, InsightError } from '../../scope.ts';
import { registerBriefing } from './routes.ts';

const pool = dbPool('insight', 'runtime', 'test');
const token = randomUUID();
const app = Fastify();
let now = new Date('2026-11-21T01:00:00Z');
app.setErrorHandler((error, _request, reply) => {
  if (!(error instanceof InsightError)) throw error;
  return reply.code(error.status).send({ code: error.code });
});
registerBriefing(app, pool, { gatewayToken: token, now: () => now });

beforeAll(() => runner({
  databaseUrl: dbConfig('insight', 'migrate', 'test'),
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
  schema: 'insight', migrationsSchema: 'insight', migrationsTable: 't311_test_migrations',
  direction: 'up', verbose: false, log: () => {},
}), 30_000);
afterAll(async () => { await app.close(); await pool.end(); });

it('keeps one acknowledgement and outbox event across retries, owner sessions and the business day boundary', async () => {
  const storeId = randomUUID(), actorId = randomUUID();
  const headers = { authorization: `Bearer ${token}`, 'x-navis-store-id': storeId, 'x-navis-store-role': 'owner',
    'x-navis-user-id': actorId, 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '04:00',
    'idempotency-key': randomUUID() };
  const url = `/internal/v1/insight/stores/${storeId}/insight/briefings`;
  const ack = { method: 'POST', url: url + '/2026-11-21/ack', headers, payload: {} } as const;
  expect((await app.inject({ ...ack, headers: { ...headers, 'x-navis-store-role': 'staff' } })).statusCode).toBe(403);
  expect((await app.inject({ url, headers })).json()).toMatchObject({
    acknowledgement: null,
    sources: { sales: { state: 'ready', data: { projectedNetSales: 0 } }, environment: { state: 'ready' },
      manualsGrants: { state: 'ready' }, reservations: { state: 'not-connected' } },
  });

  const results = await Promise.all([app.inject(ack), app.inject(ack),
    app.inject({ ...ack, headers: { ...headers, 'idempotency-key': randomUUID() } })]);
  expect(results.map(response => response.statusCode)).toEqual([200, 200, 200]);
  const receipt = results[0]!.json();
  expect(results.map(response => response.json())).toEqual([receipt, receipt, receipt]);
  const reload = await app.inject({ url, headers: { ...headers, 'x-navis-user-id': randomUUID() } });
  expect(reload.json().acknowledgement).toEqual({ acknowledgedAt: receipt.acknowledgedAt, receiptId: receipt.receiptId });
  const events = await inStore(pool, storeId, db => db.query(
    "SELECT payload FROM insight.outbox WHERE store_id=$1 AND event_type='insight.briefing_acknowledged.v1'", [storeId]), true);
  expect(events.rows).toEqual([{ payload: expect.objectContaining({ receiptId: receipt.receiptId, businessDay: '2026-11-21' }) }]);
  expect((await pool.query('SELECT count(*)::int AS count FROM insight.briefing_ack')).rows).toEqual([{ count: 0 }]);
  now = new Date('2026-11-22T01:00:00Z');
  expect((await app.inject({ url, headers })).json().acknowledgement).toBeNull();
  expect((await app.inject(ack)).json()).toEqual(receipt);
  expect((await app.inject({ ...ack, url: url + '/2026-11-22/ack' })).json()).toEqual({ code: 'IDEMPOTENCY_MISMATCH' });
  expect((await app.inject({ ...ack, headers: { ...headers, 'idempotency-key': randomUUID() } })).json())
    .toEqual({ code: 'BRIEFING_DAY_CHANGED' });
});
