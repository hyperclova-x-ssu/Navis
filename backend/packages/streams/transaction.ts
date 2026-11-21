import type { Pool, PoolClient } from 'pg';

export async function transact<T>(pool: Pool, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export const backoffMs = (attempt: number): number => Math.min(30_000, 250 * 2 ** Math.min(7, attempt - 1));

export function schemaName(service: string): string {
  switch (service) {
    case 'pos': case 'inventory': case 'customer': case 'account': case 'marketing': case 'insight':
      return service;
    default:
      throw new Error('Invalid streams database schema');
  }
}
