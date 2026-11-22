import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { recordReceiptExpenseCandidate } from '../../expenses.ts';
import { createReversalTokens } from '../../reversals.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { preparePosRoute, type PosOwnerRouteWithPreflight } from '../../preflight.ts';
import { PosError } from '../../wire.ts';
import { registerPosRealityRoutes } from '../02/routes.ts';
import { registerMemberAccountRoutes } from "../05/routes.ts";
import { recordFunding, refundFunding } from '../05/funding.ts';
import { registerCustomOrderRoutes } from "../08/routes.ts";
import { registerFinanceRoutes } from './routes.ts';
import { recognizeCustomPickup } from './custom-pickup.ts';

const runtime = dbPool('pos', 'runtime', 'test');
const migrator = dbPool('pos', 'migrate', 'test');
const app = Fastify();
const day = '2026-11-17';
const initial = '2026-11-17T06:45:00Z';
let at = new Date(initial);
const storeId = randomUUID(), otherStore = randomUUID(), memberStore = randomUUID();
const splitMember = randomUUID();
const actorId = randomUUID(), otherActor = randomUUID();
const menuId = randomUUID(), unknownMenu = randomUUID();
let receiptStatus: 'pending' | 'active' | 'voided' = 'active';
const owner: PosOwnerRouteWithPreflight = (method, path, mode, handler) => {
  app.route<{ Params: { storeId: string; id?: string } }>({ method, url: '/pos/:storeId' + path,
    async handler(req, reply) {
      try {
        const { storeId } = req.params;
        const prepared = await preparePosRoute(runtime, { storeId, actorId: req.headers['x-test-actor'] === 'other' ? otherActor : actorId },
          () => at, handler, req.params, req.body, String(req.headers['idempotency-key']), req.query);
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
  for (const store of [storeId, otherStore, memberStore]) {
    await withStoreTransaction(migrator, store, async (db) => {
      await db.query('INSERT INTO pos.store (store_id) VALUES ($1)', [store]);
      await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
        VALUES ($1, $2, '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [store, day]);
      for (const [id, baseCost] of [[menuId, 1000], [unknownMenu, null]] as const) {
        await db.query('INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)', [
          store, id, { name: '원본 메뉴', basePrice: 4500, baseCost, recipeVersion: 'recipe-1', saleStatus: 'selling', groups: [] },
        ]);
      }
    });
  }
  registerFinanceRoutes(owner, { readReceiptStatus: async () => ({ status: receiptStatus }) });
  registerPosRealityRoutes(owner, createReversalTokens(randomUUID()));
  const customer = {
    async member() { return { memberId: splitMember, active: true, product: null }; },
    async archive() { throw new Error("Unexpected archive"); },
    async reserve() { throw new Error("Unexpected pass claim"); },
  };
  registerMemberAccountRoutes(owner, { customer });
  registerCustomOrderRoutes(owner, { customer, reversalSecret: randomUUID() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await Promise.all([runtime.end(), migrator.end()]);
});

function call(method: HTTPMethods, path: string, payload?: object, key: string = randomUUID(), store = storeId, actor?: string) {
  return app.inject({ method, url: '/pos/' + store + path, payload,
    headers: { 'idempotency-key': key, ...(actor && { 'x-test-actor': actor }) } });
}

async function ok(method: HTTPMethods, path: string, body?: object, key?: string) {
  const response = await call(method, path, body, key);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

it('reconciles sale-time cost and actual cash, freezes a close and blocks edits until confirmed reopen', async () => {
  const draft = await ok('POST', '/bills', { type: 'takeout', lines: [{ menuId, qty: 1 }, { menuId: unknownMenu, qty: 1 }] });
  const opening = await ok('GET', '/closings/' + day);
  expect(opening.pendingBills).toEqual([draft.resourceId]);
  expect((await call('POST', '/closings', { businessDate: day, expectedRevision: opening.revision })).json().reason)
    .toBe('CLOSING_BLOCKED');
  const sale = await ok('POST', '/bills/' + draft.resourceId + '/payments',
    { method: 'cash', quoteRevision: draft.quote.quoteRevision, amount: 9000 });
  const create = { date: day, category: 'operations', amount: 2000, evidence: 'card', memo: ' 운영 물품 ' };
  const key = randomUUID();
  const expense = await ok('POST', '/expenses', create, key);
  expect(await ok('POST', '/expenses', create, key)).toEqual(expense);
  expect((await call('POST', '/expenses', create)).json().reason).toBe('LIKELY_DUPLICATE_EXPENSE');
  expect((await call('GET', '/expenses/' + expense.resourceId, undefined, undefined, otherStore)).statusCode).toBe(404);
  expect(await ok('GET', '/expenses/' + expense.resourceId)).toMatchObject({ memo: '운영 물품', revision: 1 });
  const ledger = await ok('GET', '/ledger?businessDate=' + day);
  expect(ledger.totals).toMatchObject({ sales: { gross: 9000, discount: 0, refund: 0, total: 9000,
    byMethod: { cash: 9000, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 } },
    deposits: { gross: 9000, returned: 0, total: 9000, byMethod: { cash: 9000 } },
    knownCost: 1000, cost: null, unknownCostSales: 4500, expenses: 2000, profit: 7000, orderCount: 1, realPaymentCount: 1 });
  expect(ledger.hours).toContainEqual(expect.objectContaining({ businessDate: day, hour: 15, sales: 9000 }));
  expect((await ok('GET', '/deposits?businessDate=' + day)).items).toMatchObject([{ paymentId: sale.paymentId,
    purpose: 'sale', kind: 'payment', businessDate: day, splits: [{ method: 'cash', amount: 9000 }] }]);
  expect((await ok('GET', '/margins?businessDate=' + day)).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ menuId, recipeVersion: 'recipe-1', cost: 1000, contribution: 3500 }),
    expect.objectContaining({ menuId: unknownMenu, cost: null, contribution: null }),
  ]));
  const ready = await ok('GET', '/closings/' + day);
  await ok('PATCH', '/closings/' + day + '/drawer', { opening: 20000, expectedRevision: ready.revision });
  expect((await call('POST', '/closings', { businessDate: day, expectedRevision: ready.revision })).json().reason).toBe('STALE_REVISION');
  const drawerState = await ok('GET', '/closings/' + day);
  const movement = await ok('POST', '/cash-movements',
    { businessDate: day, kind: 'out', amount: 250, memo: '테스트 시재', expectedRevision: drawerState.revision });
  const movementPath = '/cash-movements/' + movement.resourceId;
  expect((await ok('GET', '/closings/' + day)).drawer).toMatchObject({ expected: 28750, out: 250 });
  expect((await call('DELETE', movementPath, { expectedRevision: movement.revision })).json().reason).toBe('CONFIRMATION_REQUIRED');
  await ok('DELETE', movementPath, { expectedRevision: movement.revision, confirmed: true });
  const cash = await ok('GET', '/closings/' + day);
  expect(cash.drawer).toMatchObject({ expected: 29000, actual: null, difference: null });
  const close = await ok('POST', '/closings', { businessDate: day, expectedRevision: cash.revision });
  const frozen = await ok('GET', '/closings/' + day);
  expect(frozen).toMatchObject({ status: 'closed', closingId: close.resourceId, totals: ledger.totals, drawer: cash.drawer });
  expect((await call('PATCH', '/expenses/' + expense.resourceId, { amount: 1, expectedRevision: 1 })).json().reason).toBe('DAY_CLOSED');
  expect((await call('POST', '/closings/' + close.resourceId + '/reopen', { expectedRevision: frozen.revision })).json().reason)
    .toBe('CONFIRMATION_REQUIRED');
  await ok('POST', '/closings/' + close.resourceId + '/reopen', { confirmed: true, expectedRevision: frozen.revision });
  const history = await ok('GET', '/closings');
  expect(history.items).toMatchObject([{ closingId: close.resourceId, reopenedAt: expect.any(String), totals: ledger.totals }]);
  const update = await ok('PATCH', '/expenses/' + expense.resourceId, { amount: 2300, expectedRevision: 1 });
  const undo = '/finance/receipts/' + update.receiptId + '/undo';
  expect((await call('POST', undo, {}, undefined, storeId, 'other')).statusCode).toBe(404);
  await ok('POST', undo, {});
  expect(await ok('GET', '/expenses/' + expense.resourceId)).toMatchObject({ amount: 2000, revision: 3 });
  const events = await withStoreTransaction(runtime, storeId, (db) => db.query(`
    SELECT event_type, payload FROM pos.outbox WHERE event_type IN ('pos.expense_changed.v1', 'pos.closing_changed.v1')
      AND store_id = $1 ORDER BY store_seq
  `, [storeId]), { readOnly: true });
  expect(events.rows.filter(row => row.event_type === 'pos.closing_changed.v1').map(row => row.payload.status)).toEqual(['closed', 'open']);
  expect(events.rows.every(row => !Object.hasOwn(row.payload, 'memo'))).toBe(true);
});

it('keeps zero-price receipt candidates separate, dedupes redelivery and rechecks undo at confirmation', async () => {
  const receiptId = randomUUID();
  const event = { producer: 'inventory', eventType: 'inventory.receipt_recorded.v1', schemaVersion: 1, storeId,
    eventId: randomUUID(), storeSeq: '1', scopeKey: storeId, aggregateId: receiptId, occurredAt: at.toISOString(),
    payload: { receiptId, supplierId: randomUUID(), businessDate: day, amount: 0, undoUntil: '2026-11-17T06:45:06.000Z' },
  } as const;
  const put = () => withStoreTransaction(runtime, storeId, (db) => recordReceiptExpenseCandidate(db, event), { write: true });
  const expenseId = await put();
  expect(await put()).toBe(expenseId);
  expect((await ok('GET', '/expense-candidates?businessDate=' + day)).items)
    .toMatchObject([{ expenseId, receiptId, amount: 0, status: 'candidate', revision: 1 }]);
  const path = '/expense-candidates/' + expenseId + '/confirm';
  receiptStatus = 'pending';
  expect((await call('POST', path, { expectedRevision: 1 })).json().reason).toBe('RECEIPT_PENDING');
  receiptStatus = 'active';
  const booked = await ok('POST', path, { expectedRevision: 1 });
  expect(await ok('GET', '/expenses/' + expenseId)).toMatchObject({ expenseId, receiptId, amount: 0, status: 'confirmed' });
  at = new Date('2026-11-17T06:45:07Z');
  expect((await call('POST', '/finance/receipts/' + booked.receiptId + '/undo', {})).json().reason).toBe('UNDO_EXPIRED');
  at = new Date(initial);
});

it('recognizes a pickup once, using the actual custom deposit only for tender totals', async () => {
  const customOrderId = randomUUID();
  const settlementId = randomUUID();
  const paymentId = randomUUID();
  await withStoreTransaction(runtime, otherStore, async (db) => {
    await db.query(`INSERT INTO pos.settlement (store_id, settlement_id, purpose, amount, at)
      VALUES ($1,$2,'custom_order',2000,$3)`, [otherStore, settlementId, at]);
    await db.query(`INSERT INTO pos.payment
      (store_id, payment_id, settlement_id, created_by, amount, splits, transaction_no, approval_no, at, channel)
      VALUES ($1,$2,$3,$4,2000,'[{"method":"cash","amount":2000}]','custom-entry','custom-entry',$5,'cash_record')`,
    [otherStore, paymentId, settlementId, actorId, at]);
  }, { write: true });
  const readOther = async (path: string) => {
    const result = await call('GET', path + '?businessDate=' + day, undefined, undefined, otherStore);
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  };
  expect((await readOther('/ledger')).totals).toMatchObject({ sales: { total: 0 }, deposits: { byPurpose: { custom_order: 2000 } } });
  await withStoreTransaction(runtime, otherStore, async (db) => {
    const tx = { db, storeId: otherStore, at, actorId };
    const source = { customOrderId, settlementId, businessDate: day, name: '테스트 맞춤 주문', amount: 5000 };
    const recognitionId = await recognizeCustomPickup(tx, source);
    expect(await recognizeCustomPickup(tx, source)).toBe(recognitionId);
  }, { write: true });
  expect((await readOther('/ledger')).totals).toMatchObject({
    sales: { total: 5000, bySource: { menu: 0, customPickup: 5000 }, byMethod: { cash: 0 } }, deposits: { total: 2000, byPurpose: { custom_order: 2000 } },
    knownCost: 0, cost: null, unknownCostSales: 5000, profit: 5000, orderCount: 1,
  });
  expect((await readOther('/margins')).items).toMatchObject([{
    kind: 'custom-pickup', sourceId: customOrderId, sales: 5000, cost: null, unitCost: null,
  }]);
});

it('sums member tender and a confirmed return while keeping both out of sales', async () => {
  const memberId = randomUUID();
  const customer = { async member() { return { memberId, active: true, product: null }; } };
  const topup = await withStoreTransaction(runtime, memberStore, (db) =>
    recordFunding({ db, storeId: memberStore, actorId, at }, customer, randomUUID(), memberId, {
      purpose: 'charge_topup', amount: 9000, expectedRevision: 0,
      splits: [{ method: 'card', amount: 6000 }, { method: 'cash', amount: 3000 }],
      terminal: { approvalNo: 'B09-ORIGINAL', occurredAt: initial },
    }), { write: true });
  const returned = await withStoreTransaction(runtime, memberStore, (db) =>
    refundFunding({ db, storeId: memberStore, actorId, at }, randomUUID(), topup.settlementId, {
      amount: 6000, expectedRevision: 1, confirmed: true,
      terminal: { approvalNo: 'B09-RETURN', occurredAt: initial },
    }), { write: true });
  const summary = await call('GET', '/ledger?businessDate=' + day, undefined, undefined, memberStore);
  expect(summary.statusCode).toBe(200);
  expect(summary.json().totals).toMatchObject({ sales: {
    total: 0, byMethod: { cash: 0, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 },
  }, deposits: {
    gross: 9000, returned: 6000, total: 3000, byMethod: { cash: 3000, card: 0 },
    byMethodReturned: { card: 6000 }, byPurpose: { charge_topup: 3000 },
  }, realPaymentCount: 1, orderCount: 0 });
  const rows = await call('GET', '/deposits?businessDate=' + day, undefined, undefined, memberStore);
  expect(rows.json().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'payment', paymentId: topup.paymentId, amount: 9000 }),
    expect.objectContaining({ kind: 'refund', paymentId: topup.paymentId, correctionId: returned.correctionId, amount: 6000 }),
  ]));
});

