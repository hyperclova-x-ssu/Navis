import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { registerPlacePublication } from './place-routes.ts';
import { registerPublicationApprovals } from './publication-routes.ts';

const pool = dbPool('inventory', 'runtime', 'test');
const migrator = dbPool('inventory', 'migrate', 'test');

beforeAll(() => runMigrations('inventory', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test'), 30_000);
afterAll(async () => {
  await Promise.all([pool.end(), migrator.end()]);
});

it('requires a widget press and releases all database locks before publishing a menu item', async () => {
  const store = randomUUID();
  const id = randomUUID();
  const actor = randomUUID();
  const gatewayToken = randomUUID();
  await withStoreTransaction(migrator, store, async db => {
    await db.query('INSERT INTO inventory.store (store_id) VALUES ($1)', [store]);
    await db.query(
      "INSERT INTO inventory.menu_item (store_id, menu_id, kind, name, category, price, sale_status) VALUES ($1,$2,'menu','Coffee','drink',3900,'selling')",
      [store, id]);
  });

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let items: { name: string; price: number }[] = [];
  let writes = 0;
  const app = Fastify();
  registerPlacePublication(app, pool, gatewayToken, {
    inventory: {
      async menu() { return items; },
      async publishMenu(_scope, _approval, patch) {
        writes += 1;
        entered.resolve();
        await release.promise;
        items = [{ name: patch.name!, price: patch.price! }];
        return items;
      },
    },
    account: {
      async venue() { throw new Error('Unexpected venue read'); },
      async updateVenue() { throw new Error('Unexpected venue write'); },
    },
  });
  registerPublicationApprovals(app, pool, gatewayToken);
  const root = '/internal/v1/inventory/stores/' + store;
  const command = root + '/menu/' + id + '/place';
  const headers = {
    authorization: 'Bearer ' + gatewayToken,
    'x-navis-user-id': actor, 'x-navis-store-id': store, 'x-navis-store-role': 'owner',
  };

  try {
    const preview = await app.inject({ method: 'POST', url: command + '/preview', headers, payload: { input: {} } });
    expect(preview.statusCode).toBe(200);
    const { previewId, expectedRevision } = preview.json();
    expect(preview.json()).toMatchObject({ previewId, expectedRevision: 1, inputHash: expect.any(String),
      diff: { desired: { name: 'Coffee', price: 3900 } }, expiresAt: expect.any(String) });
    const press = (extraHeaders: Record<string, string> = {}, extra: object = {}) => app.inject({
      method: 'POST', url: root + '/approvals', headers: { ...headers, ...extraHeaders },
      payload: { stage: 'press', operation: 'place.menu.publish', resourceId: id, expectedRevision, previewId, ...extra },
    });
    const confirm = (approvalId: string, extra: object = {}) => app.inject({
      method: 'POST', url: command + '/confirm', payload: { approvalId, expectedRevision, previewId, ...extra },
      headers: { ...headers, 'idempotency-key': approvalId },
    });
    expect((await confirm(randomUUID())).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect((await press({ 'x-navis-user-id': randomUUID() })).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect((await press({}, { expectedRevision: 2 })).json()).toEqual({ code: 'STALE_REVISION' });
    const expired = (await press()).json();
    await withStoreTransaction(migrator, store, db => db.query(
      "UPDATE inventory.card_approval SET expires_at=clock_timestamp() - interval '1 second' WHERE store_id=$1 AND approval_id=$2",
      [store, expired.approvalId]));
    expect((await confirm(expired.approvalId)).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect(writes).toBe(0);
    const { approvalId } = (await press()).json();
    const duplicate = (await press()).json();
    expect((await confirm(approvalId, { input: { currentName: 'tampered' } })).json()).toEqual({ code: 'CARD_REQUIRED' });
    const confirming = confirm(approvalId);
    await Promise.race([entered.promise, confirming.then(reply => { throw new Error(reply.body); })]);
    try {
      expect((await app.inject({ url: root + '/place/menu', headers })).json()).toEqual({ items: [] });
      expect((await confirm(approvalId)).json()).toEqual({ code: 'PUBLICATION_IN_PROGRESS' });
      await withStoreTransaction(migrator, store, async db => {
        await db.query("SET LOCAL lock_timeout='1s'");
        await db.query('UPDATE inventory.menu_item SET revision=revision+1 WHERE store_id=$1 AND menu_id=$2', [store, id]);
      });
    } finally {
      release.resolve();
    }
    expect((await confirming).json()).toEqual({ code: 'STALE_REVISION' });
    expect((await confirm(approvalId)).json()).toEqual({ code: 'STALE_REVISION' });
    expect((await confirm(duplicate.approvalId)).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect(writes).toBe(1);
  } finally {
    release.resolve();
    await app.close();
  }
});
