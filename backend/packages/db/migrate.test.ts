import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { dbPool } from './index.ts';
import { runMigrations } from './migrate.ts';

it('records SQL migrations in the service schema and supports a retry and rollback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navis-migrations-'));
  const pool = dbPool('insight', 'migrate', 'test');
  try {
    await writeFile(join(dir, '20261120000000_probe.sql'), `
-- Up Migration
CREATE TABLE insight.t302_migration_probe (id integer PRIMARY KEY);

-- Down Migration
DROP TABLE insight.t302_migration_probe;
`);
    await runMigrations('insight', dir, 'test');
    await runMigrations('insight', dir, 'test');
    const applied = await pool.query('SELECT name FROM insight.schema_migrations');
    expect(applied.rows).toEqual([{ name: '20261120000000_probe' }]);
    await runMigrations('insight', dir, 'test', 'down');
    const rolledBack = await pool.query("SELECT to_regclass('insight.t302_migration_probe') AS probe");
    expect(rolledBack.rows).toEqual([{ probe: null }]);
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
