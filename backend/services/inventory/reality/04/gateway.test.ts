import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { InjectOptions } from 'light-my-request';
import { createClient } from 'redis';
import { expect, it } from 'vitest';
import { createGateway } from '../../../../gateway/app.ts';
import { createApp } from '../../../../infra/http.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { OutboxRelay, relayDbPool } from '../../../../packages/streams/relay.ts';
import { RedisStreams } from '../../../../packages/streams/redis.ts';
import { createPosReceiptConsumer } from '../../../../workers/pos-receipts/consumer.ts';
import { createAccountApp } from '../../../account/app.ts';
import { createSigningKeys } from '../../../account/keys.ts';
import { provisionOwner } from '../../../account/reality/00/provision.ts';
import { createCalendarProjectionConsumers } from '../../../customer/reality/07/projection.ts';
import { registerCalendarStaffRoutes } from '../../../customer/reality/07/routes.ts';
import { createPosApp } from '../../../pos/app.ts';
import type { ReadReceiptStatus } from '../../../pos/reality/09/expenses.ts';
import { withStoreTransaction as inPos } from '../../../pos/transaction.ts';
import { createInventoryApp } from '../../app.ts';
import { withStoreTransaction } from '../../store-transaction.ts';

const redisEndpoint = process.env.NAVIS_FORECAST_TEST_REDIS_URL;

