import type { Pool, PoolClient } from 'pg';

// The callback can also be used by service-owned consumers to commit a checkpoint
// and the business effect together. Scope clears on both commit and rollback.
export async function withStoreTransaction<T>(
  pool: Pool, storeId: string, action: (db: PoolClient) => Promise<T>, { write = false, readOnly = false } = {},
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    if (write) {
      // Orders, command/claim transitions, reversals, and future closes use the same store lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pos:' || $1, 0))", [storeId]);
    }
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
