import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbPool } from '../../packages/db/index.ts';
import { createInsightApp } from '../../services/insight/app.ts';
import { execute } from '../../services/insight/reality/10/commands.ts';
import { inStore } from '../../services/insight/scope.ts';

const pool = dbPool('insight', 'runtime', 'test');
const storeId = randomUUID();
const actorId = randomUUID();
const token = randomUUID();
const now = new Date('2026-11-21T07:00:00Z');
const app = createInsightApp(pool, { gatewayToken: token, now: () => now, logging: false });
const prefix = `/internal/v1/insight/stores/${storeId}/insight`;
const post = (path, payload, key = randomUUID(), user = actorId) => app.inject({
  method: 'POST', url: prefix + path, payload, headers: {
    authorization: `Bearer ${token}`, 'idempotency-key': key, 'x-navis-user-id': user,
    'x-navis-store-id': storeId, 'x-navis-store-role': 'owner',
    'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00:00',
  },
});

try {
  const manualResponse = await post('/manuals', { title: '오픈 점검', section: 'handover', category: 'opening', steps: ['창문 열기'] });
  assert.equal(manualResponse.statusCode, 200);
  const manual = manualResponse.json();
  assert.ok(manual.undoUntil);
  const reviewId = randomUUID();
  const review = await inStore(pool, storeId, db => execute({ db, storeId, actorId, at: now }, randomUUID(), {}, async () => {
    await db.query(`INSERT INTO insight.cctv_review (store_id, business_date, hour, review_id, revision, marked_at)
      VALUES ($1, '2026-11-21', 15, $2, 1, $3)`, [storeId, reviewId, now]);
    return { resourceId: reviewId, revision: 1, affectedSources: ['cctv'], undoUntil: new Date(+now + 6000).toISOString() };
  }));
  for (const [original, expectedStatus] of [[review, 201], [manual, 200]]) {
    const path = `/receipts/${original.receiptId}/undo`;
    assert.equal((await post(path, {}, randomUUID(), randomUUID())).statusCode, 404);
    const key = randomUUID();
    const undone = await post(path, {}, key);
    assert.equal(undone.statusCode, expectedStatus, undone.body);
    assert.equal(undone.json().resourceId, original.resourceId);
    assert.deepEqual((await post(path, {}, key)).json(), undone.json());
  }
  const { rows } = await inStore(pool, storeId, db => db.query(`
    SELECT (SELECT marked_at FROM insight.cctv_review WHERE review_id = $1) AS marked,
      (SELECT archived FROM insight.manuals_grants_record WHERE id = $2) AS archived
  `, [reviewId, manual.resourceId]), true);
  assert.deepEqual(rows, [{ marked: null, archived: true }]);
  console.info('PASS canonical Insight undo preserves both CCTV and manual command receipts and rejects another actor');
} finally {
  await app.close();
  await pool.end();
}
