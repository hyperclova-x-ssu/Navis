import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { createSeedContext, resolveHostedSeedClock, type SeedContext } from '../../packages/db/seed-context.ts';
import { loadPersonaCapabilities, type PersonaCapability } from './app.ts';
import { PINNED_PERSONA_INSTANT, PERSONA_ACCOUNT_ID } from './clock.ts';
import { PERSONA_MAINTENANCE_LOCK, personaPool, personaTransaction } from './db.ts';

export type PersonaSeedContext = {
  accountId: string;
  generation: string;
  previousGeneration?: string;
  now: Date;
  cafe: SeedContext;
};

export function createPersonaSeedContext(deploymentInstant?: Date, replay?: SeedContext): PersonaSeedContext {
  const now = deploymentInstant ?? new Date(PINNED_PERSONA_INSTANT);
  const cafe = replay ?? createSeedContext(deploymentInstant ? { now } : undefined);
  const menu = cafe.rows.menu_item.filter((row: { deleted_at: string | null }) => row.deleted_at === null);
  return {
    accountId: PERSONA_ACCOUNT_ID,
    generation: now.toISOString(),
    now,
    cafe: { ...cafe, rows: { ...cafe.rows, menu_item: menu } },
  };
}

export async function seedPersona(pool: Pool, capabilities: readonly PersonaCapability[], context: PersonaSeedContext): Promise<void> {
  await personaTransaction(pool, undefined, async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [PERSONA_MAINTENANCE_LOCK]);
    await client.query("SELECT set_config('app.persona_account_id', $1, true)", [context.accountId]);
    const { rows: [current] } = await client.query<{ generation_at: Date }>(
      'SELECT generation_at FROM naver_virtual.seed_generation WHERE account_id = $1', [context.accountId]);
    if (current && current.generation_at.getTime() > context.now.getTime()) {
      throw new Error('Persona NAVER seed generation is older than the installed generation');
    }
    if (current && current.generation_at.toISOString() !== context.generation) {
      await client.query('DELETE FROM naver_virtual.effect_journal WHERE account_id = $1', [context.accountId]);
    }
    await client.query(`INSERT INTO naver_virtual.seed_generation (account_id, generation_at) VALUES ($1, $2)
      ON CONFLICT (account_id) DO UPDATE SET generation_at = EXCLUDED.generation_at`, [context.accountId, context.generation]);
    const { rows: revisions } = await client.query<{ capability: string; generation_at: Date }>(
      'SELECT capability, generation_at FROM naver_virtual.seed_revision WHERE account_id = $1', [context.accountId]);
    const seeded = new Map(revisions.map(row => [row.capability, row.generation_at.toISOString()]));
    for (const capability of capabilities) {
      if (!capability.seed || seeded.get(capability.id) === context.generation) continue;
      await capability.seed(client, { ...context, previousGeneration: seeded.get(capability.id) });
      await client.query(`INSERT INTO naver_virtual.seed_revision (account_id, capability, generation_at) VALUES ($1, $2, $3)
        ON CONFLICT (account_id, capability) DO UPDATE SET generation_at = EXCLUDED.generation_at`,
      [context.accountId, capability.id, context.generation]);
    }
  });
}

async function main(): Promise<void> {
  const instant = process.env.NAVIS_NAVER_VIRTUAL_SEED_INSTANT;
  if (!instant && process.env.NAVIS_NAVER_VIRTUAL_CLOCK === 'real') {
    throw new Error('A hosted seed requires NAVIS_NAVER_VIRTUAL_SEED_INSTANT');
  }
  const context = createPersonaSeedContext(instant ? resolveHostedSeedClock({ instant }).now : undefined);
  const pool = personaPool('migrate');
  try { await seedPersona(pool, await loadPersonaCapabilities(), context); } finally { await pool.end(); }
  console.info(`[naver-virtual] installed generation ${context.generation} (${context.cafe.businessDate})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    console.error('Persona NAVER seed failed');
    process.exitCode = 1;
  });
}
