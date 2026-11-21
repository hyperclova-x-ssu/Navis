import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { dbConfig, dbPool } from '../../packages/db/index.ts';
import { runMigrations } from '../../packages/db/migrate.ts';
import { createPosApp } from './app.ts';
import { recordReceiptExpenseCandidate } from './expenses.ts';
import { seed } from './seed.ts';
import { withStoreTransaction } from './transaction.ts';

const gatewayToken = randomBytes(32).toString('hex');
const customerToken = randomBytes(32).toString('hex');
const runtime = new Pool({ ...dbConfig('pos', 'runtime', 'test'), max: 2 });
const migrate = dbPool('pos', 'migrate', 'test');
const now = new Date('2026-11-17T06:45:00Z');
let fakeApprovalSucceeds = true;
const app = createPosApp(runtime, {
  gatewayToken, customerToken, now: () => now, approve: () => fakeApprovalSucceeds, logging: false,
});
const menuId = randomUUID();
const optionId = randomUUID();
const stores = Array.from({ length: 14 }, () => randomUUID());

beforeAll(async () => {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  await runMigrations('pos', dir, 'test');
  await runMigrations('pos', dir, 'test');
  for (const store of stores) {
    await withStoreTransaction(migrate, store, async (db) => {
      await db.query('INSERT INTO pos.store (store_id, display_name) VALUES ($1, $2)', [store, 'Synthetic café']);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at, seq)
        VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z', 153)`, [store]);
      await db.query(`INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)`, [
        store, menuId, { name: 'Café latte', basePrice: 4500, baseCost: 1000, recipeVersion: 'recipe-1', saleStatus: 'selling',
          groups: [{ required: false, options: [{ optionId, name: 'Extra shot', extraPrice: 500, extraCost: 200, recipeVersion: 'shot-1' }] }] },
      ]);
    });
  }
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([runtime.end(), migrate.end()]);
});

function request(storeId: string, path: string, payload?: object, key = randomUUID(), token = gatewayToken,
  overrides: Record<string, string> = {}) {
  return app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url: `/internal/v1/pos/stores/${storeId}${path}`,
    headers: {
      authorization: `Bearer ${token}`, 'x-navis-store-id': storeId, 'x-navis-store-role': 'owner',
      'x-navis-user-id': '7e9329c8-3c22-400b-a635-9b5ce52ad7a7', 'idempotency-key': key, ...overrides,
    },
    payload,
  });
}

async function draft(store: string, qty = 1, discount = 0) {
  const response = await request(store, '/bills', { type: 'dine_in', lines: [{ menuId, qty, optionIds: [optionId] }], discount });
  expect(response.statusCode).toBe(200);
  return response.json().value;
}

async function begin(store: string, key = randomUUID(), qty = 1, discount = 0) {
  const bill = await draft(store, qty, discount);
  const input = { billId: bill.billId, quoteRevision: bill.quoteRevision, splits: [{ method: 'card', amount: 5000 * qty - discount }] };
  const response = await request(store, '/approvals', input, key);
  expect(response.statusCode).toBe(200);
  const { attemptId, quoteFingerprint } = response.json().value;
  return { key, input, attemptId, quoteFingerprint, pending: response.json() };
}

function finish(store: string, approval: Awaited<ReturnType<typeof begin>>) {
  return request(store, `/approvals/${approval.attemptId}/finish`,
    { expectedQuoteFingerprint: approval.quoteFingerprint }, approval.key);
}

async function rows<T extends import('pg').QueryResultRow>(store: string, sql: string) {
  return withStoreTransaction(runtime, store, async (db) => (await db.query<T>(sql)).rows);
}

