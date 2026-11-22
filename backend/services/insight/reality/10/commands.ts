import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fingerprint, InsightError, type OwnerScope } from '../../scope.ts';

export type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[]; undoUntil?: string };
export type WriteContext = OwnerScope & { db: PoolClient; at: Date };

export async function appendObservationEvent(
  db: PoolClient, storeId: string, at: Date, eventType: string, aggregateId: string, payload: object,
) {
  await db.query(`
    WITH sequence AS (
      INSERT INTO insight.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = insight.outbox_scope.last_seq + 1 RETURNING last_seq
    ) INSERT INTO insight.outbox (store_id, scope_key, event_id, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT $1::text::uuid, $1, $2, last_seq, $3, $4, $5, $6 FROM sequence`,
  [storeId, randomUUID(), eventType, aggregateId, at, payload]);
}

export async function execute(
  ctx: WriteContext, key: string, input: unknown, apply: () => Promise<Omit<Receipt, 'receiptId'>>,
) {
  const { db, storeId, actorId } = ctx;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('insight.observations:' || $1, 0))", [storeId]);
  const digest = fingerprint(input);
  const { rows: [previous] } = await db.query<{ fingerprint: string; receipt: Receipt }>(`
    SELECT fingerprint, receipt FROM insight.observation_command WHERE store_id=$1 AND actor_id=$2 AND command_key=$3`,
  [storeId, actorId, key]);
  if (previous) {
    if (previous.fingerprint !== digest) throw new InsightError(409, 'IDEMPOTENCY_MISMATCH');
    return previous.receipt;
  }
  const receipt = { ...await apply(), receiptId: randomUUID() };
  await db.query(`INSERT INTO insight.observation_command (store_id, actor_id, command_key, fingerprint, receipt_id, receipt)
    VALUES ($1,$2,$3,$4,$5,$6)`, [storeId, actorId, key, digest, receipt.receiptId, receipt]);
  return receipt;
}
