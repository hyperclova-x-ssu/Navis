import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { readSecret } from '../../packages/db/index.ts';

export const PERSONA_MAINTENANCE_LOCK = 2361840;

export function personaPool(role: 'runtime' | 'migrate'): Pool {
  const user = role === 'runtime' ? 'nvirtual_run' : 'nvirtual_mig';
  return new Pool({
    host: process.env.NAVIS_DB_HOST ?? 'db', port: 5432, database: 'naver_virtual', user,
    password: readSecret(`/run/secrets/${user}_password`), application_name: user,
    max: 5, connectionTimeoutMillis: 2_000, query_timeout: role === 'runtime' ? 3_000 : 30_000,
  });
}

export async function personaTransaction<T>(
  pool: Pool, accountId: string | undefined, run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    if (accountId !== undefined) {
      await client.query("SELECT set_config('app.persona_account_id', $1, true), set_config('statement_timeout', '2000', true)", [accountId]);
    }
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export class PersonaEffectError extends Error {
  readonly statusCode: 400 | 409;
  readonly code: 'INVALID_IDEMPOTENCY_KEY' | 'IDEMPOTENCY_CONFLICT';

  constructor(statusCode: PersonaEffectError['statusCode'], code: PersonaEffectError['code']) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function personaEffect<T extends string | null>(
  pool: Pool, accountId: string, operation: string, key: string | undefined, fingerprint: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<{ ref: T; replayed: boolean }> {
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new PersonaEffectError(400, 'INVALID_IDEMPOTENCY_KEY');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Expected a canonical SHA-256 effect fingerprint');
  return personaTransaction(pool, accountId, async client => {
    // Keep an effect and its attempt key in the same installed demo generation.
    await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [PERSONA_MAINTENANCE_LOCK]);
    const won = await client.query(`INSERT INTO naver_virtual.effect_journal
      (account_id, operation, attempt_key, fingerprint) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING`, [accountId, operation, key, fingerprint]);
    if (won.rowCount === 0) {
      const { rows: [prior] } = await client.query<{ fingerprint: string; resource_ref: T }>(
        `SELECT fingerprint, resource_ref FROM naver_virtual.effect_journal
         WHERE account_id = $1 AND operation = $2 AND attempt_key = $3`, [accountId, operation, key]);
      if (!prior || prior.fingerprint !== fingerprint) throw new PersonaEffectError(409, 'IDEMPOTENCY_CONFLICT');
      return { ref: prior.resource_ref, replayed: true };
    }
    const ref = await work(client);
    await client.query(`UPDATE naver_virtual.effect_journal SET resource_ref = $4
      WHERE account_id = $1 AND operation = $2 AND attempt_key = $3`, [accountId, operation, key, ref]);
    return { ref, replayed: false };
  });
}

export async function assertPersonaReady(
  pool: Pool, accountId: string, seededCapabilities: readonly string[], migrations: readonly string[] = ['foundation'],
): Promise<void> {
  await personaTransaction(pool, accountId, async client => {
    const { rowCount } = await client.query(`SELECT 1 FROM naver_virtual.seed_generation AS generation
      WHERE generation.account_id = $1 AND NOT EXISTS (
        SELECT unnest($2::text[]) EXCEPT SELECT capability FROM naver_virtual.seed_revision
        WHERE account_id = $1 AND generation_at = generation.generation_at
      ) AND NOT EXISTS (
        SELECT unnest($3::text[]) EXCEPT SELECT id FROM naver_virtual.schema_migrations
      )`, [accountId, seededCapabilities, migrations]);
    if (!rowCount) throw new Error('Persona café generation unavailable');
  });
}
