import type { Pool, PoolClient } from 'pg';
import type { PosOwnerRoute } from './reality/02/routes.ts';
import type { FinanceTx } from './reality/09/input.ts';
import { withStoreTransaction } from './transaction.ts';

type BaseHandler = Parameters<PosOwnerRoute>[3];
type PosRouteParams = Parameters<BaseHandler>[1] & { key?: string };
type RouteHandler = (tx: FinanceTx, params: PosRouteParams, body: unknown, key: string, query: unknown) => ReturnType<BaseHandler>;
type PosScope = Omit<FinanceTx, 'db' | 'at'>;
export type PosPreflight = PosScope & { at: Date; read<T>(inspect: (tx: FinanceTx) => Promise<T>): Promise<T> };
export type PosCommit = (tx: FinanceTx) => Promise<unknown>;
export type PosRouteHandler = RouteHandler | {
  prepare(scope: PosPreflight, params: PosRouteParams, body: unknown, key: string): Promise<PosCommit>;
};
export type PosOwnerRouteWithPreflight = (method: Parameters<PosOwnerRoute>[0], path: string,
  mode: Parameters<PosOwnerRoute>[2], handler: PosRouteHandler) => void;

export async function preparePosRoute(pool: Pool, scope: PosScope, now: () => Date, handler: PosRouteHandler,
  params: PosRouteParams, body: unknown, key: string, query: unknown) {
  if (typeof handler === 'function') {
    return { at: undefined, apply: (db: PoolClient, at: Date) => handler({ ...scope, at, db }, params, body, key, query) };
  }
  const at = now();
  const commit = await handler.prepare({ ...scope, at,
    read: inspect => withStoreTransaction(pool, scope.storeId, db => inspect({ ...scope, at, db }), { readOnly: true }),
  }, params, body, key);
  return { at, apply: (db: PoolClient) => commit({ ...scope, at, db }) };
}
