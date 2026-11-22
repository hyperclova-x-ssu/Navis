import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { readCurrentRecipe } from '../../recipes.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { registerMenuRoutes } from './routes.ts';

const store = randomUUID();
const milk = { dbId: randomUUID(), purchase: { unitPrice: 2900, basePerUnit: 1000 } };
const token = randomBytes(32).toString('hex');
const posToken = randomBytes(32).toString('hex');
const owner = randomUUID();
const photo = randomUUID();
const run = dbPool('inventory', 'runtime', 'test');
const mig = dbPool('inventory', 'migrate', 'test');
let now = new Date('2026-11-21T06:45:00.000Z');

function service() {
  const app = createApp('inventory', async () => {}, false);
  registerMenuRoutes(app, run, token, {
    now: () => now,
    posCatalogToken: posToken,
    verifyPhoto: async ({ storeId, actorId, fileId }) => storeId === store && actorId === owner && fileId === photo,
  });
  return app;
}

const root = (storeId: string) => `/internal/v1/inventory/stores/${storeId}`;
const create = { name: `메뉴 검증용 라떼 ${randomUUID()}`, category: 'beverage', price: 4500 };
const headers = (storeId: string, actor = owner, key = randomUUID()) => ({
  authorization: `Bearer ${token}`,
  'x-navis-store-id': storeId,
  'x-navis-store-role': 'owner',
  'x-navis-user-id': actor,
  'idempotency-key': key,
});
const app = service();

