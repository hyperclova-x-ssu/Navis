import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbConfig, dbPool } from '../../../packages/db/index.ts';
import { runMigrations } from '../../../packages/db/migrate.ts';
import type { StreamEnvelope } from '../../../packages/streams/index.ts';
import { RedisStreams } from '../../../packages/streams/redis.ts';
import { OutboxRelay, relayDbPool } from '../../../packages/streams/relay.ts';
import { createInsightApp } from '../../insight/app.ts';
import { createInsightSalesConsumer } from '../../insight/sales.ts';
import { createPosApp } from '../../pos/app.ts';
import { withStoreTransaction as inPos } from '../../pos/transaction.ts';
import { createInventoryApp } from '../app.ts';
import { saveRecipeVersion } from '../recipes.ts';
import { stockForItem } from '../stock.ts';
import { createInventoryStockConsumer } from '../stock-consumer.ts';
import { withStoreTransaction as inInventory } from '../store-transaction.ts';

const store = randomUUID();
const otherStore = randomUUID();
const menu = randomUUID();
const milk = randomUUID();
const owner = randomUUID();
const gateway = randomUUID();
const insightToken = randomUUID();
const inventoryToken = randomUUID();
const day = '2026-11-17';
const nextDay = '2026-11-18';
const nonComparableDay = '2026-11-12';
const history = ['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10'];
const model = 'weekday-4w-v1';
const forecastUrl = (targetDay = day, storeId = store) =>
  `/internal/v1/inventory/stores/${storeId}/forecasts/${targetDay}/${model}`;
const workloadHeaders = (token = inventoryToken, storeId = store) => ({
  authorization: `Bearer ${token}`, 'x-navis-store-id': storeId,
});
const ownerHeaders = (storeId = store) => ({
  ...workloadHeaders(gateway, storeId), 'x-navis-store-role': 'owner', 'x-navis-user-id': owner,
});
const fixtureClock = () => new Date('2026-11-17T19:59:59Z');
let posNow = fixtureClock();
let inventoryNow = fixtureClock();
const atHistory = (date: string) => new Date(`${date}T03:00:00Z`);
const milkRecipe = (quantityBase: number) => [{ itemId: 'milk', quantityBase, unitDimension: 'mL' }];

