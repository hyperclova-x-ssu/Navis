import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AccountEventPayloads } from '../../../../packages/contracts/events.ts';

export async function emitAccountEvent<T extends keyof AccountEventPayloads>(
  client: PoolClient, type: T, aggregateId: string, payload: AccountEventPayloads[T],
) {
  await client.query(`
    WITH sequence AS (
      INSERT INTO account.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = account.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO account.outbox (store_id, scope_key, store_seq, event_id, event_type, aggregate_id, payload)
    SELECT $1::uuid, $1, last_seq, $2, $3, $4, $5 FROM sequence
  `, [payload.storeId, randomUUID(), type, aggregateId, payload]);
}