beforeAll(async () => {
  await runMigrations('inventory', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  await withStoreTransaction(mig, store, async db => {
    const supplier = randomUUID();
    const order = randomUUID();
    await db.query('INSERT INTO inventory.store VALUES ($1)', [store]);
    await db.query("INSERT INTO inventory.inventory_item (store_id, item_id, base_unit) VALUES ($1, $2, 'mL')", [store, milk.dbId]);
    await db.query("INSERT INTO inventory.supplier VALUES ($1, $2, 'Test supplier')", [store, supplier]);
    await db.query("INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on) VALUES ($1, $2, $3, '2026-11-21')", [store, order, supplier]);
    await db.query(`
      INSERT INTO inventory.purchase_order_line (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price)
      VALUES ($1, $2, $3, $4, 10, 'L', $5, $6)
    `, [store, randomUUID(), order, milk.dbId, milk.purchase.basePerUnit, milk.purchase.unitPrice]);
  });
}, 30_000);

afterAll(async () => {
  await app.close();
  await Promise.all([run.end(), mig.end()]);
});

describe('store menu HTTP', () => {
  it('persists canonical categories and serves legacy drinks in the beverage filter and POS snapshot', async () => {
    const url = root(store);
    const legacy = randomUUID();
    await withStoreTransaction(mig, store, async db => {
      await db.query(`INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, seasonal, price, sale_status)
        VALUES ($1, $2, 'menu', 'Legacy autumn drink', 'drink', 'autumn', 4200, 'selling')`, [store, legacy]);
    });
    const reopened = service();
    try {
      for (const category of ['coffee', 'tea', 'beverage', 'dessert']) {
        const result = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(store),
          payload: { ...create, name: `${create.name} ${category}`, category } });
        expect(result.statusCode).toBe(201);
        const { resourceId: menuId } = result.json();
        const list = await reopened.inject({ url: `${url}/menu?category=${category}`, headers: headers(store) });
        expect(list.statusCode).toBe(200);
        expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ menuId, category, seasonal: null })]));
        if (category === 'beverage') expect(list.json().items).toEqual(expect.arrayContaining([
          expect.objectContaining({ menuId: legacy, category: 'beverage', seasonal: 'autumn' }),
        ]));
      }
      const result = await reopened.inject({ url: `${url}/catalog-snapshot?menuId=${legacy}`,
        headers: { ...headers(store), authorization: `Bearer ${posToken}` } });
      expect(result.json().items).toMatchObject([{ menuId: legacy, category: 'beverage', seasonal: 'autumn' }]);
      const invalid = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(store), payload: { ...create, category: 'seasonal' } });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await reopened.close();
    }
  });

  it('shares a scoped live catalog snapshot with authenticated POS reads only', async () => {
    const storeId = randomUUID();
    const url = root(storeId);
    const created = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(storeId), payload: create });
    const { resourceId: menuId } = created.json();
    const route = `${url}/catalog-snapshot?menuId=${menuId}&menuId=${randomUUID()}`;
    const posHeaders = { ...headers(storeId), authorization: `Bearer ${posToken}` };
    const result = await app.inject({ url: route, headers: posHeaders });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      items: [{
        menuId, name: create.name, category: create.category, basePrice: create.price, baseCost: null,
        saleStatus: 'selling', recipeVersion: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 1, groups: [],
      }], sourceRevision: 1,
    });
    expect((await app.inject({ url: route, headers: headers(storeId) })).statusCode).toBe(401);
    expect((await app.inject({ url: route, headers: { ...posHeaders, 'x-navis-store-id': store } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${url}/menu`, headers: posHeaders, payload: create })).statusCode).toBe(401);
    expect((await app.inject({ url: `${url}/catalog-snapshot?menuId=${menuId}&menuId=${menuId}`, headers: posHeaders })).statusCode).toBe(400);
  });

  it('persists a menu, options, an exact recipe and a verified photo across service instances', async () => {
    const url = root(store);
    const created = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(store), payload: create });
    expect(created.statusCode).toBe(201);
    const { resourceId: menuId, revision } = created.json();
    expect(created.json()).toMatchObject({ revision: 1, changed: true, affectedSources: expect.arrayContaining(['menu', 'pos']) });
    const groupId = randomUUID();
    const optionId = randomUUID();
    const options = await app.inject({
      method: 'PATCH', url: `${url}/menu/${menuId}/options`, headers: headers(store),
      payload: { expectedRevision: revision, groups: [{
        groupId, menuId, name: '추가 우유', required: true, options: [{
          groupId, optionId, name: '우유 추가', extraPrice: 500, extraCost: null,
          extraRecipe: [{ itemId: milk.dbId, quantityBase: 30, unitDimension: 'mL' }],
        }],
      }] },
    });
    expect(options.statusCode).toBe(200);
    const recipe = await app.inject({
      method: 'PATCH', url: `${url}/recipes`, headers: headers(store),
      payload: { menuId, expectedRevision: 2, lines: [{ itemId: milk.dbId, quantity: 0.2, unit: 'L' }] },
    });
    expect(recipe.statusCode).toBe(200);
    const patched = await app.inject({
      method: 'PATCH', url: `${url}/menu/${menuId}`, headers: headers(store),
      payload: { expectedRevision: 3, photoFileId: photo, prepMin: 4 },
    });
    expect(patched.statusCode).toBe(200);
    const reloaded = service();
    try {
      const result = await reloaded.inject({ url: `${url}/menu/${menuId}`, headers: headers(store, randomUUID()) });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      const saved = result.json();
      expect(saved).toMatchObject({
        ...create, menuId, revision: 4, photoFileId: photo, photoKey: null, prepMin: 4,
        recipeVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
        recipeLines: [{ itemId: milk.dbId, quantity: 0.2, unit: 'L' }],
        unitCost: Math.round(200 * milk.purchase.unitPrice / milk.purchase.basePerUnit),
        groups: [{ groupId, options: [{ optionId, recipeVersion: expect.stringMatching(/^[a-f0-9]{64}$/) }] }],
      });
      const current = await withStoreTransaction(run, store, (db) => db.query(`
        SELECT v.ingredients FROM inventory.recipe_current c
        JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
        WHERE c.store_id = $1 AND c.menu_id = $2 AND c.component_id = $2
      `, [store, menuId]));
      expect(current.rows[0].ingredients).toEqual([{ item_id: milk.dbId, quantity_base: 200 }]);
      const events = await withStoreTransaction(run, store, (db) => db.query(`
        SELECT aggregate_id, store_seq, payload FROM inventory.outbox
        WHERE store_id = $1 AND event_type = 'inventory.catalog_changed.v1' AND aggregate_id = $2
        ORDER BY store_seq
      `, [store, menuId]));
      expect(events.rows.map(({ payload }) => payload.revision)).toEqual([1, 2, 3, 4]);
      expect(events.rows[3].payload).toEqual({ storeId: store, menuId, revision: 4, operation: 'updated' });
      const changed = await app.inject({
        method: 'PATCH', url: `${url}/recipes`, headers: headers(store),
        payload: { menuId, expectedRevision: 4, lines: [{ itemId: milk.dbId, quantity: 250, unit: 'mL' }] },
      });
      expect(changed.statusCode).toBe(200);
      const versions = await withStoreTransaction(run, store, async (db) => {
        const snapshot = await db.query(`
          SELECT ingredients FROM inventory.recipe_version
          WHERE store_id = $1 AND menu_id = $2 AND component_id = $2 AND version = $3
        `, [store, menuId, saved.recipeVersion]);
        const current = await readCurrentRecipe(db, store, menuId, [optionId]);
        return { snapshot: snapshot.rows[0].ingredients, current };
      });
      expect(versions.snapshot).toEqual([{ item_id: milk.dbId, quantity_base: 200 }]);
      expect(versions.current).toEqual({ [milk.dbId]: '280' });
    } finally {
      await reloaded.close();
    }
  });

  it('checks owner scope, idempotency and stale revisions before committing', async () => {
    const storeId = randomUUID();
    const url = `${root(storeId)}/menu`;
    const attempt = headers(storeId);
    const req = { method: 'POST' as const, url, headers: attempt, payload: create };
    for (const context of [
      { ...attempt, authorization: 'Bearer invalid' },
      { ...attempt, 'x-navis-store-id': store },
      { ...attempt, 'x-navis-store-role': 'staff' },
      { ...attempt, 'x-navis-user-id': 'invalid' },
    ]) {
      expect([401, 403]).toContain((await app.inject({ ...req, headers: context })).statusCode);
    }
    expect((await app.inject({ url, headers: headers(storeId) })).json().items).toEqual([]);
    const attempts = await Promise.all([app.inject(req), app.inject(req)]);
    expect(attempts.map((result) => result.statusCode)).toEqual([201, 201]);
    expect(attempts[0].json()).toEqual(attempts[1].json());
    const { resourceId } = attempts[0].json();
    const mismatch = await app.inject({ ...req, payload: { ...create, price: 4600 } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toEqual({ code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH' });
    const stale = await app.inject({
      method: 'PATCH', url: `${url}/${resourceId}`, headers: headers(storeId),
      payload: { expectedRevision: 2, price: 4600 },
    });
    expect(stale.json()).toEqual({ code: 'CONFLICT', reason: 'STALE_REVISION' });
    const unchanged = await app.inject({
      method: 'PATCH', url: `${url}/${resourceId}`, headers: headers(storeId),
      payload: { expectedRevision: 1, price: create.price },
    });
    expect(unchanged.json()).toMatchObject({ changed: false, revision: 1, affectedSources: [] });
    expect(unchanged.json()).not.toHaveProperty('undoUntil');
    expect(await app.inject({ url: `${root(store)}/menu/${resourceId}`, headers: headers(store) })).toMatchObject({ statusCode: 404 });
    const list = await app.inject({ url, headers: headers(storeId) });
    expect(list.json()).toMatchObject({ items: [{ menuId: resourceId, price: create.price, revision: 1 }], nextCursor: null, sourceRevision: 1 });
    const desserts = await app.inject({ url: `${url}?category=dessert`, headers: headers(storeId) });
    expect(desserts.json()).toMatchObject({ items: [], nextCursor: null, sourceRevision: 1 });
    const second = await app.inject({
      method: 'POST', url, headers: headers(storeId),
      payload: { name: '메뉴 검증용 마들렌', category: 'dessert', price: 3000 },
    });
    const firstPage = await app.inject({ url: `${url}?limit=1`, headers: headers(storeId) });
    const { nextCursor, items } = firstPage.json();
    expect(nextCursor).toBe(items[0].menuId);
    const nextPage = await app.inject({ url: `${url}?limit=1&cursor=${nextCursor}`, headers: headers(storeId) });
    expect(nextPage.json().nextCursor).toBeNull();
    expect([items[0].menuId, nextPage.json().items[0].menuId].sort()).toEqual([resourceId, second.json().resourceId].sort());
  });

  it('archives and restores through the visible owner receipt and enforces expiry', async () => {
    const storeId = randomUUID();
    const url = root(storeId);
    const created = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(storeId), payload: create });
    const { resourceId } = created.json();
    const itemUrl = `${url}/menu/${resourceId}`;
    const archived = await app.inject({ method: 'DELETE', url: itemUrl, headers: headers(storeId), payload: { expectedRevision: 1 } });
    expect(archived.statusCode).toBe(200);
    const { receiptId, undoUntil } = archived.json();
    expect((await app.inject({ url: itemUrl, headers: headers(storeId) })).statusCode).toBe(404);
    const undo = `${url}/receipts/${receiptId}/undo`;
    expect((await app.inject({ method: 'POST', url: undo, headers: headers(storeId, randomUUID()), payload: {} })).statusCode).toBe(404);
    const applied = await app.inject({ method: 'POST', url: undo, headers: headers(storeId), payload: {} });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ resourceId, revision: 3, changed: true });
    expect((await app.inject({ url: itemUrl, headers: headers(storeId) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: undo, headers: headers(storeId), payload: {} })).json())
      .toEqual({ code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE' });
    const later = await app.inject({
      method: 'PATCH', url: itemUrl, headers: headers(storeId), payload: { expectedRevision: 3, price: 4800 },
    });
    now = new Date(undoUntil);
    try {
      expect((await app.inject({
        method: 'POST', url: `${url}/receipts/${later.json().receiptId}/undo`, headers: headers(storeId), payload: {},
      })).json()).toEqual({ code: 'CONFLICT', reason: 'UNDO_EXPIRED' });
      expect((await app.inject({ url: itemUrl, headers: headers(storeId) })).json().price).toBe(4800);
    } finally {
      now = new Date('2026-11-21T06:45:00.000Z');
    }
  });

  it('rejects improperly scoped ingredients, fractional base units, empty required groups and foreign photos', async () => {
    const url = root(randomUUID());
    const storeId = url.split('/').at(-1)!;
    const created = await app.inject({ method: 'POST', url: `${url}/menu`, headers: headers(storeId), payload: create });
    const { resourceId: menuId } = created.json();
    for (const [itemUrl, payload, code, reason] of [
      [`${url}/recipes`, { menuId, lines: [{ itemId: milk.dbId, quantity: 1, unit: 'mL' }] }, 404, 'ITEM_NOT_FOUND'],
      [`${url}/recipes`, { menuId, lines: [{ itemId: milk.dbId, quantity: 0.5, unit: 'mL' }] }, 400, 'UNIT_MISMATCH'],
      [`${url}/menu/${menuId}/options`, { groups: [{ groupId: randomUUID(), menuId, name: '필수', required: true, options: [] }] }, 400, 'REQUIRED_GROUP_EMPTY'],
      [`${url}/menu/${menuId}`, { photoFileId: photo }, 404, 'PHOTO_NOT_FOUND'],
    ] as const) {
      const failed = await app.inject({
        method: 'PATCH', url: itemUrl, headers: headers(storeId), payload: { ...payload, expectedRevision: 1 },
      });
      expect(failed.statusCode).toBe(code);
      expect(failed.json()).toMatchObject({ reason });
    }
    const item = await app.inject({ url: `${url}/menu/${menuId}`, headers: headers(storeId) });
    expect(item.json()).toMatchObject({ revision: 1, photoFileId: null, groups: [], recipeLines: [] });
  });
});
