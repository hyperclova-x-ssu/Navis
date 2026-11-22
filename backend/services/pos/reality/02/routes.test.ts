import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { createClient } from 'redis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { RedisStreams } from '../../../../packages/streams/redis.ts';
import { OutboxRelay } from '../../../../packages/streams/relay.ts';
import { abortCommand, commandOutcome, linkClaim, parseClaim } from '../../claims.ts';
import { saveRecipeVersion } from '../../../inventory/recipes.ts';
import { createInventoryStockConsumer } from '../../../inventory/stock-consumer.ts';
import { stockForItem } from '../../../inventory/stock.ts';
import { withStoreTransaction as inventoryTransaction } from '../../../inventory/store-transaction.ts';
import { createReversalTokens, receipt } from '../../reversals.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { PosError, type PosTx } from '../../wire.ts';
import { listMargins } from '../09/finance.ts';
import { registerPosRealityRoutes } from './routes.ts';

const runtime = dbPool('pos', 'runtime', 'test');
const migrator = dbPool('pos', 'migrate', 'test');
const app = Fastify();
const liveApp = Fastify();
const now = new Date('2026-11-17T06:45:00Z');
const actorId = randomUUID();
const menuId = randomUUID();
const stores = Array.from({ length: 14 }, () => randomUUID());
const tokens = createReversalTokens(randomBytes(32).toString('hex'));
const catalogScopes: { storeId: string; actorId: string; menuIds: readonly string[] }[] = [];
let catalogPrice = 5100;
let catalogRecipe: string | null = 'a'.repeat(64);

type Params = { storeId: string; id?: string };
function owner(target: FastifyInstance, method: HTTPMethods, path: string, mode: 'read' | 'command',
  handler: (tx: PosTx, params: Params, body: unknown, key: string, query: unknown) => Promise<unknown>) {
  target.route<{ Params: Params }>({ method, url: '/internal/v1/pos/stores/:storeId' + path, async handler(req, reply) {
    const { storeId } = req.params;
    try {
      return await withStoreTransaction(runtime, storeId, (db) => handler({ db, actorId, storeId, at: now },
        req.params, req.body, String(req.headers['idempotency-key']), req.query),
      { write: mode === 'command', readOnly: mode === 'read' });
    } catch (error) {
      if (error instanceof PosError) return reply.code(error.statusCode).send(error.result);
      throw error;
    }
  } });
}

beforeAll(async () => {
  await runMigrations('pos', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  for (const storeId of stores) {
    await withStoreTransaction(migrator, storeId, async (db) => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1)', [storeId]);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [storeId]);
      await db.query('INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)', [
        storeId, menuId, { name: '라테', basePrice: 4500, baseCost: 1000, recipeVersion: 'recipe-1', saleStatus: 'selling', groups: [] },
      ]);
    });
  }
  registerPosRealityRoutes(owner.bind(null, app), tokens);
  registerPosRealityRoutes(owner.bind(null, liveApp), tokens, {
    async readCatalog(scope) {
      catalogScopes.push(scope);
      return { items: [{ menuId, name: '원본 라테', basePrice: catalogPrice, baseCost: null, saleStatus: 'selling', recipeVersion: catalogRecipe, groups: [] }] };
    },
  });
  await Promise.all([app.ready(), liveApp.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), liveApp.close()]);
  await Promise.all([runtime.end(), migrator.end()]);
});

function request(storeId: string, method: HTTPMethods, path: string, payload?: object, key: string = randomUUID(), target = app) {
  return target.inject({ method, url: `/internal/v1/pos/stores/${storeId}${path}`,
    headers: { 'idempotency-key': key }, payload });
}

async function bill(store: string, table?: { tableId: string; expectedRevision: number }) {
  const result = await request(store, 'POST', '/bills', { type: table ? 'dine_in' : 'takeout', lines: [{ menuId, qty: 1 }], table });
  expect(result.statusCode, result.body).toBe(200);
  return result.json();
}

const terminal = { approvalNo: 'A-214564', receiptNo: 'R-451', occurredAt: '2026-11-17T06:43:00.000Z' };

