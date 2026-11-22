import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../../../../infra/http.ts';
import { dbPool } from '../../../../../packages/db/index.ts';
import { runMigrations } from '../../../../../packages/db/migrate.ts';
import type { NaverRequestScope } from '../../../../../packages/naver/config/index.ts';
import type { Order } from '../../../../../packages/naver/contracts/pn02/wire.ts';
import { createNaverTransport } from '../../../../../packages/naver/transport/index.ts';
import { createPosNaver } from '../../../naver/index.ts';
import { withStoreTransaction } from '../../../transaction.ts';
import { registerNaverOrderRoutes } from './routes.ts';
import { posNaverOperations } from './runtime.ts';

const pool = dbPool('pos', 'runtime', 'test');
const gatewayToken = randomBytes(32).toString('hex');
const store = randomUUID();
const actorId = randomUUID();
const now = () => new Date('2026-11-23T03:00:00Z');
type Write = { operation: string; key: string | null; body: unknown };
let orders = new Map<string, Order>();
let writes: Write[] = [];
let providerCalls = 0;
const applied = new Map<string, Order>();
let mode: 'ok' | 'lost-response' | 'unreachable' | 'refuse' | 'down' = 'ok';
let sequence = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settlementRow = {
  paymentId: 'PN09SETTLED01', payHistId: 'PN09SETTLED01-A', settleType: '정산', merchantPayKey: 'merchant-order-02',
  productName: '아메리카노', payDate: '20261119', settleBasisDate: '20261119', settleExpectDate: '20261121', settleCompleteDate: '20261121',
  paySettleAmount: 4500, totalCommissionAmount: -90, totalPayCommissionAmount: -90, settleExpectAmount: 4410,
};
const cancellationRow = {
  ...settlementRow, payHistId: 'PN09SETTLED01-C1', settleType: '정산 후 취소', payDate: '20261122', settleBasisDate: '20261122',
  settleExpectDate: '20261124', settleCompleteDate: '', paySettleAmount: -500, totalCommissionAmount: 15, totalPayCommissionAmount: 15,
  settleExpectAmount: -485,
};
const commerceOrder = (productOrderId: string, productOrderStatus: string) => ({
  order: { orderId: productOrderId.slice(0, -2), orderDate: '2026-11-23T09:30:00+09:00', paymentDate: '2026-11-23T09:30:00+09:00' },
  productOrder: { productOrderId, productOrderStatus, productId: '1', originalProductId: '2', productName: '하우스 블렌드 원두',
    itemNo: '3', quantity: 1, totalPaymentAmount: 12000 },
});

function provider(scope: NaverRequestScope): Response {
  providerCalls++;
  if (mode === 'down') return json({ code: 'UNAVAILABLE' }, 503);
  const parts = scope.url.pathname.split('/');
  switch (scope.operation) {
    case 'pn02.orders.list':
      return json([...orders.values()]);
    case 'pn02.orders.read': {
      const order = orders.get(parts[4]);
      return order ? json(order) : json({ code: 'NOT_FOUND' }, 404);
    }
    case 'pn02.orders.prepare':
    case 'pn02.orders.pickup': {
      if (mode === 'unreachable') throw new Error('connect ECONNREFUSED');
      const [ref, action] = [parts[4], parts[5]];
      const key = scope.headers.get('idempotency-key');
      const body: { preparationMinutes?: number } = JSON.parse(new TextDecoder().decode(scope.body));
      writes.push({ operation: scope.operation, key, body });
      if (mode === 'refuse') return json({ code: 'CONFLICT' }, 409);
      const order = orders.get(ref);
      if (!order || !key) return json({ code: 'NOT_FOUND' }, 404);
      if (!applied.has(key)) {
        if (order.status !== (action === 'prepare' ? 'received' : 'preparing')) return json({ code: 'CONFLICT' }, 409);
        orders.set(ref, { ...order, status: action === 'prepare' ? 'preparing' : 'picked-up',
          preparationMinutes: body.preparationMinutes ?? order.preparationMinutes });
        applied.set(key, orders.get(ref)!);
      }
      if (mode === 'lost-response') throw new Error('socket hang up');
      return json(orders.get(ref));
    }
    case 'pn09.pay.settlement': {
      const [lookup, key] = [parts[6], parts[7]];
      const list = [settlementRow, cancellationRow].filter(row => (lookup === 'payment-id' ? row.paymentId : row.payHistId) === key);
      const page = Number(scope.url.searchParams.get('pageNumber') ?? 1);
      return json({ code: 'Success', message: '성공', body: { list: page === 1 ? list : [], responseCount: page === 1 ? list.length : 0,
        currentPage: page, ...(page === 1 && { totalCount: list.length, totalPageCount: list.length ? 1 : 0 }) } });
    }
    case 'pn16.commerce.orders.detail': {
      const { productOrderIds } = JSON.parse(new TextDecoder().decode(scope.body)) as { productOrderIds: string[] };
      const known = [commerceOrder('202611230001001', 'PAYED'), commerceOrder('202611220001101', 'DELIVERED')];
      return json({ timestamp: '2026-11-23T03:00:00Z', traceId: 'trace',
        data: known.filter(row => productOrderIds.includes(row.productOrder.productOrderId)) });
    }
  }
  return json({ code: 'NOT_FOUND' }, 404);
}

