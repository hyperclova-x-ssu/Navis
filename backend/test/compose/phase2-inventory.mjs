import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const backend = fileURLToPath(new URL('../../', import.meta.url));
const dbService = 'inventory-test-db';
const redisService = 'inventory-test-redis';
const toolsService = 'inventory-test-tools';
const override = `
services:
  ${dbService}:
    extends: { file: compose.yaml, service: streams-test-db }
  ${redisService}:
    extends: { file: compose.yaml, service: streams-test-redis }
  ${toolsService}:
    extends: { file: compose.yaml, service: streams-tools }
    environment:
      NAVIS_DB_HOST: ${dbService}
      NAVIS_REDIS_URL: redis://${redisService}:6379
`;

function compose(...args) {
  return execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'navis-backend-local',
    '-f', 'compose.yaml', '-f', '-', '--profile', 'streams-test', ...args], {
    input: override, cwd: backend, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  });
}

if (process.argv[2] === 'inside') {
  await runInContainer();
} else {
  const mounts = ['services/inventory', 'workers/pos-receipts', 'test/compose'].flatMap((dir) => [
    '-v', `${join(backend, dir)}:/app/backend/${dir}:ro`,
  ]);
  const run = (...args) => compose('run', '-T', '--rm', '--pull', 'never', ...mounts, toolsService, ...args);
  try {
    compose('up', '-d', '--pull', 'never', '--no-deps', '--wait', dbService, redisService);
    for (const service of ['inventory', 'pos']) {
      run('npm', 'run', 'migrate', '--', service);
      run('npm', 'run', 'seed', '--', service);
    }
    compose('exec', '-T', dbService, '/docker-entrypoint-initdb.d/20-stream-access.sh');
    process.stdout.write(run('node', 'test/compose/phase2-inventory.mjs', 'inside'));
  } finally {
    compose('rm', '-sf', dbService, redisService);
  }
}