it('reads scoped coupon sales totals for the current day and the prior 28 days', async () => {
  const store = stores[12];
  const visit = randomUUID();
  for (const qty of [2, 3, 4]) {
    const draft = (await request(store, 'POST', '/bills', { type: 'takeout', lines: [{ menuId, qty }] })).json();
    const sale = await request(store, 'POST', `/bills/${draft.resourceId}/payments`, {
      method: 'cash', amount: draft.quote.payable, quoteRevision: draft.quote.quoteRevision,
    });
    expect(sale.statusCode, sale.body).toBe(200);
    if (qty === 4) continue;
    const { settlementId } = sale.json();
    const day = qty === 2 ? '2026-10-20' : '2026-10-19';
    await withStoreTransaction(migrator, store, async db => {
      const at = `${day}T10:00:00Z`;
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, $3::timestamptz - interval '1 hour', $3::timestamptz + interval '23 hours')`, [store, day, at]);
      await db.query('UPDATE pos.bill SET business_date = $1, recognized_at = $2 WHERE store_id = $3 AND bill_id = $4',
        [day, at, store, draft.resourceId]);
      await db.query('UPDATE pos.settlement SET at = $1 WHERE store_id = $2 AND settlement_id = $3', [at, store, settlementId]);
      await db.query('UPDATE pos.sales_recognition SET business_date = $1, at = $2 WHERE store_id = $3 AND settlement_id = $4',
        [day, at, store, settlementId]);
      await db.query('INSERT INTO pos.member_account (store_id, member_id, revision) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING', [store, visit]);
      await db.query(`INSERT INTO pos.member_sale (store_id, settlement_id, member_id, cash_amount, contains_member_value)
        VALUES ($1, $2, $3, $4, false)`, [store, settlementId, visit, draft.quote.payable]);
    });
  }
  const period = '/coupon-sales?businessDate=2026-11-17';
  const result = await request(store, 'GET', period);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({ businessDate: '2026-11-17',
    hours: [{ businessDate: '2026-10-20', hour: 19, count: 1 }],
    visits: [{ businessDate: '2026-10-20', hour: 19, memberId: visit }],
    menuFrequency: [{ menuId, count: 1 }], soldToday: [{ menuId, quantity: 4 }],
  });
  expect((await request(store, 'GET', `${period}&view=today`)).json()).toMatchObject({
    hours: [], visits: [], menuFrequency: [], soldToday: [{ menuId, quantity: 4 }],
  });
  expect((await request(stores[0], 'GET', period)).json()).toMatchObject({ hours: [], visits: [], soldToday: [] });
  expect((await request(store, 'GET', '/coupon-sales?businessDate=2026-02-30')).statusCode).toBe(400);

  const draft = await bill(store);
  const sale = (await request(store, 'POST', `/bills/${draft.resourceId}/payments`, {
    method: 'cash', amount: draft.quote.payable, quoteRevision: draft.quote.quoteRevision,
  })).json();
  const quote = (await request(store, 'POST', `/payments/${sale.paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  const correction = await request(store, 'POST', `/settlements/${sale.settlementId}/corrections`, { quoteToken: quote.quoteToken, confirmed: true });
  expect(correction.statusCode, correction.body).toBe(200);
  expect((await request(store, 'GET', period)).json().soldToday).toEqual([{ menuId, quantity: 4 }]);
});

it('attributes sold menu quantities to the same business date as recognized margin', async () => {
  const store = stores[13];
  const saleDay = '2026-11-17';
  const billDay = '2026-11-16';
  const draft = (await request(store, 'POST', '/bills', { type: 'takeout', lines: [{ menuId, qty: 2 }] })).json();
  const sale = await request(store, 'POST', `/bills/${draft.resourceId}/payments`, {
    method: 'cash', amount: draft.quote.payable, quoteRevision: draft.quote.quoteRevision,
  });
  expect(sale.statusCode, sale.body).toBe(200);
  await withStoreTransaction(migrator, store, async db => {
    await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, $2, '2026-11-15T20:00:00Z', '2026-11-16T20:00:00Z')`, [store, billDay]);
    await db.query('UPDATE pos.bill SET business_date = $1 WHERE store_id = $2 AND bill_id = $3', [billDay, store, draft.resourceId]);
  });
  const today = await request(store, 'GET', `/coupon-sales?businessDate=${saleDay}&view=today`);
  const prior = await request(store, 'GET', `/coupon-sales?businessDate=${billDay}&view=today`);
  const margins = await withStoreTransaction(runtime, store, db => listMargins({ db, storeId: store, actorId, at: now },
    { businessDate: saleDay }), { readOnly: true });
  expect(margins.items).toMatchObject([{ menuId, quantity: 2 }]);
  expect(today.json().soldToday).toEqual([{ menuId, quantity: 2 }]);
  expect(prior.json().soldToday).toEqual([]);
});

it('uses a scoped reservation claim for the first postpaid order and can reconcile it before payment', async () => {
  const storeId = stores[11];
  const added = await request(storeId, 'POST', '/tables', { label: 'T1', seats: 4 });
  const table = { tableId: added.json().resourceId, expectedRevision: added.json().revision };
  const sourceId = randomUUID(), claimId = randomUUID(), commandKey = randomUUID();
  const body = { type: 'dine_in', lines: [{ menuId, qty: 1 }], table, reservationId: sourceId };
  const privatePos = <T>(run: (tx: PosTx) => Promise<T>) => withStoreTransaction(runtime, storeId,
    db => run({ db, storeId, actorId, at: now }), { write: true });

  expect((await request(storeId, 'POST', '/bills', body, commandKey)).json()).toMatchObject({ reason: 'RESERVATION_CLAIM_REQUIRED' });
  await privatePos(tx => linkClaim(tx, parseClaim({
    claimId, commandKey, sourceId, sourceVersion: 2, kind: 'reservation_first_order',
    reservationBinding: { actorId, tableId: table.tableId, expiresAt: '2026-11-17T07:30:00.000Z' },
  })));
  expect((await request(storeId, 'POST', '/bills', { ...body, reservationId: randomUUID() }, commandKey)).json())
    .toMatchObject({ reason: 'RESERVATION_CLAIM_MISMATCH' });
  const reply = await request(storeId, 'POST', '/bills', body, commandKey);
  expect(reply.statusCode, reply.body).toBe(200);
  const { resourceId: billId, orderId } = reply.json();
  expect((await request(storeId, 'POST', '/bills', body, commandKey)).json()).toEqual(reply.json());
  expect(await privatePos(tx => commandOutcome(tx, commandKey)))
    .toMatchObject({ status: 'linked', result: { billId, orderId, tableId: table.tableId } });
  expect(await privatePos(tx => abortCommand(tx, commandKey, claimId))).toMatchObject({ status: 'linked' });
  const { rows } = await withStoreTransaction(runtime, storeId, db => db.query(
    "SELECT payload FROM pos.outbox WHERE event_type = 'pos.reservation_order_linked.v1'"));
  expect(rows).toEqual([{ payload: { billId, orderId, tableId: table.tableId, claimId, reservationId: sourceId, sourceVersion: 2 } }]);
});

it('keeps Connect source separate from verified provider references on the order and receipt', async () => {
  const storeId = stores[11];
  const { resourceId: billId, quote } = await bill(storeId);
  const attemptId = randomUUID();
  const kioskSlip = { ...terminal, approvalNo: `NC-${attemptId.replaceAll('-', '').slice(0, 12).toUpperCase()}` };
  const body = { method: 'easy_pay', amount: quote.payable, quoteRevision: quote.quoteRevision, terminal: kioskSlip };
  const path = `/bills/${billId}/payments`;
  const key = `payment:${attemptId}:${quote.quoteRevision}`;
  expect((await request(storeId, 'POST', path, { ...body, naverPayPaymentId: 'PN09SETTLED01' })).statusCode).toBe(400);
  const paid = await request(storeId, 'POST', path, body, key);
  expect(paid.statusCode, paid.body).toBe(200);
  const { orderId, paymentId } = paid.json();
  const read = (url: string) => request(storeId, 'GET', url).then(response => response.json());
  const receiptPath = `/payments/${paymentId}/receipt`;
  const orderPath = `/orders/${orderId}`;
  expect(await read(orderPath)).toMatchObject({ source: 'connect' });
  expect(await read(receiptPath)).toMatchObject({ source: 'connect', approvalNo: kioskSlip.approvalNo });
  expect(await read(receiptPath)).not.toHaveProperty('naverPayPaymentId');

  await withStoreTransaction(migrator, storeId, db => db.query(`
    INSERT INTO pos.naver_order_link (store_id, order_ref, payment_id, naver_pay_payment_id, smartstore_product_order_id)
    VALUES ($1, $2, $3, $4, $5)
  `, [storeId, 'external-order-1', paymentId, 'PN09SETTLED01', '202611230001001']), { write: true });
  const links = { source: 'connect', naverPayPaymentId: 'PN09SETTLED01', smartstoreProductOrderId: '202611230001001' };
  expect(await read(orderPath)).toMatchObject(links);
  expect(await read(receiptPath)).toMatchObject(links);
  const hidden = await withStoreTransaction(runtime, stores[0], db => db.query(
    'SELECT 1 FROM pos.naver_order_link WHERE order_ref = $1', ['external-order-1']));
  expect(hidden.rowCount).toBe(0);
});

it('records terminal money once, keeps the original receipt, and refreshes orders without exposing terminal data in the outbox', async () => {
  const store = stores[0];
  const draft = await bill(store);
  const paymentPath = `/bills/${draft.resourceId}/payments`;
  const body = { method: 'card', amount: 4500, quoteRevision: draft.quote.quoteRevision, terminal };
  const key = randomUUID();
  expect((await request(store, 'POST', paymentPath, { ...body, terminal: undefined })).json().reason).toBe('TERMINAL_RECORD_REQUIRED');
  const results = await Promise.all([request(store, 'POST', paymentPath, body, key), request(store, 'POST', paymentPath, body, key)]);
  expect(results[0].statusCode, results[0].body).toBe(200);
  const recorded = results[0].json();
  expect(results[1].json()).toEqual(recorded);
  expect(recorded).toMatchObject({ resourceId: recorded.paymentId, receiptId: recorded.paymentId, revision: 1 });
  expect((await request(store, 'POST', paymentPath, { ...body, amount: 4501 }, key)).json().reason).toBe('IDEMPOTENCY_MISMATCH');
  const reloaded = await withStoreTransaction(runtime, store, (db) => receipt({ db, actorId, storeId: store, at: now }, recorded.paymentId));
  expect(reloaded).toMatchObject({ paymentId: recorded.paymentId, amount: 4500,
    at: new Date(terminal.occurredAt), channel: 'terminal_record', terminal });
  const orders = await request(store, 'GET', '/orders?businessDate=2026-11-17');
  expect(orders.json()).toMatchObject({ items: [{ orderId: recorded.orderId, paymentId: recorded.paymentId }], nextCursor: null });
  const { rows } = await withStoreTransaction(runtime, store, (db) => db.query('SELECT event_type, payload FROM pos.outbox'));
  expect(rows).toEqual([{ event_type: 'pos.sale_recognized.v1', payload: expect.objectContaining({ paymentId: recorded.paymentId, amount: 4500, cost: 1000 }) }]);
  expect(JSON.stringify(rows)).not.toContain(terminal.approvalNo);
  const other = await bill(store);
  expect((await request(store, 'POST', `/bills/${other.resourceId}/payments`, { ...body, quoteRevision: other.quote.quoteRevision })).json().reason)
    .toBe('TERMINAL_REFERENCE_EXISTS');
  const afterDuplicate = await request(store, 'GET', '/orders?businessDate=2026-11-17');
  expect(afterDuplicate.json().items).toEqual(orders.json().items);
  expect((await request(stores[1], 'GET', `/bills/${draft.resourceId}`)).statusCode).toBe(404);
});

it('opens an exclusive table session, records cash, and moves the table through cleaning with a revision guard', async () => {
  const store = stores[1];
  const table = (await request(store, 'POST', '/tables', { label: '창가', seats: 4 })).json();
  const tableRef = { tableId: table.resourceId, expectedRevision: 1 };
  const draft = await bill(store, tableRef);
  expect((await request(store, 'POST', '/bills', { type: 'dine_in', lines: [{ menuId, qty: 1 }], table: tableRef })).json().reason).toBe('STALE_REVISION');
  const occupied = (await request(store, 'GET', `/tables/${table.resourceId}`)).json();
  expect(occupied).toMatchObject({ state: 'occupied', billId: draft.resourceId, revision: 2 });
  expect((await request(store, 'DELETE', `/tables/${table.resourceId}`, { expectedRevision: 2, confirmed: true })).json().reason).toBe('TABLE_BUSY');
  const paid = await request(store, 'POST', `/bills/${draft.resourceId}/payments`, {
    method: 'cash', amount: 4500, quoteRevision: draft.quote.quoteRevision,
  });
  expect(paid.statusCode, paid.body).toBe(200);
  expect((await request(store, 'GET', `/tables/${table.resourceId}`)).json()).toMatchObject({ state: 'cleaning', billId: null, revision: 3 });
  expect((await request(store, 'PATCH', `/tables/${table.resourceId}`, { expectedRevision: 3, state: 'empty' })).statusCode).toBe(200);
  expect((await request(store, 'DELETE', `/tables/${table.resourceId}`, { expectedRevision: 4 })).json().reason).toBe('CONFIRMATION_REQUIRED');
  expect((await request(store, 'GET', '/tables?limit=1')).json()).toMatchObject({ items: [{ state: 'empty', revision: 4 }] });
  expect((await runtime.query('SELECT table_id FROM pos.store_table')).rows).toEqual([]);
});

it('requires a separately confirmed terminal correction and retains its original reference', async () => {
  const store = stores[2];
  const draft = await bill(store);
  const sale = (await request(store, 'POST', `/bills/${draft.resourceId}/payments`, {
    method: 'card', amount: 4500, quoteRevision: draft.quote.quoteRevision, terminal,
  })).json();
  const quote = (await request(store, 'POST', `/payments/${sale.paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  const path = `/settlements/${sale.settlementId}/corrections`;
  const reversal = { quoteToken: quote.quoteToken, terminal: { ...terminal, receiptNo: 'R-452', occurredAt: '2026-11-17T06:44:00.000Z' } };
  expect((await request(store, 'POST', path, reversal)).json().reason).toBe('CONFIRMATION_REQUIRED');
  expect((await request(store, 'POST', path, { quoteToken: quote.quoteToken, confirmed: true })).json().reason).toBe('TERMINAL_RECORD_REQUIRED');
  const result = await request(store, 'POST', path, { ...reversal, confirmed: true });
  expect(result.statusCode, result.body).toBe(200);
  const reloaded = await withStoreTransaction(runtime, store, (db) => receipt({ db, actorId, storeId: store, at: now }, sale.paymentId));
  expect(reloaded).toMatchObject({ remaining: 0, status: 'canceled', terminal, corrections: [{
    terminal: reversal.terminal, lines: [{ allocationId: draft.quote.lines[0].allocationId,
      orderLineId: draft.quote.lines[0].orderLineId, qty: 1, gross: 4500, discount: 0, amount: 4500 }],
  }] });
});

it('refreshes a stale settlement quote without booking money and refuses a closed day', async () => {
  const store = stores[3];
  const draft = await bill(store);
  const body = { method: 'cash', amount: 4500, quoteRevision: draft.quote.quoteRevision };
  await withStoreTransaction(migrator, store, (db) => db.query(`UPDATE pos.catalog_menu SET snapshot =
    jsonb_set(snapshot, '{basePrice}', '4700') WHERE menu_id = $1`, [menuId]));
  const stale = await request(store, 'POST', `/bills/${draft.resourceId}/payments`, body);
  expect(stale.json()).toMatchObject({ reason: 'QUOTE_CHANGED', details: { quote: { payable: 4700 } } });
  const quote = (await request(store, 'POST', '/settlement-quotes', { billId: draft.resourceId })).json();
  expect(quote).toMatchObject({ billId: draft.resourceId, payable: 4700 });
  await withStoreTransaction(migrator, store, (db) => db.query("UPDATE pos.business_day SET status = 'closed'"));
  const closed = await request(store, 'POST', `/bills/${draft.resourceId}/payments`, { ...body, amount: 4700, quoteRevision: quote.quoteRevision });
  expect(closed.json().reason).toBe('DAY_CLOSED');
  expect((await request(store, 'GET', '/orders')).json().items).toEqual([]);
});

it('voids an unpaid bill after confirmation, frees its table, and paginates store reads', async () => {
  const store = stores[4];
  const table = (await request(store, 'POST', '/tables', { label: '10번', seats: 4 })).json();
  const second = (await request(store, 'POST', '/tables', { label: '11번', seats: 2 })).json();
  const draft = await bill(store, { tableId: table.resourceId, expectedRevision: 1 });
  const initial = (await request(store, 'GET', '/tables?limit=1')).json();
  const next = (await request(store, 'GET', `/tables?limit=1&cursor=${initial.nextCursor}`)).json();
  expect([...initial.items, ...next.items].map(({ tableId }) => tableId).sort()).toEqual([table.resourceId, second.resourceId].sort());
  expect((await request(store, 'POST', `/bills/${draft.resourceId}/void`, { expectedRevision: 1 })).json().reason)
    .toBe('CONFIRMATION_REQUIRED');
  expect((await request(store, 'POST', `/bills/${draft.resourceId}/void`, { expectedRevision: 1, confirmed: true })).statusCode)
    .toBe(200);
  expect((await request(store, 'GET', `/tables/${table.resourceId}`)).json()).toMatchObject({ state: 'empty', billId: null, revision: 3 });
  expect((await request(store, 'GET', `/bills/${draft.resourceId}`)).json()).toMatchObject({ status: 'void', revision: 2 });
  expect((await request(store, 'GET', '/orders')).json().items).toMatchObject([{ orderId: draft.orderId, status: 'void' }]);
  expect((await request(store, 'POST', `/orders/${draft.orderId}/preparation`, { status: 'preparing', expectedRevision: 1 }))
    .json().reason).toBe('ALREADY_REVERSED');
});

it('persists the configured table mapping, unpaid orders and kitchen times through later payment', async () => {
  const store = stores[6];
  const table = (await request(store, 'POST', '/tables', { label: '1번', seats: 2, layoutTableId: 'table-1' })).json();
  expect((await request(store, 'GET', '/tables')).json()).toMatchObject({
    sourceRevision: expect.any(Number), items: [{ tableId: table.resourceId, layoutTableId: 'table-1' }],
  });
  const draft = await bill(store, { tableId: table.resourceId, expectedRevision: 1 });
  expect(draft.orderId).toEqual(expect.any(String));
  const first = `/orders/${draft.orderId}`;
  expect((await request(store, 'GET', first)).json()).toMatchObject({ paymentId: null, settlementId: null,
    tableId: table.resourceId, preparation: 'accepted', preparingAt: null, completedAt: null });
  expect((await request(store, 'POST', first + '/preparation', { status: 'preparing', expectedRevision: 1 })).statusCode).toBe(200);
  expect((await request(store, 'POST', first + '/preparation', { status: 'completed', expectedRevision: 2 })).statusCode).toBe(200);
  const root = `/bills/${draft.resourceId}`;
  const add = { expectedRevision: 1, lines: [{ menuId, qty: 2 }] };
  const key = randomUUID();
  const addition = (await request(store, 'POST', root + '/orders', add, key)).json();
  expect(addition).toMatchObject({ revision: 2, quote: { payable: 13500 }, orderId: expect.any(String) });
  expect((await request(store, 'POST', root + '/orders', add, key)).json()).toEqual(addition);
  expect((await request(store, 'POST', root + '/orders', add)).json().reason).toBe('STALE_REVISION');
  expect((await request(store, 'POST', root + '/payments', { method: 'cash', amount: 4500,
    quoteRevision: draft.quote.quoteRevision })).json().reason).toBe('QUOTE_CHANGED');
  expect((await withStoreTransaction(runtime, store, (db) => db.query('SELECT payment_id FROM pos.payment'))).rows).toEqual([]);
  const sale = (await request(store, 'POST', root + '/payments', { method: 'cash', amount: 13500,
    quoteRevision: addition.quote.quoteRevision })).json();
  expect(sale.orderIds).toEqual([draft.orderId, addition.orderId]);
  expect((await request(store, 'GET', first)).json()).toMatchObject({ paymentId: sale.paymentId,
    preparation: 'completed', preparingAt: now.toISOString(), completedAt: now.toISOString() });
  expect((await request(store, 'GET', '/payments/' + sale.paymentId + '/receipt')).json()).toMatchObject({
    orderNos: [1, 2], amount: 13500, lines: expect.arrayContaining([expect.objectContaining({ qty: 2 })]),
  });
  expect((await request(store, 'GET', '/tables/' + table.resourceId)).json()).toMatchObject({
    state: 'cleaning', billId: null, lastBillId: draft.resourceId,
  });
});

it('moves, separates and merges bill allocations while retaining order identity and fixed discount', async () => {
  const store = stores[7];
  const makeTable = async (label: string) => {
    const { resourceId } = (await request(store, 'POST', '/tables', { label, seats: 2 })).json();
    return { tableId: resourceId, expectedRevision: 1 };
  };
  const first = await makeTable('1번');
  const second = await makeTable('2번');
  const third = await makeTable('3번');
  const draft = (await request(store, 'POST', '/bills', { type: 'dine_in', table: first,
    lines: [{ menuId, qty: 3 }], discount: 1000 })).json();
  const root = `/bills/${draft.resourceId}`;
  expect((await request(store, 'POST', root + '/move', { expectedRevision: 1, table: second })).json())
    .toMatchObject({ revision: 2 });
  expect((await request(store, 'GET', '/tables/' + first.tableId)).json().state).toBe('empty');
  const orderLineId = draft.quote.lines[0].orderLineId;
  const split = (qty: number) => request(store, 'POST', root + '/split', { expectedRevision: 2, table: third,
    lines: [{ orderLineId, qty }] });
  expect((await split(3)).json().reason).toBe('QTY_ALLOCATION_INVALID');
  const separated = (await split(1)).json();
  expect(separated).toMatchObject({ revision: 1, sourceRevision: 3, quote: { discount: 333, payable: 4167 } });
  const order = async () => (await request(store, 'GET', '/orders/' + draft.orderId)).json();
  expect(new Set((await order()).tableIds)).toEqual(new Set([second.tableId, third.tableId]));
  const merged = (await request(store, 'POST', root + '/merge', { expectedRevision: 3,
    targetBillId: separated.resourceId, targetExpectedRevision: 1 })).json();
  expect(merged).toMatchObject({ resourceId: separated.resourceId, revision: 2, quote: { discount: 1000, payable: 12500 } });
  expect((await order()).statusHistory.map((row: { kind: string }) => row.kind)).toEqual(['move', 'separate', 'merge']);
  const pay = (await request(store, 'POST', `/bills/${merged.resourceId}/payments`, {
    method: 'cash', quoteRevision: merged.quote.quoteRevision, amount: 12500,
  })).json();
  expect(pay.orderIds).toEqual([draft.orderId]);
  expect((await request(store, 'GET', '/payments/' + pay.paymentId + '/receipt')).json()).toMatchObject({
    orderNos: [1], amount: 12500, gross: 13500, discount: 1000,
  });
});

it('undoes a transfer by receipt while preserving later preparation and rejects stale undo', async () => {
  const store = stores[8];
  const makeTable = async (label: string) => {
    const { resourceId } = (await request(store, 'POST', '/tables', { label, seats: 2 })).json();
    return { tableId: resourceId, expectedRevision: 1 };
  };
  const from = await makeTable('1번');
  const to = await makeTable('2번');
  const draft = await bill(store, from);
  const route = `/bills/${draft.resourceId}/move`;
  const body = { expectedRevision: 1, table: to };
  const moveKey = randomUUID();
  const move = (await request(store, 'POST', route, body, moveKey)).json();
  expect(move.undoUntil).toBe('2026-11-17T06:45:06.000Z');
  const order = `/orders/${draft.orderId}`;
  await request(store, 'POST', order + '/preparation', { status: 'preparing', expectedRevision: 2 });
  const undoRoute = `/receipts/${move.receiptId}/undo`;
  const undoKey = randomUUID();
  expect((await request(stores[7], 'POST', undoRoute, {})).statusCode).toBe(404);
  const undo = await request(store, 'POST', undoRoute, {}, undoKey);
  expect(undo.json()).toMatchObject({ resourceId: draft.resourceId, revision: 3 });
  expect((await request(store, 'POST', undoRoute, {}, undoKey)).json()).toEqual(undo.json());
  expect((await request(store, 'GET', order)).json()).toMatchObject({
    tableId: from.tableId, statusHistory: [], preparation: 'preparing', preparingAt: now.toISOString(),
  });
  expect((await request(store, 'POST', route, body, moveKey)).json().reason).toBe('COMMAND_UNDONE');
  const later = (await request(store, 'POST', route, { expectedRevision: 3, table: { ...to, expectedRevision: 3 } })).json();
  await request(store, 'POST', `/bills/${draft.resourceId}/orders`, { expectedRevision: 4, lines: [{ menuId, qty: 1 }] });
  expect((await request(store, 'POST', `/receipts/${later.receiptId}/undo`, {})).json().reason).toBe('UNDO_UNAVAILABLE');
});

it('restores split and merge quantities, discounts and table occupancy on guarded undo', async () => {
  const store = stores[9];
  const [left, right] = await Promise.all(['1번', '2번'].map(async label => {
    const { resourceId } = (await request(store, 'POST', '/tables', { label, seats: 2 })).json();
    return resourceId;
  }));
  const source = (await request(store, 'POST', '/bills', { type: 'dine_in',
    table: { tableId: left, expectedRevision: 1 }, lines: [{ menuId, qty: 3 }], discount: 1000 })).json();
  const root = `/bills/${source.resourceId}`;
  const separate = async (expectedRevision: number, tableRevision: number) => (await request(store, 'POST', root + '/split', {
    expectedRevision, table: { tableId: right, expectedRevision: tableRevision },
    lines: [{ orderLineId: source.quote.lines[0].orderLineId, qty: 1 }],
  })).json();
  const restore = async (receiptId: string) => request(store, 'POST', `/receipts/${receiptId}/undo`, {});
  const firstSplit = await separate(1, 1);
  const undone = await restore(firstSplit.receiptId);
  expect(undone.json()).toMatchObject({ revision: 3, quote: source.quote });
  expect((await request(store, 'GET', `/bills/${firstSplit.resourceId}`)).json()).toMatchObject({ status: 'void', orderIds: [] });
  expect((await request(store, 'GET', `/tables/${right}`)).json()).toMatchObject({ revision: 3, state: 'empty' });

  const split = await separate(3, 3);
  const merge = (await request(store, 'POST', root + '/merge', { expectedRevision: 4,
    targetBillId: split.resourceId, targetExpectedRevision: 1 })).json();
  expect(merge.quote.payable).toBe(12500);
  expect((await restore(merge.receiptId)).json()).toMatchObject({ revision: 6, quote: { payable: 8333, discount: 667 } });
  expect((await request(store, 'GET', `/bills/${split.resourceId}`)).json()).toMatchObject({ status: 'open', quote: { payable: 4167, discount: 333 } });
  expect((await request(store, 'GET', `/tables/${left}`)).json()).toMatchObject({ billId: source.resourceId });
  expect((await request(store, 'GET', `/tables/${right}`)).json()).toMatchObject({ billId: split.resourceId });
});

it('attributes payment to the restored table when its session keeps the original opening time', async () => {
  const store = stores[10];
  const makeTable = async (label: string) => {
    const { resourceId } = (await request(store, 'POST', '/tables', { label, seats: 2 })).json();
    return { tableId: resourceId, expectedRevision: 1 };
  };
  const left = await makeTable('1번');
  const right = await makeTable('2번');
  const draft = await bill(store, left);
  await withStoreTransaction(migrator, store, db => db.query(`
    UPDATE pos.table_session SET opened_at = $1 WHERE store_id = $2 AND bill_id = $3`,
  ['2026-11-17T06:44:00Z', store, draft.resourceId]));
  const root = `/bills/${draft.resourceId}`;
  const move = (await request(store, 'POST', root + '/move', { expectedRevision: 1, table: right })).json();
  expect((await request(store, 'POST', `/receipts/${move.receiptId}/undo`, {})).statusCode).toBe(200);
  expect((await request(store, 'GET', `/tables/${left.tableId}`)).json().openedAt).toBe('2026-11-17T06:44:00.000Z');
  const paid = await request(store, 'POST', root + '/payments', { method: 'cash', amount: 4500, quoteRevision: draft.quote.quoteRevision });
  expect(paid.statusCode, paid.body).toBe(200);
  expect((await request(store, 'GET', root)).json()).toMatchObject({ status: 'paid', tableId: left.tableId });
  expect((await request(store, 'GET', `/orders/${draft.orderId}`)).json()).toMatchObject({ tableId: left.tableId });
});

it('quotes from the current scoped catalog and rejects an unavailable recipe before recognizing a sale', async () => {
  const storeId = stores[4];
  const call = (method: HTTPMethods, path: string, body?: object) => request(storeId, method, path, body, undefined, liveApp);
  const draftResponse = await call('POST', '/bills', { type: 'takeout', lines: [{ menuId, qty: 1 }, { menuId, qty: 1 }] });
  expect(draftResponse.statusCode, draftResponse.body).toBe(200);
  const draft = draftResponse.json();
  expect(draft.quote).toMatchObject({ payable: 10200, lines: [{ recipeVersion: 'a'.repeat(64), baseCost: null }, { basePrice: 5100 }] });
  expect(catalogScopes).toEqual([{ storeId, actorId, menuIds: [menuId] }]);
  catalogPrice = 5300;
  const paymentPath = `/bills/${draft.resourceId}/payments`;
  expect((await call('POST', paymentPath, { method: 'cash', amount: 10200, quoteRevision: draft.quote.quoteRevision })).json())
    .toMatchObject({ reason: 'QUOTE_CHANGED', details: { quote: { payable: 10600 } } });
  const quote = (await call('POST', '/settlement-quotes', { billId: draft.resourceId })).json();
  catalogRecipe = null;
  const missingRecipe = await call('POST', paymentPath, { method: 'cash', amount: 10600, quoteRevision: quote.quoteRevision });
  expect(missingRecipe.json().reason).toBe('CATALOG_RECIPE_UNAVAILABLE');
  expect((await call('GET', '/orders')).json().items).toMatchObject([{ status: 'void' }]);
});

it('allows the runtime to provision a verified store and day only within the current RLS scope', async () => {
  const storeId = randomUUID();
  const insert = 'INSERT INTO pos.store (store_id) VALUES ($1)';
  await expect(runtime.query(insert, [storeId])).rejects.toMatchObject({ code: '42501' });
  await withStoreTransaction(runtime, storeId, async (db) => {
    await db.query(insert, [storeId]);
    await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [storeId]);
  });
  const result = await request(storeId, 'GET', '/bills');
  expect(result.json()).toMatchObject({ items: [] });
});

it.runIf(process.env.NAVIS_B02_COMPOSE_STOCK === '1')('records a sale over service HTTP and projects its stock effect through Redis', async () => {
  const storeId = stores[5];
  const stockMenu = randomUUID();
  const itemId = randomUUID();
  const day = '2026-11-17';
  const inventory = dbPool('inventory', 'runtime', 'test');
  const inventorySetup = dbPool('inventory', 'migrate', 'test');
  const stockCheckpoint = dbPool('inventory', 'relay', 'test');
  const posRelay = dbPool('pos', 'relay', 'test');
  const client = createClient({ url: 'redis://test-redis:6379', socket: { reconnectStrategy: false } });
  const redis = new RedisStreams(client);
  const inventoryApp = Fastify();
  const posApp = Fastify();
  try {
    await inventoryTransaction(inventorySetup, storeId, async (db) => {
      await db.query('INSERT INTO inventory.store (store_id) VALUES ($1)', [storeId]);
      await db.query(`INSERT INTO inventory.inventory_item (store_id, item_id, recipe_key, base_unit)
        VALUES ($1, $2, 'i-test-milk', 'mL')`, [storeId, itemId]);
      await db.query(`INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status)
        VALUES ($1, $2, 'menu', '라테', 'drink', 4500, 'selling')`, [storeId, stockMenu]);
      await db.query(`INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [storeId, day]);
      await db.query(`INSERT INTO inventory.stock_daily_opening (store_id, business_date, item_id, channel, quantity_base)
        VALUES ($1, $2, $3, 'store', 1000)`, [storeId, day, itemId]);
      await saveRecipeVersion(db, storeId, stockMenu, stockMenu, [{ itemId: 'i-test-milk', quantityBase: 150, unitDimension: 'mL' }]);
    });
    const { registerMenuRoutes } = await import('../../../inventory/reality/01/routes.ts');
    const posCatalogToken = randomUUID();
    registerMenuRoutes(inventoryApp, inventory, randomUUID(), { posCatalogToken });
    const inventoryOrigin = await inventoryApp.listen({ host: '127.0.0.1', port: 0 });
    registerPosRealityRoutes(owner.bind(null, posApp), tokens, {
      async readCatalog({ storeId, actorId, menuIds }) {
        const url = new URL(`/internal/v1/inventory/stores/${storeId}/catalog-snapshot`, inventoryOrigin);
        for (const id of menuIds) url.searchParams.append('menuId', id);
        const result = await fetch(url, { headers: { authorization: `Bearer ${posCatalogToken}`,
          'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' } });
        if (!result.ok) throw new Error('Inventory snapshot failed');
        return result.json();
      },
    });
    await client.connect();
    const relay = new OutboxRelay({ producer: 'pos', database: posRelay, redis, groups: [{ name: 'inventory', database: stockCheckpoint }] });
    const consumer = createInventoryStockConsumer(inventory, redis, 'r1-b02-stock');
    const stock = () => inventoryTransaction(inventory, storeId, (db) => stockForItem(db, storeId, day, itemId));
    const drain = async () => {
      for (let i = 0; i < 100; i++) {
        if (await relay.step() === 'idle') {
          for (let delivery = 0; delivery < 100; delivery++) {
            if (!await consumer.step()) return;
          }
          throw new Error('Inventory consumer did not drain');
        }
      }
      throw new Error('POS relay did not drain');
    };

    const origin = await posApp.listen({ host: '127.0.0.1', port: 0 });
    const root = `${origin}/internal/v1/pos/stores/${storeId}`;
    const http = async (path: string, body?: object, key = randomUUID()) => {
      const response = await fetch(root + path, {
        method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', 'idempotency-key': key } : {},
        body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      return payload;
    };
    const table = await http('/tables', { label: '창가', seats: 2 });
    const draft = await http('/bills', {
      type: 'dine_in', lines: [{ menuId: stockMenu, qty: 1 }], table: { tableId: table.resourceId, expectedRevision: 1 },
    });
    const path = `/bills/${draft.resourceId}/payments`;
    const body = { method: 'cash', quoteRevision: draft.quote.quoteRevision, amount: 4500 };
    const key = randomUUID();
    const sale = await http(path, body, key);
    expect(await http(path, body, key)).toEqual(sale);
    await drain();
    expect(await stock()).toMatchObject({ usedQuantityBase: '150', availableQuantityBase: '850' });
    expect(await http(`/tables/${table.resourceId}`)).toMatchObject({ state: 'cleaning', revision: 3 });
    expect(await http(`/payments/${sale.paymentId}/receipt`)).toMatchObject({ paymentId: sale.paymentId, amount: 4500, channel: 'cash_record' });
    const quote = await http(`/payments/${sale.paymentId}/reversal-quote`, { kind: 'cancel' });
    const correction = await http(`/settlements/${sale.settlementId}/corrections`, { quoteToken: quote.quoteToken, confirmed: true });
    await drain();
    expect(await stock()).toMatchObject({ usedQuantityBase: '0', availableQuantityBase: '1000' });
    const events = (await redis.events('pos')).filter((event) => event.storeId === storeId);
    expect(events.map(({ eventType, aggregateId, storeSeq }) => [eventType, aggregateId, storeSeq])).toEqual([
      ['pos.table_changed.v1', table.resourceId, '1'], ['pos.table_session_changed.v1', table.resourceId, '2'],
      ['pos.sale_recognized.v1', sale.settlementId, '3'], ['pos.table_session_changed.v1', table.resourceId, '4'],
      ['pos.sale_corrected.v1', correction.resourceId, '5'],
    ]);
    console.info(JSON.stringify({ storeId, ...sale, tableId: table.resourceId, correctionId: correction.resourceId,
      eventIds: events.map((event) => event.eventId), stockAfterSaleMl: 850, stockAfterCorrectionMl: 1000 }));
  } finally {
    if (client.isOpen) redis.close();
    await Promise.all([inventoryApp.close(), posApp.close()]);
    await Promise.all([inventory.end(), inventorySetup.end(), stockCheckpoint.end(), posRelay.end()]);
  }
}, 30_000);