it.skipIf(!redisEndpoint)('persists owner purchasing through the gateway and projects partial intake, stock, calendar and POS', async () => {
  const storeId = randomUUID();
  const tokens = { account: randomUUID(), inventory: randomUUID(), customer: randomUUID(), pos: randomUUID(), posToInventory: randomUUID() };
  const accountDb = dbPool('account', 'runtime', 'test');
  const accountSetup = dbPool('account', 'migrate', 'test');
  const inventoryDb = dbPool('inventory', 'runtime', 'test');
  const posDb = dbPool('pos', 'runtime', 'test');
  const posWorker = dbPool('pos', 'worker', 'test');
  const customerDb = dbPool('customer', 'runtime', 'test');
  const relayDb = relayDbPool('inventory');
  const posRelayDb = relayDbPool('pos');
  const customerRelayDb = relayDbPool('customer');
  const origin = 'http://127.0.0.1:18284';
  const host = new URL(origin).host;
  let clock = new Date('2026-11-21T02:45:00Z');
  const now = () => clock;
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' } });
  const account = createAccountApp({ pool: accountDb, gatewayToken: tokens.account, keys: await createSigningKeys(keys.privateKey),
    publicOrigin: origin, logging: false });
  const inventory = createInventoryApp(inventoryDb, tokens.inventory, false, now, undefined, { posCatalogToken: tokens.posToInventory });
  const customer = createApp('customer', async () => {}, false);
  registerCalendarStaffRoutes(customer, customerDb, tokens.customer, { now });
  const [accountUrl, inventoryUrl, customerUrl] = await Promise.all([account, inventory, customer].map(app => app.listen({ host: '127.0.0.1', port: 0 })));
  const readReceiptStatus: ReadReceiptStatus = async ({ storeId, actorId, receiptId }) => {
    const response = await fetch(`${inventoryUrl}/internal/v1/inventory/stores/${storeId}/purchase-receipt-status/${receiptId}`, {
      headers: { authorization: `Bearer ${tokens.posToInventory}`, 'x-navis-store-id': storeId,
        'x-navis-store-role': 'owner', 'x-navis-user-id': actorId },
    });
    if (!response.ok) throw new Error(`Receipt status lookup returned ${response.status}`);
    return response.json();
  };
  const pos = createPosApp(posDb, { gatewayToken: tokens.pos, now, logging: false, operating: true, readReceiptStatus });
  const posUrl = await pos.listen({ host: '127.0.0.1', port: 0 });
  const gateway = createGateway({ accountUrl, inventoryUrl, accountToken: tokens.account, inventoryToken: tokens.inventory,
    customer: { url: customerUrl, token: tokens.customer }, pos: { url: posUrl, token: tokens.pos }, accountOrigin: origin, logging: false });
  const redisUrl = new URL(redisEndpoint!);
  redisUrl.pathname = '/9';
  const client = createClient({ url: redisUrl.href, disableOfflineQueue: true });
  await client.connect();
  const redis = new RedisStreams(client);
  try {
    const login = { loginId: `${randomUUID()}@example.invalid`, password: randomBytes(18).toString('base64url') };
    await provisionOwner(accountSetup, { ...login, storeId, ownerName: '발주 테스트',
      storeName: '격리 구매 매장', businessDayStart: '05:00' });
    let accessToken: string | undefined;
    const requestIds: string[] = [];
    const send = async (method: InjectOptions['method'], url: string, status: number, payload?: object, key = randomUUID()) => {
      const response = await gateway.inject({ method, url, payload, headers: {
        host, origin, 'sec-fetch-site': 'same-origin', 'idempotency-key': key,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      } });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
      requestIds.push(String(response.headers['x-request-id']));
      return response.json();
    };
    const root = `/api/v1/stores/${storeId}`;
    const suppliers = `${root}/inventory/suppliers`;
    const orders = `${root}/inventory/purchase-orders`;
    const terms = `${root}/inventory/purchase-items`;
    await send('GET', suppliers, 401);
    ({ accessToken } = await send('POST', '/api/v1/auth/login', 200, login));
    const ownerId = decodeJwt(accessToken!).sub!;
    const supplier = await send('POST', suppliers, 201, { name: '공급 매장', contact: '담당자', phone: '010-1234-9876' });
    const stock = await send('POST', `${root}/inventory/items`, 201, { sku: 'MILK', name: '우유', unit: 'L', stock: 0.5, threshold: 1 });
    const itemPath = `${root}/inventory/items/${stock.resourceId}`;
    const term = await send('POST', terms, 201, { itemId: stock.resourceId, supplierId: supplier.resourceId,
      minimumQty: 1, orderStep: 0.5, unitPrice: 2400, leadDays: 2 });
    const draft = { purchaseItemId: term.resourceId, qty: 3.5, expectedRevision: term.revision };
    const order = await send('POST', orders, 201, { ...draft, suggestionItemId: stock.resourceId });
    const orderPath = `${orders}/${order.poId}`;
    expect(order).toMatchObject({ dueDate: '2026-11-23', total: 8400, revision: 1 });
    expect(await send('POST', orders, 409, { ...draft, suggestionItemId: stock.resourceId })).toMatchObject({ reason: 'STALE_SUGGESTION' });
    const duplicateKey = randomUUID();
    expect(await send('POST', orders, 409, draft, duplicateKey)).toMatchObject({ reason: 'LIKELY_DUPLICATE_ORDER' });
    const duplicate = await send('POST', orders, 201, { ...draft, confirmDuplicate: true }, duplicateKey);
    await send('POST', `${orders}/${duplicate.poId}/cancel`, 200, { expectedRevision: duplicate.revision, confirmed: true });
    await send('PATCH', `${terms}/${term.resourceId}`, 200, { expectedRevision: term.revision, unitPrice: 9000 });
    const menu = await send('POST', `${root}/inventory/menu`, 201, { name: '우유 메뉴', category: 'drink', price: 4500 });
    await send('PATCH', `${root}/inventory/recipes`, 200, { menuId: menu.resourceId, expectedRevision: menu.revision,
      lines: [{ itemId: stock.resourceId, quantity: 0.2, unit: 'L' }] });
    expect(await send('GET', `${root}/inventory/menu/${menu.resourceId}`, 200)).toMatchObject({ unitCost: 1800 });

    const receiptsPath = `${orderPath}/receipts`;
    const key = randomUUID();
    const input = { polId: order.polId, qty: 1.5, expectedRevision: order.revision };
    expect(await send('POST', receiptsPath, 409, { ...input, qty: 4 })).toMatchObject({ reason: 'QTY_OVER_REMAINING' });
    const receipt = await send('POST', receiptsPath, 201, input, key);
    expect(await send('POST', receiptsPath, 201, input, key)).toEqual(receipt);
    expect(await send('POST', receiptsPath, 409, { ...input, qty: 2 }, key)).toMatchObject({ reason: 'IDEMPOTENCY_MISMATCH' });
    expect(await send('POST', receiptsPath, 409, input)).toMatchObject({ reason: 'STALE_REVISION' });
    expect(receipt).toMatchObject({ qtyRemaining: 2, affectedSources: expect.arrayContaining(['stock', 'calendar', 'ledger']) });
    expect(await send('GET', itemPath, 200)).toMatchObject({ stock: { rawQuantityBase: '2000' } });

    const getStatus = (id: string) => readReceiptStatus({ storeId, actorId: ownerId, receiptId: id });
    expect(await getStatus(receipt.receiptId)).toEqual({ status: 'pending' });

    const relay = new OutboxRelay({ producer: 'inventory', database: relayDb, redis,
      groups: [{ name: 'pos', database: posRelayDb }, { name: 'customer', database: customerRelayDb }] });
    const posConsumer = createPosReceiptConsumer(posWorker, redis, 'b04-receipts');
    const [calendarConsumer] = createCalendarProjectionConsumers(customerDb, redis, 'b04-calendar');
    const drain = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await relay.step() === 'idle') break;
      }
      await Promise.all([posConsumer.step(), calendarConsumer.step()]);
    };
    const queryCandidate = (id: string) => inPos(posDb, storeId, async db => (await db.query(`
      SELECT expense_id AS "expenseId", amount::int, status FROM pos.expense_candidate WHERE store_id = $1 AND receipt_id = $2
    `, [storeId, id])).rows, { readOnly: true });
    await expect.poll(async () => { await drain(); return queryCandidate(receipt.receiptId); }, { timeout: 8000, interval: 20 })
      .toMatchObject([{ amount: 3600, status: 'candidate' }]);
    const candidatePath = `${root}/pos/expense-candidates`;
    const pendingCandidates = await send('GET', candidatePath, 200);
    expect(pendingCandidates).toMatchObject({ items: [{ receiptId: receipt.receiptId, amount: 3600, status: 'candidate' }] });
    const pending = pendingCandidates.items[0];
    expect(await send('POST', `${candidatePath}/${pending.expenseId}/confirm`, 409, { expectedRevision: pending.revision }))
      .toMatchObject({ reason: 'RECEIPT_PENDING' });
    const calendarPath = `${root}/calendar/projections`;
    expect(await send('GET', calendarPath, 200)).toMatchObject({ items: [{ sourceId: order.poId, date: '2026-11-23', sourceRevision: 2 }] });

    const reversed = await send('POST', `${root}/inventory/purchasing/receipts/${receipt.receiptId}/undo`, 200, {});
    expect(await getStatus(receipt.receiptId)).toEqual({ status: 'voided' });
    expect(await send('GET', itemPath, 200)).toMatchObject({ stock: { rawQuantityBase: '500' } });
    await expect.poll(async () => { await drain(); return queryCandidate(receipt.receiptId); }, { timeout: 8000, interval: 20 })
      .toMatchObject([{ amount: 3600, status: 'canceled' }]);

    const active = await send('POST', receiptsPath, 201, { ...input, expectedRevision: reversed.revision, qty: 2 });
    clock = new Date(+clock + 7000);
    expect(await getStatus(active.receiptId)).toEqual({ status: 'active' });
    expect(await send('POST', `${root}/inventory/purchasing/receipts/${active.receiptId}/undo`, 409, {})).toMatchObject({ reason: 'UNDO_EXPIRED' });
    await expect.poll(async () => { await drain(); return queryCandidate(active.receiptId); }, { timeout: 8000, interval: 20 })
      .toMatchObject([{ amount: 4800, status: 'candidate' }]);

    accessToken = undefined;
    ({ accessToken } = await send('POST', '/api/v1/auth/login', 200, login));
    const saved = await send('GET', orderPath, 200);
    expect(saved).toMatchObject({ status: 'partial', lines: [{ received: 2, remaining: 1.5, qtyOrdered: 3.5, unitPrice: 2400,
      unitSnapshot: 'L', basePerUnit: 1000, itemNameSnapshot: '우유' }] });
    expect(await send('GET', itemPath, 200)).toMatchObject({ stock: { rawQuantityBase: '2500' } });
    const history = await send('GET', `${root}/inventory/purchasing/receipts`, 200);
    expect(history.items).toEqual(expect.arrayContaining([expect.objectContaining({ receiptId: active.receiptId, voidedAt: null })]));
    const cancelPath = `${orderPath}/cancel`;
    expect(await send('POST', cancelPath, 400, { expectedRevision: saved.revision })).toMatchObject({ reason: 'CONFIRMATION_REQUIRED' });
    await send('POST', cancelPath, 200, { expectedRevision: saved.revision, confirmed: true });
    await drain();
    expect(await send('GET', calendarPath, 200)).toMatchObject({ items: [] });
    expect(await queryCandidate(active.receiptId)).toHaveLength(1);
    const candidates = await send('GET', candidatePath, 200);
    const candidate = candidates.items.find((row: { receiptId: string }) => row.receiptId === active.receiptId);
    expect(candidate).toMatchObject({ amount: 4800, status: 'candidate' });
    expect((await send('GET', `${root}/pos/expenses`, 200)).items).toEqual([]);
    const confirmPath = `${candidatePath}/${candidate.expenseId}/confirm`;
    const confirmKey = randomUUID();
    const booked = await send('POST', confirmPath, 200, { expectedRevision: candidate.revision }, confirmKey);
    expect(await send('POST', confirmPath, 200, { expectedRevision: candidate.revision }, confirmKey)).toEqual(booked);
    expect(await send('GET', `${root}/pos/expenses`, 200)).toMatchObject({ items: [{ receiptId: active.receiptId, amount: 4800 }] });
    expect((await inventoryDb.query('SELECT 1 FROM inventory.purchase_order WHERE store_id = $1', [storeId])).rowCount).toBe(0);
    const outbox = await withStoreTransaction(inventoryDb, storeId, async db => (await db.query(`
      SELECT event_id, event_type, aggregate_id FROM inventory.outbox WHERE store_id = $1 AND aggregate_id = ANY($2)
      ORDER BY store_seq`, [storeId, [order.poId, receipt.receiptId, active.receiptId]])).rows, { readOnly: true });
    console.log('B04 HTTP/DB/stream witness', JSON.stringify({ storeId, requestIds, poId: order.poId, polId: order.polId,
      receiptId: active.receiptId, candidate: await queryCandidate(active.receiptId), outbox }));
  } finally {
    client.destroy();
    await Promise.all([gateway, account, inventory, customer, pos].map(app => app.close()));
    await Promise.all([accountDb, accountSetup, inventoryDb, posDb, posWorker, customerDb, relayDb, posRelayDb, customerRelayDb].map(pool => pool.end()));
  }
}, 30_000);
