import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Owner, ProviderResult, SmsEffect, SmsState } from './ports.ts';
import { authorNotification, NoticeError } from './wire.ts';
import type { InquirySource, NoticeDraft } from './wire.ts';

export type Kind = 'inquiry' | 'notice';
type Status = 'waiting' | 'draft_ready' | 'draft' | 'done' | 'deleted';
export type Inquiry = {
  type: 'review' | 'message'; title: string | null; text: string | null; sourceUrl: string | null;
  draft: { text: string; source: 'owner' | 'naver-ai' | 'navis' } | null;
  reply: { text: string; state: 'recorded' | 'saved' | 'accepted' } | null;
};
export type Notice = NoticeDraft & { result: ProviderResult | SmsEffect | { state: 'recorded' } | null };
export type Row = {
  id: string; kind: Kind; revision: number; status: Status; source: InquirySource | null; providerRef: string | null;
  data: Inquiry | Notice; updatedAt: Date;
};
export type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[];
  state: 'saved' | 'recorded' | 'accepted' | 'deleted' | 'rejected' | SmsState; undoUntil?: string; reason?: string };
/** Notice states that keep the Calendar entry: a pending or delivered send still happens on that day. */
const calendarStates = new Set<Receipt['state']>(['saved', 'recorded', 'accepted', 'scheduled', 'sent', 'uncertain']);
type ResultRow = { resourceId: string; fingerprint: string; receiptId: string; receipt: Receipt | null };

const columns = 'id, kind, revision, status, source, provider_ref AS "providerRef", data, updated_at AS "updatedAt"';
export function dto({ data, id, revision, status, source, providerRef, updatedAt, kind }: Row) {
  return { ...data, id, revision, status, source, providerRef, updatedAt,
    ...(kind === 'inquiry' && (data as Inquiry).type === 'review' ? { authorNotification } : {}) };
}

export async function get(db: PoolClient, storeId: string, kind: Kind, id: string, includeDeleted = false) {
  const { rows: [row] } = await db.query<Row>(`SELECT ${columns} FROM marketing.reply_notice_record
    WHERE store_id=$1 AND kind=$2 AND id=$3`, [storeId, kind, id]);
  if (!row || !includeDeleted && row.status === 'deleted') throw new NoticeError(404, 'NOT_FOUND');
  return row;
}

export async function list(db: PoolClient, storeId: string, kind: Kind, input: { cursor: string | null; limit: number },
  asOf: Date) {
  const { rows } = await db.query<Row>(`SELECT ${columns} FROM marketing.reply_notice_record
    WHERE store_id=$1 AND kind=$2 AND ($3::uuid IS NULL OR id>$3) AND status<>'deleted'
    ORDER BY id LIMIT $4`, [storeId, kind, input.cursor, input.limit + 1]);
  const { rows: [stats] } = await db.query<{ sourceRevision: string; waitingCount: number }>(`SELECT
    COALESCE(SUM(revision),0)::text AS "sourceRevision",
    COUNT(*) FILTER (WHERE status IN ('draft', 'waiting', 'draft_ready'))::int AS "waitingCount"
    FROM marketing.reply_notice_record WHERE store_id=$1 AND kind=$2`, [storeId, kind]);
  return { items: rows.slice(0, input.limit).map(dto), nextCursor: rows.length > input.limit ? rows[input.limit - 1].id : null,
    asOf: asOf.toISOString(), sourceRevision: Number(stats.sourceRevision), waitingCount: stats.waitingCount };
}

export async function byKey(db: PoolClient, owner: Owner, key: string, fingerprint: string) {
  const { rows: [row] } = await db.query<ResultRow>(`SELECT resource_id AS "resourceId", fingerprint, receipt_id AS "receiptId", receipt
    FROM marketing.reply_notice_command WHERE store_id=$1 AND actor_id=$2 AND action_key=$3`, [owner.storeId, owner.actorId, key]);
  if (row && row.fingerprint !== fingerprint) throw new NoticeError(409, 'IDEMPOTENCY_CONFLICT');
  return row;
}

export async function byReceipt(db: PoolClient, owner: Owner, receiptId: string) {
  const { rows: [row] } = await db.query<Pick<ResultRow, 'resourceId' | 'receipt'>>(
    `SELECT resource_id AS "resourceId", receipt FROM marketing.reply_notice_command
     WHERE store_id=$1 AND actor_id=$2 AND receipt_id=$3`, [owner.storeId, owner.actorId, receiptId]);
  if (!row) throw new NoticeError(404, 'NOT_FOUND');
  return row.receipt ?? { resourceId: row.resourceId, receiptId, state: 'pending-reconciliation' };
}

