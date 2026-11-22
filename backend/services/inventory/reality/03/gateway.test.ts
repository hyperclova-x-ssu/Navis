import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { InjectOptions } from 'light-my-request';
import { createClient } from 'redis';
import { expect, it } from 'vitest';
import { createGateway } from '../../../../gateway/app.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { RedisStreams } from '../../../../packages/streams/redis.ts';
import { OutboxRelay, relayDbPool } from '../../../../packages/streams/relay.ts';
import { createPosReceiptConsumer } from '../../../../workers/pos-receipts/consumer.ts';
import { createAccountApp } from '../../../account/app.ts';
import { createSigningKeys } from '../../../account/keys.ts';
import { provisionOwner } from '../../../account/reality/00/provision.ts';
import { transaction as inAccount } from '../../../account/transaction.ts';
import { createPosApp } from '../../../pos/app.ts';
import { appendOutbox } from '../../../pos/ledger.ts';
import { withStoreTransaction as inPos } from '../../../pos/transaction.ts';
import type { PosSaleCorrected, PosSaleRecognized } from '../../../../packages/contracts/events.ts';
import { createInventoryApp } from '../../app.ts';
import { createInventoryStockConsumer } from '../../stock-consumer.ts';
import { withStoreTransaction } from '../../store-transaction.ts';

const redisEndpoint = process.env.NAVIS_FORECAST_TEST_REDIS_URL;

