import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { PromoError } from '../../../../frontend/server/promo/errors.mjs';
import { validateSchema } from '../../../../frontend/server/promo/schema.mjs';
import { fingerprint, sha256, type PromoArtifacts } from '../../../services/marketing/promo/contracts.ts';
import type { PromoUsage } from '../../../services/insight/usage.ts';
import { withLease, type Lease } from './leases.ts';
import type { ModelRequest, ModelStage, PromoProvider, ProviderUsage, Received } from './providers.ts';
import type { createUsageClient } from './clients.ts';

export class UnsettledAttempt extends Error {}

interface Attempt {
  attempt_id: string;
  request_hash: string;
  state: 'pending' | 'received' | 'not_sent';
  asset_id: string | null;
  usage: PromoUsage | null;
  started_at: Date;
  settled_at: Date | null;
}

export function createAttemptRunner({
  database, lease, artifacts, meter, provider, signal, reconcileWindowMs,
}: {
  database: Pool;
  lease: Lease;
  artifacts: PromoArtifacts;
  meter: ReturnType<typeof createUsageClient>;
  provider: PromoProvider;
  signal: AbortSignal;
  reconcileWindowMs: number;
}) {
  const { store_id: storeId, job_id: jobId, stage } = lease;
  const scope = { storeId, resourceId: jobId };
  let sequence = 0;
  const lookCalls = new Map<string, Promise<{ output: unknown }>>();
  const pending = new Set<Promise<unknown>>();

  async function reconcile(modelStage: ModelStage, attempt: Attempt) {
    const timeout = new PromoError('AI_TIMEOUT', undefined);
    const deadline = attempt.started_at.getTime() + reconcileWindowMs;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeout;
    const control = new AbortController();
    const recoverySignal = AbortSignal.any([signal, control.signal]);
    try {
      const expired = delay(remainingMs, undefined, { signal: recoverySignal }).then(() => {
        control.abort(timeout);
        throw timeout;
      });
      const recovery = Promise.resolve().then(() => {
        recoverySignal.throwIfAborted();
        return provider.reconcile(modelStage, attempt.attempt_id, recoverySignal);
      });
      const response = await Promise.race([expired, recovery]);
      recoverySignal.throwIfAborted();
      if (Date.now() >= deadline) throw timeout;
      return response;
    } catch (error) {
      recoverySignal.throwIfAborted();
      throw error;
    } finally {
      control.abort();
    }
  }

  function usageFor(modelStage: ModelStage, attemptId: string, response: Received, latencyMs: number): PromoUsage {
    const fallback: ProviderUsage = {
      latencyMs: Math.min(latencyMs, 2_147_483_647),
      outcome: response.error === 'AI_BAD_OUTPUT' ? 'invalid_output'
        : response.error === 'AI_TIMEOUT' ? 'timeout' : response.error ? 'error' : 'success',
      inputTokens: null, outputTokens: null, reasoningTokens: null,
    };
    return { ...(response.usage ?? fallback), ...provider.identity(modelStage), stage: modelStage, attemptId, correlationId: jobId };
  }

  async function runAttempt(modelStage: ModelStage, callKey: string, hash: string, attemptNo: number, request: ModelRequest) {
    const key = [storeId, jobId, stage, callKey, attemptNo];
    const { attempt, fresh } = await withLease(database, lease, async db => {
      const { rows: [existing] } = await db.query<Attempt>(`
        SELECT attempt_id, request_hash, state, asset_id, usage, started_at, settled_at FROM marketing.promo_attempt
        WHERE store_id = $1 AND job_id = $2 AND stage = $3 AND call_key = $4 AND attempt_no = $5`, key);
      if (existing) {
        // A changed prompt or model cannot displace an unresolved call after a redeploy.
        if (existing.request_hash !== hash) throw new UnsettledAttempt();
        return { attempt: existing, fresh: false };
      }

      const { rows: [created] } = await db.query<Attempt>(`
        INSERT INTO marketing.promo_attempt (store_id, job_id, stage, call_key, attempt_no, attempt_id, request_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING attempt_id, request_hash, state, asset_id, usage, started_at, settled_at`,
      [...key, randomUUID(), hash]);
      return { attempt: created, fresh: true };
    });

    const { attempt_id: attemptId } = attempt;
    if (attempt.state === 'not_sent') return { state: 'not_sent' } as const;
    if (attempt.state === 'received') {
      if (!attempt.asset_id || !attempt.settled_at) throw new Error('Promo attempt lacks a receipt');
      const { bytes } = await artifacts.read(scope, attempt.asset_id, signal);
      const response = JSON.parse(bytes.toString('utf8')) as Received;
      const latencyMs = Math.max(0, attempt.settled_at.getTime() - attempt.started_at.getTime());
      await meter.record(storeId, attempt.usage ?? usageFor(modelStage, attemptId, response, latencyMs), signal);
      return response;
    }

    signal.throwIfAborted();
    const started = performance.now();
    let response = fresh
      ? await provider.invoke(modelStage, attemptId, request)
      : await reconcile(modelStage, attempt);
    const latencyMs = Math.round(performance.now() - started);
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
      usage = usageFor(modelStage, attemptId, response, latencyMs);
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
