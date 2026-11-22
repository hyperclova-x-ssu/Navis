import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { createPosApp } from '../../app.ts';
import { preparePosRoute, type PosOwnerRouteWithPreflight } from '../../preflight.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { PosError } from '../../wire.ts';
import { registerMemberAccountRoutes } from '../05/routes.ts';
import { registerFinanceRoutes } from '../09/routes.ts';
import { registerCustomOrderRoutes } from './routes.ts';

const runtime = dbPool('pos', 'runtime', 'test');
const migrator = dbPool('pos', 'migrate', 'test');
const app = Fastify();
const at = new Date('2026-11-17T06:45:00Z');
const day = '2026-11-17';
const storeId = randomUUID(), secondStore = randomUUID();
const actorId = randomUUID(), memberId = randomUUID(), photo = randomUUID();
const fields = [{ fieldId: 'note', label: '문구', input: 'text', required: true, options: [] }];
const splits = [{ kind: 'method', method: 'cash', amount: 45000 }];

const owner: PosOwnerRouteWithPreflight = (method, path, mode, handler) => {
  app.route<{ Params: { storeId: string; id?: string } }>({ method, url: '/pos/:storeId' + path,
    async handler(req, reply) {
      const { storeId } = req.params;
      try {
        const prepared = await preparePosRoute(runtime, { storeId, actorId }, () => at, handler,
          req.params, req.body, String(req.headers['idempotency-key']), req.query);
        return await withStoreTransaction(runtime, storeId, db => prepared.apply(db, at),
          { write: mode === 'command', readOnly: mode === 'read' });
      } catch (error) {
        if (error instanceof PosError) return reply.code(error.statusCode).send(error.result);
        throw error;
      }
    } });
};

beforeAll(async () => {
  await runMigrations('pos', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  for (const store of [storeId, secondStore]) {
    await withStoreTransaction(migrator, store, async db => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1)', [store]);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [store, day]);
    });
  }
  const customer = {
    member: async (_store: string, id: string) => ({ memberId: id, active: id === memberId, product: null }),
    archive: async () => { throw new Error('Unexpected archive'); },
    reserve: async () => { throw new Error('Unexpected pass claim'); },
  };
  registerMemberAccountRoutes(owner, { customer });
  registerCustomOrderRoutes(owner, {
    reversalSecret: randomUUID(), customer,
    verifyReference: async input => input.fileId === photo,
  });
  registerFinanceRoutes(owner);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.all([runtime.end(), migrator.end()]);
});

function call(method: HTTPMethods, path: string, payload?: object, key: string = randomUUID(), store = storeId) {
  return app.inject({ method, url: '/pos/' + store + path, payload, headers: { 'idempotency-key': key } });
}