it.skipIf(!redisEndpoint)('persists owner records through the gateway and reflects POS and purchase events', async () => {
  await runMigrations('account', fileURLToPath(new URL('../../../account/migrations/', import.meta.url)), 'test');
  const token = { account: randomUUID(), inventory: randomUUID(), catalog: randomUUID(), pos: randomUUID(), forecast: randomUUID() };
  const storeId = randomUUID();
  const accountDb = dbPool('account', 'runtime', 'test');
  const accountSetup = dbPool('account', 'migrate', 'test');
  const inventoryDb = dbPool('inventory', 'runtime', 'test');
  const inventorySetup = dbPool('inventory', 'migrate', 'test');
  const inventoryWorker = dbPool('inventory', 'worker', 'test');
  const posDb = dbPool('pos', 'runtime', 'test');
  const posRelayDb = relayDbPool('pos');
  const inventoryRelayDb = relayDbPool('inventory');
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const origin = 'http://127.0.0.1:18283';
  const host = new URL(origin).host;
  const now = () => new Date('2026-11-21T02:45:00Z');
  const account = createAccountApp({
    pool: accountDb, gatewayToken: token.account, keys: await createSigningKeys(keyPair.privateKey), publicOrigin: origin, logging: false,
  });
  const inventory = createInventoryApp(inventoryDb, token.inventory, false, now, token.forecast, { posCatalogToken: token.catalog });
  const inventoryUrl = await inventory.listen({ host: '127.0.0.1', port: 0 });
  const pos = createPosApp(posDb, { gatewayToken: token.pos, now, logging: false, operating: true,
    async readCatalog({ storeId, actorId, menuIds }) {
      const url = new URL(`/internal/v1/inventory/stores/${storeId}/catalog-snapshot`, inventoryUrl);
      for (const id of menuIds) url.searchParams.append('menuId', id);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token.catalog}`, 'x-navis-store-id': storeId,
        'x-navis-user-id': actorId, 'x-navis-store-role': 'owner' } });
      if (!response.ok) throw new Error('Live catalog unavailable');
      return response.json();
    },
  });
  const [accountUrl, posUrl] = await Promise.all([
    account.listen({ host: '127.0.0.1', port: 0 }), pos.listen({ host: '127.0.0.1', port: 0 }),
  ]);
  const gateway = createGateway({
    accountUrl, inventoryUrl, accountToken: token.account, inventoryToken: token.inventory,
    pos: { url: posUrl, token: token.pos }, accountOrigin: origin, logging: false,
  });
  const redisUrl = new URL(redisEndpoint!);
  redisUrl.pathname = '/7';
  const client = createClient({ url: redisUrl.href, disableOfflineQueue: true });
  await client.connect();
  const redis = new RedisStreams(client);
  const login = { loginId: `${randomUUID()}@example.invalid`, password: randomBytes(18).toString('base64url') };
  try {
    await provisionOwner(accountSetup, { ...login, ownerName: '재고 테스트',
      storeName: '격리된 테스트 매장', storeId, businessDayStart: '05:00' });
    let accessToken: string | undefined;
    const requestIds: string[] = [];
    const send = async (method: InjectOptions['method'], url: string, status: number, payload?: object) => {
      const response = await gateway.inject({ method, url, payload, headers: {
        host, origin, 'sec-fetch-site': 'same-origin', 'idempotency-key': randomUUID(),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      } });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      requestIds.push(String(response.headers['x-request-id']));
      return response.json();
    };
    const root = `/api/v1/stores/${storeId}`;
    await send('GET', root + '/inventory/items', 401);
    ({ accessToken } = await send('POST', '/api/v1/auth/login', 200, login));
    expect(await send('GET', root + '/inventory/items', 200)).toMatchObject({ items: [], businessDate: '2026-11-21' });
    const item = await send('POST', root + '/inventory/items', 201, { sku: 'WITNESS-MILK', name: '우유', unit: 'L', stock: 1, threshold: 0.9 });
    const { resourceId: itemId } = item;
    const lot = await send('POST', root + '/inventory/stock-batches', 201, {
      itemId, expectedRevision: item.revision, expiresOn: '2026-11-21', quantity: 0.4,
    });
    const menu = await send('POST', root + '/inventory/menu', 201, { name: '테스트 라떼', category: 'drink', price: 4500 });
    const saveRecipe = (expectedRevision: number, quantity: number) => send('PATCH', root + '/inventory/recipes', 200, {
      menuId: menu.resourceId, expectedRevision, lines: [{ itemId, quantity, unit: 'mL' }],
    });
    const recipe = await saveRecipe(menu.revision, 150);
    const milk = await send('GET', root + `/inventory/items/${itemId}`, 200);
    expect(await send('DELETE', root + `/inventory/items/${itemId}`, 409, {
      expectedRevision: milk.revision, confirmed: true,
    })).toMatchObject({ reason: 'REFERENCED_ITEM' });
    const retired = await send('POST', root + '/inventory/items', 201, {
      sku: 'WITNESS-RETIRED', name: '보관 재료', unit: 'mL', stock: 0, threshold: 0,
    });
    await send('DELETE', root + `/inventory/items/${retired.resourceId}`, 200, {
      expectedRevision: retired.revision, confirmed: true,
    });
    expect(await send('PATCH', root + '/inventory/recipes', 404, {
      menuId: menu.resourceId, expectedRevision: recipe.revision, lines: [{ itemId: retired.resourceId, quantity: 1, unit: 'mL' }],
    })).toMatchObject({ reason: 'ITEM_NOT_FOUND' });
    const bill = await send('POST', root + '/pos/bills', 200, { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }] });
    const sale = await send('POST', root + `/pos/bills/${bill.resourceId}/payments`, 200, {
      method: 'cash', amount: 4500, quoteRevision: bill.quote.quoteRevision,
    });
    const forecastPath = '/forecasts/2026-11-21/weekday-4w-v1';
    expect(await send('GET', root + '/inventory' + forecastPath, 200)).toMatchObject({ status: 'no_data' });
    const forecast = await fetch(`${inventoryUrl}/internal/v1/inventory/stores/${storeId}${forecastPath}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token.forecast}`, 'x-navis-store-id': storeId, 'content-type': 'application/json' },
      body: JSON.stringify({ menus: [{ menuId: menu.resourceId, fourWeekQuantity: '4' }] }),
    });
    expect(forecast.status).toBe(200);
    const generated = await forecast.json();
    expect(generated).toMatchObject({ status: 'ready', results: expect.arrayContaining([
      { scope: 'ingredient', targetId: itemId, expected: '150.00' },
    ]) });
    await saveRecipe(recipe.revision, 200);

    const relay = new OutboxRelay({ producer: 'pos', database: posRelayDb, redis, groups: [{ name: 'inventory', database: inventoryRelayDb }] });
    const consume = createInventoryStockConsumer(inventoryWorker, redis, 'b03-gateway-stock');
    expect((await inventoryWorker.query('SELECT current_user AS role')).rows).toEqual([{ role: 'inventory_wrk' }]);
    expect((await inventoryWorker.query('SELECT item_id FROM inventory.inventory_item')).rowCount).toBe(0);
    await expect(inventoryWorker.query('SELECT receipt_id FROM inventory.stock_command')).rejects.toMatchObject({ code: '42501' });
    await expect(inventoryWorker.query("UPDATE inventory.inventory_item SET name = 'blocked' WHERE false"))
      .rejects.toMatchObject({ code: '42501' });
    const itemPath = root + `/inventory/items/${itemId}`;
    const lotPath = root + `/inventory/stock-batches?itemId=${itemId}`;
    const historyPath = root + `/inventory/stock-movements?itemId=${itemId}`;
    const drainRelay = async (outbox: OutboxRelay) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await outbox.step() === 'idle') return;
      }
      throw new Error('Outbox relay did not drain');
    };
    const projectStock = async () => {
      await consume.step();
      return send('GET', itemPath, 200);
    };
    await drainRelay(relay);
    await expect.poll(projectStock, { interval: 20, timeout: 5000 }).toMatchObject({ thresholdBase: '900', expiresOn: '2026-11-21',
      stock: { rawQuantityBase: '850', usedQuantityBase: '150' } });
    expect(await send('GET', lotPath, 200)).toMatchObject({ items: [{ batchId: lot.resourceId, remainingQuantityBase: '250' }] });
    const reversal = await send('POST', root + `/pos/payments/${sale.paymentId}/reversal-quote`, 200, { kind: 'cancel' });
    const correction = await send('POST', root + `/pos/settlements/${sale.settlementId}/corrections`, 200, {
      quoteToken: reversal.quoteToken, confirmed: true,
    });
    // A separately authenticated session reads the persisted stock, lots and historical source IDs.
    ({ accessToken } = await send('POST', '/api/v1/auth/login', 200, login));
    await drainRelay(relay);
    await expect.poll(projectStock, { interval: 20, timeout: 5000 })
      .toMatchObject({ stock: { rawQuantityBase: '1000', usedQuantityBase: '0' } });
    expect(await send('GET', lotPath, 200)).toMatchObject({ items: [{ batchId: lot.resourceId, remainingQuantityBase: '400' }] });
    expect(await send('GET', historyPath, 200)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'usage', sourceId: sale.settlementId, deltaBase: '-150', menuQuantity: 1 }),
      expect.objectContaining({ kind: 'usage', sourceId: correction.resourceId, deltaBase: '150', menuQuantity: -1 }),
    ]) });
    expect(await send('GET', root + '/inventory' + forecastPath, 200)).toEqual({ ...generated, stale: true });
    await send('PUT', root + '/inventory' + forecastPath, 404, { menus: [] });

    const supplierId = randomUUID();
    const orderId = randomUUID();
    const polId = randomUUID();
    await withStoreTransaction(inventorySetup, storeId, async db => {
      await db.query("INSERT INTO inventory.supplier VALUES ($1, $2, '유제품 공급사')", [storeId, supplierId]);
      await db.query("INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on) VALUES ($1, $2, $3, '2026-11-21')",
        [storeId, orderId, supplierId]);
      await db.query(`
        INSERT INTO inventory.purchase_order_line (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
        VALUES ($1, $2, $3, $4, 2, 'L', 1000, 2400)
      `, [storeId, polId, orderId, itemId]);
    });
    const purchaseKey = randomUUID();
    const receive = async () => {
      const response = await fetch(`${inventoryUrl}/internal/v1/inventory/stores/${storeId}/receipts`, {
        method: 'POST', headers: { authorization: `Bearer ${token.inventory}`, 'x-navis-store-id': storeId,
          'x-navis-store-role': 'owner', 'x-navis-user-id': randomUUID(), 'content-type': 'application/json', 'idempotency-key': purchaseKey },
        body: JSON.stringify({ polId, qty: 1 }),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };
    const purchased = await receive();
    expect(purchased).toMatchObject({ qtyRemaining: 1 });
    expect(await receive()).toEqual(purchased);
    expect(await send('GET', itemPath, 200)).toMatchObject({ stock: { rawQuantityBase: '2000' } });
    expect(await send('GET', historyPath, 200)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'receive', sourceId: purchased.receiptId, deltaBase: '1000' }),
    ]) });
    const effects = await withStoreTransaction(inventoryDb, storeId, db => db.query<{ event_id: string }>(`
      SELECT event_id FROM inventory.outbox WHERE store_id = $1 AND event_type = 'inventory.receipt_recorded.v1' AND aggregate_id = $2
    `, [storeId, purchased.receiptId]), { readOnly: true });
    expect(effects.rowCount).toBe(1);
    const purchaseRelay = new OutboxRelay({ producer: 'inventory', database: inventoryRelayDb, redis,
      groups: [{ name: 'pos', database: posRelayDb }] });
    const purchaseConsumer = createPosReceiptConsumer(posDb, redis, 'b03-receipt-proof');
    let candidateId: string | undefined;
    await drainRelay(purchaseRelay);
    await expect.poll(async () => {
      await purchaseConsumer.step();
      const { rows } = await inPos(posDb, storeId, db => db.query<{ expense_id: string; amount: string }>(`
        SELECT expense_id, amount::text FROM pos.expense_candidate WHERE store_id = $1 AND receipt_id = $2
      `, [storeId, purchased.receiptId]), { readOnly: true });
      candidateId = rows[0]?.expense_id;
      return rows.map(row => row.amount);
    }, { interval: 20, timeout: 5000 }).toEqual(['2400']);
    const memberSettlementId = randomUUID();
    const memberSale = await inPos(posDb, storeId, async db => {
      const { rows: [{ payload }] } = await db.query<{ payload: PosSaleRecognized['payload'] }>(`
        SELECT payload FROM pos.outbox WHERE store_id = $1 AND aggregate_id = $2 AND event_type = 'pos.sale_recognized.v1'
      `, [storeId, sale.settlementId]);
      const { paymentId: _paymentId, ...recognized } = payload;
      const memberSale = {
        ...recognized,
        memberId: randomUUID(),
        settlementId: memberSettlementId,
        billId: randomUUID(),
        orderId: randomUUID(),
        lines: recognized.lines.map(line => ({ ...line, allocationId: randomUUID(), orderLineId: randomUUID() })),
      };
      await appendOutbox<PosSaleRecognized>({ db, storeId, actorId: randomUUID(), at: now() }, 'pos.sale_recognized.v1', memberSettlementId, memberSale);
      return memberSale;
    }, { write: true });
    await drainRelay(relay);
    await expect.poll(projectStock, { interval: 20, timeout: 5000 })
      .toMatchObject({ stock: { rawQuantityBase: '1850', usedQuantityBase: '150' } });
    expect(await send('GET', historyPath, 200)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'usage', sourceId: memberSettlementId, deltaBase: '-150', menuQuantity: 1 }),
    ]) });
    const memberCorrectionId = randomUUID();
    await inPos(posDb, storeId, db => appendOutbox<PosSaleCorrected>({
      db, storeId, actorId: randomUUID(), at: now(),
    }, 'pos.sale_corrected.v1', memberCorrectionId, {
      memberId: memberSale.memberId, billId: memberSale.billId, orderId: memberSale.orderId,
      settlementId: memberSale.settlementId, businessDate: memberSale.businessDate, lines: memberSale.lines,
      correctionId: memberCorrectionId, kind: 'cancel', target: 'recognized_sale', usageEffect: 'restore',
      amountDelta: -memberSale.amount, costDelta: memberSale.cost === null ? null : -memberSale.cost,
      incompleteMarginCoverage: memberSale.incompleteMarginCoverage,
    }), { write: true });
    await drainRelay(relay);
    await expect.poll(projectStock, { interval: 20, timeout: 5000 })
      .toMatchObject({ stock: { rawQuantityBase: '2000', usedQuantityBase: '0' } });
    expect(await send('GET', historyPath, 200)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'usage', sourceId: memberCorrectionId, deltaBase: '150', menuQuantity: -1 }),
    ]) });
    console.info('inventory gateway witness', JSON.stringify({
      storeId, itemId, lotId: lot.resourceId, menuId: menu.resourceId, saleId: sale.settlementId,
      correctionId: correction.resourceId, memberSettlementId, memberCorrectionId, itemReceipt: item.receiptId, lotReceipt: lot.receiptId,
      purchaseReceipt: purchased.receiptId, purchaseEventId: effects.rows[0].event_id, candidateId,
      posEventIds: (await redis.events('pos')).filter(event => event.storeId === storeId).map(event => event.eventId), requestIds,
    }));
  } finally {
    redis.close();
    try {
      await Promise.all([gateway.close(), inventory.close(), account.close(), pos.close()]);
      await inAccount(accountSetup, async db => {
        await db.query('DELETE FROM account.store WHERE store_id = $1', [storeId]);
        await db.query('DELETE FROM account.outbox_scope WHERE scope_key = $1', [storeId]);
        await db.query('DELETE FROM account.app_user WHERE email = $1', [login.loginId]);
      });
    } finally {
      await Promise.all([accountDb, accountSetup, inventoryDb, inventorySetup, inventoryWorker,
        posDb, posRelayDb, inventoryRelayDb].map(db => db.end()));
    }
  }
});
