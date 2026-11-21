import type { Pool } from 'pg';
import { PermanentStreamError, StreamConsumer, type StreamHandler } from '../../../packages/streams/consumer.ts';
import type { RedisStreams } from '../../../packages/streams/redis.ts';
import { promoQueued } from '../../../services/marketing/outbox.ts';

export const promoGroup = 'marketing-worker';

export const dispatchPromo: StreamHandler = async (db, event) => {
  if (!event.storeId || event.payload.jobId !== event.aggregateId || Object.keys(event.payload).length !== 1) {
    throw new PermanentStreamError('INVALID_PROMO_JOB_EVENT');
  }
  const result = await db.query(`
    UPDATE marketing.promo_job SET dispatched_at = coalesce(dispatched_at, clock_timestamp())
    WHERE store_id = $1 AND job_id = $2`, [event.storeId, event.aggregateId]);
  if (!result.rowCount) throw new PermanentStreamError('PROMO_JOB_NOT_FOUND');
};

export function createPromoConsumer(options: { database: Pool; redis: RedisStreams; name: string; handlers?: Record<string, StreamHandler> }) {
  return new StreamConsumer({
    ...options, service: 'marketing', producer: 'marketing', group: promoGroup,
    handlers: { ...options.handlers, [promoQueued]: dispatchPromo },
  });
}