async function runInContainer() {
  const { seedCatalog } = await import('../../../frontend/src/data/db/generated/catalog.ts');
  const { dbPool } = await import('../../packages/db/index.ts');
  const { createInventoryApp } = await import('../../services/inventory/app.ts');
  const { createPosApp } = await import('../../services/pos/app.ts');
  const { withStoreTransaction } = await import('../../services/inventory/store-transaction.ts');
  const { storeId } = seedCatalog.store;
  const { dbId: menuId, groups } = seedCatalog.menu.find((menu) => menu.menuId === 'm-cafe-latte');
  const { optionId } = groups[0].options[0];
  const { dbId: milkId } = seedCatalog.items.find((item) => item.itemId === 'i-milk');
  const { dbId: supplierId } = seedCatalog.suppliers.find((supplier) => supplier.supplierId === 's-dairy');
  const businessDate = '2026-11-17';
  const now = () => new Date('2026-11-17T06:45:00Z');
  const inventoryDb = dbPool('inventory');
  const inventorySetup = dbPool('inventory', 'migrate');
  const posDb = dbPool('pos');
  const posSetup = dbPool('pos', 'migrate');
  const token = randomUUID();
  const inventoryApp = createInventoryApp(inventoryDb, token, false, now);
  const posApp = createPosApp(posDb, { gatewayToken: token, now, logging: false });
  const headers = {
    authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
    'x-navis-store-role': 'owner', 'x-navis-user-id': randomUUID(),
  };
  const receiptPath = `/internal/v1/inventory/stores/${storeId}/receipts`;
  const request = async (app, path, payload, key = randomUUID(), requestHeaders = headers) => {
    const address = app.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { ...requestHeaders, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    return { statusCode: response.status, body, json: () => JSON.parse(body) };
  };
  const inv = (payload, key, requestHeaders) => request(inventoryApp, receiptPath, payload, key, requestHeaders);
  const pos = async (path, body, key) => {
    const response = await request(posApp, `/internal/v1/pos/stores/${storeId}${path}`, body, key);
    assert.equal(response.statusCode, 200, `POS ${path}: ${response.body}`);
    return response.json();
  };
  const inventory = (read) => withStoreTransaction(inventoryDb, storeId, read);
  const inventoryFixture = (write) => withStoreTransaction(inventorySetup, storeId, write);
  const posFixture = (write) => withStoreTransaction(posSetup, storeId, write);
  const redis = [];
  const relayPools = [];

  try {
    await Promise.all([inventoryApp, posApp].map(app => app.listen({ host: '127.0.0.1', port: 0 })));
    const { statusCode } = await inv({ polId: randomUUID(), qty: 1 }, undefined, { ...headers, authorization: 'Bearer invalid' });
    assert.equal(statusCode, 401, 'receipt write requires the verified gateway credential');
    assert.equal((await inv({ polId: randomUUID(), qty: 1 }, undefined,
      { ...headers, 'x-navis-store-id': randomUUID() })).statusCode, 403);
    console.log('ok 1 - receipt authorization');

    const { createInventoryStockConsumer } = await import('../../services/inventory/stock-consumer.ts');
    const { saveRecipeVersion, readCurrentRecipe } = await import('../../services/inventory/recipes.ts');
    const { stockForItem } = await import('../../services/inventory/stock.ts');
    const { createPosReceiptConsumer } = await import('../../workers/pos-receipts/consumer.ts');
    const { connectStreams } = await import('../../packages/streams/index.ts');
    const { OutboxRelay, relayDbPool } = await import('../../packages/streams/relay.ts');

    for (const identity of ['relay', 'inventory', 'pos']) redis.push(await connectStreams(identity));
    const [relayRedis, stockRedis, receiptRedis] = redis;
    for (const service of ['pos', 'inventory', 'customer']) relayPools.push(relayDbPool(service));
    const [posRelayDb, inventoryRelayDb, customerRelayDb] = relayPools;
    const posRelay = new OutboxRelay({ producer: 'pos', database: posRelayDb, redis: relayRedis,
      groups: [{ name: 'inventory', database: inventoryRelayDb }, { name: 'customer', database: customerRelayDb }] });
    const inventoryRelay = new OutboxRelay({ producer: 'inventory', database: inventoryRelayDb, redis: relayRedis,
      groups: [{ name: 'pos', database: posRelayDb }] });
    const stockConsumer = createInventoryStockConsumer(inventoryDb, stockRedis, 'inventory-acceptance');
    const receiptConsumer = createPosReceiptConsumer(posDb, receiptRedis, 'receipts-acceptance');
    const repeatPosEffect = async (event) => {
      await posFixture(db => db.query(`
        WITH sequence AS (
          UPDATE pos.outbox_scope SET last_seq = last_seq + 1 WHERE store_id = $1 RETURNING last_seq
        )
        INSERT INTO pos.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
        SELECT $3, store_id, scope_key, last_seq, event_type, aggregate_id, occurred_at, payload
        FROM pos.outbox CROSS JOIN sequence WHERE store_id = $1 AND event_id = $2
      `, [storeId, event.eventId, randomUUID()]));
      assert.equal(await posRelay.step(), 'published');
      assert.ok(await stockConsumer.step());
    };
    const replay = async (event, consumer, newIdentity = {}) => {
      const epoch = await relayRedis.readyEpoch(event.producer);
      assert.ok(epoch);
      assert.equal(await relayRedis.append(event.producer, epoch, { ...event, ...newIdentity }), true);
      assert.ok(await consumer.step());
    };

    const poId = randomUUID();
    const polId = randomUUID();
    const otherLine = randomUUID();
    await inventoryFixture(async (db) => {
      await db.query(`UPDATE inventory.stock_daily_opening SET quantity_base = 10000
        WHERE store_id = $1 AND business_date = $2 AND item_id = $3 AND channel = 'store'`, [storeId, businessDate, milkId]);
      await db.query(`INSERT INTO inventory.stock_movement (store_id, movement_id, item_id, business_date, kind, delta_base, channel, at)
        VALUES ($1, $2, $3, $4, 'adjust', -100, 'store', $5)`, [storeId, randomUUID(), milkId, businessDate, now()]);
      await db.query(`INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on)
        VALUES ($1, $2, $3, $4)`, [storeId, poId, supplierId, businessDate]);
      await db.query(`INSERT INTO inventory.purchase_order_line
        (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
        VALUES ($1, $2, $4, $5, 10, 'L', 1000, 2300), ($1, $3, $4, $5, 1, 'L', 1000, 2300)`,
      [storeId, polId, otherLine, poId, milkId]);
    });

    const milkRecipe = (quantityBase) => [{ itemId: 'i-milk', quantityBase, unitDimension: 'mL' }];
    const saleOptionVersion = await inventoryFixture(db => saveRecipeVersion(db, storeId, menuId, optionId, milkRecipe(40)));
    await posFixture(db => db.query(`UPDATE pos.catalog_menu
      SET snapshot = jsonb_set(snapshot, '{groups,0,options,0,recipeVersion}', to_jsonb($3::text))
      WHERE store_id = $1 AND menu_id = $2`, [storeId, menuId, saleOptionVersion]));
    const { value: bill } = await pos('/bills', { type: 'takeout', lines: [{ menuId, qty: 2, optionIds: [optionId] }] });
    const key = randomUUID();
    const { value: approval } = await pos('/approvals', {
      billId: bill.billId, quoteRevision: bill.quoteRevision, splits: [{ method: 'card', amount: 7600 }],
    }, key);
    const { value: sale } = await pos(`/approvals/${approval.attemptId}/finish`,
      { expectedQuoteFingerprint: approval.quoteFingerprint }, key);
    const stock = () => inventory(db => stockForItem(db, storeId, businessDate, milkId));
    const assertStock = async (used, raw) => assert.deepEqual(await stock(), {
      usedQuantityBase: String(used), rawQuantityBase: String(raw),
      availableQuantityBase: String(Math.max(0, raw)), deficitQuantityBase: String(Math.max(0, -raw)),
    });

    await inventoryFixture(async (db) => {
      await saveRecipeVersion(db, storeId, menuId, menuId, milkRecipe(350));
      await saveRecipeVersion(db, storeId, menuId, optionId, milkRecipe(70));
    });
    assert.deepEqual(await inventory(db => readCurrentRecipe(db, storeId, menuId, [optionId])), {
      [milkId]: '420',
    });
    assert.equal(await posRelay.step(), 'rebuilt');
    assert.equal(await posRelay.step(), 'published');
    assert.ok(await stockConsumer.step());
    await assertStock(600, 9300);
    console.log('ok 2 - delayed sale uses original base and option recipes after edit');

    const [saleEvent] = await relayRedis.events('pos');
    await replay(saleEvent, stockConsumer);
    await assertStock(600, 9300);
    await repeatPosEffect(saleEvent);
    await assertStock(600, 9300);
    console.log('ok 3 - sale transport and settlement identity redelivery');

    const cancel = await pos(`/payments/${sale.paymentId}/reversal-quote`, {
      kind: 'cancel', lines: [{ orderLineId: bill.lines[0].orderLineId, qty: 1 }],
    });
    await pos('/corrections', { quoteToken: cancel.quoteToken, confirmed: true });
    assert.equal(await posRelay.step(), 'published');
    assert.ok(await stockConsumer.step());
    await assertStock(300, 9600);
    const correction = (await relayRedis.events('pos')).find((event) => event.eventType === 'pos.sale_corrected.v1');
    await replay(correction, stockConsumer);
    await repeatPosEffect(correction);
    await assertStock(300, 9600);
    console.log('ok 4 - partial cancellation restores original usage once');

    await pos(`/orders/${sale.orderIds[0]}/preparation`, { status: 'completed' });
    const refund = await pos(`/payments/${sale.paymentId}/reversal-quote`, { kind: 'refund', amount: 500 });
    await pos('/corrections', { quoteToken: refund.quoteToken, confirmed: true });
    assert.equal(await posRelay.step(), 'published');
    assert.ok(await stockConsumer.step());
    await assertStock(300, 9600);
    console.log('ok 5 - prepared-goods refund keeps physical usage');

    const input = { polId, qty: 3 };
    const receiptKey = randomUUID();
    await inventorySetup.query('ALTER TABLE inventory.outbox ADD CONSTRAINT reject_fixture_write CHECK (false) NOT VALID');
    assert.equal((await inv(input, receiptKey)).statusCode, 503);
    await assertStock(300, 9600);
    await inventorySetup.query('ALTER TABLE inventory.outbox DROP CONSTRAINT reject_fixture_write');
    console.log('ok 6 - outbox failure rolls back receipt, movement and sequence');
    const [first, retried] = await Promise.all([inv(input, receiptKey), inv(input, receiptKey)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(retried.statusCode, 200, retried.body);
    const receipt = first.json();
    assert.deepEqual(retried.json(), receipt);
    assert.equal(receipt.qtyRemaining, 7);
    const mismatch = await inv({ ...input, qty: 2 }, receiptKey);
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().reason, 'IDEMPOTENCY_MISMATCH');
    assert.equal((await inv({ ...input, qty: 8 })).statusCode, 409);
    await assertStock(300, 12600);
    const count = (db, table) => db.query(`SELECT count(*)::int AS n FROM ${table}`).then(result => result.rows[0].n);
    assert.equal(await inventory(db => count(db, 'inventory.goods_receipt')), 1);
    assert.equal(await inventory(db => count(db, 'inventory.stock_movement')), 2);
    assert.equal(await inventory(db => count(db, 'inventory.outbox')), 1);
    assert.equal(await count(inventoryDb, 'inventory.stock_movement'), 0);
    console.log('ok 7 - concurrent receipt replay, stock, order balance and tenant scope');

    assert.equal(await inventoryRelay.step(), 'rebuilt');
    assert.equal(await inventoryRelay.step(), 'published');
    assert.ok(await receiptConsumer.step());
    const [receiptEvent] = await relayRedis.events('inventory');
    await replay(receiptEvent, receiptConsumer);
    await replay(receiptEvent, receiptConsumer, { storeSeq: '2', eventId: randomUUID() });
    const candidates = await withStoreTransaction(posDb, storeId, async (db) => (await db.query(
      `SELECT receipt_id AS "receiptId", supplier_id AS "supplierId", amount::text FROM pos.expense_candidate`,
    )).rows);
    assert.deepEqual(candidates, [{ receiptId: receipt.receiptId, supplierId, amount: '6900' }]);
    console.log('ok 8 - receipt redelivery creates one POS expense candidate using order-time price');
  } finally {
    await Promise.all([inventoryApp.close(), posApp.close()]);
    for (const connection of redis) connection.close();
    await Promise.all([inventoryDb, inventorySetup, posDb, posSetup, ...relayPools].map(pool => pool.end()));
  }
}