describe.skipIf(!process.env.NAVIS_FORECAST_TEST_REDIS_URL)('T-315 forecast with the isolated Compose test DB', () => {
  const inventoryDb = dbPool('inventory', 'runtime', 'test');
  const inventorySetup = dbPool('inventory', 'migrate', 'test');
  const insightDb = dbPool('insight', 'runtime', 'test');
  const posDb = dbPool('pos', 'runtime', 'test');
  const posSetup = dbPool('pos', 'migrate', 'test');
  const pos = createPosApp(posDb, { gatewayToken: gateway, now: () => posNow, logging: false });
  const inventory = createInventoryApp(inventoryDb, gateway, false, () => inventoryNow, inventoryToken);
  const insight = createInsightApp(insightDb, { forecastToken: insightToken, logging: false, cctvEnabled: false });
  let inventoryRelayDb: Pool;
  let posRelayDb: Pool;
  let insightBaseUrl: string;
  let inventoryBaseUrl: string;
  let redis: RedisStreams;
  let recipeVersion: string;
  const read = (targetDay = day, scopedStore = store) => inventory.inject({
    url: forecastUrl(targetDay, scopedStore), headers: ownerHeaders(scopedStore),
  });
  const put = (body: object, targetDay = day, headers = workloadHeaders()) => inventory.inject({
    method: 'PUT', url: forecastUrl(targetDay), headers, payload: body,
  });
  const generated = () => inInventory(inventoryDb, store, async db => (await db.query(`
    SELECT aggregate_id, payload, store_seq FROM inventory.outbox
    WHERE event_type = 'inventory.forecast_generated.v1' ORDER BY store_seq
  `)).rows);
  const clock = () => fixtureClock();
  async function run(now = clock, storeId = store) {
    const { runForecast } = await import('../../../workers/forecast-cron/run.ts');
    return runForecast({
      storeId, now, insight: { baseUrl: insightBaseUrl, token: insightToken },
      inventory: { baseUrl: inventoryBaseUrl, token: inventoryToken },
    });
  }

  beforeAll(async () => {
    inventoryRelayDb = relayDbPool('inventory');
    posRelayDb = relayDbPool('pos');
    for (const service of ['inventory', 'pos'] as const) {
      await runMigrations(service, fileURLToPath(new URL(`../../${service}/migrations/`, import.meta.url)), 'test');
    }
    // Insight's own suite uses this history; the migration-helper test owns schema_migrations.
    await runner({
      databaseUrl: dbConfig('insight', 'migrate', 'test'),
      dir: fileURLToPath(new URL('../../insight/migrations/', import.meta.url)),
      schema: 'insight', migrationsSchema: 'insight', migrationsTable: 't311_test_migrations',
      direction: 'up', verbose: false, log: () => {},
    });
    for (const scope of [store, otherStore]) {
      await inInventory(inventorySetup, scope, async db => {
        await db.query('INSERT INTO inventory.store (store_id) VALUES ($1)', [scope]);
        await db.query(`
          INSERT INTO inventory.business_day (store_id, business_date, starts_at, ends_at)
          SELECT $1, d, (d + time '05:00') AT TIME ZONE 'Asia/Seoul',
            ((d + 1) + time '05:00') AT TIME ZONE 'Asia/Seoul'
          FROM unnest($2::date[]) d
        `, [scope, [...history, day, nextDay]]);
      });
    }
    await inInventory(inventorySetup, store, async db => {
      await db.query(`
        INSERT INTO inventory.inventory_item (store_id, item_id, recipe_key, base_unit) VALUES ($1, $2, 'milk', 'mL')
      `, [store, milk]);
      await db.query(`
        INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status)
        VALUES ($1, $2, 'menu', 'Synthetic latte', 'drink', 4000, 'selling')
      `, [store, menu]);
      recipeVersion = await saveRecipeVersion(db, store, menu, menu, milkRecipe(260));
      await db.query(`
        INSERT INTO inventory.stock_daily_opening (store_id, business_date, item_id, channel, quantity_base)
        VALUES ($1, $2, $3, 'store', 10000)
      `, [store, history[3], milk]);
    });
    await inPos(posSetup, store, async db => {
      await db.query("INSERT INTO pos.store (store_id, display_name) VALUES ($1, 'Synthetic café')", [store]);
      await db.query(`
        INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at, seq)
        SELECT $1, d, (d + time '05:00') AT TIME ZONE 'Asia/Seoul',
          ((d + 1) + time '05:00') AT TIME ZONE 'Asia/Seoul', 0
        FROM unnest($2::date[]) d
      `, [store, [...history, nonComparableDay, day, nextDay]]);
      await db.query('INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot) VALUES ($1, $2, $3)', [store, menu, {
        name: 'Synthetic latte', basePrice: 4000, baseCost: 1100, saleStatus: 'selling', recipeVersion, groups: [],
      }]);
    }, { write: true });
    const client = createClient({ url: process.env.NAVIS_FORECAST_TEST_REDIS_URL, disableOfflineQueue: true });
    await client.connect();
    redis = new RedisStreams(client);
    [insightBaseUrl, inventoryBaseUrl] = await Promise.all([
      insight.listen({ host: '127.0.0.1', port: 0 }),
      inventory.listen({ host: '127.0.0.1', port: 0 }),
    ]);
  }, 30_000);

  afterAll(async () => {
    redis?.close();
    await Promise.all([inventory.close(), insight.close(), pos.close()]);
    await Promise.all([inventoryDb, inventorySetup, insightDb, posDb, posSetup, inventoryRelayDb, posRelayDb]
      .map(pool => pool?.end()));
  });

  it('binds forecast paths to workload identity, owner read access and store scope', async () => {
    const body = { menus: [{ menuId: menu, fourWeekQuantity: '7' }] };
    expect((await put(body, day, ownerHeaders())).statusCode).toBe(401);
    expect((await put(body, day, workloadHeaders(inventoryToken, otherStore))).statusCode).toBe(403);
    expect((await inventory.inject({ url: forecastUrl(), headers: ownerHeaders(otherStore) })).statusCode).toBe(403);
    expect((await put(body, '2026-02-30')).statusCode).toBe(400);
    expect((await put({ menus: [body.menus[0], body.menus[0]] })).statusCode).toBe(400);
    expect((await put({ menus: [{ menuId: menu, fourWeekQuantity: -1 }] })).statusCode).toBe(400);
    expect((await read()).json()).toEqual({ targetDate: day, modelVersion: model, status: 'no_data', results: [] });
  });

  it('keeps missing input retryable and resolves the target at the persisted café boundary', async () => {
    const missing = { targetDate: day, modelVersion: model, status: 'no_data', results: [] };
    expect(await run()).toEqual(missing);
    expect((await read()).json()).toEqual(missing);
    expect(await run(() => new Date('2026-11-17T20:00:00Z'))).toMatchObject({ targetDate: nextDay, status: 'no_data' });
    expect(await generated()).toHaveLength(0);
  });

  async function posPost(path: string, payload: object, key = randomUUID()) {
    const res = await pos.inject({
      method: 'POST', url: `/internal/v1/pos/stores/${store}${path}`,
      headers: { ...ownerHeaders(), 'idempotency-key': key }, payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function recognize(date: string, quantity: number) {
    posNow = atHistory(date);
    const { value: bill } = await posPost('/bills', { type: 'takeout', lines: [{ menuId: menu, qty: quantity, optionIds: [] }] });
    const key = randomUUID();
    const { value: approval } = await posPost('/approvals', {
      billId: bill.billId, quoteRevision: bill.quoteRevision, splits: [{ method: 'card', amount: 4000 * quantity }],
    }, key);
    const { value } = await posPost(`/approvals/${approval.attemptId}/finish`,
      { expectedQuoteFingerprint: approval.quoteFingerprint }, key);
    return value.paymentId as string;
  }

  it('replays POS correction, uses current recipes, and publishes once per forecast key on retry', async () => {
    await recognize(history[0], 2);
    const canceled = await recognize(history[1], 3);
    const quote = await posPost(`/payments/${canceled}/reversal-quote`, { kind: 'cancel' });
    expect(quote.stockEffect).toBe('restore');
    await posPost('/corrections', { quoteToken: quote.quoteToken, confirmed: true });
    await recognize(history[2], 3);
    await recognize(history[3], 2);
    await recognize(nonComparableDay, 50);

    const events = await inPos(posDb, store, async db => (await db.query<StreamEnvelope>(`
      SELECT producer, store_id AS "storeId", scope_key AS "scopeKey", store_seq AS "storeSeq",
        event_id AS "eventId", event_type AS "eventType", schema_version AS "schemaVersion",
        aggregate_id AS "aggregateId", to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt", payload
      FROM pos.outbox ORDER BY store_seq
    `)).rows);
    const rebuilding = await redis.beginRebuild('pos', ['insight', 'inventory']);
    expect(await redis.finishRebuild('pos', rebuilding)).toBe(true);
    const epoch = (await redis.readyEpoch('pos'))!;
    const insightConsumer = createInsightSalesConsumer(insightDb, redis, 'forecast-insight');
    const stockConsumer = createInventoryStockConsumer(inventoryDb, redis, 'forecast-stock');
    for (const event of events.slice(0, 3)) expect(await redis.append('pos', epoch, event)).toBe(true);
    await insightConsumer.step();
    expect(await run()).toMatchObject({ status: 'no_data' });
    expect(await generated()).toEqual([]);

    for (const event of [...events.slice(3), events[2]]) expect(await redis.append('pos', epoch, event)).toBe(true);
    const supplier = randomUUID();
    const po = randomUUID();
    const pol = randomUUID();
    await inInventory(inventorySetup, store, async db => {
      await saveRecipeVersion(db, store, menu, menu, milkRecipe(350));
      await db.query("INSERT INTO inventory.supplier (store_id, supplier_id, name) VALUES ($1, $2, 'Synthetic dairy')",
        [store, supplier]);
      await db.query('INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on) VALUES ($1, $2, $3, $4)',
        [store, po, supplier, history[3]]);
      await db.query(`
        INSERT INTO inventory.purchase_order_line
          (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
        VALUES ($1, $2, $3, $4, 1, 'L', 1000, 2000)
      `, [store, pol, po, milk]);
    });
    await insightConsumer.step();
    await stockConsumer.step();
    expect(await redis.pending('pos', 'insight')).toBe(0);
    expect(await redis.pending('pos', 'inventory')).toBe(0);

    const historicalStock = () => inInventory(inventoryDb, store, db => stockForItem(db, store, history[3], milk));
    expect(await historicalStock()).toMatchObject({ usedQuantityBase: '520', rawQuantityBase: '9480' });
    inventoryNow = atHistory(history[3]);
    try {
      const receipt = await inventory.inject({
        method: 'POST', url: `/internal/v1/inventory/stores/${store}/receipts`,
        headers: { ...ownerHeaders(), 'idempotency-key': randomUUID() }, payload: { polId: pol, qty: 1 },
      });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toMatchObject({ qtyRemaining: 0 });
    } finally {
      inventoryNow = fixtureClock();
    }
    const expected = [
      { scope: 'store', targetId: null, expected: '1.75' },
      { scope: 'menu', targetId: menu, expected: '1.75' },
      { scope: 'ingredient', targetId: milk, expected: '612.50' },
    ];
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatchObject({ status: 'ready', results: expected });
    expect(second).toEqual(first);
    expect((await read()).json()).toEqual(first);
    expect(await historicalStock()).toMatchObject({ usedQuantityBase: '520', rawQuantityBase: '10480' });
    const publications = await generated();
    expect(publications).toHaveLength(3);
    expect(publications.map(row => row.payload)).toEqual(expected.map(({ scope, targetId }) => ({
      storeId: store, targetDate: day, modelVersion: model, scope, targetId,
    })));
    expect(new Set(publications.map(row => row.aggregate_id)).size).toBe(3);
    const relay = new OutboxRelay({
      producer: 'inventory', database: inventoryRelayDb, redis, groups: [{ name: 'pos', database: posRelayDb }],
    });
    expect(await relay.step()).toBe('rebuilt');
    for (let publication = 0; publication < 4; publication++) expect(await relay.step()).toBe('published');
    expect(await relay.step()).toBe('idle');
    const relayed = (await redis.events('inventory')).filter(event => event.eventType === 'inventory.forecast_generated.v1');
    expect(relayed.map(event => event.aggregateId)).toEqual(publications.map(row => row.aggregate_id));
    expect((await put({ menus: [{ menuId: menu, fourWeekQuantity: '8' }] })).json()).toEqual({
      code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH',
    });
    expect(await generated()).toEqual(publications);
    expect(await run(clock, otherStore)).toMatchObject({ status: 'no_data' });
    expect((await read(day, otherStore)).json()).toMatchObject({ status: 'no_data' });
    expect((await inventoryDb.query('SELECT 1 FROM inventory.demand_forecast')).rowCount).toBe(0);
    expect(await inInventory(inventoryDb, otherStore, db =>
      db.query('SELECT 1 FROM inventory.demand_forecast'))).toMatchObject({ rowCount: 0 });
  });

  it('rolls back forecast rows when the outbox write fails and can retry the same key', async () => {
    const body = { menus: [{ menuId: menu, fourWeekQuantity: '0' }] };
    const before = await generated();
    await inventorySetup.query(`
      ALTER TABLE inventory.outbox ADD CONSTRAINT t315_outbox_write_failure
      CHECK (event_type <> 'inventory.forecast_generated.v1') NOT VALID
    `);
    try {
      expect((await put(body, nextDay)).statusCode).toBe(503);
      expect((await read(nextDay)).json()).toMatchObject({ status: 'no_data' });
      expect(await generated()).toEqual(before);
    } finally {
      await inventorySetup.query('ALTER TABLE inventory.outbox DROP CONSTRAINT t315_outbox_write_failure');
    }
    expect((await put(body, nextDay)).json()).toMatchObject({
      status: 'ready',
      results: [
        { scope: 'store', expected: '0.00' },
        { scope: 'menu', expected: '0.00' },
        { scope: 'ingredient', expected: '0.00' },
      ],
    });
    const after = await generated();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map(row => row.store_seq)).toEqual(['5', '6', '7']);
  });
});
