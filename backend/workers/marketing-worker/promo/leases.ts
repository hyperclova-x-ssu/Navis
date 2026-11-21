import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inStore } from '../../../services/marketing/transaction.ts';
import type { CheckpointStage, PromoJob, PromoResult, Stage } from '../../../services/marketing/promo/contracts.ts';

export interface Lease extends PromoJob {
  lease_token: string;
}
export class LostLease extends Error {}

const ownsLease = "store_id = $1 AND job_id = $2 AND lease_token = $3 AND status = 'running' AND lease_until > clock_timestamp()";
const leaseKey = (lease: Lease) => [lease.store_id, lease.job_id, lease.lease_token];

export function claim(pool: Pool, storeId: string, leaseMs: number) {
  return inStore(pool, storeId, async db => {
    const { rows: [job] } = await db.query<Lease>(`
      WITH eligible AS (
        SELECT store_id, job_id FROM marketing.promo_job
        WHERE store_id = $1 AND status IN ('queued', 'running') AND dispatched_at IS NOT NULL
          AND next_run_at <= clock_timestamp() AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY started_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE marketing.promo_job job SET status = 'running', lease_token = $2,
        lease_until = clock_timestamp() + $3 * interval '1 millisecond'
      FROM eligible WHERE job.store_id = eligible.store_id AND job.job_id = eligible.job_id RETURNING job.*`,
    [storeId, randomUUID(), leaseMs]);
    return job;
  });
}

export function withLease<T>(pool: Pool, lease: Lease, run: (db: PoolClient) => Promise<T>) {
  return inStore(pool, lease.store_id, async db => {
    // Evaluate expiry after obtaining the lock. No cross-service work runs while held.
    const locked = await db.query('SELECT 1 FROM marketing.promo_job WHERE store_id = $1 AND job_id = $2 FOR UPDATE',
      [lease.store_id, lease.job_id]);
    if (!locked.rowCount) throw new LostLease();
    const valid = await db.query(`SELECT 1 FROM marketing.promo_job WHERE ${ownsLease}`, leaseKey(lease));
    if (!valid.rowCount) throw new LostLease();
    return run(db);
  });
}

async function update(pool: Pool, lease: Lease, set: string, args: unknown[] = []) {
  await withLease(pool, lease, async db => {
    const changed = await db.query(`UPDATE marketing.promo_job SET ${set} WHERE ${ownsLease}`, [...leaseKey(lease), ...args]);
    if (!changed.rowCount) throw new LostLease();
  });
}

export const renew = (pool: Pool, lease: Lease, leaseMs: number) =>
  update(pool, lease, "lease_until = clock_timestamp() + $4 * interval '1 millisecond'", [leaseMs]);

export const defer = (pool: Pool, lease: Lease, delayMs: number) =>
  update(pool, lease, "lease_token = NULL, lease_until = NULL, next_run_at = clock_timestamp() + $4 * interval '1 millisecond'", [delayMs]);

export const fail = (pool: Pool, lease: Lease, reason: string) =>
  update(pool, lease, "status = 'failed', lease_token = NULL, lease_until = NULL, finished_at = clock_timestamp(), fail_reason = $4", [reason]);

export const complete = (pool: Pool, lease: Lease, fileId: string, result: PromoResult) =>
  update(pool, lease, "status = 'done', lease_token = NULL, lease_until = NULL, finished_at = clock_timestamp(), asset_id = $4, result = $5",
    [fileId, result]);

export function checkpoint(pool: Pool, lease: Lease, stage: CheckpointStage, next: Stage, fileId: string) {
  return withLease(pool, lease, async db => {
    await db.query(`
      INSERT INTO marketing.promo_checkpoint (store_id, job_id, stage, asset_id) VALUES ($1, $2, $3, $4)`,
    [lease.store_id, lease.job_id, stage, fileId]);
    const changed = await db.query(`
      UPDATE marketing.promo_job SET stage = $4, stage_started_at = clock_timestamp(),
        lease_token = NULL, lease_until = NULL, next_run_at = clock_timestamp() WHERE ${ownsLease}`,
    [...leaseKey(lease), next]);
    if (!changed.rowCount) throw new LostLease();
  });
}