const transport = createNaverTransport({
  bindings: posNaverOperations.map(([operation, method, grade, route]) => ({
    operation, method, grade, route, storeId: store, providerAccount: 'ansungjalbu-cafe', mode: 'fake' as const, handler: provider,
  })),
});
const service = createApp('pos', async () => {}, false);
registerNaverOrderRoutes(service, pool, { gatewayToken, storeId: store, naver: createPosNaver(transport), now });

const headers = (storeId = store, key?: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${gatewayToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner',
  ...(key && { 'idempotency-key': key }), ...extra,
});
const call = (method: 'GET' | 'POST', tail: string, payload?: object, key?: string, storeId = store, extra?: Record<string, string>) =>
  service.inject({ method, url: `/internal/v1/pos/stores/${storeId}/naver${tail}`, headers: headers(storeId, key, extra), payload });

function seedOrders(...rows: Array<[string, Order['status'], number | null]>) {
  orders = new Map(rows.map(([suffix, status, preparationMinutes]) => {
    const orderNumber = `order-${sequence}-${suffix}`;
    return [orderNumber, { orderNumber, status, preparationMinutes }];
  }));
  return [...orders.keys()];
}

beforeAll(() => runMigrations('pos', fileURLToPath(new URL('../../../migrations/', import.meta.url)), 'test'), 30_000);
beforeEach(() => {
  sequence++;
  writes = [];
  providerCalls = 0;
  mode = 'ok';
});
afterAll(async () => {
  await service.close();
  await pool.end();
});

it('lists NAVER orders with only the owner-visible order fields', async () => {
  const [received, preparing, done] = seedOrders(['a', 'received', null], ['b', 'preparing', 7], ['c', 'picked-up', 5]);
  const list = await call('GET', '/orders');
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  const body = list.json();
  expect(body).toMatchObject({ nextCursor: null, status: 'ready', asOf: now().toISOString() });
  expect(body.items).toEqual([
    { orderNumber: received, source: 'naver', status: 'received', preparationMinutes: null, revision: expect.any(Number),
      preparingAt: null, pickedUpAt: null, actions: { prepare: true, pickup: false } },
    expect.objectContaining({ orderNumber: preparing, status: 'preparing', preparationMinutes: 7, actions: { prepare: false, pickup: true } }),
    expect.objectContaining({ orderNumber: done, status: 'picked-up', actions: { prepare: false, pickup: false } }),
  ]);
  expect((await call('GET', '/orders?status=preparing')).json().items.map((row: { orderNumber: string }) => row.orderNumber)).toEqual([preparing]);
  const first = (await call('GET', '/orders?limit=1')).json();
  expect(first.nextCursor).toBe(received);
  expect((await call('GET', `/orders?limit=1&cursor=${first.nextCursor}`)).json().items[0].orderNumber).toBe(preparing);
  expect((await call('GET', `/orders/${done}`)).json()).toMatchObject({ orderNumber: done, status: 'picked-up' });
  expect((await call('GET', '/orders/order-missing')).statusCode).toBe(404);
  expect((await call('GET', '/orders?status=done')).statusCode).toBe(400);
  expect(writes).toEqual([]);
});

