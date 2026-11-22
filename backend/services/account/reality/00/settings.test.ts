import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { demoIdentity } from '../../identity.ts';
import { seed } from '../../seed.ts';
import { readPreferences, savePreferences } from './settings.ts';

const { storeId, userId } = demoIdentity;
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migrator = dbPool('account', 'migrate', 'test');
const runtime = dbPool('account', 'runtime', 'test');
let client: PoolClient;

beforeAll(async () => {
  await runMigrations('account', migrations, 'test');
  await seed(migrator);
});

beforeEach(async () => {
  client = await runtime.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.store_id', $1, true), set_config('app.user_id', $2, true)", [storeId, userId]);
});

afterEach(async () => {
  try {
    await client?.query('ROLLBACK');
  } finally {
    client?.release();
  }
});

afterAll(async () => {
  await Promise.all([migrator.end(), runtime.end()]);
});

it('defaults the seeded demo owner to light when no preference is stored', async () => {
  expect(await readPreferences(client, storeId, userId)).toEqual({ theme: 'light', textScale: 100, locale: 'ko', revision: 0 });
});

it('returns an explicitly stored dark preference', async () => {
  await savePreferences(client, storeId, userId, { theme: 'dark', textScale: 125, locale: 'en', revision: 1 }, 1);
  expect(await readPreferences(client, storeId, userId)).toEqual({ theme: 'dark', textScale: 125, locale: 'en', revision: 1 });
});
