import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isRecord, isUuid } from '../../pos-client.ts';

export class MemberError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly details?: object;
  readonly field?: string;
  constructor(status: number, reason: string, details?: object, field?: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.details = details;
    this.field = field;
  }
}

export type CustomerTx = { db: PoolClient; storeId: string; actorId: string; at: Date; day: string };
export type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[];
  undoUntil?: string; memberId?: string; customerId?: string; noteId?: string };
export const memberSources = ['customers', 'members', 'customer-groups', 'voice-booking', 'pos.member-accounts'];
const undoMs = 6000;
export function object(input: unknown, keys: readonly string[]) {
  if (!isRecord(input) || Object.keys(input).some(key => !keys.includes(key))) throw new MemberError(400, 'INVALID_REQUEST');
  return input;
}
export function id(input: unknown) {
  const value = typeof input === 'string' ? input.toLowerCase() : input;
  if (!isUuid(value)) throw new MemberError(400, 'INVALID_REQUEST');
  return value;
}
export function integer(input: unknown, min = 1, max = 2_147_483_647) {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) {
    throw new MemberError(400, 'INVALID_REQUEST');
  }
  return input;
}
export function key(input: unknown) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_:.~-]{1,160}$/.test(input)) throw new MemberError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  return input;
}
export function text(input: unknown, max: number, reason = 'INVALID_REQUEST', field?: string) {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > max || input.includes('\u0000')) {
    throw new MemberError(400, reason, undefined, field);
  }
  return input.trim();
}
export function confirm(input: unknown) {
  if (input !== true) throw new MemberError(400, 'CONFIRMATION_REQUIRED');
}
export function revision(actual: number, expected: number) {
  if (actual !== expected) throw new MemberError(409, 'STALE_REVISION', { revision: actual });
}
export function limit(input: unknown) {
  if (input === undefined) return 50;
  if (typeof input !== 'string' || !/^[1-9][0-9]{0,2}$/.test(input)) throw new MemberError(400, 'INVALID_REQUEST');
  return integer(Number(input), 1, 200);
}
export function page<T>(rows: T[], take: number, cursor: (row: T) => string, tx: CustomerTx, sourceRevision: number) {
  const items = rows.slice(0, take);
  return { items, nextCursor: rows.length > take ? cursor(items[take - 1]) : null,
    asOf: tx.at.toISOString(), sourceRevision };
}
export async function sourceRevision({ db, storeId }: CustomerTx) {
  const { rows: [row] } = await db.query<{ last_seq: string }>('SELECT last_seq FROM customer.outbox_scope WHERE scope_key = $1', [storeId]);
  return Number(row?.last_seq ?? 0);
}
export async function event({ db, storeId, at }: CustomerTx, type: string, aggregateId: string, payload: object) {
  const { rows: [row] } = await db.query<{ last_seq: string }>(`
    INSERT INTO customer.outbox_scope (scope_key,last_seq) VALUES ($1,1)
    ON CONFLICT (scope_key) DO UPDATE SET last_seq = customer.outbox_scope.last_seq + 1 RETURNING last_seq
  `, [storeId]);
  await db.query(`
    INSERT INTO customer.outbox (store_id,scope_key,store_seq,event_id,event_type,aggregate_id,occurred_at,payload)
    VALUES ($1::uuid,$1::text,$2,$3,$4,$5,$6,$7)
  `, [storeId, row.last_seq, randomUUID(), type, aggregateId, at, payload]);
}
export async function locked({ db, storeId }: CustomerTx) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('customer:members:' || $1, 0))", [storeId]);
}
export async function apply(tx: CustomerTx, requestKey: string, action: string, input: object,
  run: () => Promise<{ receipt: Omit<Receipt, 'receiptId' | 'undoUntil'>; inverse?: object }>) {
  const { db, storeId, actorId, at } = tx;
  await locked(tx);
  const fingerprint = createHash('sha256').update(JSON.stringify({ actorId, action, input }, (_key, value: unknown) =>
    isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
  const { rows: [previous] } = await db.query<{ fingerprint: string; receipt: Receipt }>(
    'SELECT fingerprint, receipt FROM customer.member_command WHERE store_id = $1 AND request_key = $2', [storeId, requestKey]);
  if (previous) {
    if (fingerprint !== previous.fingerprint) throw new MemberError(409, 'IDEMPOTENCY_MISMATCH');
    return previous.receipt;
  }
  const { receipt: value, inverse } = await run();
  const receipt: Receipt = { ...value, receiptId: randomUUID(),
    ...(inverse && { undoUntil: new Date(at.getTime() + undoMs).toISOString() }) };
  await db.query(`
    INSERT INTO customer.member_command (store_id, request_key, actor_id, fingerprint, receipt_id, receipt, inverse)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [storeId, requestKey, actorId, fingerprint, receipt.receiptId, receipt, inverse ?? null]);
  return receipt;
}
