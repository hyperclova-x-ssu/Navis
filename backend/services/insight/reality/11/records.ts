import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fingerprint, InsightError, type OwnerScope } from '../../scope.ts';

export type Kind = 'manual' | 'draft' | 'checklist' | 'notice' | 'application';
export type Data = Record<string, unknown>;
export type Row = {
  id: string; kind: Kind; parentId: string | null; businessDay: string | null;
  data: Data; revision: number; updatedAt: Date; archived: boolean;
};
export type Change = Pick<Row, 'id' | 'kind' | 'parentId' | 'businessDay' | 'data' | 'archived'>;
export type Context = OwnerScope & { db: PoolClient; now: Date; businessDay: string };
export type Receipt = {
  resourceId: string; revision: number; receiptId: string; affectedSources: string[];
  undoUntil?: string; changed: boolean;
};
const columns = 'id, kind, parent_id AS "parentId", business_day::text AS "businessDay", data, revision, updated_at AS "updatedAt", archived';
export const missing = () => new InsightError(404, 'NOT_FOUND');
export const conflict = (code: string) => new InsightError(409, code);

export async function lockCommands(db: PoolClient, storeId: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('insight:manuals-grants:' || $1::text, 0))", [storeId]);
}

export function create(kind: Kind, data: Data, options: { id?: string; parentId?: string; businessDay?: string } = {}): Change {
  return { id: options.id ?? randomUUID(), kind, data, parentId: options.parentId ?? null,
    businessDay: options.businessDay ?? null, archived: false };
}

export async function byId(ctx: Context, kind: Kind, id: string, includeArchived = false) {
  const { rows: [row] } = await ctx.db.query<Row>(
    `SELECT ${columns} FROM insight.manuals_grants_record WHERE store_id=$1 AND kind=$2 AND id=$3 AND ($4 OR NOT archived)`,
    [ctx.storeId, kind, id, includeArchived]);
  return row;
}

export async function list(ctx: Context, kind: Kind, query: {
  cursor: string | null; limit: number; from: string | null; to: string | null; parentId: string | null;
}) {
  const { rows } = await ctx.db.query<Row>(`SELECT ${columns} FROM insight.manuals_grants_record
    WHERE store_id=$1 AND kind=$2 AND NOT archived AND ($3::uuid IS NULL OR id>$3)
      AND ($4::date IS NULL OR business_day >= $4) AND ($5::date IS NULL OR business_day <= $5)
      AND ($6::uuid IS NULL OR parent_id=$6)
    ORDER BY id LIMIT $7`, [ctx.storeId, kind, query.cursor, query.from, query.to, query.parentId, query.limit + 1]);
  return rows;
}

export async function sourceRevision(ctx: Context) {
  const { rows: [row] } = await ctx.db.query<{ revision: number }>(
    'SELECT revision FROM insight.manuals_grants_revision WHERE store_id=$1', [ctx.storeId]);
  return row?.revision ?? 0;
}

export async function currentChecklist(ctx: Context, manual: Row) {
  const { rows: [row] } = await ctx.db.query<Row>(`SELECT ${columns} FROM insight.manuals_grants_record
    WHERE store_id=$1 AND kind='checklist' AND parent_id=$2 AND business_day=$3
      AND data->>'manualRevision'=$4 AND NOT archived`,
  [ctx.storeId, manual.id, ctx.businessDay, String(manual.data.checklistVersion)]);
  return row;
}

export async function noticesForSync(ctx: Context, ids: string[]) {
  const { rows } = await ctx.db.query<Row>(`SELECT ${columns} FROM insight.manuals_grants_record
    WHERE store_id=$1 AND kind='notice' AND (NOT archived OR id = ANY($2::uuid[]))`, [ctx.storeId, ids]);
  return rows;
}

