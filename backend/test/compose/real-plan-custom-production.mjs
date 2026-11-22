import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbPool } from '../../packages/db/index.ts';
import { calendarPosProjectionHandlers, listProjections } from '../../services/customer/reality/07/projection.ts';
import { withCustomerStore as inStore } from '../../services/customer/claims.ts';

const db = dbPool('customer', 'runtime', 'test');
const storeId = randomUUID();
const orderId = randomUUID();
const type = 'pos.custom_pickup_changed.v1';
const project = (revision, productionEntry) => inStore(db, storeId, client => calendarPosProjectionHandlers[type](client, {
  eventId: randomUUID(), producer: 'pos', storeId, scopeKey: storeId, storeSeq: String(revision), eventType: type,
  schemaVersion: 1, aggregateId: orderId, occurredAt: '2026-11-21T01:00:00.000Z',
  payload: {
    calendarProjection: { source: 'custom-pickup', sourceId: orderId, revision, entry: { date: '2026-11-23', time: '15:00' } },
    productionProjection: { source: 'custom-production', sourceId: orderId, revision, entry: productionEntry },
  },
}));
const read = () => inStore(db, storeId, client => listProjections({ db: client, storeId }, {
  start: '2026-11-21', end: '2026-11-25', limit: 10, cursor: [null, null],
}));

try {
  const entry = { date: '2026-11-22', time: '11:00' };
  await project(1, entry);
  assert.deepEqual((await read()).map(({ source, sourceId, title, date, time }) => ({ source, sourceId, title, date, time })), [
    { source: 'custom-pickup', sourceId: orderId, title: '픽업 예정', date: '2026-11-23', time: '15:00' },
    { source: 'custom-production', sourceId: orderId, title: '제작 예정', ...entry },
  ]);
  await project(2, null);
  await project(1, entry);
  assert.deepEqual((await read()).map(({ source, sourceRevision }) => ({ source, sourceRevision })), [
    { source: 'custom-pickup', sourceRevision: 2 },
  ]);
  console.info('PASS Customer persists distinct production and pickup rows, and stale delivery cannot revive production');
} finally {
  await db.end();
}
