import assert from 'node:assert/strict';
import * as seed from '../../packages/db/seed-context.ts';

const [mode, instant, variant, ...extra] = process.argv.slice(2);
if (mode === undefined) {
  assert.equal(typeof seed.resolveHostedSeedClock, 'function', 'Navis and Persona share an explicit hosted seed instant');
  const active = '2026-11-22T04:59:59+09:00';
  const context = seed.createSeedContext(seed.resolveHostedSeedClock({ instant: active, endDate: '2026-11-22' }));
  assert.equal(context.end, '2026-11-22');
  assert.equal(context.businessDate, '2026-11-21');
  assert.equal(context.days, 90);
  assert.throws(() => seed.resolveHostedSeedClock({ instant: active, endDate: '2026-11-21' }), /conflicts/);
  assert.throws(() => seed.resolveHostedSeedClock({ instant: '2026-11-22T05:00:00' }), /timezone-qualified/);
  assert.throws(() => seed.resolveHostedSeedClock({ instant: '2026-02-30T05:00:00+09:00' }), /timezone-qualified/);
  const pinned = seed.createSeedContext(seed.resolveHostedSeedClock({ endDate: '2026-11-22' }));
  assert.equal(pinned.end, '2026-11-22');
  assert.equal(pinned.businessDate, '2026-11-22');
  console.info('PASS shared hosted seed instant and 05:00 cutoff, plus standalone D-346 pin compatibility');
} else {
  assert.ok(['--install-replay', '--verify-replay'].includes(mode) && instant && !extra.length,
    'Pass --install-replay or --verify-replay followed by INSTANT [VARIANT]');
  assert.equal(process.env.NAVIS_DISPOSABLE_REPLAY_SEED, '1');
  assert.equal(process.env.NAVIS_DB_HOST, 'db', 'Use the disposable Compose DB service');
  const { dbPool } = await import('../../packages/db/index.ts');
  const { personaPool, personaTransaction } = await import('../../services/naver-virtual/db.ts');
  const { createPersonaSeedContext, seedPersona } = await import('../../services/naver-virtual/seed.ts');
  const { loadPersonaCapabilities } = await import('../../services/naver-virtual/app.ts');
  const scenario = seed.createReplaySeedContext({ instant, variant });
  const persona = createPersonaSeedContext(scenario.now, scenario);
  const [{ seed: accountSeed }, { seed: inventorySeed }, { seed: posSeed }] = await Promise.all([
    import('../../services/account/seed.ts'), import('../../services/inventory/seed.ts'), import('../../services/pos/seed.ts'),
  ]);
  const [account, inventory, pos] = ['account', 'inventory', 'pos'].map(name => dbPool(name, 'migrate'));
  const virtual = personaPool('migrate');
  try {
    if (mode === '--install-replay') {
      const { transaction } = await import('../../services/account/transaction.ts');
      await transaction(account, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('navis:disposable-replay-seed'))");
        const existing = await client.query('SELECT 1 FROM account.store LIMIT 1');
        assert.equal(existing.rowCount, 0, 'Each replay variant requires a fresh database volume');
        await accountSeed(account, scenario);
        await inventorySeed(inventory, scenario);
        await posSeed(pos, scenario);
        await seedPersona(virtual, await loadPersonaCapabilities(), persona);
      });
    }
    const { withStoreTransaction: inInventory } = await import('../../services/inventory/store-transaction.ts');
    const { withStoreTransaction: inPos } = await import('../../services/pos/transaction.ts');
    const [store] = scenario.rows.store;
    const owner = await account.query(
      'SELECT role FROM account.store_member WHERE store_id = $1', [store.store_id]);
    assert.deepEqual(owner.rows, [{ role: 'owner' }]);
    const archived = await inInventory(inventory, store.store_id, db => db.query(
      'SELECT menu_id FROM inventory.menu_item WHERE store_id = $1 AND deleted_at IS NOT NULL', [store.store_id]));
    assert.deepEqual(archived.rows.map(row => row.menu_id), scenario.archivedMenuIds);
    const projected = await inPos(pos, store.store_id, db => db.query(
      'SELECT menu_id FROM pos.catalog_menu WHERE store_id = $1 AND menu_id = ANY($2::uuid[])',
      [store.store_id, scenario.archivedMenuIds]));
    assert.equal(projected.rowCount, 0);
    for (const [schema, pool, inStore] of [['inventory', inventory, inInventory], ['pos', pos, inPos]]) {
      const days = await inStore(pool, store.store_id, db => db.query(
        `SELECT business_date::text FROM ${schema}.business_day WHERE store_id = $1`, [store.store_id]));
      assert.deepEqual(days.rows, [{ business_date: scenario.businessDate }]);
    }
    const generation = await personaTransaction(virtual, persona.accountId, db => db.query(
      'SELECT generation_at FROM naver_virtual.seed_generation WHERE account_id = $1', [persona.accountId]));
    assert.equal(generation.rows[0].generation_at.toISOString(), scenario.now.toISOString());
    const place = await personaTransaction(virtual, persona.accountId, db => db.query(
      'SELECT menu FROM naver_virtual.pn01_place WHERE account_id = $1', [persona.accountId]));
    const activeMenu = scenario.rows.menu_item.filter(row => row.deleted_at === null)
      .map(({ name, price }) => ({ name, price }));
    assert.deepEqual(place.rows[0].menu, activeMenu);
    console.info(`PASS replay setup ${variant ?? 'café'}: ${scenario.end}, business date ${scenario.businessDate}`);
  } finally {
    await Promise.all([account.end(), inventory.end(), pos.end(), virtual.end()]);
  }
}
