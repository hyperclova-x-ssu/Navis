import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendMarketingEvent, promoQueued } from '../outbox.ts';
import { inStore } from '../transaction.ts';
import { fingerprint, type CatalogSnapshot, type PromoInput, type PromoJob } from './contracts.ts';

export class PromoRouteError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string>;

  constructor(status: number, code: string, details: Record<string, string> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ConfirmedCard = { proposalId: string; snapshotRevision: number; input: PromoInput; source: 'card' };

export async function enqueuePromo(pool: Pool, scope: { storeId: string; actorId: string }, key: string,
  card: ConfirmedCard, validate: () => Promise<CatalogSnapshot>) {
  const { storeId, actorId } = scope;
  const requestHash = fingerprint({ ...card, actorId });
  async function findPrior(db: PoolClient) {
    const { rows: [prior] } = await db.query<PromoJob & { request_hash: string }>(
      'SELECT * FROM marketing.promo_job WHERE store_id = $1 AND action_key = $2', [storeId, key]);
    if (prior && prior.request_hash !== requestHash) throw new PromoRouteError(409, 'ACTION_CONFLICT');
    return prior;
  }

  const existing = await inStore(pool, storeId, findPrior);
  if (existing) return existing;
  const validation = await validate().then(snapshot => ({ snapshot }), (error: unknown) => ({ error }));
  return inStore(pool, storeId, async db => {
    // A concurrent request can commit this key while the catalog is being resolved.
    const prior = await findPrior(db);
    if (prior) return prior;
    if ('error' in validation) throw validation.error;
    return insertPromoJob(db, scope, key, requestHash, card.input, validation.snapshot);
  }, { serialize: true });
}

/** Insert a job and its queue event inside the caller's serialized store transaction. */
export async function insertPromoJob(db: PoolClient, scope: { storeId: string; actorId: string },
  key: string, requestHash: string, input: PromoInput, snapshot: CatalogSnapshot) {
  const { storeId, actorId } = scope;
  const { rows: [active] } = await db.query<{ job_id: string }>(`
    SELECT job_id FROM marketing.promo_job WHERE store_id = $1 AND status IN ('queued', 'running')`, [storeId]);
  if (active) throw new PromoRouteError(409, 'BUSY', { activeJobId: active.job_id });

  const jobId = randomUUID();
  const { rows: [job] } = await db.query<PromoJob>(`
    INSERT INTO marketing.promo_job (store_id, job_id, actor_id, action_key, request_hash, input, catalog_snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [storeId, jobId, actorId, key, requestHash, input, snapshot]);
  await appendMarketingEvent(db, storeId, { type: promoQueued, aggregateId: jobId, payload: { jobId } });
  return job;
}

export async function getPromoJob(pool: Pool, storeId: string, jobId: string) {
  return inStore(pool, storeId, async db => {
    const { rows: [job] } = await db.query<PromoJob>(
      'SELECT * FROM marketing.promo_job WHERE store_id = $1 AND job_id = $2', [storeId, jobId]);
    if (!job) throw new PromoRouteError(404, 'NOT_FOUND');
    return job;
  });
}

export function promoView(job: PromoJob) {
  const { job_id, store_id, status, stage, input, started_at, stage_started_at, fail_reason, asset_id, result } = job;
  const base = `/api/v1/stores/${store_id}/promo/jobs/${job_id}`;
  const { posterAssetId, sceneAssetId, ...details } = result ?? {};
  return {
    jobId: job_id, status, stage, stageState: status === 'done' || status === 'failed' ? status : 'active',
    lookCount: input.photoIds.length, startedAt: started_at.toISOString(), stageStartedAt: stage_started_at.toISOString(),
    failReason: fail_reason, assetId: asset_id,
    result: result && { ...details, fileUrl: `${base}/video.mp4`,
      ...(posterAssetId ? { posterUrl: `${base}/poster.jpg` } : {}),
      ...(sceneAssetId ? { sceneDownloadUrl: `${base}/scene.html` } : {}),
    },
  };
}
