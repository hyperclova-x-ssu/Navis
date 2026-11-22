// GAP-POS compose proof: owner HTTP through api-gateway → POS → its own PostgreSQL, with the private
// NAVER virtual server answering PN02 orders, PN09 settlement and PN16 Smart Store status (no outbound calls).
// Phase `write` presses the two order cards and reads the payment views. Phase `reread` runs after a POS
// restart in a new session. Run inside the Compose network with access to `api-gateway` and `db` (README).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { dbPool } from '../../../../../packages/db/index.ts';
import { provisionOwner } from '../../../../account/reality/00/provision.ts';
import { withStoreTransaction } from '../../../transaction.ts';

const phase = process.argv[2];
const { NAVIS_GAP_POS_RUN: run, NAVIS_GAP_POS_PASSWORD: password, NAVIS_GAP_POS_PRODUCT_ORDER_IDS: productOrderIds = '' } = process.env;
assert.ok(['write', 'reread'].includes(phase) && /^[a-f0-9]{12}$/.test(run ?? '') && (password ?? '').length >= 24, 'usage');
const origin = 'http://127.0.0.1:18180';
const gateway = 'http://api-gateway:3000';
const cafe = 'c05409a6-f082-5964-a787-c1ed3184988b';
const owner = { loginId: `gap-pos-${run}@example.invalid`, storeId: cafe };
const keys = { prepare: `gap-pos-${run}-prepare`, pickup: `gap-pos-${run}-pickup` };
const posDb = dbPool('pos', 'migrate');
const accountDb = dbPool('account', 'migrate');
const evidence = { phase, requests: [] };
let session = {};

