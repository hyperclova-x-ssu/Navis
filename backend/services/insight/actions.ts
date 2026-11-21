import type { Pool } from 'pg';
import type { AgentActionProposal } from '../../../frontend/shared/navis-agent-schema.mjs';
import type { PromoVideoInput } from '../../../frontend/src/data/marketing/types.ts';
import { InsightError, inStore, isUuid, type OwnerScope } from './scope.ts';

export const promoCommand = 'video.make';
export type MarketingEndpoint = { baseUrl: string; token: string };

export type CardConfirmation = { source: 'card'; runId: string; snapshotRevision: number };
export const confirmationSchema = {
  type: 'object', additionalProperties: false, required: ['source', 'runId', 'snapshotRevision'],
  properties: {
    source: { const: 'card' },
    runId: { type: 'string', minLength: 1, maxLength: 128 },
    snapshotRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
};

export async function saveProposal(pool: Pool, scope: OwnerScope, proposal: AgentActionProposal, input: PromoVideoInput, now: Date) {
  if (proposal.command !== promoCommand || proposal.tier !== 'normal' || !isUuid(proposal.proposalId)) {
    throw new InsightError(503, 'SERVICE_UNAVAILABLE');
  }
  // The owner can deliberately retry a confirmed card after a lost response.
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  await inStore(pool, scope.storeId, db => db.query(`
    INSERT INTO insight.assistant_proposal (store_id, actor_id, proposal_id, run_id, snapshot_revision, expires_at, input)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
  [scope.storeId, scope.actorId, proposal.proposalId, proposal.runId, proposal.snapshotRevision, expiresAt, JSON.stringify(input)]));
}

async function startJob(
  endpoint: MarketingEndpoint, scope: OwnerScope, proposalId: string, revision: number, input: PromoVideoInput,
) {
  const url = new URL(`/internal/v1/marketing/stores/${scope.storeId}/promo/jobs`, endpoint.baseUrl);
  const result = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1800),
    headers: {
      authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json',
      'idempotency-key': `navis:${proposalId}`, 'x-navis-store-id': scope.storeId,
      'x-navis-user-id': scope.actorId, 'x-navis-store-role': 'owner',
    },
    body: JSON.stringify({ proposalId, snapshotRevision: revision, input, source: 'card' }),
  });
  if (result.status === 409) {
    const body = await result.json().catch(() => null);
    const code = body?.code === 'STALE_SNAPSHOT' ? 'STALE_SNAPSHOT' : 'ACTION_CONFLICT';
    throw new InsightError(409, code);
  }
  if (![200, 201, 202].includes(result.status)) {
    await result.body?.cancel();
    throw new InsightError(503, 'SERVICE_UNAVAILABLE');
  }
  const { jobId } = await result.json();
  if (!isUuid(jobId)) throw new InsightError(503, 'SERVICE_UNAVAILABLE');
  return jobId;
}

export async function confirmProposal(pool: Pool, endpoint: MarketingEndpoint, scope: OwnerScope, proposalId: string,
  confirmation: CardConfirmation, now: Date) {
  if (!isUuid(proposalId)) throw new InsightError(400, 'INVALID_REQUEST');
  const identity = [scope.storeId, scope.actorId, proposalId, confirmation.runId];
  const selection = `FROM insight.assistant_proposal
    WHERE store_id=$1 AND actor_id=$2 AND proposal_id=$3 AND run_id=$4`;
  const accepted = await inStore(pool, scope.storeId, async db => {
    const { rows: [proposal] } = await db.query<{
      snapshot_revision: string; expires_at: Date; confirmed_at: Date | null; job_id: string | null;
    }>(`SELECT snapshot_revision, expires_at, confirmed_at, job_id ${selection} FOR UPDATE`, identity);
    if (!proposal) throw new InsightError(404, 'NOT_FOUND');
    if (Number(proposal.snapshot_revision) !== confirmation.snapshotRevision) throw new InsightError(409, 'STALE_SNAPSHOT');
    if (proposal.job_id) return proposal.job_id;
    if (!proposal.confirmed_at) {
      if (proposal.expires_at <= now) throw new InsightError(409, 'PROPOSAL_EXPIRED');
      await db.query('UPDATE insight.assistant_proposal SET confirmed_at=$5 WHERE store_id=$1 AND actor_id=$2 AND proposal_id=$3 AND run_id=$4',
        [...identity, now]);
    }
    return null;
  });
  if (accepted) return { jobId: accepted };
  // Serialize delivery of this proposal. The marketing job key covers a lost
  // response or a restart between the domain commit and the local receipt.
  return inStore(pool, scope.storeId, async db => {
    const { rows: [proposal] } = await db.query<{ job_id: string | null; input: PromoVideoInput }>(
      `SELECT job_id, input ${selection} AND confirmed_at IS NOT NULL FOR UPDATE`,
      identity);
    if (!proposal) throw new InsightError(404, 'NOT_FOUND');
    if (proposal.job_id) return { jobId: proposal.job_id };
    const jobId = await startJob(endpoint, scope, proposalId, confirmation.snapshotRevision, proposal.input);
    await db.query('UPDATE insight.assistant_proposal SET job_id=$5 WHERE store_id=$1 AND actor_id=$2 AND proposal_id=$3 AND run_id=$4',
      [...identity, jobId]);
    return { jobId };
  });
}