it('reads the saved provider reference for each NAVER order and uses it for read-only status lookups', async () => {
  const [npay, smartstore, unlinked] = seedOrders(['a', 'received', null], ['b', 'preparing', 7], ['c', 'received', null]);
  const migrator = dbPool('pos', 'migrate', 'test');
  try {
    await withStoreTransaction(migrator, store, async db => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [store]);
      await db.query(`INSERT INTO pos.naver_order_link (store_id, order_ref, naver_pay_payment_id, smartstore_product_order_id)
        VALUES ($1, $2, $4, NULL), ($1, $3, NULL, $5)`, [store, npay, smartstore, 'PN09SETTLED01', '202611230001001']);
    }, { write: true });
  } finally {
    await migrator.end();
  }

  expect((await call('GET', '/orders')).json().items).toEqual([
    expect.objectContaining({ orderNumber: npay, naverPayPaymentId: 'PN09SETTLED01' }),
    expect.objectContaining({ orderNumber: smartstore, smartstoreProductOrderId: '202611230001001' }),
    expect.objectContaining({ orderNumber: unlinked }),
  ]);
  const paymentOrder = (await call('GET', `/orders/${npay}`)).json();
  const commerceOrder = (await call('GET', `/orders/${smartstore}`)).json();
  expect(paymentOrder).not.toHaveProperty('smartstoreProductOrderId');
  expect(commerceOrder).not.toHaveProperty('naverPayPaymentId');
  expect((await call('GET', `/npay/payments/${paymentOrder.naverPayPaymentId}`)).json().items[0])
    .toMatchObject({ paymentId: 'PN09SETTLED01', status: 'settled' });
  expect((await call('POST', '/smartstore/order-statuses', { productOrderIds: [commerceOrder.smartstoreProductOrderId] })).json().items)
    .toEqual([{ productOrderId: '202611230001001', productOrderStatus: 'PAYED' }]);
  expect((await call('GET', `/orders/${unlinked}`)).json()).not.toHaveProperty('naverPayPaymentId');
  expect(writes).toEqual([]);
});

