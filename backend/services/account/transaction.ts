import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await run(client);
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

export function inStore<T>(pool: Pool, storeId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async (client) => {
    await client.query("SELECT set_config('app.store_id', $1, true), set_config('statement_timeout', '2000', true)", [storeId]);
    return run(client);
  });
}