export async function assertWritable(db: PoolClient, storeId: string, resourceId: string, approvalId?: string) {
  const { rowCount } = await db.query(`SELECT 1 FROM marketing.reply_notice_command WHERE store_id=$1
    AND ((resource_id=$2 AND receipt IS NULL) OR approval_id=$3)`, [storeId, resourceId, approvalId ?? null]);
  if (rowCount) throw new NoticeError(409, 'PENDING_OR_USED_APPROVAL');
}

export async function insert(db: PoolClient, storeId: string, row: Row) {
  const result = await db.query(`INSERT INTO marketing.reply_notice_record(store_id,id,kind,revision,status,source,provider_ref,data,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (store_id,source,provider_ref) DO NOTHING`,
  [storeId, row.id, row.kind, row.revision, row.status, row.source, row.providerRef, row.data, row.updatedAt]);
  if (!result.rowCount) throw new NoticeError(409, 'INQUIRY_ALREADY_RECORDED');
}

export async function reserve(db: PoolClient, owner: Owner, row: Row, key: string, fingerprint: string, approvalId?: string) {
  const id = randomUUID();
  await db.query(`INSERT INTO marketing.reply_notice_command(store_id,actor_id,action_key,resource_id,approval_id,fingerprint,receipt_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [owner.storeId, owner.actorId, key, row.id, approvalId ?? null, fingerprint, id]);
  return id;
}

export async function complete(db: PoolClient, owner: Owner, row: Row, receiptId: string, state: Receipt['state'],
  period?: { date: string; endDate?: string }, undoUntil?: string) {
  const receipt: Receipt = { resourceId: row.id, revision: row.revision, receiptId, state, ...(undoUntil && { undoUntil }),
    affectedSources: row.kind === 'inquiry' ? ['inquiries', 'marketing-today'] : ['notices', 'briefing', 'calendar'] };
  await db.query(`UPDATE marketing.reply_notice_record SET revision=$3, status=$4, data=$5, updated_at=$6
    WHERE store_id=$1 AND id=$2`, [owner.storeId, row.id, row.revision, row.status, row.data, row.updatedAt]);
  await db.query(`UPDATE marketing.reply_notice_command SET receipt=$3 WHERE store_id=$1 AND receipt_id=$2`,
    [owner.storeId, receiptId, receipt]);
  await publishRecordChange(db, owner.storeId, row, state, receiptId, period);
  return receipt;
}

/**
 * Finish an attempt whose effect is known to have sent nothing (RV-GAP-B-5). The record keeps its revision and no
 * event is published. The approval stays consumed, so a retry needs a fresh card; the same key replays the rejection.
 */
export async function reject(db: PoolClient, owner: Owner, row: Row, receiptId: string, revision: number, reason: string) {
  const receipt: Receipt = { resourceId: row.id, revision, receiptId, state: 'rejected', reason,
    affectedSources: row.kind === 'inquiry' ? ['inquiries', 'marketing-today'] : ['notices', 'briefing', 'calendar'] };
  await db.query(`UPDATE marketing.reply_notice_command SET receipt=$3 WHERE store_id=$1 AND receipt_id=$2`,
    [owner.storeId, receiptId, receipt]);
  return receipt;
}

export async function publishRecordChange(db: PoolClient, storeId: string, row: Row, state: Receipt['state'],
  receiptId?: string, period?: { date: string; endDate?: string }) {
  const eventType = row.kind === 'inquiry' ? 'marketing.inquiry_changed.v1' : 'marketing.message_status_changed.v1';
  const payload = { revision: row.revision, status: row.status, state, receiptId, ...(row.kind === 'notice' && {
    closure: (row.data as Notice).closure,
    calendarProjection: { source: 'notice', sourceId: row.id, revision: row.revision,
      entry: period && row.status === 'done' && calendarStates.has(state) ? period : null },
  }) };
  await db.query(`WITH seq AS (
    INSERT INTO marketing.outbox_scope(scope_key,last_seq) VALUES ($2::text,1)
    ON CONFLICT (scope_key) DO UPDATE SET last_seq=marketing.outbox_scope.last_seq+1 RETURNING last_seq
  ) INSERT INTO marketing.outbox(event_id,store_id,scope_key,store_seq,event_type,aggregate_id,occurred_at,payload)
    SELECT $1,$2::text::uuid,$2::text,last_seq,$3,$4,$5,$6 FROM seq`,
  [randomUUID(), storeId, eventType, row.id, row.updatedAt, payload]);
}
