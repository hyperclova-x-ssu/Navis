import type { Pool, PoolClient } from 'pg';

export async function withStoreTransaction<T>(
  pool: Pool,
  storeId: string,
  query: (client: PoolClient) => Promise<T>,
  { readOnly = false } = {},
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const result = await query(client);
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
