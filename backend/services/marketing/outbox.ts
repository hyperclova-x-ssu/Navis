import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export const promoQueued = 'marketing.promo_job_queued.v1';

type MarketingEvent = { type: typeof promoQueued; aggregateId: string; payload: { jobId: string } }
  | { type: 'marketing.message_queued.v1'; aggregateId: string; payload: Record<string, unknown> };

/** Call inside the same scoped transaction as the new aggregate. */
export async function appendMarketingEvent(db: PoolClient, storeId: string, event: MarketingEvent) {
  const eventId = randomUUID();
  await db.query(`
    WITH seq AS (
      INSERT INTO marketing.outbox_scope (scope_key, last_seq) VALUES ($2::text, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = marketing.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO marketing.outbox (event_id, store_id, scope_key, store_seq, event_type,
                                  aggregate_id, occurred_at, payload)
    SELECT $1, $2::text::uuid, $2::text, last_seq, $3, $4, clock_timestamp(), $5::jsonb FROM seq`,
  [eventId, storeId, event.type, event.aggregateId, JSON.stringify(event.payload)]);
  return eventId;
}
