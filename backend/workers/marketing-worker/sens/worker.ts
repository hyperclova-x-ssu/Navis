import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { sendWait, type Attempt } from '../../../services/marketing/sens/ledger.ts';
import { resolveReply, resolveTestTarget, SensError, type SensPolicy } from '../../../services/marketing/sens/policy.ts';
import { inStore } from '../../../services/marketing/transaction.ts';
import type { FakeSensTransport, ProviderOutcome } from './transport.ts';

const deadlineMs = 15_000;
const sendable = "state IN ('queued', 'retryable') AND dispatched_at IS NOT NULL";

async function boundedIO(execute: (signal: AbortSignal) => Promise<ProviderOutcome>): Promise<ProviderOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderOutcome>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ state: 'unknown' });
    }, deadlineMs);
  });
  try { return await Promise.race([execute(controller.signal), timeout]); }
  catch { return { state: 'unknown' }; }
  finally { clearTimeout(timer); }
}

function settle(database: Pool, storeId: string, receiptId: string, token: string, outcome: ProviderOutcome) {
  return inStore(database, storeId, async db => {
    const identity = [storeId, receiptId, token];
    const current = 'store_id=$1 AND receipt_id=$2 AND send_token=$3';
    if (outcome.state === 'not_sent') {
      await db.query(`
        UPDATE marketing.sens_attempt
        SET state = CASE WHEN retry_send_at IS NULL THEN 'retryable' ELSE 'failed' END
        WHERE ${current} AND state IN ('sending', 'uncertain') AND provider_request_id IS NULL`, identity);
      return;
    }

    const validRequestId = !!outcome.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(outcome.requestId);
    if (outcome.state === 'unknown' || !validRequestId) {
      await db.query(`
        UPDATE marketing.sens_attempt
        SET state='uncertain', provider_request_id=coalesce(provider_request_id, $4)
        WHERE ${current} AND state IN ('sending', 'uncertain')`,
      [...identity, validRequestId ? outcome.requestId : null]);
      return;
    }

    await db.query(`
      UPDATE marketing.sens_attempt
      SET state='accepted', provider_request_id=$4, accepted_at=coalesce(accepted_at, clock_timestamp()),
          delivery_state=CASE WHEN delivery_at IS NULL THEN coalesce($5, 'pending') ELSE delivery_state END,
          delivery_at=CASE WHEN $5 IS NOT NULL THEN coalesce(delivery_at, clock_timestamp()) ELSE delivery_at END
      WHERE ${current} AND state IN ('sending', 'uncertain', 'accepted')
        AND (provider_request_id IS NULL OR provider_request_id = $4)`,
    [...identity, outcome.requestId, outcome.delivery ?? null]);
  });
}

export function createSensWorker(database: Pool, options: { policy: SensPolicy; transport: FakeSensTransport }) {
  const { policy, transport } = options;
  if (transport.kind !== 'fake') throw new Error('Test SMS requires the fake transport');

  async function runNext(storeId: string): Promise<boolean> {
    const attempt = await inStore(database, storeId, async db => {
      const { rows: [row] } = await db.query<Attempt>(`
        SELECT * FROM marketing.sens_attempt WHERE store_id=$1 AND ${sendable}`, [storeId]);
      return row;
    });
    if (!attempt) return false;

    const scope = { storeId, actorId: attempt.actor_id };
    let input;
    try {
      const target = await resolveTestTarget(policy, storeId, attempt.target_alias);
      const draft = await resolveReply(policy, scope, attempt.draft_id);
      const body = draft.replies.get(attempt.body_hash);
      if (target.routingHash !== attempt.routing_hash || draft.sampleId !== attempt.sample_id
        || draft.sessionId !== attempt.draft_session_id || !body) throw new SensError('FORBIDDEN');
      input = { senderNumber: target.senderNumber, number: target.number, body };
    } catch (error) {
      // A transient resolver failure leaves the attempt available for another poll.
      if (!(error instanceof SensError)) return false;
      await inStore(database, storeId, db => db.query(`
        UPDATE marketing.sens_attempt SET state='blocked'
        WHERE store_id=$1 AND receipt_id=$2 AND state=$3 AND ${sendable}`, [storeId, attempt.receipt_id, attempt.state]));
      return false;
    }

    const dispatchId = randomUUID();
    const claimed = await inStore(database, storeId, async db => {
      if (await sendWait(db, storeId, 'send')) return false;
      const { rowCount } = await db.query(`
        UPDATE marketing.sens_attempt
        SET state='sending', send_token=$4,
            first_send_at=coalesce(first_send_at, statement_timestamp()),
            retry_send_at=CASE WHEN state='retryable' THEN statement_timestamp() END
        WHERE store_id=$1 AND receipt_id=$2 AND state=$3 AND ${sendable}`,
      [storeId, attempt.receipt_id, attempt.state, dispatchId]);
      return rowCount === 1;
    }, { serialize: true });
    if (!claimed) return false;

    const outcome = await boundedIO(signal => transport.send({ dispatchId, ...input }, signal));
    await settle(database, storeId, attempt.receipt_id, dispatchId, outcome);
    return true;
  }

  async function reconcile(storeId: string, receiptId: string): Promise<void> {
    const attempt = await inStore(database, storeId, async db => {
      const { rows: [row] } = await db.query<Attempt>(`
        SELECT * FROM marketing.sens_attempt WHERE store_id=$1 AND receipt_id=$2 AND (
          state='uncertain' OR (state='accepted' AND delivery_state='pending')
          OR (state='sending' AND coalesce(retry_send_at, first_send_at) <=
            statement_timestamp() - $3 * interval '1 millisecond')
        )`, [storeId, receiptId, deadlineMs]);
      return row;
    });
    if (!attempt?.send_token) return;
    const dispatchId = attempt.send_token;
    const outcome = await boundedIO(signal => transport.reconcile({ dispatchId, requestId: attempt.provider_request_id }, signal));
    await settle(database, storeId, receiptId, dispatchId, outcome);
  }

  return { runNext, reconcile };
}
