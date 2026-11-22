import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { transact } from '../../../../packages/streams/transaction.ts';
import { projectCalendarSource } from '../../../customer/reality/07/projection.ts';
import { inStore } from '../../transaction.ts';
import { importOfficialLocalSnapshot } from './official.ts';
import { localPosHandlers } from './pos.ts';
import { registerLocalMarketingRoutes } from './routes.ts';
import { pn10SearchInterest } from './sources.ts';

const port = Number(process.env.B13_PG_PORT);
assert.ok(port > 0, 'Run against the disposable Compose database');
const connection = { host: '127.0.0.1', port, database: 'postgres' };
const admin = new pg.Pool({ ...connection, user: 'postgres' });
const migrator = new pg.Pool({ ...connection, user: 'marketing_mig' });
const runtime = new pg.Pool({ ...connection, user: 'marketing_run' });
const customerAdmin = new pg.Pool({ ...connection, database: 'b13_customer', user: 'postgres' });
const customer = new pg.Pool({ ...connection, database: 'b13_customer', user: 'customer_run' });
const store = randomUUID(), partner = randomUUID(), outsider = randomUUID(), actor = randomUUID();
const readToken = randomUUID(), commandToken = randomUUID();
let app = Fastify();
let origin = '';
let now = new Date('2026-11-21T17:00:00Z');

