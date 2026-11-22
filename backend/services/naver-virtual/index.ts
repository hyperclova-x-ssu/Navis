import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { requiredEnv } from '../../packages/db/index.ts';
import { loadPersonaGrants } from '../../packages/naver/config/index.ts';
import { createPersonaCallback } from '../../packages/naver/transport/index.ts';
import { createPersonaApp, loadPersonaCapabilities } from './app.ts';
import { createPersonaClock, PERSONA_ACCOUNT_ID } from './clock.ts';
import { assertPersonaReady, personaPool } from './db.ts';
import { listPersonaMigrations } from './migrate.ts';

async function main(): Promise<void> {
  const now = disposableReplayClock() ?? createPersonaClock(process.env.NAVIS_NAVER_VIRTUAL_CLOCK);
  const grants = loadPersonaGrants(requiredEnv('NAVIS_NAVER_VIRTUAL_GRANTS_FILE'), PERSONA_ACCOUNT_ID);
  const required = process.env.NAVIS_NAVER_VIRTUAL_REQUIRED_CAPABILITIES?.split(',') ?? [];
  const capabilities = await loadPersonaCapabilities(required);
  const seedIds = capabilities.filter(capability => capability.seed).map(capability => capability.id);
  const migrationIds = listPersonaMigrations(capabilities).map(migration => migration.id);
  const callback = createPersonaCallback({
    talktalk: process.env.NAVIS_NAVER_VIRTUAL_TALKTALK_CALLBACK_URL,
    aicall: process.env.NAVIS_NAVER_VIRTUAL_AICALL_CALLBACK_URL,
  });
  const pool = personaPool('runtime');
  const app = createPersonaApp({ pool, grants, capabilities, now, callback,
    ready: () => assertPersonaReady(pool, PERSONA_ACCOUNT_ID, seedIds, migrationIds),
  });
  pool.on('error', () => app.log.warn('Idle persona database connection closed unexpectedly'));
  app.addHook('onClose', async () => pool.end());
  await listen(app);
}

await main().catch(() => {
  console.error('Persona NAVER startup failed');
  process.exitCode = 1;
});