it("nets a mixed sale on correction and freezes the original split for another owner session", async () => {
  const nextDay = "2026-11-18";
  await withStoreTransaction(migrator, memberStore, async db => {
    await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, $2, $3, $4)`, [memberStore, nextDay, "2026-11-17T20:00:00Z", "2026-11-18T20:00:00Z"]);
  });
  const request = async (method: HTTPMethods, path: string, body?: object, actor?: string) => {
    const response = await call(method, path, body, undefined, memberStore, actor);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  await request("POST", "/member-accounts/" + splitMember + "/entries", {
    purpose: "charge_topup", amount: 2000, expectedRevision: 0, splits: [{ method: "cash", amount: 2000 }],
  });
  const draft = await request("POST", "/bills", { type: "takeout", lines: [{ menuId, qty: 1 }] });
  const path = "/bills/" + draft.resourceId;
  const input = { memberId: splitMember, allocations: [
    { kind: "method", method: "card", amount: 1500 },
    { kind: "method", method: "cash", amount: 1000 },
    { kind: "method", method: "easy_pay", amount: 500 },
    { kind: "charge", amount: 1000 },
    { kind: "receivable", amount: 500 },
  ] };
  const quote = await request("POST", path + "/member-quote", input);
  const terminal = { approvalNo: "B09-MIXED", occurredAt: initial };
  const sale = await request("POST", path + "/member-payments", {
    ...input, quoteRevision: quote.quoteRevision, accountRevision: quote.accountRevision, terminal,
  });
  const split = { card: 1500, cash: 1000, easy_pay: 500, charge: 1000, receivable: 500, mixed: 4500 };
  const ledger = await request("GET", "/ledger?businessDate=" + day);
  expect(ledger.totals.sales.byMethod).toEqual(split);
  expect(ledger.days[0].sales.byMethod).toEqual(split);
  expect((await request("GET", "/margins?businessDate=" + day)).totals.sales.byMethod).toEqual(split);
  const open = await request("GET", "/closings/" + day);
  await request("POST", "/closings", { businessDate: day, expectedRevision: open.revision });
  const closed = await request("GET", "/closings/" + day, undefined, "other");
  expect(closed.totals.sales.byMethod).toEqual(split);
  await request("POST", "/closings/" + closed.closingId + "/reopen", {
    expectedRevision: closed.revision, confirmed: true,
  });
  const reverse = await request("POST", "/payments/" + sale.paymentId + "/reversal-quote", { kind: "cancel" });
  expect(reverse.canSubmit, JSON.stringify(reverse.issues)).toBe(true);
  await request("POST", "/settlements/" + sale.settlementId + "/corrections", {
    quoteToken: reverse.quoteToken, confirmed: true,
    terminal: { approvalNo: "B09-MIXED-RETURN", occurredAt: initial },
  });
  const period = await request("GET", "/ledger?from=" + day + "&to=" + nextDay, undefined, "other");
  const net = { card: 0, cash: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 };
  expect(period.days[0].sales.byMethod).toEqual(net);
  expect(period.totals.sales.byMethod).toEqual(net);
  expect((await request("GET", "/closings")).items[0].totals.sales.byMethod).toEqual(split);
  expect((await request("GET", "/ledger?businessDate=" + day, undefined, "other")).sourceRevision)
    .not.toBe(ledger.sourceRevision);
});

it("nets a later partial pickup refund against the original methods without counting an advance as sales", async () => {
  const nextDay = "2026-11-18";
  await withStoreTransaction(migrator, storeId, async db => {
    await db.query(`INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at)
      VALUES ($1, $2, $3, $4)`, [storeId, nextDay, "2026-11-17T20:00:00Z", "2026-11-18T20:00:00Z"]);
  });
  const before = await ok("GET", "/ledger?businessDate=" + day);
  const template = await ok("POST", "/custom-templates", { name: "케이크 주문서", fields: [
    { fieldId: "note", label: "문구", input: "text", required: true, options: [] },
  ] });
  const order = await ok("POST", "/custom-orders", {
    templateId: template.templateId, answers: { note: "축하해요" }, productLabel: "케이크",
    channel: "phone", quantity: 1, memberId: splitMember, desiredPickupAt: nextDay + "T17:00",
  });
  const path = "/custom-orders/" + order.customOrderId;
  const transition = (expectedRevision: number, type: string, args: object) =>
    ok("POST", path + "/transitions", { type, expectedRevision, ...args });
  const quoted = await transition(order.revision, "customOrder.quote", { quoteAmount: 6000, proposedPickupAt: nextDay + "T17:00" });
  const approved = await transition(quoted.revision, "customOrder.recordDecision", {
    decision: "approved", quoteRevision: quoted.quoteRevision, paymentTiming: "advance",
  });
  const allocations = [{ kind: "method", method: "cash", amount: 2000 }, { kind: "method", method: "card", amount: 4000 }];
  const quote = await ok("POST", path + "/settlement-quote", { allocations });
  const paid = await ok("POST", path + "/payments", {
    quoteId: quote.quoteId, expectedRevision: approved.revision, allocations,
    terminal: { approvalNo: "B09-PICKUP", occurredAt: initial },
  });
  const advance = await ok("GET", "/ledger?businessDate=" + day);
  expect(advance.totals.sales.byMethod).toEqual(before.totals.sales.byMethod);
  expect(advance.totals.deposits.byPurpose.custom_order).toBe(6000);
  const ready = await transition(paid.revision, "customOrder.setStage", { nextStage: "production_complete" });
  const received = await transition(ready.revision, "customOrder.receive", { confirmed: true });
  at = new Date(nextDay + "T06:45:00Z");
  try {
    const reversal = await ok("POST", path + "/reversal-quote", { kind: "refund", amount: 3000 });
    await ok("POST", path + "/corrections", {
      quoteId: reversal.quoteId, expectedRevision: received.revision, kind: "refund", amount: 3000, confirmed: true,
      terminal: { approvalNo: "B09-PICKUP-RETURN", occurredAt: at.toISOString() },
    });
    const period = await ok("GET", "/ledger?from=" + day + "&to=" + nextDay);
    expect(period.days[1].sales.byMethod).toEqual({ cash: 0, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 });
    expect(period.totals.sales.byMethod).toEqual(before.totals.sales.byMethod);
    expect(period.totals.sales.bySource.customPickup).toBe(3000);
    expect(period.days[1].deposits.byMethodReturned).toMatchObject({ cash: 1000, card: 2000 });
  } finally {
    at = new Date(initial);
  }
});
