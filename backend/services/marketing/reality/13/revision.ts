import type { PoolClient } from 'pg';

type Source = 'local-changes' | 'community';

export async function advanceSource(db: PoolClient, storeId: string, source: Source) {
  await db.query(`INSERT INTO marketing.local_source_revision (store_id, source) VALUES ($1, $2)
    ON CONFLICT (store_id, source) DO UPDATE SET revision = marketing.local_source_revision.revision + 1`, [storeId, source]);
}

export async function readSourceRevision(db: PoolClient, storeId: string, source: Source) {
  const { rows: [row] } = await db.query<{ revision: string }>(`
    SELECT revision FROM marketing.local_source_revision WHERE store_id = $1 AND source = $2`, [storeId, source]);
  return Number(row?.revision ?? 0);
}
