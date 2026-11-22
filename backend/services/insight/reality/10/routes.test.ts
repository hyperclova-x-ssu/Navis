import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { dbConfig, dbPool } from '../../../../packages/db/index.ts';
import { inStore } from '../../scope.ts';
import { registerCamera } from '../../cctv.ts';
import { posTableChanged } from './projection.ts';
import { registerB10Routes } from './routes.ts';

const pool = dbPool('insight', 'runtime', 'test');
const migrationPool = dbPool('insight', 'migrate', 'test');
const token = randomUUID();
const now = () => new Date('2026-11-21T07:00:00Z');
const app = createApp('insight', async () => {}, false);
registerB10Routes(app, pool, token, now);
const headers = (store: string, actor: string, key = randomUUID()) => ({
  authorization: `Bearer ${token}`, 'x-navis-store-role': 'owner', 'x-navis-store-id': store,
  'x-navis-user-id': actor, 'idempotency-key': key, 'x-navis-pos-tables-enabled': '1',
});
const url = (store: string, path: string) => `/internal/v1/insight/stores/${store}/insight/${path}`;
beforeAll(() => runner({
  databaseUrl: dbConfig('insight', 'migrate', 'test'),
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
  schema: 'insight', migrationsSchema: 'insight', migrationsTable: 't311_test_migrations', direction: 'up',
  verbose: false, log: () => {},
}), 30_000);
afterAll(async () => { await app.close(); await Promise.all([pool.end(), migrationPool.end()]); });

it('persists a manual measurement and returns alerts to a fresh owner session', async () => {
  const store = randomUUID(), actor = randomUUID(), key = randomUUID();
  const measurement = { measuredAt: '2026-11-21T06:50:00Z', temperatureC: 28.5, humidityPct: 40 };
  const request = { method: 'POST', url: url(store, 'environment-readings'), headers: headers(store, actor, key), payload: measurement } as const;
  const result = await app.inject(request);
  expect(result.statusCode).toBe(201);
  expect((await app.inject(request)).json()).toEqual(result.json());
  expect((await app.inject({ ...request, payload: { ...measurement, humidityPct: 41 } })).statusCode).toBe(409);
  expect((await app.inject({ ...request, headers: { ...request.headers, 'x-navis-store-id': randomUUID() } })).statusCode).toBe(403);
  const summary = await app.inject({ url: url(store, 'environment-summary'), headers: headers(store, randomUUID()) });
  expect(summary.json()).toMatchObject({ current: { ...measurement, measuredAt: '2026-11-21T06:50:00.000Z', source: 'manual' },
    alerts: [{ metric: 'temperatureC', direction: 'above' }] });
  const other = randomUUID();
  expect((await app.inject({ url: url(other, 'environment-summary'), headers: headers(other, actor) })).json().current).toBeNull();
  expect((await inStore(pool, store, db => db.query('SELECT event_type FROM insight.outbox'))).rows)
    .toEqual([{ event_type: 'insight.environment_reading_recorded.v1' }]);
  expect((await pool.query('SELECT * FROM insight.environment_reading')).rowCount).toBe(0);
});

it('revises registered zones and links only active same-store POS tables', async () => {
  const store = randomUUID(), actor = randomUUID(), cameraId = randomUUID(), tableId = randomUUID();
  await registerCamera(migrationPool, { storeId: store, cameraId, zoneRevision: 0, zoneIds: [], deviceId: randomUUID(),
    token: randomUUID(), expiresAt: new Date('2026-11-22T07:00:00Z') });
  const request = { method: 'PATCH', url: url(store, `cameras/${cameraId}/zones`), headers: headers(store, actor),
    payload: { expectedRevision: 0, zones: [{ label: '창가', polygon: [{ x: .1, y: .1 }, { x: .8, y: .1 }, { x: .8, y: .8 }] }] } } as const;
  expect((await app.inject(request)).json()).toMatchObject({ revision: 1 });
  const zoneList = await app.inject({ url: url(store, `zones?cameraId=${cameraId}`), headers: headers(store, actor) });
  const [zone] = zoneList.json().items;
  expect(zone).toMatchObject({ label: '창가', cameraId, zoneSetRevision: 1 });
  const link = { method: 'PATCH', url: url(store, `zones/${zone.zoneId}/table-link`), headers: headers(store, actor),
    payload: { expectedRevision: 0, tableId } } as const;
  expect((await app.inject({ ...link, headers: { ...link.headers, 'x-navis-pos-tables-enabled': '0' } })).json())
    .toEqual({ code: 'TABLE_LINK_DISABLED' });
  expect((await app.inject(link)).json()).toEqual({ code: 'TABLE_UNAVAILABLE' });
  await inStore(pool, store, db => posTableChanged(db, {
    producer: 'pos', scopeKey: store, storeId: store, eventType: 'pos.table_changed.v1', eventId: randomUUID(),
    storeSeq: '1', schemaVersion: 1, aggregateId: tableId, occurredAt: now().toISOString(),
    payload: { tableId, revision: 1, state: 'empty' },
  }));
  expect((await app.inject(link)).json()).toMatchObject({ revision: 1 });
  expect((await app.inject({ url: url(store, 'table-links'), headers: headers(store, randomUUID()) })).json().items)
    .toEqual([expect.objectContaining({ tableId, zoneId: zone.zoneId, tableState: 'active' })]);
});
