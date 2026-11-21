import type { Pool, PoolClient } from 'pg';
import { transact } from '../../packages/streams/transaction.ts';

export function inStore<T>(pool: Pool, storeId: string, run: (db: PoolClient) => Promise<T>, { serialize = false } = {}) {
  return transact(pool, async db => {
    await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    if (serialize) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('marketing:' || $1, 0))", [storeId]);
    }
    return run(db);
  });
}
