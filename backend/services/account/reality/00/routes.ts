import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { SessionClaims } from '../../keys.ts';
import { liveRole, storesForSession } from '../../sessions.ts';
import { inStore } from '../../transaction.ts';
import { boardIds, parseBoard, readBoards, saveBoard } from './boards.ts';
import { emitAccountEvent } from './outbox.ts';
import { parsePreferences, parseProfile, readPreferences, readProfile, savePreferences, saveProfile } from './settings.ts';
import { AccountError, actorFrom, invalid, keyPattern, option } from './wire.ts';

export const accountRoot = '/internal/v1/account/stores/:storeId';
export const notFound = () => new AccountError(404, 'NOT_FOUND');
export type AccountParams = { storeId: string; boardId?: string; fileId?: string };
type Params = AccountParams;
type ActorHandler = (client: PoolClient, actor: SessionClaims, request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => Promise<unknown>;

export async function accountErrors(reply: FastifyReply, run: () => Promise<unknown>) {
  try { return await run(); } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    return reply.code(error.statusCode).send({ code: error.code,
      ...(error.reason && { reason: error.reason }), ...(error.field && { field: error.field }) });
  }
}

export function accountStoreHandler(pool: Pool, ownerOnly: boolean, handler: ActorHandler, lock = false) {
  return (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => accountErrors(reply, async () => {
    const actor = actorFrom(request);
    if (actor.store_id !== request.params.storeId.toLowerCase() || (ownerOnly && actor.role !== 'owner')) {
      throw new AccountError(403, 'STORE_FORBIDDEN');
    }
    return inStore(pool, actor.store_id, async client => {
      if (lock) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('account:' || $1, 0))", [actor.store_id]);
      const role = await liveRole(client, actor, lock);
      if (!role) throw new AccountError(401, 'UNAUTHENTICATED');
      if (role !== actor.role) throw new AccountError(403, 'STORE_FORBIDDEN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [actor.sub]);
      return handler(client, actor, request, reply);
    });
  });
}

type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[] };

async function command(
  client: PoolClient, actor: SessionClaims, request: FastifyRequest, resourceId: string, source: string,
  input: { expected: number }, apply: (checkRevision: (revision: number) => number) => Promise<number>,
): Promise<Receipt> {
  const { 'idempotency-key': key } = request.headers;
  if (typeof key !== 'string' || !keyPattern.test(key)) throw invalid('idempotencyKey', 'IDEMPOTENCY_KEY_REQUIRED');
  const { store_id: storeId, sub: userId } = actor;
  const hash = createHash('sha256').update(JSON.stringify([source, resourceId, input])).digest();
  const { rows: [previous] } = await client.query<{ fingerprint: Buffer; result: Receipt }>(`
    SELECT fingerprint, result FROM account.command_receipt WHERE store_id = $1 AND user_id = $2 AND idempotency_key = $3
  `, [storeId, userId, key]);
  if (previous) {
    if (!hash.equals(previous.fingerprint)) throw new AccountError(409, 'CONFLICT', 'IDEMPOTENCY_CONFLICT');
    return previous.result;
  }
  const revision = await apply(current => {
    if (current !== input.expected) throw new AccountError(409, 'CONFLICT', 'STALE_REVISION');
    return current + 1;
  });
  const result = { resourceId, revision, receiptId: randomUUID(), affectedSources: [source] };
  await client.query(`
    INSERT INTO account.command_receipt (store_id, user_id, idempotency_key, fingerprint, receipt_id, result)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [storeId, userId, key, hash, result.receiptId, result]);
  return result;
}

export function registerAccountRecords(app: FastifyInstance, pool: Pool, verifyWorkload: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const options = { onRequest: verifyWorkload };
  app.get('/internal/v1/account/stores', options, (request, reply) => accountErrors(reply, async () => {
    const list = await storesForSession(pool, actorFrom(request));
    if (!list) throw new AccountError(401, 'UNAUTHENTICATED');
    return list;
  }));
  app.get<{ Params: Params }>(`${accountRoot}/operating-clock`, options, accountStoreHandler(pool, true, async (client, { store_id: storeId }) => {
    const { rows: [clock] } = await client.query(`
      SELECT timezone, business_day_start::text AS "businessDayStart" FROM account.store WHERE store_id = $1
    `, [storeId]);
    if (!clock) throw notFound();
    return clock;
  }));
  app.get<{ Params: Params }>(`${accountRoot}/profile`, options, accountStoreHandler(pool, false, async (client, { store_id: storeId }) => {
    const profile = await readProfile(client, storeId);
    if (!profile) throw notFound();
    return profile;
  }));
  app.patch<{ Params: Params }>(`${accountRoot}/profile`, options, accountStoreHandler(pool, true, (client, actor, request) => {
    const input = parseProfile(request.body);
    const storeId = actor.store_id;
    return command(client, actor, request, storeId, 'profile', input, async next => {
      const current = await readProfile(client, storeId);
      if (!current) throw notFound();
      const revision = next(current.revision);
      await saveProfile(client, { ...current, ...input.patch }, revision);
      await emitAccountEvent(client, 'account.store_changed.v1', storeId, { storeId, revision });
      return revision;
    });
  }, true));
  app.get<{ Params: Params }>(`${accountRoot}/preferences`, options, accountStoreHandler(pool, false, (client, actor) =>
    readPreferences(client, actor.store_id, actor.sub)));
  app.patch<{ Params: Params }>(`${accountRoot}/preferences`, options, accountStoreHandler(pool, false, (client, actor, request) => {
    const input = parsePreferences(request.body);
    const { store_id: storeId, sub: userId } = actor;
    return command(client, actor, request, userId, 'preferences', input, async next => {
      const current = await readPreferences(client, storeId, userId);
      const revision = next(current.revision);
      await savePreferences(client, storeId, userId, { ...current, ...input.patch }, revision);
      await emitAccountEvent(client, 'account.preferences_changed.v1', userId, { storeId, userId, revision });
      return revision;
    });
  }, true));
  app.get<{ Params: Params }>(`${accountRoot}/boards`, options, accountStoreHandler(pool, false, async (client, { store_id: storeId }) => {
    const items = await readBoards(client, storeId);
    return { items, nextCursor: null, asOf: new Date().toISOString(), sourceRevision: items.reduce((sum, item) => sum + item.revision, 0) };
  }));
  app.put<{ Params: Params }>(`${accountRoot}/boards/:boardId`, options, accountStoreHandler(pool, true, (client, actor, request) => {
    const boardId = option(request.params.boardId, boardIds, 'boardId');
    const input = parseBoard(request.body, boardId);
    const storeId = actor.store_id;
    return command(client, actor, request, boardId, 'boards', input, async next => {
      const previous = (await readBoards(client, storeId)).find(board => board.boardId === boardId)!;
      const revision = next(previous.revision);
      await saveBoard(client, storeId, previous, input, revision);
      return revision;
    });
  }, true));
}