it('commits the approved café bill, payment, recognition, original receipt and ordered outbox together', async () => {
  const store = stores[0];
  const approval = await begin(store, randomUUID(), 1, 250);
  expect(await rows(store, 'SELECT * FROM pos.payment')).toEqual([]);
  const result = await finish(store, approval);
  expect(result.statusCode).toBe(200);
  const { paymentId, settlementId, orderIds } = result.json().value;
  expect(result.json().value).toMatchObject({ remaining: 0, settled: true });
  const receipt = await request(store, `/payments/${paymentId}/receipt`);
  expect(receipt.json()).toMatchObject({
    paymentId, settlementId, amount: 4750, gross: 5000, discount: 250, orderNos: [154],
    remaining: 4750, transactionNo: '거래-20261117-0154', approvalNo: '예시-000154',
    sourceSnapshot: { lines: [{ gross: 5000, discount: 250, amount: 4750 }] },
  });
  expect(await rows(store, 'SELECT event_id, store_seq, event_type, payload FROM pos.outbox')).toEqual([{
    event_id: expect.any(String), store_seq: '1', event_type: 'pos.sale_recognized.v1',
    payload: expect.objectContaining({ settlementId, paymentId, orderId: orderIds[0], businessDate: '2026-11-17',
      lines: [expect.objectContaining({ menuId, quantity: 1, recipeVersion: 'recipe-1' })] }),
  }]);
  expect(await rows(store, "SELECT fingerprint, receipt FROM pos.command_ledger WHERE command_type = 'approval.finish'"))
    .toEqual([{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), receipt: result.json() }]);
  expect(await rows(store, 'SELECT amount, cost FROM pos.sales_recognition')).toEqual([{ amount: '4750', cost: '1200' }]);
});

it('replays the exact original pending and committed responses and rejects a conflicting body', async () => {
  const store = stores[1];
  const approval = await begin(store);
  const results = await Promise.all([finish(store, approval), finish(store, approval)]);
  expect(results.every((result) => result.statusCode === 200)).toBe(true);
  expect(results[0].json()).toEqual(results[1].json());
  expect((await request(store, '/approvals', approval.input, approval.key)).json()).toEqual(approval.pending);
  const conflict = await request(store, '/approvals', { ...approval.input, splits: [{ method: 'cash', amount: 5000 }] }, approval.key);
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().reason).toBe('IDEMPOTENCY_MISMATCH');
  expect(await rows(store, 'SELECT store_seq FROM pos.outbox')).toEqual([{ store_seq: '1' }]);
  expect((await rows(store, 'SELECT payment_id FROM pos.payment')).length).toBe(1);
});