function send(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const outgoing = httpRequest(url, { method, headers, signal: AbortSignal.timeout(10_000) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function call(method, path, status, { body, key, record } = {}) {
  const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
  if (path.startsWith('/api/v1/auth/') && session.cookie) headers.cookie = session.cookie;
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await send(gateway + path, method, headers, body === undefined ? undefined : JSON.stringify(body));
  const text = response.body.toString('utf8');
  assert.equal(response.status, status, `${method} ${path} expected ${status}: ${text.slice(0, 300)}`);
  const setCookie = response.headers['set-cookie']?.find(value => value.startsWith('navis_refresh='));
  if (setCookie) session.cookie = setCookie.split(';')[0];
  if (record) evidence.requests.push({ step: record, method, path: path.replace(/\/api\/v1\/stores\/[0-9a-f-]+/, '/api/v1/stores/{storeId}'),
    status, requestId: response.headers['x-request-id'] ?? null, cacheControl: response.headers['cache-control'] ?? null });
  return text ? JSON.parse(text) : undefined;
}

async function login(account) {
  session = {};
  session.token = (await call('POST', '/api/v1/auth/login', 200, { body: { loginId: account.loginId, password } })).accessToken;
}

const pos = `/api/v1/stores/${cafe}/pos/naver`;
const byNumber = list => Object.fromEntries(list.items.map(item => [item.orderNumber, item]));
const journal = () => withStoreTransaction(posDb, cafe, async db => (await db.query(`
  SELECT command_key, order_ref, action, preparation_minutes, before_revision, state, receipt_id, receipt, settled_at
  FROM pos.naver_order_command WHERE store_id = $1 AND command_key = ANY($2::text[]) ORDER BY created_at`,
[cafe, Object.values(keys)])).rows);

try {
  if (phase === 'write') {
    const outsider = { loginId: `gap-pos-other-${run}@example.invalid`, storeId: randomUUID() };
    for (const [account, name] of [[owner, '안숭잘부 카페'], [outsider, 'Other store']]) {
      await provisionOwner(accountDb, { loginId: account.loginId, password, ownerName: 'Synthetic owner',
        storeId: account.storeId, storeName: name, businessDayStart: '05:00' });
    }
    await call('GET', `${pos}/orders`, 401, { record: 'no session' });
    await login(owner);
    const before = await call('GET', `${pos}/orders`, 200, { record: 'list NAVER orders' });
    const orders = byNumber(before);
    assert.deepEqual(Object.keys(orders[`order-01`]).sort(),
      ['actions', 'orderNumber', 'pickedUpAt', 'preparationMinutes', 'preparingAt', 'revision', 'source', 'status']);
    assert.deepEqual([orders['order-01'].status, orders['order-02'].status], ['received', 'preparing']);
    evidence.before = before.items;

    const stale = await call('POST', `${pos}/orders/order-01/prepare`, 409,
      { key: `gap-pos-${run}-stale`, body: { expectedRevision: orders['order-01'].revision + 1, preparationMinutes: 10 }, record: 'stale press' });
    assert.equal(stale.reason, 'STALE_REVISION');
    const prepared = await call('POST', `${pos}/orders/order-01/prepare`, 200,
      { key: keys.prepare, body: { expectedRevision: orders['order-01'].revision, preparationMinutes: 10 }, record: '[준비 시작] order-01' });
    assert.deepEqual(await call('POST', `${pos}/orders/order-01/prepare`, 200,
      { key: keys.prepare, body: { expectedRevision: orders['order-01'].revision, preparationMinutes: 10 }, record: 'replay same key' }), prepared);
    const picked = await call('POST', `${pos}/orders/order-02/pickup`, 200,
      { key: keys.pickup, body: { expectedRevision: orders['order-02'].revision }, record: '[픽업 완료] order-02' });
    assert.deepEqual([prepared.status, prepared.preparationMinutes, picked.status], ['preparing', 10, 'picked-up']);
    evidence.receipts = { prepared, picked };

    const settled = await call('GET', `${pos}/npay/payments/PN09SETTLED01`, 200, { record: 'Npay settlement by payment' });
    assert.deepEqual(settled.items.map(row => [row.payHistId, row.kind]),
      [['PN09SETTLED01-A', 'approval'], ['PN09SETTLED01-C1', 'cancellation']]);
    assert.equal(typeof settled.page.totalCount, 'number');
    const unapproved = await call('GET', `${pos}/npay/payments/PN09BOOKED01`, 200, { record: 'Npay without settlement' });
    assert.deepEqual([unapproved.items, unapproved.totals.settledAmount], [[], 0]);
    const history = await call('GET', `${pos}/npay/pay-histories/PN09SETTLED01-C1`, 200, { record: 'Npay settlement by history' });
    assert.deepEqual(history.items.map(row => row.kind), ['cancellation']);
    evidence.npay = { settled, unapproved, history };

    const ids = productOrderIds.split(',').filter(Boolean);
    assert.equal(ids.length, 2);
    const statuses = await call('POST', `${pos}/smartstore/order-statuses`, 200,
      { body: { productOrderIds: [...ids, '999999'] }, record: 'Smart Store order status' });
    assert.deepEqual(statuses.unavailable, ['999999']);
    assert.deepEqual(statuses.items.map(row => Object.keys(row).sort()), [['productOrderId', 'productOrderStatus'], ['productOrderId', 'productOrderStatus']]);
    evidence.smartstore = statuses;

    await login(outsider);
    const other = await call('GET', `/api/v1/stores/${outsider.storeId}/pos/naver/orders`, 404, { record: 'unconnected store' });
    assert.equal(other.reason, 'NAVER_NOT_CONNECTED');
    await call('POST', `${pos}/orders/order-01/pickup`, 403,
      { key: `gap-pos-${run}-outsider`, body: { expectedRevision: prepared.revision }, record: 'other owner on café store' });
    await call('POST', '/api/v1/auth/logout', 204);
  } else {
    await login(owner);
    const after = byNumber(await call('GET', `${pos}/orders`, 200, { record: 'new session re-read' }));
    const rows = await journal();
    assert.deepEqual(rows.map(row => [row.order_ref, row.action, row.state]), [['order-01', 'prepare', 'settled'], ['order-02', 'pickup', 'settled']]);
    const [prepare, pickup] = rows;
    assert.deepEqual([after['order-01'].status, after['order-01'].preparationMinutes, after['order-01'].revision],
      ['preparing', 10, prepare.receipt.revision]);
    assert.equal(after['order-01'].preparingAt, prepare.settled_at.toISOString());
    assert.deepEqual([after['order-02'].status, after['order-02'].revision], ['picked-up', pickup.receipt.revision]);
    assert.equal(after['order-02'].pickedUpAt, pickup.settled_at.toISOString());
    const detail = await call('GET', `${pos}/orders/order-01`, 200, { record: 'detail re-read' });
    assert.deepEqual(detail, after['order-01']);
    // The same card key after the restart returns the stored receipt without another provider write.
    const replay = await call('POST', `${pos}/orders/order-02/pickup`, 200,
      { key: keys.pickup, body: { expectedRevision: Number(pickup.before_revision) }, record: 'replay after restart' });
    assert.deepEqual(replay, pickup.receipt);
    evidence.after = [after['order-01'], after['order-02']];
    evidence.journal = rows.map(({ receipt, ...row }) => ({ ...row, receiptRevision: receipt.revision }));
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await Promise.all([posDb.end(), accountDb.end()]);
}
