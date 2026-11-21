import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { dbPool, type Service } from './index.ts';
import { runMigrations } from './migrate.ts';

const sliceServices = ['account', 'inventory', 'pos', 'customer'] as const satisfies readonly Service[];

async function main(): Promise<void> {
  const [command, target, ...extra] = process.argv.slice(2);
  const selected = sliceServices.filter((service) => target === undefined || target === service);
  if ((command !== 'migrate' && command !== 'seed') || !selected.length || extra.length) {
    console.error(`Usage: npm run migrate|seed [-- ${sliceServices.join('|')}]`);
    process.exitCode = 1;
    return;
  }

  for (const service of selected) {
    const root = new URL(`../../services/${service}/`, import.meta.url);
    const entry = new URL(command === 'migrate' ? 'migrations/' : 'seed.ts', root);
    if (!existsSync(entry)) {
      console.info(`[${service}] ${command} pending service implementation`);
      continue;
    }

    if (command === 'migrate') {
      await runMigrations(service, fileURLToPath(entry));
      continue;
    }

    const { seed }: { seed: (pool: Pool) => Promise<void> } = await import(entry.href);
    const pool = dbPool(service, 'migrate');
    try {
      await seed(pool);
      console.info(`[${service}] seed complete`);
    } finally {
      await pool.end();
    }
  }
}

await main().catch(() => {
  console.error('Database command failed. Check the service migration or seed and local database state.');
  process.exitCode = 1;
});
