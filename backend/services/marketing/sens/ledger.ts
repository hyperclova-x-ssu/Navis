import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendMarketingEvent } from '../outbox.ts';
import { sha256 } from '../promo/contracts.ts';
import { inStore } from '../transaction.ts';
import { resolveReply, resolveTestTarget, SensError, type OwnerScope, type SensCard, type SensPolicy } from './policy.ts';

export const messageQueued = 'marketing.message_queued.v1';
type SendState = 'queued' | 'sending' | 'uncertain' | 'retryable' | 'accepted' | 'blocked' | 'failed';
export type DeliveryState = 'pending' | 'delivered' | 'failed';

export interface Attempt {
  store_id: string;
  receipt_id: string;
  actor_id: string;
  request_hash: string;
  draft_id: string;
  draft_session_id: string;
  sample_id: string;
  target_alias: string;
  routing_hash: string;
  body_hash: string;
  state: SendState;
  send_token: string | null;
  first_send_at: Date | null;
  retry_send_at: Date | null;
  provider_request_id: string | null;
  accepted_at: Date | null;
  delivery_state: DeliveryState | null;
  delivery_at: Date | null;
}

const openStates = "('queued', 'sending', 'uncertain', 'retryable')";

export async function sendWait(db: PoolClient, storeId: string, kind: 'reserve' | 'send') {
  const reservations = 'SELECT created_at AS at FROM marketing.sens_attempt WHERE store_id = $1';
  const sends = `
    SELECT first_send_at AS at FROM marketing.sens_attempt WHERE store_id = $1
    UNION ALL
    SELECT retry_send_at AS at FROM marketing.sens_attempt WHERE store_id = $1`;
  const { rows: [row] } = await db.query<{ retry_after: number }>(`
    WITH recent AS (
      SELECT at FROM (${kind === 'reserve' ? reservations : sends}) attempts
      WHERE at > statement_timestamp() - interval '1 day' ORDER BY at DESC LIMIT 3
    )
    SELECT GREATEST(0, CEIL(extract(epoch FROM max(at) + interval '1 minute' - statement_timestamp())),
      CASE WHEN count(*) = 3 THEN CEIL(extract(epoch FROM min(at) + interval '1 day' - statement_timestamp())) END
    )::int AS retry_after FROM recent`, [storeId]);
  return row.retry_after;
}

export async function enqueueSensAttempt(pool: Pool, scope: OwnerScope, card: SensCard, policy: SensPolicy) {
  const { storeId, actorId } = scope;
  const { draftId, targetId, body } = card.input;
  const actionKey = `navis:${card.proposalId}`;
  const requestHash = sha256(JSON.stringify([card.snapshotRevision, draftId, targetId, body]));
  const bodyHash = sha256(body);
  async function findPrior(db: PoolClient) {
    const { rows: [prior] } = await db.query<Attempt>(
      'SELECT * FROM marketing.sens_attempt WHERE store_id = $1 AND action_key = $2', [storeId, actionKey]);
    if (prior && prior.actor_id !== actorId) throw new SensError('NOT_FOUND');
    if (prior && prior.request_hash !== requestHash) throw new SensError('CONFLICT');
    return prior;
  }

  async function validate() {
    const target = await resolveTestTarget(policy, storeId, targetId);
    const draft = await resolveReply(policy, scope, draftId);
    if (!draft.replies.has(bodyHash)) throw new SensError('INVALID_REPLY');
    return { draft, routingHash: target.routingHash };
  }

  const existing = await inStore(pool, storeId, findPrior);
  if (existing) return existing;
  const validation = await validate().catch((error: unknown) => ({ error }));
  return inStore(pool, storeId, async db => {
    const prior = await findPrior(db);
    if (prior) return prior;
    if ('error' in validation) throw validation.error;
    const { draft, routingHash } = validation;
    const { rowCount } = await db.query(`
      SELECT 1 FROM marketing.sens_attempt
      WHERE store_id = $1 AND (state IN ${openStates} OR (actor_id, draft_session_id, sample_id) = ($2, $3, $4))
      LIMIT 1`, [storeId, actorId, draft.sessionId, draft.sampleId]);
    if (rowCount) throw new SensError('CONFLICT');
    const retryAfter = await sendWait(db, storeId, 'reserve');
    if (retryAfter) throw new SensError('RATE_LIMITED', retryAfter);

    const receiptId = randomUUID();
    const { rows: [attempt] } = await db.query<Attempt>(`
      INSERT INTO marketing.sens_attempt
        (store_id, receipt_id, actor_id, action_key, request_hash, draft_id, draft_session_id, sample_id,
         target_alias, routing_hash, body_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [storeId, receiptId, actorId, actionKey, requestHash, draftId, draft.sessionId, draft.sampleId, targetId, routingHash, bodyHash]);
    await appendMarketingEvent(db, storeId, { type: messageQueued, aggregateId: receiptId, payload: { receiptId } });
    return attempt;
  }, { serialize: true });
}

export function getSensAttempt(pool: Pool, scope: OwnerScope, receiptId: string) {
  return inStore(pool, scope.storeId, async db => {
    const { rows: [attempt] } = await db.query<Attempt>(`
      SELECT * FROM marketing.sens_attempt WHERE store_id = $1 AND receipt_id = $2 AND actor_id = $3`,
    [scope.storeId, receiptId, scope.actorId]);
    if (!attempt) throw new SensError('NOT_FOUND');
    return attempt;
  });
}

export function sensReceipt(attempt: Attempt) {
  return {
    receiptId: attempt.receipt_id,
    state: attempt.state,
    acceptance: attempt.accepted_at ? { requestId: attempt.provider_request_id, recordedAt: attempt.accepted_at.toISOString() } : null,
    delivery: attempt.delivery_state ? { status: attempt.delivery_state, recordedAt: attempt.delivery_at?.toISOString() ?? null } : null,
  };
}