export async function briefingFacts(ctx: Context) {
  const { rows: [facts] } = await ctx.db.query<{
    openingChecked: number; openingSteps: number; upcomingGrantDeadlines: number;
  }>(`SELECT
    coalesce((SELECT sum(jsonb_array_length(c.data->'checkedSteps')) FROM insight.manuals_grants_record m
      JOIN insight.manuals_grants_record c ON c.store_id=m.store_id AND c.parent_id=m.id
      WHERE m.store_id=$1 AND m.kind='manual' AND NOT m.archived AND m.data->>'isPublished'='true'
        AND m.data->>'category'='opening' AND c.kind='checklist' AND NOT c.archived AND c.business_day=$2::date
        AND c.data->>'manualRevision'=m.data->>'checklistVersion'), 0)::int AS "openingChecked",
    coalesce((SELECT sum(jsonb_array_length(data->'steps')) FROM insight.manuals_grants_record
      WHERE store_id=$1 AND kind='manual' AND NOT archived AND data->>'isPublished'='true'
        AND data->>'category'='opening'), 0)::int AS "openingSteps",
    (SELECT count(*) FROM insight.manuals_grants_record WHERE store_id=$1 AND kind='notice' AND NOT archived
      AND data->>'deadline' BETWEEN $2::date::text AND ($2::date + 7)::text)::int AS "upcomingGrantDeadlines"`,
  [ctx.storeId, ctx.businessDay]);
  return { ...facts!, businessDay: ctx.businessDay, asOf: ctx.now.toISOString(), sourceRevision: await sourceRevision(ctx) };
}

const sources: Record<Kind, string[]> = {
  manual: ['manuals', 'checklists', 'briefing'], draft: ['manuals'], checklist: ['checklists', 'manuals', 'briefing'],
  notice: ['grants', 'briefing', 'calendar'], application: ['grants', 'briefing'],
};

