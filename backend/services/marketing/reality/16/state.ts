import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fingerprint, type PromoInput } from '../../promo/contracts.ts';
import { inStore } from '../../transaction.ts';
import { badRequest, conflict, notFound, type Channel } from './wire.ts';

export type Owner = { storeId: string; actorId: string };
export type Source = 'promo-assets' | 'promo-drafts' | 'promo-publications' | 'promo-jobs';
export type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: Source[] };
export type Draft = { draftId: string; revision: number; input: Partial<PromoInput>; jobId: string | null; updatedAt: Date };
export type Asset = { assetId: string; fileId: string; menuId: string | null; width: number; height: number };
export type Publication = { publicationId: string; jobId: string; channel: Channel; method: 'attestation' | 'provider';
  state: 'pending' | 'published' | 'failed'; revision: number; providerRef: string | null; link: string | null; createdAt: Date };

export const draftColumns = 'draft_id AS "draftId", revision, input, job_id AS "jobId", updated_at AS "updatedAt"';
export const assetColumns = 'asset_id AS "assetId", file_id AS "fileId", menu_id AS "menuId", width, height';
export const publicationColumns = `publication_id AS "publicationId", job_id AS "jobId", channel, method,
  state, revision, provider_ref AS "providerRef", link, created_at AS "createdAt"`;

export async function getDraft(db: PoolClient, storeId: string, draftId: string) {
  const { rows: [draft] } = await db.query<Draft>(
    `SELECT ${draftColumns} FROM marketing.promo_draft WHERE store_id = $1 AND draft_id = $2`, [storeId, draftId]);
  if (!draft) throw notFound();
  return draft;
}

export async function emitPromoChange(db: PoolClient, storeId: string, receipt: Receipt, eventType = 'marketing.promo_status_changed.v1') {
  const eventId = randomUUID();
  await db.query(`
    WITH seq AS (
      INSERT INTO marketing.outbox_scope (scope_key, last_seq) VALUES ($2::text, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = marketing.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO marketing.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT $1, $2::text::uuid, $2::text, last_seq, $3, $4, clock_timestamp(), $5
    FROM seq`, [eventId, storeId, eventType, receipt.receiptId, JSON.stringify({
    resourceId: receipt.resourceId,
    revision: receipt.revision, affectedSources: receipt.affectedSources,
  })]);
}

type Mutation<T> = (db: PoolClient, receiptId: string) => Promise<T>;
type CommandResult<T> = { value: T; replayed: boolean };

async function replay<T>(db: PoolClient, owner: Owner, key: string, hash: string): Promise<CommandResult<T> | null> {
  const { rows: [prior] } = await db.query<{ fingerprint: string; receipt: T }>(
    'SELECT fingerprint, receipt FROM marketing.promo_command WHERE store_id = $1 AND command_key = $2',
    [owner.storeId, key]);
  if (!prior) return null;
  if (prior.fingerprint !== hash) throw conflict('IDEMPOTENCY_CONFLICT');
  return { value: prior.receipt, replayed: true };
}

async function runCommand<T extends { receipt: Receipt }>(pool: Pool, owner: Owner, key: unknown, effect: unknown,
  operation: { mutate: Mutation<T> } | { prepare: () => Promise<Mutation<T>> }) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(key)) throw badRequest();
  const hash = fingerprint([owner.actorId, effect]);
  let mutate: Mutation<T>;
  if ('mutate' in operation) {
    mutate = operation.mutate;
  } else {
    const readReplay = () => inStore(pool, owner.storeId, db => replay<T>(db, owner, key, hash));
    const prior = await readReplay();
    if (prior) return prior;
    try {
      mutate = await operation.prepare();
    } catch (error) {
      // A concurrent request may have committed the same command during preparation.
      const committed = await readReplay();
      if (committed) return committed;
      throw error;
    }
  }
  return inStore(pool, owner.storeId, async db => {
    const prior = await replay<T>(db, owner, key, hash);
    if (prior) return prior;
    const value = await mutate(db, randomUUID());
    await db.query('INSERT INTO marketing.promo_command (store_id, command_key, fingerprint, receipt) VALUES ($1, $2, $3, $4)',
      [owner.storeId, key, hash, value]);
    await emitPromoChange(db, owner.storeId, value.receipt);
    return { value, replayed: false };
  }, { serialize: true });
}

export function command<T extends { receipt: Receipt }>(pool: Pool, owner: Owner, key: unknown, effect: unknown, mutate: Mutation<T>) {
  return runCommand(pool, owner, key, effect, { mutate });
}

export function preparedCommand<T extends { receipt: Receipt }>(pool: Pool, owner: Owner, key: unknown, effect: unknown,
  prepare: () => Promise<Mutation<T>>) {
  return runCommand(pool, owner, key, effect, { prepare });
}

export function receipt(receiptId: string, resourceId: string, revision: number, ...affectedSources: Source[]): Receipt {
  return { receiptId, resourceId, revision, affectedSources };
}
