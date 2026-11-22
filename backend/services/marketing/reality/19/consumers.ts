import type { Pool } from 'pg';
import { StreamConsumer, type RedisStreams, type StreamHandler } from '../../../../packages/streams/index.ts';
import type { EventProducer } from '../../../../packages/contracts/events.ts';
import { groupCustomerHandlers, performancePosHandlers } from './projection.ts';

/**
 * Marketing reads each producer stream through exactly one consumer in group `marketing`; two consumers in one group
 * would split the deliveries. Slices that project the same event type (B13 local sales, B19 sales) are merged here and
 * run in order inside the consumer's single transaction and savepoint, so one checkpoint covers all of them.
 */
export function mergeStreamHandlers(...sets: readonly Readonly<Record<string, StreamHandler>>[]) {
  const merged = new Map<string, StreamHandler[]>();
  for (const set of sets) for (const [type, handler] of Object.entries(set)) merged.set(type, [...merged.get(type) ?? [], handler]);
  return Object.fromEntries([...merged].map(([type, handlers]) => [type, (async (db, event) => {
    for (const handler of handlers) await handler(db, event);
  }) satisfies StreamHandler]));
}

export const marketingConsumerGroup = 'marketing';

export function createMarketingStreamConsumers(database: Pool, redis: RedisStreams, name: string,
  extra: Partial<Record<'customer' | 'pos', Readonly<Record<string, StreamHandler>>>> = {}) {
  const handlers: Record<'customer' | 'pos', Record<string, StreamHandler>> = {
    customer: mergeStreamHandlers(groupCustomerHandlers, extra.customer ?? {}),
    pos: mergeStreamHandlers(performancePosHandlers, extra.pos ?? {}),
  };
  return (['customer', 'pos'] as const satisfies readonly EventProducer[]).map(producer => new StreamConsumer({
    database, redis, name, producer, service: 'marketing', group: marketingConsumerGroup, handlers: handlers[producer],
  }));
}