async function start() {
  app = Fastify();
  registerLocalMarketingRoutes(app, runtime, {
    readToken, commandToken, now: () => now,
    async canOffer(sender, recipient) { return sender === store && recipient === partner; },
    async listPeers(storeId) { return storeId === store ? [{ storeId: partner, displayName: '동네 카페' }] : []; },
    searchInterest: pn10SearchInterest(() => ({
      async trend({ request }) {
        return { result: { ...request, results: [{ title: request.keywordGroups[0].groupName,
          data: [{ period: request.startDate, ratio: 100 }] }] } };
      },
    })),
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}

async function request(storeId: string, path: string, expected: number, body?: object,
  key: string = randomUUID(), token = body ? commandToken : readToken) {
  const response = await fetch(`${origin}/internal/v1/marketing/stores/${storeId}${path}`, {
    method: body ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${token}`, 'x-navis-store-role': 'owner',
      'x-navis-user-id': actor, 'x-navis-store-id': storeId, 'idempotency-key': key,
      'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00:00',
      'content-type': 'application/json',
    }, body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}

try {
  await admin.query(`CREATE ROLE marketing_mig LOGIN; CREATE ROLE marketing_run LOGIN;
    CREATE SCHEMA marketing AUTHORIZATION marketing_mig; GRANT USAGE ON SCHEMA marketing TO marketing_run`);
  await admin.query('CREATE DATABASE b13_customer');
  await customerAdmin.query(`CREATE ROLE customer_mig; CREATE ROLE customer_run LOGIN;
    CREATE SCHEMA customer AUTHORIZATION customer_mig; GRANT USAGE ON SCHEMA customer TO customer_run`);
  await transact(customerAdmin, async db => {
    await db.query('SET LOCAL ROLE customer_mig');
    const sql = await readFile(new URL('../../../customer/migrations/20261122000700_real_calendar_staff.sql', import.meta.url), 'utf8');
    await db.query(sql.split('-- Down Migration')[0]);
  });
  const setup = await admin.connect();
  try {
    await setup.query('SET ROLE marketing_mig');
    for (const file of ['20261121000500_promo.sql', '20261122001300_real_local.sql']) {
      const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      await setup.query(sql.split('-- Down Migration')[0]);
    }
    await setup.query('RESET ROLE');
  } finally { setup.release(); }

  const officialId = randomUUID();
  const source = { region: '서울 동작구', coverageDate: '2026-10-01', kinds: ['festival' as const],
    changes: [{ id: officialId, kind: 'festival' as const, title: '공식 축제', authority: '서울특별시',
      referenceDate: '2026-11-21', sourceUrl: 'https://data.seoul.go.kr/' }],
    population: [{ quarter: '2026-Q4', weekday: 6, startHour: 14, endHour: 15, estimate: 128,
      referenceDate: '2026-10-01', refreshedAt: '2026-11-21T00:00:00Z', sourceUrl: 'https://data.seoul.go.kr/' }],
  };
  await importOfficialLocalSnapshot(migrator, store, source);
  await importOfficialLocalSnapshot(migrator, store, source);

  await start();
  const range = '?from=2026-11-01&to=2026-11-30';
  const offer = { recipientStoreId: partner, title: '공동 행사', terms: '함께 준비', sharedContact: '운영팀',
    startsOn: '2026-11-21', endsOn: '2026-11-30', respondBy: '2026-11-21' };
  const change = { title: '영업 시간 변경', region: '서울 동작구', referenceDate: '2026-11-21' };
  await request(store, '/local-changes', 401, change, randomUUID(), readToken);
  const { resourceId: changeId } = await request(store, '/local-changes', 200, change);
  const initial = await request(store, '/local-changes' + range, 200);
  assert.equal(initial.unreadCount, 2);
  assert.equal(initial.sourceRevision, 2);
  const firstPage = await request(store, '/local-changes' + range + '&limit=1', 200);
  const secondPage = await request(store, '/local-changes' + range + '&limit=1&cursor=' + firstPage.nextCursor, 200);
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  assert.equal(firstPage.sourceRevision, secondPage.sourceRevision);
  assert.equal(initial.items.find((item: { id: string }) => item.id === officialId).revision, 1);
  const key = `navis:run:${randomUUID()}`;
  const ack = await request(store, `/local-changes/${changeId}/ack`, 200, { expectedRevision: 1 }, key);
  assert.deepEqual(await request(store, `/local-changes/${changeId}/ack`, 200, { expectedRevision: 1 }, key), ack);
  await request(store, `/local-changes/${changeId}/ack`, 409, { expectedRevision: 2 }, key);
  await request(partner, `/local-changes/${changeId}/unack`, 404, { expectedRevision: 2 });
  await request(store, `/local-changes/receipts/${ack.receiptId}/undo`, 200, {});
  await request(store, `/local-changes/${changeId}/ack`, 200, { expectedRevision: 3 });

  const { resourceId: offerId } = await request(store, '/offers', 200, offer);
  assert.deepEqual((await request(store, '/offers/peers', 200)).items, [{ storeId: partner, displayName: '동네 카페' }]);
  assert.equal((await request(store, '/offers', 200)).items[0].canRespond, false);
  const pending = (await request(partner, '/offers', 200)).items[0];
  assert.equal(pending.canRespond, true);
  assert.equal(pending.sharedContact, null);
  await request(store, `/offers/${offerId}/accept`, 403, { expectedRevision: 1 });
  await request(outsider, `/offers/${offerId}/accept`, 404, { expectedRevision: 1 });
  await request(partner, `/offers/${offerId}/decline`, 400, { expectedRevision: 1 });
  now = new Date('2026-11-21T20:00:00Z');
  assert.equal((await request(partner, '/offers', 200)).items[0].canRespond, false);
  assert.equal((await request(partner, `/offers/${offerId}/accept`, 409, { expectedRevision: 1 })).code, 'OFFER_EXPIRED');
  now = new Date('2026-11-21T17:00:00Z');
  await request(partner, `/offers/${offerId}/accept`, 200, { expectedRevision: 1 });
  await request(partner, `/offers/${offerId}/accept`, 409, { expectedRevision: 1 });

  const saleType = 'pos.sale_recognized.v1';
  const correctionType = 'pos.sale_corrected.v1';
  const settlementId = randomUUID(), allocationId = randomUUID(), menuId = randomUUID();
  const sale = { storeId: store, eventType: saleType, eventId: randomUUID(), producer: 'pos',
    scopeKey: store, storeSeq: '1', schemaVersion: 1, aggregateId: settlementId, occurredAt: '2026-11-21T05:20:00Z',
    payload: { settlementId, businessDate: '2026-11-21', lines: [{ allocationId, menuId, quantity: 2 }] } } as const;
  const correction = { ...sale, eventType: correctionType, eventId: randomUUID(), storeSeq: '2',
    payload: { ...sale.payload, usageEffect: 'restore', lines: [{ allocationId, menuId, quantity: 1 }] } };
  await inStore(runtime, store, async db => {
    await localPosHandlers[saleType](db, sale);
    await localPosHandlers[saleType](db, sale);
    await localPosHandlers[correctionType](db, correction);
  });
  await app.close();
  await start();

  assert.equal((await request(store, '/local-changes' + range, 200)).unreadCount, 1);
  for (const party of [store, partner]) {
    const accepted = (await request(party, '/offers', 200)).items[0];
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.sharedContact, '운영팀');
  }
  assert.equal((await request(outsider, '/offers', 200)).items.length, 0);
  const trade = await request(store, '/trade-area' + range + '&quarter=2026-Q4&weekday=6', 200);
  assert.equal(trade.population.items[0].estimate, 128);
  assert.deepEqual(trade.sales.items, [{ hour: 14, quantity: 1, settlementIds: [settlementId] }]);
  const trends = await request(store, '/local-trends' + range + '&keyword=coffee', 200);
  assert.equal(trends.search.items[0].ratio, 100);
  assert.equal(trends.sales.items[0].menuId, menuId);
  const missing = await runtime.query('SELECT count(*) FROM marketing.local_change');
  assert.equal(missing.rows[0].count, '0');
  const events = await admin.query(`SELECT event_type, count(*)::integer AS count FROM marketing.outbox GROUP BY event_type`);
  assert.deepEqual(Object.fromEntries(events.rows.map(row => [row.event_type, row.count])), {
    'marketing.local_change_recorded.v1': 1, 'marketing.local_change_acknowledged.v1': 3,
    'marketing.partnership_changed.v1': 2, 'marketing.partnership_offer_changed.v1': 2,
  });
  const projections = await admin.query(`SELECT store_id, aggregate_id, payload->'calendarProjection' AS entry
    FROM marketing.outbox WHERE event_type = 'marketing.partnership_changed.v1' ORDER BY store_id`);
  assert.deepEqual(projections.rows.map(row => row.store_id), [store, partner].sort());
  for (const row of projections.rows) {
    assert.equal(row.aggregate_id, offerId);
    assert.deepEqual(row.entry, { source: 'community-offer', sourceId: offerId,
      revision: 2, entry: { date: offer.startsOn, endDate: offer.endsOn } });
    await transact(customer, async db => {
      await db.query("SELECT set_config('app.store_id', $1, true)", [row.store_id]);
      assert.equal(await projectCalendarSource(db, row.store_id, 'marketing', row.entry), true);
      assert.equal(await projectCalendarSource(db, row.store_id, 'marketing', row.entry), false);
    });
  }
  const calendar = await customerAdmin.query(`SELECT store_id, source_id FROM customer.calendar_projection ORDER BY store_id`);
  assert.deepEqual(calendar.rows.map(row => [row.store_id, row.source_id]), [store, partner].sort().map(storeId => [storeId, offerId]));
  console.log('Marketing HTTP and PostgreSQL restart proof passed', { changeId, offerId, settlementId });
} finally {
  await app.close();
  await runtime.end();
  await migrator.end();
  await customer.end();
  await customerAdmin.end();
  await admin.end();
}
