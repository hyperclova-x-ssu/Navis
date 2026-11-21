import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PromoError } from '../../../../frontend/server/promo/errors.mjs';
import { validateSchema } from '../../../../frontend/server/promo/schema.mjs';
import { fingerprint, sha256, type PromoArtifacts } from '../../../services/marketing/promo/contracts.ts';
import type { PromoUsage } from '../../../services/insight/usage.ts';
import { withLease, type Lease } from './leases.ts';
import type { ModelRequest, ModelStage, PromoProvider, Received } from './providers.ts';
import type { createUsageClient } from './clients.ts';

export class UnsettledAttempt extends Error {}

interface Attempt {
  attempt_id: string;
  request_hash: string;
  state: 'pending' | 'received' | 'not_sent';
  asset_id: string | null;
  usage: PromoUsage | null;
}

export function createAttemptRunner({
  database, lease, artifacts, meter, provider, signal,
}: {
  database: Pool;
  lease: Lease;
  artifacts: PromoArtifacts;
  meter: ReturnType<typeof createUsageClient>;
  provider: PromoProvider;
  signal: AbortSignal;
}) {
  const { store_id: storeId, job_id: jobId, stage } = lease;
  const scope = { storeId, resourceId: jobId };
  let sequence = 0;
  const lookCalls = new Map<string, Promise<{ output: unknown }>>();
  const pending = new Set<Promise<unknown>>();

  async function runAttempt(modelStage: ModelStage, callKey: string, hash: string, attemptNo: number, request: ModelRequest) {
    const key = [storeId, jobId, stage, callKey, attemptNo];
    const { attempt, fresh } = await withLease(database, lease, async db => {
      const { rows: [existing] } = await db.query<Attempt>(`
        SELECT attempt_id, request_hash, state, asset_id, usage FROM marketing.promo_attempt
        WHERE store_id = $1 AND job_id = $2 AND stage = $3 AND call_key = $4 AND attempt_no = $5`, key);
      if (existing) {
        // A changed prompt or model cannot displace an unresolved call after a redeploy.
        if (existing.request_hash !== hash) throw new UnsettledAttempt();
        return { attempt: existing, fresh: false };
      }

      const { rows: [created] } = await db.query<Attempt>(`
        INSERT INTO marketing.promo_attempt (store_id, job_id, stage, call_key, attempt_no, attempt_id, request_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING attempt_id, request_hash, state, asset_id, usage`,
      [...key, randomUUID(), hash]);
      return { attempt: created, fresh: true };
    });

    const { attempt_id: attemptId } = attempt;
    if (attempt.state === 'not_sent') return { state: 'not_sent' } as const;
    if (attempt.state === 'received') {
      if (!attempt.asset_id) throw new Error('Promo attempt lacks a receipt');
      const { bytes } = await artifacts.read(scope, attempt.asset_id, signal);
      if (attempt.usage) await meter.record(storeId, attempt.usage, signal);
      return JSON.parse(bytes.toString('utf8')) as Received;
    }

    signal.throwIfAborted();
    let response = fresh
      ? await provider.invoke(modelStage, attemptId, request)
      : await provider.reconcile(modelStage, attemptId, signal);
    if (response.state === 'unknown') throw new UnsettledAttempt();
    if (response.state === 'received' && !response.error && validateSchema(request.schema, response.output).length) {
      response = { state: 'received', error: 'AI_BAD_OUTPUT',
        usage: response.usage && { ...response.usage, outcome: 'invalid_output' } };
    }
    await withLease(database, lease, async () => undefined);
    let assetId: string | null = null;
    let usage: PromoUsage | null = null;
    if (response.state === 'received') {
      assetId = await artifacts.put(scope, `attempt-${attemptId}-${lease.lease_token}`,
        'promo_checkpoint', 'application/json', Buffer.from(JSON.stringify(response)), signal);
      if (response.usage) {
        usage = { ...response.usage, ...provider.identity(modelStage), stage: modelStage, attemptId, correlationId: jobId };
      }
    }

    await withLease(database, lease, async db => {
      await db.query(`
        UPDATE marketing.promo_attempt SET state = $3, asset_id = $4, usage = $5, settled_at = clock_timestamp()
        WHERE store_id = $1 AND attempt_id = $2`, [storeId, attemptId, response.state, assetId, usage]);
    });
    // Resubmitting this saved usage after a crash or a lost HTTP response is idempotent in Insight.
    if (usage) await meter.record(storeId, usage, signal);
    return response;
  }

  async function run(modelStage: ModelStage, key: string, hash: string, request: ModelRequest) {
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      const result = await runAttempt(modelStage, key, hash, attemptNo, request);
      if (result.state === 'not_sent') continue;
      if (!result.error) return { output: result.output };
      if (result.error === 'AI_BAD_OUTPUT' && attemptNo === 1) continue;
      throw new PromoError(result.error, undefined);
    }
    throw new PromoError('AI_UNAVAILABLE', undefined);
  }

  return {
    model: (modelStage: ModelStage) => provider.identity(modelStage).model,
    runner: (modelStage: ModelStage) => ({
      run(request: ModelRequest) {
        const hash = fingerprint({
          model: provider.identity(modelStage), prompt: request.prompt, schema: request.schema,
          images: request.images?.map(image => ({
            sha256: sha256(image.bytes), mediaType: image.mediaType,
          })),
        });
        const key = modelStage === 'look' ? request.images?.[0]?.lookKey : String(++sequence);
        if (!key) throw new PromoError('AI_BAD_OUTPUT', undefined);
        const prior = modelStage === 'look' ? lookCalls.get(key) : undefined;
        if (prior) return prior;
        const task = run(modelStage, key, hash, request);
        if (modelStage === 'look') lookCalls.set(key, task);
        pending.add(task);
        void task.then(() => pending.delete(task), () => pending.delete(task));
        return task;
      },
    }),
    async flush() {
      // Look runs two photo requests in parallel. Wait for the other request to settle before releasing the lease.
      await Promise.allSettled(pending);
    },
  };
}
