import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { dbPool, fileSecret, requiredEnv, services } from './index.ts';
import { runMigrations } from './migrate.ts';
import { createSeedContext, disposableReplaySeedContext, resolveHostedSeedClock, type SeedContext } from './seed-context.ts';

const fixture = {
  storeId: 'c05409a6-f082-5964-a787-c1ed3184988b',
  cameraId: '40e3a9dc-71bd-4d6a-9990-d78f0eb4fb8a',
  deviceId: '1193f81c-7593-4644-a9bc-04bc9e2fbd22',
  zoneId: '9132a338-9403-4b27-aaf1-96fb595cb9ed',
};

async function main(): Promise<void> {
  const [command, target, ...extra] = process.argv.slice(2);
  if (command === 'provision-owner' && !target) {
    const { provisionOwner } = await import('../../services/account/reality/00/provision.ts');
    const pool = dbPool('account', 'migrate');
    try {
      await provisionOwner(pool, JSON.parse(fileSecret('NAVIS_OWNER_PROVISION_FILE')));
      console.info('[account] owner and store provisioning complete');
    } finally { await pool.end(); }
    return;
  }
  const selected = services.filter((service) => target === undefined || target === service);
  const hostedDemo = command === 'seed-hosted-demo';
  if ((command !== 'migrate' && command !== 'seed' && !hostedDemo) || !selected.length || extra.length) {
    console.error(`Usage: cli.ts migrate|seed|seed-hosted-demo [${services.join('|')}] or cli.ts provision-owner`);
    process.exitCode = 1;
    return;
  }
  if (hostedDemo) {
    if (process.env.NAVIS_HOSTED_DEMO_SEED !== '1') {
      console.error('Hosted demo seed requires NAVIS_HOSTED_DEMO_SEED=1');
      process.exitCode = 1;
      return;
    }
    requiredEnv('NAVIS_DB_HOST');
  }
  const seedCamera = command !== 'migrate' && selected.includes('insight')
    && (hostedDemo || process.env.NAVIS_PHASE3_FIXTURES === '1');
  const cameraToken = seedCamera ? fileSecret('NAVIS_FIXTURE_CCTV_TOKEN_FILE') : undefined;
  const instant = process.env.NAVIS_NAVER_VIRTUAL_SEED_INSTANT;
  const seedContext = command === 'migrate' ? undefined : hostedDemo
    ? createSeedContext(resolveHostedSeedClock({ instant, endDate: process.env.NAVIS_HOSTED_DEMO_SEED_END_DATE }))
    : disposableReplaySeedContext() ?? (instant ? createSeedContext(resolveHostedSeedClock({ instant })) : createSeedContext());
  if (seedContext) {
    console.info(`[seed] Seoul range ${seedContext.start} to ${seedContext.end} (${seedContext.days} days), business date ${seedContext.businessDate}, cutoff ${seedContext.cutoff}`);
  }

  for (const service of selected) {
    const root = new URL(`../../services/${service}/`, import.meta.url);
    if (service === 'insight' && cameraToken) {
      const { registerCamera } = await import('../../services/insight/cctv.ts');
      const pool = dbPool(service, 'migrate');
      try {
        await registerCamera(pool, { ...fixture, zoneRevision: 1, zoneIds: [fixture.zoneId],
          token: cameraToken, expiresAt: new Date('2099-01-01T00:00:00Z') });
        console.info('[insight] demo camera seed complete');
      } finally { await pool.end(); }
    }
    const entry = new URL(command === 'migrate' ? 'migrations/' : 'seed.ts', root);
    if (!existsSync(entry)) {
      console.info(`[${service}] no ${command} files`);
      continue;
    }

    if (command === 'migrate') {
      await runMigrations(service, fileURLToPath(entry));
      continue;
    }

    const { seed }: { seed: (pool: Pool, context?: SeedContext) => Promise<void> } = await import(entry.href);
    const pool = dbPool(service, 'migrate');
    try {
      await seed(pool, seedContext);
      if (service === 'account') {
        const { seedCafePromoPhotos } = await import('./promo-cafe.ts');
        const { seedCafeMenuPhotos } = await import('../../services/inventory/reality/01/menu-photo-seed.ts');
        await seedCafePromoPhotos(pool);
        await seedCafeMenuPhotos(pool);
      }
      if (service === 'inventory') {
        const { demoIdentity } = await import('../../services/account/identity.ts');
        const { withStoreTransaction } = await import('../../services/inventory/store-transaction.ts');
        const { houseBlendProductNo } = await import('../../services/naver-virtual/capabilities/pn16/data.ts');
        await withStoreTransaction(pool, demoIdentity.storeId, client => client.query(`
          INSERT INTO inventory.commerce_link (store_id, item_id, origin_product_no)
          SELECT store_id, item_id, $2 FROM inventory.inventory_item
          WHERE store_id = $1 AND recipe_key = 'i-bean-house' AND archived_at IS NULL
          ON CONFLICT DO NOTHING`, [demoIdentity.storeId, houseBlendProductNo]));
      }
      console.info(`[${service}] seed complete`);
    } catch (error) {
      const databaseError = error as { code?: string; table?: string; constraint?: string };
      console.error(`[${service}] seed failed`, {
        code: databaseError.code, table: databaseError.table, constraint: databaseError.constraint,
      });
      throw error;
    } finally {
      await pool.end();
    }
  }
}

await main().catch(() => {
  console.error('Database command failed. Check the service migration or seed and local database state.');
  process.exitCode = 1;
});
