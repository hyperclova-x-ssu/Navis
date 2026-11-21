import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { transact } from '../../packages/streams/transaction.ts';

export type StoreParams = { storeId: string };
export type OwnerScope = { storeId: string; actorId: string };

export class InsightError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value);

export const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value && !value.startsWith('0000');
};

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function fingerprint(value: unknown) {
  return hash(JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1));
  }));
}
export const bearer = (req: FastifyRequest) => req.headers.authorization?.match(/^Bearer ([^\s,]{1,512})$/i)?.[1];

export function authenticateWorkload(req: FastifyRequest, token: string) {
  const supplied = bearer(req);
  if (!supplied || !timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(token), 'hex'))) {
    throw new InsightError(401, 'UNAUTHENTICATED');
  }
}

export function requireStore(req: FastifyRequest<{ Params: StoreParams }>, token: string): string {
  authenticateWorkload(req, token);
  const { storeId } = req.params;
  if (!isUuid(storeId) || req.headers['x-navis-store-id'] !== storeId) {
    throw new InsightError(403, 'STORE_FORBIDDEN');
  }
  return storeId;
}

export function requireOwner(req: FastifyRequest<{ Params: StoreParams }>, token: string): OwnerScope {
  const storeId = requireStore(req, token);
  const actorId = req.headers['x-navis-user-id'];
  if (!isUuid(actorId) || req.headers['x-navis-store-role'] !== 'owner') {
    throw new InsightError(403, 'STORE_FORBIDDEN');
  }
  return { storeId, actorId };
}

export async function setStore(db: PoolClient, storeId: string) {
  await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
}

export function inStore<T>(pool: Pool, storeId: string, run: (db: PoolClient) => Promise<T>, readOnly = false) {
  return transact(pool, async db => {
    if (readOnly) await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await setStore(db, storeId);
    return run(db);
  });
}