it('refuses other credentials, roles and unconnected stores before any provider call', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  const other = randomUUID();
  expect((await call('GET', '/orders', undefined, undefined, store, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  expect((await call('GET', '/orders', undefined, undefined, store, { 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
  expect((await call('GET', '/orders', undefined, undefined, store, { 'x-navis-store-id': other })).statusCode).toBe(403);
  const unconnected = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: 1, preparationMinutes: 5 }, randomUUID(), other);
  expect(unconnected.statusCode).toBe(404);
  expect(unconnected.json()).toMatchObject({ code: 'NOT_FOUND', reason: 'NAVER_NOT_CONNECTED' });
  expect((await call('GET', '/npay/payments/PN09SETTLED01', undefined, undefined, other)).statusCode).toBe(404);
  expect(providerCalls).toBe(0);
});

it('prepares and picks up an order only from the owner press with the revision the owner saw', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  const { revision } = (await call('GET', `/orders/${ref}`)).json();
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 12 })).json())
    .toMatchObject({ reason: 'IDEMPOTENCY_KEY_REQUIRED' });
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 0 }, randomUUID())).json())
    .toMatchObject({ reason: 'INVALID_PREPARATION_TIME' });
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 12, confirmed: true }, randomUUID()))
    .statusCode).toBe(400);
  const stale = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision + 1, preparationMinutes: 12 }, randomUUID());
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ reason: 'STALE_REVISION', details: { revision } });
  const early = await call('POST', `/orders/${ref}/pickup`, { expectedRevision: revision }, randomUUID());
  expect(early.json()).toMatchObject({ code: 'CONFLICT', reason: 'ORDER_TRANSITION' });
  expect(writes).toEqual([]);

  const key = randomUUID();
  const prepared = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 12 }, key);
  expect(prepared.statusCode).toBe(200);
  const receipt = prepared.json();
  expect(receipt).toEqual({ resourceId: ref, orderNumber: ref, revision: expect.any(Number), receiptId: expect.any(String),
    status: 'preparing', preparationMinutes: 12, affectedSources: ['pos.naver-orders'] });
  expect(writes).toEqual([{ operation: 'pn02.orders.prepare', key: 'pos-naver-order:' + receipt.receiptId, body: { preparationMinutes: 12 } }]);
  const reread = (await call('GET', `/orders/${ref}`)).json();
  expect(reread).toMatchObject({ status: 'preparing', preparationMinutes: 12, revision: receipt.revision, preparingAt: now().toISOString(),
    pickedUpAt: null, actions: { prepare: false, pickup: true } });
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 12 }, key)).json()).toEqual(receipt);
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 13 }, key)).json())
    .toMatchObject({ reason: 'IDEMPOTENCY_MISMATCH' });
  expect(writes).toHaveLength(1);

  const picked = (await call('POST', `/orders/${ref}/pickup`, { expectedRevision: receipt.revision }, randomUUID())).json();
  expect(picked).toMatchObject({ status: 'picked-up', preparationMinutes: 12 });
  expect(writes.map(write => write.body)).toEqual([{ preparationMinutes: 12 }, {}]);
  expect((await call('GET', `/orders/${ref}`)).json()).toMatchObject({ status: 'picked-up', pickedUpAt: now().toISOString(),
    actions: { prepare: false, pickup: false } });
});

const journal = (key: string) => withStoreTransaction(pool, store, async db => (await db.query(
  'SELECT state, receipt_id FROM pos.naver_order_command WHERE store_id = $1 AND command_key = $2', [store, key])).rows, { readOnly: true });

it('settles an applied command whose response was lost, once, by the original key', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  const { revision } = (await call('GET', `/orders/${ref}`)).json();
  const key = randomUUID();
  mode = 'lost-response';
  const lost = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 9 }, key);
  expect(lost.statusCode).toBe(503);
  expect(lost.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', reason: 'ORDER_PROVIDER_OUTCOME_UNKNOWN' });
  expect(await journal(key)).toEqual([{ state: 'pending', receipt_id: expect.any(String) }]);
  mode = 'ok';
  // A second press sees the effect already applied: the pending command is settled and the new press is stale.
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 9 }, randomUUID())).json())
    .toMatchObject({ reason: 'STALE_REVISION' });
  const settled = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 9 }, key);
  expect(settled.statusCode).toBe(200);
  expect(settled.json()).toMatchObject({ status: 'preparing', preparationMinutes: 9 });
  expect(writes).toHaveLength(1);
  expect(await journal(key)).toEqual([{ state: 'settled', receipt_id: settled.json().receiptId }]);
});

it('holds other presses while an unconfirmed command is pending and resends it with the same provider key', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  const { revision } = (await call('GET', `/orders/${ref}`)).json();
  const key = randomUUID();
  mode = 'unreachable';
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 6 }, key)).json())
    .toMatchObject({ reason: 'ORDER_PROVIDER_OUTCOME_UNKNOWN' });
  mode = 'ok';
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 6 }, randomUUID())).json())
    .toMatchObject({ code: 'CONFLICT', reason: 'ORDER_PROVIDER_PENDING' });
  expect(writes).toEqual([]);
  const settled = (await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 6 }, key)).json();
  expect(settled).toMatchObject({ status: 'preparing', preparationMinutes: 6 });
  expect(writes).toEqual([{ operation: 'pn02.orders.prepare', key: 'pos-naver-order:' + settled.receiptId, body: { preparationMinutes: 6 } }]);
});