it('appends one cancellation and cost reversal using immutable price, option cost and discount at sale', async () => {
  const store = stores[2];
  const approval = await begin(store, randomUUID(), 2, 251);
  const { paymentId } = (await finish(store, approval)).json().value;
  await withStoreTransaction(migrate, store, (db) => db.query(`UPDATE pos.catalog_menu SET snapshot =
    jsonb_set(snapshot, '{baseCost}', '9999') WHERE menu_id = $1`, [menuId]));
  const quote = (await request(store, `/payments/${paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  expect(quote).toMatchObject({ amount: 9749, canSubmit: true, stockEffect: 'restore' });
  const key = randomUUID();
  const input = { quoteToken: quote.quoteToken, confirmed: true };
  const results = await Promise.all([request(store, '/corrections', input, key), request(store, '/corrections', input, key)]);
  expect(results[0].statusCode).toBe(200);
  expect(results[0].json()).toEqual(results[1].json());
  expect((await request(store, '/corrections', input)).json().reason).toBe('QUOTE_CHANGED');
  expect(await rows(store, 'SELECT amount, cost FROM pos.sales_recognition ORDER BY amount DESC')).toEqual([
    { amount: '9749', cost: '2400' }, { amount: '-9749', cost: '-2400' },
  ]);
  expect(await rows(store, 'SELECT event_type, store_seq FROM pos.outbox ORDER BY store_seq')).toEqual([
    { event_type: 'pos.sale_recognized.v1', store_seq: '1' }, { event_type: 'pos.sale_corrected.v1', store_seq: '2' },
  ]);
  const receipt = (await request(store, `/payments/${paymentId}/receipt`)).json();
  expect(receipt).toMatchObject({ amount: 9749, remaining: 0, status: 'canceled',
    corrections: [{ kind: 'cancel', amount: 9749 }], lines: [{ discount: 251, qty: 2 }] });
  expect((await finish(store, approval)).json().value.paymentId).toBe(paymentId);
});

it('refunds prepared goods financially and keeps sale-time usage and cost', async () => {
  const store = stores[3];
  const sale = (await finish(store, await begin(store))).json().value;
  const preparation = await request(store, `/orders/${sale.orderIds[0]}/preparation`, { status: 'preparing' });
  expect(preparation.statusCode).toBe(200);
  const cancel = (await request(store, `/payments/${sale.paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  expect(cancel).toMatchObject({ canSubmit: false, issues: [{ reason: 'USE_REFUND' }] });
  const quote = (await request(store, `/payments/${sale.paymentId}/reversal-quote`, { kind: 'refund', amount: 1001 })).json();
  expect(quote).toMatchObject({ canSubmit: true, stockEffect: 'keep' });
  expect((await request(store, '/corrections', { quoteToken: quote.quoteToken, confirmed: true })).statusCode).toBe(200);
  expect(await rows(store, 'SELECT amount, cost FROM pos.sales_recognition ORDER BY amount DESC')).toEqual([
    { amount: '5000', cost: '1200' }, { amount: '-1001', cost: '0' },
  ]);
  const event = (await rows<{payload: object}>(store, "SELECT payload FROM pos.outbox WHERE event_type = 'pos.sale_corrected.v1'"))[0];
  expect(event.payload).toMatchObject({ kind: 'refund', usageEffect: 'keep', lines: [{ quantity: 0 }] });
});

it('keeps unknown cost NULL on cancellation and rejects a correction after close', async () => {
  const store = stores[4];
  await withStoreTransaction(migrate, store, (db) => db.query(`UPDATE pos.catalog_menu SET snapshot =
    jsonb_set(snapshot, '{baseCost}', 'null')`));
  const { paymentId } = (await finish(store, await begin(store))).json().value;
  const quote = (await request(store, `/payments/${paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  expect((await request(store, '/corrections', { quoteToken: quote.quoteToken, confirmed: true })).statusCode).toBe(200);
  expect(await rows(store, 'SELECT amount, cost FROM pos.sales_recognition ORDER BY amount DESC')).toEqual([
    { amount: '5000', cost: null }, { amount: '-5000', cost: null },
  ]);
  const next = (await finish(store, await begin(store))).json().value;
  const beforeClose = (await request(store, `/payments/${next.paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  await withStoreTransaction(migrate, store, (db) => db.query("UPDATE pos.business_day SET status = 'closed'"));
  const rejected = await request(store, '/corrections', { quoteToken: beforeClose.quoteToken, confirmed: true });
  expect(rejected.json().reason).toBe('DAY_CLOSED');
  expect(await rows(store, 'SELECT store_seq FROM pos.outbox ORDER BY store_seq')).toEqual([
    { store_seq: '1' }, { store_seq: '2' }, { store_seq: '3' },
  ]);
});

it('rolls back the whole sale and correction on a real outbox insert failure, with no sequence gap', async () => {
  const store = stores[5];
  const approval = await begin(store);
  const constraint = 't306_deliberate_outbox_failure';
  const failOutbox = () => migrate.query(`ALTER TABLE pos.outbox ADD CONSTRAINT ${constraint} CHECK (false) NOT VALID`);
  const allowOutbox = () => migrate.query(`ALTER TABLE pos.outbox DROP CONSTRAINT ${constraint}`);
  await failOutbox();
  try {
    expect((await finish(store, approval)).statusCode).toBe(503);
    expect(await rows(store, 'SELECT * FROM pos.payment')).toEqual([]);
    expect(await rows(store, 'SELECT * FROM pos.settlement')).toEqual([]);
    expect(await rows(store, 'SELECT * FROM pos.sales_recognition')).toEqual([]);
    expect(await rows(store, 'SELECT * FROM pos.outbox_scope')).toEqual([]);
    expect(await rows(store, "SELECT * FROM pos.command_ledger WHERE command_type = 'approval.finish'")).toEqual([]);
    expect(await rows(store, 'SELECT status FROM pos.bill')).toEqual([{ status: 'open' }]);
    expect(await rows(store, "SELECT status FROM pos.command_ledger WHERE command_type = 'approval.begin'")).toEqual([{ status: 'pending' }]);
  } finally {
    await allowOutbox();
  }
  const { paymentId } = (await finish(store, approval)).json().value;
  const quote = (await request(store, `/payments/${paymentId}/reversal-quote`, { kind: 'cancel' })).json();
  const body = { quoteToken: quote.quoteToken, confirmed: true };
  const key = randomUUID();
  await failOutbox();
  try {
    expect((await request(store, '/corrections', body, key)).statusCode).toBe(503);
    expect(await rows(store, 'SELECT * FROM pos.payment_correction')).toEqual([]);
    expect(await rows(store, "SELECT * FROM pos.command_ledger WHERE command_type = 'payment.reverse'")).toEqual([]);
  } finally {
    await allowOutbox();
  }
  expect((await request(store, '/corrections', body, key)).statusCode).toBe(200);
  expect(await rows(store, 'SELECT store_seq FROM pos.outbox ORDER BY store_seq')).toEqual([{ store_seq: '1' }, { store_seq: '2' }]);
});

it('requires scope, rejects cross-store resources, and enforces forced RLS independently of HTTP', async () => {
  const store = stores[6];
  const other = stores[7];
  const { paymentId } = (await finish(store, await begin(store))).json().value;
  expect((await request(store, `/payments/${paymentId}/receipt`, undefined, undefined, 'bad-token')).statusCode).toBe(401);
  expect((await request(store, `/payments/${paymentId}/receipt`, undefined, undefined, gatewayToken, { 'x-navis-store-id': other })).statusCode).toBe(403);
  expect((await request(store, `/payments/${paymentId}/receipt`, undefined, undefined, gatewayToken, { 'x-navis-store-role': 'staff' })).statusCode).toBe(403);
  expect((await request(other, `/payments/${paymentId}/receipt`)).statusCode).toBe(404);
  expect((await request(other, `/payments/${paymentId}/reversal-quote`, {kind: 'cancel'})).statusCode).toBe(404);
  expect(await rows(other, 'SELECT * FROM pos.settlement')).toEqual([]);
  expect((await runtime.query('SELECT * FROM pos.outbox')).rows).toEqual([]);
  const policies = await runtime.query(`SELECT relname FROM pg_class JOIN pg_namespace n ON n.oid = relnamespace
    WHERE n.nspname = 'pos' AND relkind = 'r' AND relname <> 'schema_migrations'
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)`);
  expect(policies.rows).toEqual([]);
  await expect(runtime.query('UPDATE pos.payment SET amount = 1')).rejects.toMatchObject({ code: '42501' });
});

it('authenticates claim linking, preserves committed outcomes and durably fences an aborted attempt', async () => {
  const store = stores[8];
  const claimId = randomUUID();
  const commandKey = randomUUID();
  const claim = { claimId, commandKey, kind: 'reservation_first_order', sourceId: randomUUID(), sourceVersion: 2 };
  expect((await request(store, '/claims', claim)).statusCode).toBe(401);
  expect((await request(store, '/claims', claim, undefined, customerToken)).json()).toMatchObject({ claimId, commandKey });
  expect((await request(store, '/claims', claim, undefined, customerToken)).json()).toEqual(claim);
  expect((await request(store, '/claims', { ...claim, sourceVersion: 3 }, undefined, customerToken)).json().reason).toBe('CLAIM_MISMATCH');
  expect((await request(store, `/outcomes/${commandKey}`, undefined, undefined, customerToken)).json()).toMatchObject({ status: 'missing' });
  const abort = await request(store, `/outcomes/${commandKey}/abort`, { claimId }, undefined, customerToken);
  expect(abort.json()).toMatchObject({ status: 'aborted' });
  const bill = await draft(store);
  const late = await request(store, '/approvals', { billId: bill.billId, quoteRevision: bill.quoteRevision, splits: [{ method: 'card', amount: 5000 }] }, commandKey);
  expect(late.json().reason).toBe('COMMAND_ABORTED');

  const approved = await begin(store);
  const committed = (await finish(store, approved)).json();
  expect((await request(store, `/outcomes/${approved.key}`, undefined, undefined, customerToken)).json()).toMatchObject({
    status: 'committed', result: committed,
  });
  expect((await request(store, `/outcomes/${approved.key}/abort`, { claimId }, undefined, customerToken)).statusCode).toBe(409);
  expect(await rows(store, 'SELECT store_seq FROM pos.outbox')).toEqual([{ store_seq: '1' }]);
});

it('recognizes a bound membership claim once and keeps the durable sale receipt', async () => {
  const store = stores[12];
  const otherStore = stores[13];
  const key = randomUUID();
  const claimId = randomUUID();
  const claim = { claimId, commandKey: key, kind: 'membership_use', sourceId: randomUUID(), sourceVersion: 1 };
  expect((await request(store, '/claims', claim, undefined, customerToken)).json()).toEqual(claim);

  const bill = await draft(store, 2);
  const input = { billId: bill.billId, quoteRevision: bill.quoteRevision, splits: [{ method: 'card', amount: 10000 }] };
  expect((await request(store, '/approvals', input, key, customerToken)).statusCode).toBe(401);
  expect((await request(otherStore, '/approvals', input, key)).statusCode).toBe(404);
  const started = await request(store, '/approvals', input, key);
  expect(started.statusCode).toBe(200);
  const { attemptId, quoteFingerprint } = started.json().value;
  const approval = { key, input, pending: started.json(), attemptId, quoteFingerprint };
  expect((await request(store, '/approvals', input, key)).json()).toEqual(approval.pending);
  const attempts = await Promise.all([finish(store, approval), finish(store, approval)]);
  expect(attempts.map((result) => result.statusCode)).toEqual([200, 200]);
  const receipt = attempts[0].json();
  expect(attempts[1].json()).toEqual(receipt);
  expect(receipt.value).toMatchObject({ settlementId: expect.any(String), billId: bill.billId, orderIds: [expect.any(String)] });
  const outcome = { status: 'committed', result: receipt };
  expect((await request(store, `/outcomes/${key}`, undefined, undefined, customerToken)).json()).toEqual(outcome);
  expect((await request(store, `/outcomes/${key}/abort`, { claimId }, undefined, customerToken)).json()).toEqual(outcome);

  const events = await rows<{ event_type: string; schema_version: number; payload: object }>(store,
    'SELECT event_type, schema_version, payload FROM pos.outbox');
  expect(events).toEqual([{ event_type: 'pos.sale_recognized.v1', schema_version: 1, payload: expect.objectContaining({
    claimId, settlementId: receipt.value.settlementId, billId: bill.billId, orderId: receipt.value.orderIds[0],
    lines: [expect.objectContaining({ allocationId: expect.any(String), quantity: 2 })],
  }) }]);
  expect(events[0].payload).not.toHaveProperty('membershipContributions');

  expect((await finish(otherStore, await begin(otherStore, key))).statusCode).toBe(200);
  const walkIn = await rows<{ payload: object }>(otherStore, 'SELECT payload FROM pos.outbox');
  expect(walkIn[0].payload).not.toHaveProperty('claimId');
});

it('deduplicates receipt expenses by business receipt ID, while retaining independent stores', async () => {
  const store = stores[9];
  const receiptId = randomUUID();
  const payload = { receiptId, supplierId: randomUUID(), amount: 12000, businessDate: '2026-11-17' };
  const candidate = (scope: string, amount = payload.amount) => withStoreTransaction(runtime, scope, (db) =>
    recordReceiptExpenseCandidate(db, {
      producer: 'inventory', storeId: scope, scopeKey: scope, storeSeq: '1', eventId: randomUUID(),
      eventType: 'inventory.receipt_recorded.v1', schemaVersion: 1, aggregateId: receiptId, occurredAt: now.toISOString(),
      payload: { ...payload, amount },
    }));
  const first = await candidate(store);
  expect(await candidate(store)).toEqual(first);
  expect(await candidate(stores[10])).not.toEqual(first);
  await expect(candidate(store, 12001)).rejects.toThrow('Receipt candidate payload changed');
  expect(await rows(store, 'SELECT amount, status FROM pos.expense_candidate')).toEqual([{ amount: '12000', status: 'candidate' }]);
});

it('rejects failed or stale fake approvals durably and accepts a fresh explicitly confirmed quote', async () => {
  const store = stores[11];
  const old = await begin(store);
  await withStoreTransaction(migrate, store, (db) => db.query(`UPDATE pos.catalog_menu SET snapshot =
    jsonb_set(snapshot, '{basePrice}', '4600')`));
  const changed = await finish(store, old);
  expect(changed.statusCode).toBe(409);
  expect(changed.json()).toMatchObject({ reason: 'QUOTE_CHANGED', details: { quote: { payable: 5100 } } });
  expect((await finish(store, old)).json()).toEqual(changed.json());

  const input = {
    ...old.input, quoteRevision: changed.json().details.quote.quoteRevision, splits: [{ method: 'card', amount: 5100 }],
  };
  const freshAttempt = async () => {
    const key = randomUUID();
    const response = await request(store, '/approvals', input, key);
    expect(response.statusCode).toBe(200);
    return { key, input, pending: response.json(), ...response.json().value };
  };
  const fresh = await freshAttempt();
  fakeApprovalSucceeds = false;
  try {
    const failed = await finish(store, fresh);
    expect(failed.statusCode).toBe(422);
    expect(failed.json().reason).toBe('APPROVAL_FAILED');
    expect((await finish(store, fresh)).json()).toEqual(failed.json());
    expect(await rows(store, 'SELECT * FROM pos.payment')).toEqual([]);
    expect(await rows(store, 'SELECT * FROM pos.outbox')).toEqual([]);
  } finally {
    fakeApprovalSucceeds = true;
  }
  expect((await finish(store, await freshAttempt())).statusCode).toBe(200);
});

it('serves a sale and same-day cancellation from the generated café catalogue over private HTTP', async () => {
  await seed(migrate);
  await seed(migrate);
  const cafe = seedCatalog.store.storeId;
  const coffee = seedCatalog.menu.find((item) => item.menuId === 'm-americano')!;
  const optionIds = coffee.groups.filter((group) => group.required).map((group) => group.options[0].optionId);
  const http = createPosApp(runtime, { gatewayToken, now: () => now, logging: false });
  const origin = await http.listen({ host: '127.0.0.1', port: 0 });
  const send = (path: string, body: object, key = randomUUID()) =>
    fetch(`${origin}/internal/v1/pos/stores/${cafe}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: {
        authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json',
        'x-navis-store-id': cafe, 'x-navis-store-role': 'owner',
        'x-navis-user-id': '7e9329c8-3c22-400b-a635-9b5ce52ad7a7', 'idempotency-key': key,
      },
    });

  try {
    const quoted = await send('/bills', { type: 'takeout', lines: [{ menuId: coffee.dbId, qty: 1, optionIds }] });
    expect(quoted.status).toBe(200);
    const { billId, quoteRevision, payable } = (await quoted.json()).value;
    expect(payable).toBe(coffee.price);
    const key = randomUUID();
    const started = await send('/approvals', { billId, quoteRevision, splits: [{ method: 'cash', amount: payable }] }, key);
    expect(started.status).toBe(200);
    const { attemptId, quoteFingerprint } = (await started.json()).value;
    const approved = await send(`/approvals/${attemptId}/finish`, { expectedQuoteFingerprint: quoteFingerprint }, key);
    expect(approved.status).toBe(200);
    const { paymentId } = (await approved.json()).value;
    const reversed = await send(`/payments/${paymentId}/reversal-quote`, { kind: 'cancel' });
    const quote = await reversed.json();
    expect(quote).toMatchObject({ canSubmit: true, amount: coffee.price });
    const correction = await send('/corrections', { quoteToken: quote.quoteToken, confirmed: true });
    expect(correction.status).toBe(200);
    const { correctionId } = (await correction.json()).value;
    expect(await rows(cafe, 'SELECT aggregate_id, store_seq, payload FROM pos.outbox ORDER BY store_seq DESC LIMIT 2'))
      .toEqual([
        { aggregate_id: correctionId, store_seq: expect.any(String), payload: expect.objectContaining({ paymentId, costDelta: -coffee.unitCost! }) },
        { aggregate_id: expect.any(String), store_seq: expect.any(String), payload: expect.objectContaining({ paymentId, cost: coffee.unitCost }) },
      ]);
  } finally {
    await http.close();
  }
});
