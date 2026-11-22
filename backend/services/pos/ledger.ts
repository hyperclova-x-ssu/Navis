import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../../packages/contracts/events.ts';
import { fingerprint, PosError, type PosFailure, type PosTx } from './wire.ts';

export type CommandStatus = 'pending' | 'committed' | 'rejected' | 'aborted';
export interface Command<Receipt = unknown, Terminal = unknown, Approval = unknown> {
  fingerprint: string | null;
  status: CommandStatus;
  receipt: Receipt | null;
  terminalReceipt: Terminal | PosFailure | null;
  attemptId: string | null;
  approval: Approval | null;
}

export async function readCommand<R = unknown, T = unknown, A = unknown>(
  { db, storeId }: PosTx, type: string, key: string,
) {
  const { rows } = await db.query<Command<R, T, A>>(`
    SELECT fingerprint, status, receipt, terminal_receipt AS "terminalReceipt", attempt_id AS "attemptId", approval
    FROM pos.command_ledger WHERE store_id = $1 AND command_type = $2 AND command_key = $3
  `, [storeId, type, key]);
  return rows[0];
}

export async function applyCommand<T extends object>(
  tx: PosTx, type: string, key: string, input: object, apply: () => Promise<T>,
): Promise<T> {
  const digest = fingerprint({ actorId: tx.actorId, input });
  const previous = await readCommand<T>(tx, type, key);
  if (previous) {
    if (previous.fingerprint !== digest) throw new PosError(409, 'IDEMPOTENCY_MISMATCH');
    if (previous.status === 'aborted') throw new PosError(409, 'COMMAND_UNDONE');
    if (!previous.receipt) throw new Error('Missing command receipt');
    return previous.receipt;
  }
  const receipt = await apply();
  await tx.db.query(`
    INSERT INTO pos.command_ledger
      (store_id, command_type, command_key, fingerprint, status, receipt, terminal_receipt)
    VALUES ($1, $2, $3, $4, 'committed', $5, $5)
  `, [tx.storeId, type, key, digest, receipt]);
  return receipt;
}

export async function openDay({ db, storeId, at }: PosTx) {
  const { rows } = await db.query<{ date: string; status: string }>(`
    SELECT business_date::text AS date, status FROM pos.business_day
    WHERE store_id = $1 AND starts_at <= $2 AND ends_at > $2
    ORDER BY starts_at DESC LIMIT 2
  `, [storeId, at]);
  if (rows.length > 1) throw new Error('Overlapping POS business days');
  if (rows[0]?.status !== 'open') throw new PosError(409, 'DAY_CLOSED');
  return rows[0].date;
}

export async function nextBusinessSequence({ db, storeId }: PosTx, day: string) {
  const { rows } = await db.query<{ seq: number }>(`
    UPDATE pos.business_day SET seq = seq + 1 WHERE store_id = $1 AND business_date = $2 AND status = 'open'
    RETURNING seq
  `, [storeId, day]);
  if (!rows[0]) throw new PosError(409, 'DAY_CLOSED');
  return rows[0].seq;
}

// TODO(Q3/T-307): Add a separate relay role, head-of-scope relay, checkpointed consumption and replay.
// Production retention, required groups, retry and restore policy are pending review.
export async function appendOutbox<E extends EventEnvelope<'pos', string, object>>(
  { db, storeId, at }: PosTx, eventType: E['eventType'], aggregateId: string, payload: E['payload'],
) {
  const { rows } = await db.query<{ seq: string }>(`
    INSERT INTO pos.outbox_scope (store_id, last_seq) VALUES ($1, 1)
    ON CONFLICT (store_id) DO UPDATE SET last_seq = pos.outbox_scope.last_seq + 1
    RETURNING last_seq AS seq
  `, [storeId]);
  await db.query(`
    INSERT INTO pos.outbox (store_id, scope_key, store_seq, event_id, event_type, aggregate_id, occurred_at, payload)
    VALUES ($1::uuid, $1::uuid::text, $2, $3, $4, $5, $6, $7)
  `, [storeId, rows[0].seq, randomUUID(), eventType, aggregateId, at, payload]);
}