async function ok(method: HTTPMethods, path: string, body?: object, key?: string) {
  const response = await call(method, path, body, key);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function createOrder(templateId: string, name: string, overrides?: object) {
  return ok('POST', '/custom-orders', { templateId, answers: { note: '축하해요' }, productLabel: name,
    channel: 'phone', quantity: 1, desiredPickupAt: day + 'T17:00', memberId, ...overrides });
}

const pathFor = (id: string) => '/custom-orders/' + id;
function transition(order: { customOrderId: string; revision: number }, type: string, args: object = {}, key?: string) {
  return ok('POST', pathFor(order.customOrderId) + '/transitions', { type, expectedRevision: order.revision, ...args }, key);
}

it('persists the same pickup, records an advance once and recognizes income at handover only', async () => {
  const template = await ok('POST', '/custom-templates', { name: '케이크 주문서', fields });
  const created = await createOrder(template.templateId, '45,000원 케이크', { referencePhotoKeys: [photo] });
  const path = pathFor(created.customOrderId);
  expect((await ok('GET', '/custom-orders?query=CO-001&limit=1')).items).toMatchObject([
    { customOrderId: created.customOrderId, orderNo: 1, revision: created.revision },
  ]);
  const quote = await transition(created, 'customOrder.quote', { quoteAmount: 45000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quote, 'customOrder.recordDecision', { decision: 'approved', quoteRevision: quote.quoteRevision, paymentTiming: 'advance' });
  expect((await ok('GET', path)).pickup).toMatchObject({ reservationId: approved.pickupReservationId, status: 'confirmed', time: '17:00' });
  expect((await call('GET', path, undefined, undefined, secondStore)).statusCode).toBe(404);
  const paymentQuote = await ok('POST', path + '/settlement-quote', { allocations: splits });
  const key = randomUUID();
  const input = { quoteId: paymentQuote.quoteId, expectedRevision: approved.revision, allocations: splits };
  const paid = await ok('POST', path + '/payments', input, key);
  expect(await ok('POST', path + '/payments', input, key)).toEqual(paid);
  expect((await ok('GET', path)).payment).toMatchObject({ status: 'paid', amountSettled: 45000, realDeposits: 45000 });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({ sales: { total: 0 }, deposits: { total: 45000 } });
  const pickupPath = '/custom-pickups/' + approved.pickupReservationId + '/transitions';
  expect((await call('POST', pickupPath, { type: 'pickup.reschedule', expectedRevision: approved.revision, date: day, time: '18:00' })).json().reason)
    .toBe('STALE_REVISION');
  const moved = await ok('POST', pickupPath, { type: 'pickup.reschedule', expectedRevision: paid.revision, date: day, time: '18:00' });
  expect(moved.pickupReservationId).toBe(approved.pickupReservationId);
  const ready = await transition(moved, 'customOrder.setStage', { nextStage: 'production_complete' });
  expect((await call('POST', path + '/transitions', { type: 'customOrder.receive', expectedRevision: ready.revision })).json().reason)
    .toBe('CONFIRMATION_REQUIRED');
  const picked = await transition(ready, 'customOrder.receive', { confirmed: true });
  expect(picked.recognitionId).toEqual(expect.any(String));
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({
    sales: { total: 45000, bySource: { customPickup: 45000 } }, deposits: { total: 45000 }, unknownCostSales: 45000, orderCount: 1 });
  expect((await ok('GET', '/margins?businessDate=' + day)).items).toContainEqual(expect.objectContaining({
    kind: 'custom-pickup', cost: null, contribution: null }));
  const { rows } = await withStoreTransaction(runtime, storeId, db =>
    db.query('SELECT aggregate_id, payload FROM pos.outbox WHERE event_type = $1 ORDER BY store_seq', ['pos.custom_pickup_changed.v1']));
  expect(rows.at(-1)).toMatchObject({ aggregate_id: created.customOrderId, payload: {
    stage: 'received_by_customer', pickupProjection: { status: 'completed', time: '18:00', reservationId: approved.pickupReservationId },
    calendarProjection: { sourceId: created.customOrderId, entry: null } } });
  expect(JSON.stringify(rows)).not.toContain(photo);
  expect(JSON.stringify(rows)).not.toContain('45,000원 케이크');
  expect((await runtime.query('SELECT count(*)::int AS count FROM pos.custom_order')).rows).toEqual([{ count: 0 }]);
  expect((await withStoreTransaction(runtime, '', db => db.query('SELECT * FROM pos.custom_pickup'))).rows).toEqual([]);

  expect(picked.undoUntil).toBe('2026-11-17T06:45:06.000Z');
  const undone = await ok('POST', '/custom-receipts/receipts/' + picked.receiptId + '/undo', {});
  expect((await ok('GET', path)).pickup.status).toBe('confirmed');
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({
    sales: { total: 0 }, deposits: { total: 45000 }, unknownCostSales: 0 });
  const receivedAgain = await transition(undone, 'customOrder.receive', { confirmed: true });
  const refund = await ok('POST', path + '/reversal-quote', { kind: 'refund', amount: 5000 });
  await ok('POST', path + '/corrections', { kind: 'refund', amount: 5000, expectedRevision: receivedAgain.revision, quoteId: refund.quoteId, confirmed: true });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({
    sales: { total: 40000, refund: 5000, bySource: { customPickup: 40000 } },
    deposits: { total: 40000, returned: 5000 }, unknownCostSales: 40000, orderCount: 1 });
});

it('records a confirmed paid cancellation without recognizing a pre-handover return as sales', async () => {
  const template = await ok('POST', '/custom-templates', { name: '환불용 주문서', fields });
  const created = await createOrder(template.templateId, '환불용 상품');
  const path = pathFor(created.customOrderId);
  const quote = await transition(created, 'customOrder.quote', { quoteAmount: 45000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quote, 'customOrder.recordDecision', { decision: 'approved', quoteRevision: quote.quoteRevision, paymentTiming: 'advance' });
  const paymentQuote = await ok('POST', path + '/settlement-quote', { allocations: splits });
  const paid = await ok('POST', path + '/payments', { quoteId: paymentQuote.quoteId, expectedRevision: approved.revision, allocations: splits });
  expect((await call('POST', path + '/transitions', { type: 'customOrder.cancel', expectedRevision: paid.revision, confirmed: true })).json().reason)
    .toBe('PAYMENT_REVERSAL_REQUIRED');
  const before = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  const reversal = await ok('POST', path + '/reversal-quote', { kind: 'cancellation' });
  await ok('POST', path + '/corrections', { kind: 'cancellation', expectedRevision: paid.revision, quoteId: reversal.quoteId, confirmed: true });
  const after = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  expect(after.sales).toEqual(before.sales);
  expect(after.deposits.total).toBe(before.deposits.total - 45000);
  expect((await ok('GET', path)).pickup).toMatchObject({ status: 'canceled' });
});

it('guards receipt inputs, concurrent duplicates and template history', async () => {
  const template = await ok('POST', '/custom-templates', { name: '재사용 주문서', fields });
  const body = { templateId: template.templateId, answers: { note: '축하해요' }, productLabel: '중복 테스트', channel: 'visit',
    quantity: 1, desiredPickupAt: day + 'T17:30', guest: { name: '가나다', phone: '010-1234-5678' } };
  expect((await call('POST', '/custom-orders', { ...body, referencePhotoKeys: [randomUUID()] })).statusCode).toBe(404);
  expect((await call('POST', '/custom-orders', { ...body, memberId: randomUUID(), guest: undefined })).statusCode).toBe(404);
  const pair = await Promise.all([call('POST', '/custom-orders', body), call('POST', '/custom-orders', body)]);
  expect(pair.map(response => response.statusCode).sort()).toEqual([200, 409]);
  const orderId = pair.find(response => response.statusCode === 200)!.json().customOrderId;
  const path = '/custom-templates/' + template.templateId;
  expect((await call('DELETE', path, { expectedRevision: 1 })).json().reason).toBe('CONFIRMATION_REQUIRED');
  const archived = await ok('DELETE', path, { expectedRevision: 1, confirmed: true });
  expect((await ok('GET', pathFor(orderId))).templateSnapshot.name).toBe('재사용 주문서');
  expect((await call('GET', path)).statusCode).toBe(404);
  await ok('POST', '/custom-receipts/receipts/' + archived.receiptId + '/undo', {});
  expect(await ok('GET', path)).toMatchObject({ name: '재사용 주문서', revision: 3 });
});

it('reuses the POS terminal guard and records mixed tender without a provider approval', async () => {
  const template = await ok('POST', '/custom-templates', { name: '카드 주문서', fields });
  const created = await createOrder(template.templateId, '복합 결제 케이크');
  const quoted = await transition(created, 'customOrder.quote', { quoteAmount: 45000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quoted, 'customOrder.recordDecision',
    { decision: 'approved', quoteRevision: quoted.quoteRevision, paymentTiming: 'on_pickup' });
  const ready = await transition(approved, 'customOrder.setStage', { nextStage: 'production_complete' });
  const path = pathFor(created.customOrderId);
  expect((await call('POST', path + '/transitions', { type: 'customOrder.receive', expectedRevision: ready.revision, confirmed: true })).json().reason)
    .toBe('PAYMENT_REQUIRED');
  const allocations = [{ kind: 'method', method: 'card', amount: 30000 }, { kind: 'method', method: 'cash', amount: 15000 }];
  const quote = await ok('POST', path + '/settlement-quote', { allocations });
  const input = { quoteId: quote.quoteId, expectedRevision: ready.revision, allocations };
  expect((await call('POST', path + '/payments', input)).json().reason).toBe('TERMINAL_RECORD_REQUIRED');
  const before = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  const paid = await ok('POST', path + '/payments', { ...input, terminal: { receiptNo: 'TERM-001', occurredAt: at.toISOString() } });
  const deposit = (await ok('GET', '/deposits?businessDate=' + day)).items.find((row: { paymentId: string }) => row.paymentId === paid.paymentId);
  expect(deposit).toMatchObject({ purpose: 'custom_order', amount: 45000,
    splits: [{ method: 'card', amount: 30000 }, { method: 'cash', amount: 15000 }] });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals.sales).toEqual(before.sales);
  expect((await transition(paid, 'customOrder.receive', { confirmed: true })).undoUntil).toBeUndefined();
});

it('posts charge and receivable checkout to the B05 accounts and undoes each receipt exactly once', async () => {
  const account = '/member-accounts/' + memberId;
  const initialAccount = await ok('GET', account);
  await ok('POST', account + '/entries', { purpose: 'charge_topup', amount: 8000, expectedRevision: initialAccount.revision,
    splits: [{ method: 'cash', amount: 8000 }] });
  const template = await ok('POST', '/custom-templates', { name: '회원 결제 주문서', fields });
  const before = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  for (const kind of ['charge', 'receivable'] as const) {
    const created = await createOrder(template.templateId, kind);
    const quoted = await transition(created, 'customOrder.quote', { quoteAmount: 3000, proposedPickupAt: day + 'T17:00' });
    const approved = await transition(quoted, 'customOrder.recordDecision',
      { decision: 'approved', quoteRevision: quoted.quoteRevision, paymentTiming: 'advance' });
    const path = pathFor(created.customOrderId);
    const initial = await ok('GET', account);
    const allocations = [{ kind, amount: 3000 }];
    const quote = await ok('POST', path + '/settlement-quote', { allocations });
    expect(quote).toMatchObject({ canSubmit: true, realMethodSplits: [], accountEffects: [
      { memberId, account: kind, kind: kind === 'charge' ? 'use' : 'sale', amount: kind === 'charge' ? -3000 : 3000 },
    ] });
    expect(await ok('GET', account)).toEqual(initial);
    const input = { quoteId: quote.quoteId, expectedRevision: approved.revision, allocations };
    const key = randomUUID();
    const paid = await ok('POST', path + '/payments', input, key);
    expect(paid).toMatchObject({ paymentId: null, stage: 'in_production', undoUntil: '2026-11-17T06:45:06.000Z' });
    expect(paid.receiptId).toBe(paid.settlementId);
    expect(await ok('POST', path + '/payments', input, key)).toEqual(paid);
    expect(await ok('GET', account)).toMatchObject({ chargeBalance: initial.chargeBalance - (kind === 'charge' ? 3000 : 0),
      receivableBalance: initial.receivableBalance + (kind === 'receivable' ? 3000 : 0) });
    expect((await ok('GET', path)).payment).toMatchObject({ status: 'paid', amountSettled: 3000, realDeposits: 0,
      chargeApplied: kind === 'charge' ? 3000 : 0, receivableAmount: kind === 'receivable' ? 3000 : 0 });
    const undo = '/custom-receipts/receipts/' + paid.receiptId + '/undo';
    const undoKey = randomUUID();
    expect(await ok('POST', undo, {}, undoKey)).toMatchObject({ stage: 'payment_pending' });
    expect(await ok('POST', undo, {}, undoKey)).toMatchObject({ stage: 'payment_pending' });
    expect((await call('POST', undo, {})).json().reason).toBe('UNDO_UNAVAILABLE');
    expect((await call('POST', path + '/payments', input, key)).json().reason).toBe('COMMAND_UNDONE');
    expect(await ok('GET', account)).toEqual({ ...initial, revision: initial.revision + 2 });
    expect((await ok('GET', path)).payment).toMatchObject({ status: 'unpaid', amountSettled: 0, realDeposits: 0 });
  }
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({ sales: before.sales, deposits: before.deposits });
});

it('apportions repeated refunds across member value and recorded tender, with no revenue until pickup', async () => {
  const account = '/member-accounts/' + memberId;
  const original = await ok('GET', account);
  await ok('POST', account + '/entries', { purpose: 'charge_topup', amount: 4000, expectedRevision: original.revision,
    splits: [{ method: 'cash', amount: 4000 }] });
  const initial = await ok('GET', account);
  const template = await ok('POST', '/custom-templates', { name: '혼합 결제 주문서', fields });
  const created = await createOrder(template.templateId, '혼합 결제');
  const quoted = await transition(created, 'customOrder.quote', { quoteAmount: 6000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quoted, 'customOrder.recordDecision',
    { decision: 'approved', quoteRevision: quoted.quoteRevision, paymentTiming: 'on_pickup' });
  const ready = await transition(approved, 'customOrder.setStage', { nextStage: 'production_complete' });
  const path = pathFor(created.customOrderId);
  const allocations = [{ kind: 'charge', amount: 2000 }, { kind: 'receivable', amount: 2000 },
    { kind: 'method', method: 'cash', amount: 2000 }];
  const quote = await ok('POST', path + '/settlement-quote', { allocations });
  await ok('POST', account + '/entries', { purpose: 'charge_topup', amount: 750, expectedRevision: initial.revision,
    splits: [{ method: 'cash', amount: 750 }] });
  const body = { quoteId: quote.quoteId, expectedRevision: ready.revision, allocations };
  expect((await call('POST', path + '/payments', body)).json().reason).toBe('QUOTE_CHANGED');
  const fresh = await ok('POST', path + '/settlement-quote', { allocations });
  const before = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  const paid = await ok('POST', path + '/payments', { ...body, quoteId: fresh.quoteId });
  expect(paid).toMatchObject({ paymentId: expect.any(String) });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({
    sales: before.sales, deposits: { total: before.deposits.total + 2000 } });
  const handed = await transition(paid, 'customOrder.receive', { confirmed: true });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals.sales.total).toBe(before.sales.total + 6000);
  let revision = handed.revision;
  for (const amount of [3000, 3000]) {
    const reversal = await ok('POST', path + '/reversal-quote', { kind: 'refund', amount });
    expect(reversal).toMatchObject({ canSubmit: true, realMethodReturns: [{ method: 'cash', amount: 1000 }],
      recognitionEffects: [{ amount: -3000 }], accountEffects: [
        { account: 'charge', kind: 'reversal', amount: 1000, originalTxnId: expect.any(String) },
        { account: 'receivable', kind: 'reversal', amount: -1000, originalTxnId: expect.any(String) },
      ] });
    const input = { quoteId: reversal.quoteId, expectedRevision: revision, kind: 'refund', amount, confirmed: true };
    const key = randomUUID();
    const corrected = await ok('POST', path + '/corrections', input, key);
    expect(await ok('POST', path + '/corrections', input, key)).toEqual(corrected);
    revision = corrected.revision;
  }
  expect((await ok('GET', path)).payment).toMatchObject({ status: 'refunded', amountReturned: 6000,
    realDeposits: 0, chargeApplied: 0, receivableAmount: 0 });
  expect(await ok('GET', account)).toMatchObject({ chargeBalance: initial.chargeBalance + 750, receivableBalance: initial.receivableBalance });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({
    sales: { total: before.sales.total }, deposits: { total: before.deposits.total } });
});

it('blocks refunding collected debt and supports repeated returns with no tender rows', async () => {
  const account = '/member-accounts/' + memberId;
  const initial = await ok('GET', account);
  const template = await ok('POST', '/custom-templates', { name: '외상 수금 주문서', fields });
  const created = await createOrder(template.templateId, '외상 정산');
  const quoted = await transition(created, 'customOrder.quote', { quoteAmount: 3000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quoted, 'customOrder.recordDecision',
    { decision: 'approved', quoteRevision: quoted.quoteRevision, paymentTiming: 'advance' });
  const path = pathFor(created.customOrderId);
  const allocations = [{ kind: 'receivable', amount: 3000 }];
  const quote = await ok('POST', path + '/settlement-quote', { allocations });
  const paid = await ok('POST', path + '/payments', { expectedRevision: approved.revision, quoteId: quote.quoteId, allocations });
  const original = (await ok('POST', path + '/reversal-quote', { kind: 'refund' })).accountEffects[0].originalTxnId;
  await ok('POST', account + '/entries', { purpose: 'receivable_collection', amount: 1500, receivableTxnId: original,
    expectedRevision: initial.revision + 1, splits: [{ method: 'cash', amount: 1500 }] });
  const blocked = await ok('POST', path + '/reversal-quote', { kind: 'refund' });
  expect(blocked).toMatchObject({ canSubmit: false, issues: [{ reason: 'RECEIVABLE_ALREADY_COLLECTED',
    details: { receivableTxnId: original, remaining: 1500 } }] });
  expect((await call('POST', path + '/corrections', { kind: 'refund', expectedRevision: paid.revision, quoteId: blocked.quoteId, confirmed: true })).json().reason)
    .toBe('RECEIVABLE_ALREADY_COLLECTED');
  const undo = '/custom-receipts/receipts/' + paid.receiptId + '/undo';
  expect((await call('POST', undo, {})).json().reason).toBe('RECEIVABLE_ALREADY_COLLECTED');
  const before = (await ok('GET', '/ledger?businessDate=' + day)).totals;
  let revision = paid.revision;
  for (const amount of [1000, 500]) {
    const reversal = await ok('POST', path + '/reversal-quote', { kind: 'refund', amount });
    expect(reversal).toMatchObject({ canSubmit: true, realMethodReturns: [],
      accountEffects: [{ account: 'receivable', amount: -amount, originalTxnId: original }] });
    revision = (await ok('POST', path + '/corrections', { kind: 'refund', amount, expectedRevision: revision,
      quoteId: reversal.quoteId, confirmed: true })).revision;
  }
  expect(await ok('GET', account)).toMatchObject({ receivableBalance: initial.receivableBalance });
  expect((await ok('GET', path)).payment).toMatchObject({ amountSettled: 3000, amountReturned: 1500, realDeposits: 0, receivableAmount: 1500 });
  expect((await ok('GET', '/ledger?businessDate=' + day)).totals).toMatchObject({ sales: before.sales, deposits: before.deposits });
});

it('reissues a historical pickup snapshot with a stable event and sequence on migration rerun', async () => {
  const template = await ok('POST', '/custom-templates', { name: '이전 주문서', fields });
  const created = await createOrder(template.templateId, '이전 주문');
  const quote = await transition(created, 'customOrder.quote', { quoteAmount: 45000, proposedPickupAt: day + 'T17:00' });
  const approved = await transition(quote, 'customOrder.recordDecision', {
    decision: 'approved', quoteRevision: quote.quoteRevision, paymentTiming: 'advance',
  });
  const readEvents = async () => (await withStoreTransaction(runtime, storeId, db => db.query(
    'SELECT event_id, store_seq, payload FROM pos.outbox WHERE aggregate_id = $1 ORDER BY store_seq', [created.customOrderId],
  ))).rows;
  const before = await readEvents();
  const migration = readFileSync(new URL('../../migrations/20261122001801_real_pickup_projection_backfill.sql', import.meta.url), 'utf8')
    .split('-- Down Migration')[0];
  await migrator.query(migration);
  const after = await readEvents();
  expect(after.slice(0, -1)).toEqual(before);
  expect(after.at(-1).payload).toEqual(before.at(-1).payload);
  expect(after.at(-1).payload.pickupProjection).toMatchObject({ reservationId: approved.pickupReservationId, status: 'confirmed' });
  expect(after).toHaveLength(before.length + 1);
  await migrator.query(migration);
  expect(await readEvents()).toEqual(after);
});

it('verifies custom-order member and photo without the POS store lock, and preserves the idempotent receipt', async () => {
  const template = await ok('POST', '/custom-templates', { name: '검증 테스트 주문서', fields });
  const observations: boolean[] = [];
  let duringPhotoVerification: (() => Promise<void>) | undefined;
  const inspectLock = () => withStoreTransaction(runtime, storeId, async db => {
    const { rows: [row] } = await db.query<{ available: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('pos:' || $1, 0)) AS available", [storeId]);
    observations.push(row.available);
  });
  const owner = createPosApp(runtime, { gatewayToken: 'test-owner', operating: true, logging: false, now: () => at,
    memberCustomer: { async member() { await inspectLock(); return { memberId, active: true, product: null }; },
      async archive() { throw new Error('Unexpected archive'); }, async reserve() { throw new Error('Unexpected claim'); } },
    verifyReference: async () => { await inspectLock(); await duringPhotoVerification?.(); return true; },
  });
  const headers = { authorization: 'Bearer test-owner', 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
    'x-navis-store-role': 'owner', 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00', 'idempotency-key': randomUUID() };
  const path = `/internal/v1/pos/stores/${storeId}/custom-orders`;
  const payload = { templateId: template.templateId, expectedRevision: template.revision, answers: { note: '사전 확인' },
    channel: 'phone', productLabel: '사전 확인 케이크', quantity: 1, desiredPickupAt: `${day}T17:00`, memberId, referencePhotoKeys: [photo] };
  try {
    const result = await owner.inject({ method: 'POST', url: path, headers, payload });
    expect(result.statusCode, result.body).toBe(200);
    expect(observations).toEqual([true, true]);
    const retry = await owner.inject({ method: 'POST', url: path, headers, payload });
    expect(retry.json()).toEqual(result.json());
    expect(observations).toEqual([true, true]);

    const order = result.json();
    const orderUrl = `${path}/${order.customOrderId}`;
    duringPhotoVerification = async () => {
      if (!observations.at(-1)) return;
      const changed = await owner.inject({ method: 'POST', url: orderUrl + '/transitions', headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { type: 'customOrder.quote', expectedRevision: order.revision, quoteAmount: 20000, proposedPickupAt: `${day}T17:00` } });
      expect(changed.statusCode, changed.body).toBe(200);
    };
    const update = await owner.inject({ method: 'PATCH', url: orderUrl, headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { expectedRevision: order.revision, expectedQuoteRevision: order.quoteRevision, referencePhotoKeys: [randomUUID()] } });
    expect(observations).toEqual([true, true, true]);
    expect(update.statusCode, update.body).toBe(409);
    expect(update.json().reason).toBe('STALE_REVISION');
  } finally {
    await owner.close();
  }
});