it('keeps a provider refusal for the same key without calling NAVER again', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  const { revision } = (await call('GET', `/orders/${ref}`)).json();
  const key = randomUUID();
  mode = 'refuse';
  const refused = await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 4 }, key);
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({ reason: 'ORDER_PROVIDER_REFUSED' });
  mode = 'ok';
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: revision, preparationMinutes: 4 }, key)).json())
    .toMatchObject({ reason: 'ORDER_PROVIDER_REFUSED' });
  expect(writes).toHaveLength(1);
  expect((await call('GET', `/orders/${ref}`)).json()).toMatchObject({ status: 'received' });
});

it('shows Npay settlement lines read-only with the official counters and settled status', async () => {
  const response = await call('GET', '/npay/payments/PN09SETTLED01');
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.page).toEqual({ responseCount: 2, currentPage: 1, totalCount: 2, totalPageCount: 1 });
  expect(body.items).toEqual([
    { paymentId: 'PN09SETTLED01', payHistId: 'PN09SETTLED01-A', settleType: '정산', kind: 'approval', payDate: '20261119',
      settleBasisDate: '20261119', settleExpectDate: '20261121', settleCompleteDate: '20261121', paySettleAmount: 4500,
      totalCommissionAmount: -90, totalPayCommissionAmount: -90, settleExpectAmount: 4410, status: 'settled' },
    expect.objectContaining({ payHistId: 'PN09SETTLED01-C1', kind: 'cancellation', paySettleAmount: -500, settleExpectAmount: -485,
      settleCompleteDate: '', status: 'scheduled' }),
  ]);
  expect(body.totals).toEqual({ complete: true, paySettleAmount: 4000, totalCommissionAmount: -75, settleExpectAmount: 3925, settledAmount: 4410 });
  expect(JSON.stringify(body)).not.toMatch(/merchantPayKey|productName/);
  expect((await call('GET', '/npay/pay-histories/PN09SETTLED01-C1')).json().items).toEqual([
    expect.objectContaining({ payHistId: 'PN09SETTLED01-C1', kind: 'cancellation' })]);
  expect((await call('GET', '/npay/payments/PN09SETTLED01?page=2')).json()).toMatchObject({
    page: { responseCount: 0, currentPage: 2 }, items: [], totals: { complete: false } });
  expect((await call('GET', '/npay/payments/PN09BOOKED01')).json()).toMatchObject({ items: [], totals: { settledAmount: 0 } });
  expect((await call('GET', '/npay/payments/PN09SETTLED01?page=0')).statusCode).toBe(400);
  expect((await call('GET', '/npay/payments/' + 'X'.repeat(51))).statusCode).toBe(400);
  expect(writes).toEqual([]);
});

it('reads Smart Store order statuses without other order fields', async () => {
  const response = await call('POST', '/smartstore/order-statuses', { productOrderIds: ['202611230001001', '202611220001101', '999'] });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    items: [{ productOrderId: '202611230001001', productOrderStatus: 'PAYED' }, { productOrderId: '202611220001101', productOrderStatus: 'DELIVERED' }],
    unavailable: ['999'], asOf: now().toISOString(),
  });
  for (const productOrderIds of [[], ['1', '1'], ['A1'], Array.from({ length: 301 }, (_, i) => String(i))]) {
    expect((await call('POST', '/smartstore/order-statuses', { productOrderIds })).statusCode).toBe(400);
  }
  expect(writes).toEqual([]);
});

it('reports an unavailable provider as a retryable error', async () => {
  const [ref] = seedOrders(['a', 'received', null]);
  mode = 'down';
  expect((await call('GET', '/orders')).json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', reason: 'NAVER_ORDERS_UNAVAILABLE' });
  expect((await call('POST', `/orders/${ref}/prepare`, { expectedRevision: 1, preparationMinutes: 3 }, randomUUID())).statusCode).toBe(503);
  expect((await call('GET', '/npay/payments/PN09SETTLED01')).json()).toMatchObject({ reason: 'NPAY_SETTLEMENT_UNAVAILABLE' });
  expect((await call('POST', '/smartstore/order-statuses', { productOrderIds: ['1'] })).json()).toMatchObject({ reason: 'SMARTSTORE_UNAVAILABLE' });
  expect(writes).toEqual([]);
});
