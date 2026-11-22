import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadPersonaCapabilities, type PersonaCapability } from './app.ts';
import { PERSONA_MAINTENANCE_LOCK, personaPool, personaTransaction } from './db.ts';

export type PersonaMigration = { id: string; up: string; down: string };

const foundation: PersonaMigration = {
  id: 'foundation',
  up: `
    CREATE TABLE naver_virtual.seed_generation (
      account_id text PRIMARY KEY,
      generation_at timestamptz NOT NULL
    );
    CREATE TABLE naver_virtual.seed_revision (
      account_id text NOT NULL REFERENCES naver_virtual.seed_generation(account_id),
      capability text NOT NULL,
      generation_at timestamptz NOT NULL,
      PRIMARY KEY (account_id, capability)
    );
    CREATE TABLE naver_virtual.effect_journal (
      account_id text NOT NULL REFERENCES naver_virtual.seed_generation(account_id),
      operation text NOT NULL,
      attempt_key text NOT NULL,
      fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
      resource_ref text,
      PRIMARY KEY (account_id, operation, attempt_key)
    );
    ALTER TABLE naver_virtual.seed_generation ENABLE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.seed_revision ENABLE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.effect_journal ENABLE ROW LEVEL SECURITY;
    CREATE POLICY seed_account ON naver_virtual.seed_generation FOR SELECT TO nvirtual_run
      USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
    CREATE POLICY revision_account ON naver_virtual.seed_revision FOR SELECT TO nvirtual_run
      USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
    CREATE POLICY effect_account ON naver_virtual.effect_journal TO nvirtual_run
      USING (account_id = (SELECT current_setting('app.persona_account_id', true)))
      WITH CHECK (account_id = (SELECT current_setting('app.persona_account_id', true)));
    GRANT SELECT ON naver_virtual.seed_generation, naver_virtual.seed_revision TO nvirtual_run;
    GRANT SELECT, INSERT, UPDATE (resource_ref) ON naver_virtual.effect_journal TO nvirtual_run;
  `,
  down: `DROP TABLE naver_virtual.effect_journal, naver_virtual.seed_revision, naver_virtual.seed_generation`,
};

export function listPersonaMigrations(capabilities: readonly PersonaCapability[]): PersonaMigration[] {
  const entries = [foundation, ...capabilities.flatMap(capability => (capability.migrations ?? []).map(migration => ({
    ...migration, id: `${capability.id}:${migration.id}`,
  })))];
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate persona migration ID');
  return entries;
}

export async function migratePersona(
  pool: Pool, capabilities: readonly PersonaCapability[], direction: 'up' | 'down' = 'up',
): Promise<void> {
  const migrations = listPersonaMigrations(capabilities);
  await personaTransaction(pool, undefined, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [PERSONA_MAINTENANCE_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS naver_virtual.schema_migrations (
      id text PRIMARY KEY,
      applied_order bigint GENERATED ALWAYS AS IDENTITY
    )`);
    await client.query('GRANT SELECT (id) ON naver_virtual.schema_migrations TO nvirtual_run');
    const applied = await client.query<{ id: string }>('SELECT id FROM naver_virtual.schema_migrations ORDER BY applied_order DESC');
    if (direction === 'down') {
      const latest = applied.rows[0];
      if (!latest) return;
      const migration = migrations.find(entry => entry.id === latest.id);
      if (!migration) throw new Error('Latest persona migration is unavailable in this build');
      await client.query(migration.down);
      if (migration.id !== foundation.id) {
        const capability = migration.id.split(':', 1)[0];
        await client.query('DELETE FROM naver_virtual.seed_revision WHERE capability = $1', [capability]);
      }
      await client.query('DELETE FROM naver_virtual.schema_migrations WHERE id = $1', [migration.id]);
      return;
    }
    const appliedIds = new Set(applied.rows.map(row => row.id));
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) continue;
      await client.query(migration.up);
      await client.query('INSERT INTO naver_virtual.schema_migrations (id) VALUES ($1)', [migration.id]);
    }
  });
}

async function main(): Promise<void> {
  const [direction = 'up', ...extra] = process.argv.slice(2);
  if ((direction !== 'up' && direction !== 'down') || extra.length) throw new Error('Expected up or down');
  const pool = personaPool('migrate');
  try { await migratePersona(pool, await loadPersonaCapabilities(), direction); } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    console.error('Persona NAVER migration failed');
    process.exitCode = 1;
  });
}
