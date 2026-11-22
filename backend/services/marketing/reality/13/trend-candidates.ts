import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LocalError } from './sources.ts';
import { maxTrendCandidates, trendAlgorithm, trendKeyword, trendKeywordKey, type TrendRanking } from './trend-ranking.ts';

type Tx = { db: PoolClient; storeId: string };
type Candidate = { id: string; keyword: string; suggested: boolean };

export async function readTrendList({ db, storeId }: Tx) {
  const { rows: [row] } = await db.query<{ revision: number; items: Candidate[] }>(`
    SELECT list.revision, COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'keyword', keyword, 'suggested', suggested)
      ORDER BY suggested DESC, keyword_key, id) FROM marketing.local_trend_candidate WHERE store_id = $1), '[]'::jsonb) AS items
    FROM marketing.local_trend_list list WHERE list.store_id = $1`, [storeId]);
  return row ?? null;
}

export async function seedTrendList(tx: Tx, defaults: readonly string[]) {
  const existing = await readTrendList(tx);
  if (existing) return existing;
  const values = new Map(defaults.map(name => {
    const keyword = trendKeyword(name);
    return [trendKeywordKey(keyword), keyword];
  }));
  await tx.db.query('INSERT INTO marketing.local_trend_list (store_id) VALUES ($1)', [tx.storeId]);
  await tx.db.query(`INSERT INTO marketing.local_trend_candidate (store_id, id, keyword, keyword_key, suggested)
    SELECT $1, gen_random_uuid(), keyword, key, true FROM unnest($2::text[], $3::text[]) AS seeds(key, keyword)`,
  [tx.storeId, [...values.keys()], [...values.values()]]);
  return (await readTrendList(tx))!;
}

async function advance({ db, storeId }: Tx) {
  const { rows: [row] } = await db.query<{ revision: number }>(`UPDATE marketing.local_trend_list SET revision = revision + 1
    WHERE store_id = $1 RETURNING revision`, [storeId]);
  return row.revision;
}

export async function addTrendCandidate(tx: Tx, keyword: string, defaults: readonly string[]) {
  const list = await seedTrendList(tx, defaults.filter(value => trendKeywordKey(value) !== trendKeywordKey(keyword)));
  if (list.items.length >= maxTrendCandidates) throw new LocalError(409, 'TREND_CANDIDATE_LIMIT');
  const id = randomUUID();
  const { rowCount } = await tx.db.query(`INSERT INTO marketing.local_trend_candidate (store_id, id, keyword, keyword_key, suggested)
    VALUES ($1, $2, $3, $4, false) ON CONFLICT (store_id, keyword_key) DO NOTHING`, [tx.storeId, id, keyword, trendKeywordKey(keyword)]);
  if (!rowCount) throw new LocalError(409, 'TREND_CANDIDATE_EXISTS');
  return { id, revision: await advance(tx) };
}

export async function removeTrendCandidate(tx: Tx, id: string, expectedRevision: number) {
  const current = await readTrendList(tx);
  if (!current || !current.items.some(item => item.id === id)) throw new LocalError(404, 'NOT_FOUND');
  if (current.revision !== expectedRevision) throw new LocalError(409, 'STALE_REVISION');
  await tx.db.query('DELETE FROM marketing.local_trend_candidate WHERE store_id = $1 AND id = $2', [tx.storeId, id]);
  return { id, revision: await advance(tx) };
}

export const trendFingerprint = (keywords: readonly string[], provider?: 'fake' | 'live') =>
  createHash('sha256').update(JSON.stringify([trendAlgorithm, provider ?? 'injected', [...keywords].sort()])).digest('hex');

export async function readTrendCache(tx: Tx, day: string, fingerprint: string) {
  const { rows: [row] } = await tx.db.query<{ ranking: TrendRanking }>(`SELECT ranking FROM marketing.local_trend_cache
    WHERE store_id = $1 AND end_date = $2 AND fingerprint = $3`, [tx.storeId, day, fingerprint]);
  return row?.ranking;
}

export async function writeTrendCache(tx: Tx, fingerprint: string, ranking: TrendRanking, revision: number) {
  await tx.db.query(`INSERT INTO marketing.local_trend_cache (store_id, end_date, fingerprint, ranking)
    SELECT store_id, $2, $3, $4 FROM marketing.local_trend_list WHERE store_id = $1 AND revision = $5
    ON CONFLICT (store_id) DO UPDATE SET end_date = EXCLUDED.end_date, fingerprint = EXCLUDED.fingerprint, ranking = EXCLUDED.ranking
    WHERE marketing.local_trend_cache.end_date <= EXCLUDED.end_date`, [tx.storeId, ranking.period.to, fingerprint, ranking, revision]);
}