async function persist(ctx: Context, change: Change, sourceRev: number, operation: string) {
  const { db, storeId, actorId, now } = ctx;
  const { rows: [row] } = await db.query<{ revision: number }>(`INSERT INTO insight.manuals_grants_record
    (store_id, id, kind, parent_id, business_day, data, revision, updated_at, archived)
    VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8) ON CONFLICT (store_id,id) DO UPDATE
    SET data=EXCLUDED.data, revision=insight.manuals_grants_record.revision+1,
      updated_at=EXCLUDED.updated_at, archived=EXCLUDED.archived RETURNING revision`,
  [storeId, change.id, change.kind, change.parentId, change.businessDay, change.data, now, change.archived]);
  const revision = row!.revision;
  await db.query(`INSERT INTO insight.manuals_grants_history
    (store_id,resource_id,revision,actor_id,updated_at,operation,snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [storeId, change.id, revision, actorId, now, operation, change]);
  const grants = change.kind === 'notice' || change.kind === 'application';
  const type = grants ? 'insight.grant_review_changed.v1' : 'insight.manual_check_changed.v1';
  if (change.kind === 'draft') return revision;
  const deadline = change.archived ? null : change.data.deadline;
  const calendarProjection = change.kind === 'notice' ? { source: 'grant-deadline', sourceId: change.id, revision,
    entry: typeof deadline === 'string' ? { date: deadline } : null } : undefined;
  const payload = { resourceId: change.id, revision, sourceRevision: sourceRev, operation, kind: change.kind,
    affectedSources: sources[change.kind], ...(calendarProjection && { calendarProjection }) };
  await db.query(`WITH seq AS (
    INSERT INTO insight.outbox_scope (scope_key, last_seq) VALUES ($1,1)
    ON CONFLICT (scope_key) DO UPDATE SET last_seq=insight.outbox_scope.last_seq+1 RETURNING last_seq
    ) INSERT INTO insight.outbox (store_id,scope_key,event_id,store_seq,event_type,aggregate_id,occurred_at,payload)
    SELECT $1::uuid,$1::text,$2,last_seq,$3,$4,$5,$6 FROM seq`, [storeId, randomUUID(), type, change.id, now, payload]);
  return revision;
}

type Inverse = { afterRevision: number; before: Change };
type Stored = { receipt: Receipt; inverse: Inverse[] | null; undone_at: Date | null; fingerprint: string };
export async function undo(ctx: Context, receiptId: string) {
  const { rows: [original] } = await ctx.db.query<Stored>(`SELECT receipt,inverse,undone_at FROM insight.manuals_grants_command
    WHERE store_id=$1 AND actor_id=$2 AND receipt_id=$3`, [ctx.storeId, ctx.actorId, receiptId]);
  if (!original) throw missing();
  if (original.undone_at || !original.inverse || !original.receipt.undoUntil
    || Date.parse(original.receipt.undoUntil) <= ctx.now.getTime()) throw conflict('UNDO_UNAVAILABLE');
  for (const { afterRevision, before } of original.inverse) {
    if ((await byId(ctx, before.kind, before.id, true))?.revision !== afterRevision) throw conflict('STALE_REVISION');
    if (before.kind === 'application' && !before.archived) {
      const { rowCount } = await ctx.db.query(`SELECT 1 FROM insight.manuals_grants_record
        WHERE store_id=$1 AND kind='application' AND parent_id=$2 AND NOT archived AND id<>$3`,
      [ctx.storeId, before.parentId, before.id]);
      if (rowCount) throw conflict('STALE_REVISION');
    }
  }
  await ctx.db.query(`UPDATE insight.manuals_grants_command SET undone_at=$4
    WHERE store_id=$1 AND actor_id=$2 AND receipt_id=$3`, [ctx.storeId, ctx.actorId, receiptId, ctx.now]);
  return { resourceId: original.receipt.resourceId, changes: original.inverse.map(item => item.before) };
}

export async function run(ctx: Context, key: string, input: Data, operation: string,
  perform: () => Promise<{ resourceId: string; revision?: number; changes: Change[] }>) {
  const { db, storeId, actorId, now } = ctx;
  const hash = fingerprint(input);
  const { rows: [original] } = await db.query<Stored>(`SELECT fingerprint,receipt FROM insight.manuals_grants_command
    WHERE store_id=$1 AND actor_id=$2 AND command_key=$3`, [storeId, actorId, key]);
  if (original) {
    if (original.fingerprint !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
    return original.receipt;
  }
  const { resourceId, changes, revision: previousRevision } = await perform();
  const receipt: Receipt = { resourceId, receiptId: randomUUID(), revision: previousRevision ?? 0, changed: changes.length > 0,
    affectedSources: [...new Set(changes.flatMap(change => sources[change.kind]))] };
  const inverse: Inverse[] = [];
  if (changes.length) {
    const { rows: [source] } = await db.query<{ revision: number }>(`INSERT INTO insight.manuals_grants_revision (store_id,revision)
      VALUES ($1,1) ON CONFLICT (store_id) DO UPDATE SET revision=insight.manuals_grants_revision.revision+1 RETURNING revision`, [storeId]);
    for (const change of changes) {
      const before = await byId(ctx, change.kind, change.id, true) ?? { ...change, archived: true };
      const revision = await persist(ctx, change, source!.revision, operation);
      if (change.id === resourceId) receipt.revision = revision;
      inverse.push({ afterRevision: revision, before });
    }
  }
  const canUndo = inverse.length > 0 && !['undo', 'sync'].includes(operation);
  if (canUndo) receipt.undoUntil = new Date(now.getTime() + 6000).toISOString();
  await db.query(`INSERT INTO insight.manuals_grants_command (store_id,actor_id,command_key,fingerprint,receipt_id,receipt,inverse)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [storeId, actorId, key, hash, receipt.receiptId, receipt, canUndo ? JSON.stringify(inverse) : null]);
  return receipt;
}

export function dto(row: Row) {
  return { ...row.data, id: row.id, revision: row.revision, updatedAt: row.updatedAt.toISOString(),
    ...(row.businessDay && { businessDay: row.businessDay }) };
}

export async function history(ctx: Context, kind: Kind, id: string, cursor: number | null, limit: number) {
  if (!await byId(ctx, kind, id, true)) throw missing();
  const { rows } = await ctx.db.query(`SELECT revision,updated_at AS "updatedAt",operation,snapshot
    FROM insight.manuals_grants_history WHERE store_id=$1 AND resource_id=$2 AND ($3::integer IS NULL OR revision<$3)
    ORDER BY revision DESC LIMIT $4`, [ctx.storeId, id, cursor, limit + 1]);
  return rows;
}
