import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { withStoreTransaction } from '../../store-transaction.ts';
import { parseCommand, runStockCommand } from './commands.ts';
import { listBatches, listItems, listMovements, operatingDay } from './read.ts';
import { date, isUuid, keyPattern, StockError, uuid } from './wire.ts';

type Params = { storeId: string; itemId?: string; batchId?: string; receiptId?: string };
type Request = FastifyRequest<{ Params: Params; Querystring: Record<string, unknown> }>;
const root = '/internal/v1/inventory/stores/:storeId';
const hash = (value: string) => createHash('sha256').update(value).digest();
const codes = { 400: 'VALIDATION', 404: 'NOT_FOUND', 409: 'CONFLICT', 503: 'SERVICE_UNAVAILABLE' };

function failure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof StockError)) throw error;
  return reply.code(error.status).send({ code: codes[error.status], reason: error.reason, field: error.field });
}

function operatingClock(headers: Request['headers']) {
  const timezone = headers['x-navis-store-timezone'];
  const dayStart = headers['x-navis-business-day-start'];
  return { timezone: typeof timezone === 'string' ? timezone : undefined, dayStart: typeof dayStart === 'string' ? dayStart : undefined };
}

export function registerStockRoutes(
  app: FastifyInstance, pool: Pool, gatewayToken: string, { now = () => new Date() } = {},
) {
  const digest = hash(gatewayToken);
  const onRequest = async (req: Request, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]{1,512})$/i)?.[1];
    if (!bearer || !timingSafeEqual(hash(bearer), digest)) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const store = req.headers['x-navis-store-id'];
    if (!isUuid(req.params.storeId)) return failure(reply, new StockError(400, 'INVALID_REQUEST', 'storeId'));
    if (!isUuid(store) || store.toLowerCase() !== req.params.storeId.toLowerCase()
      || req.headers['x-navis-store-role'] !== 'owner' || !isUuid(req.headers['x-navis-user-id'])) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  };
  const writeOptions = { onRequest, bodyLimit: 16 * 1024 };

  function read(query: (db: PoolClient, storeId: string, at: Date, req: Request) => Promise<unknown>) {
    return async (req: Request, reply: FastifyReply) => {
      try {
        const storeId = req.params.storeId.toLowerCase();
        return await withStoreTransaction(pool, storeId, db => query(db, storeId, now(), req), { readOnly: true });
      } catch (error) {
        return failure(reply, error);
      }
    };
  }

  function write(type: Parameters<typeof parseCommand>[0], target?: keyof Params) {
    return async (req: Request, reply: FastifyReply) => {
      try {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !keyPattern.test(key)) throw new StockError(400, 'IDEMPOTENCY_KEY_REQUIRED');
        const storeId = req.params.storeId.toLowerCase();
        const actorId = uuid(req.headers['x-navis-user-id'], 'actorId');
        const command = parseCommand(type, req.body, target === undefined ? undefined : req.params[target]);
        const result = await withStoreTransaction(pool, storeId, db => runStockCommand(db, {
          storeId, actorId, key, now, clock: operatingClock(req.headers),
        }, command));
        return reply.code(type === 'create_item' || type === 'register_batch' ? 201 : 200).send(result);
      } catch (error) {
        return failure(reply, error);
      }
    };
  }

  const readItems = read(async (db, storeId, at, req) => {
    const day = req.query.businessDate === undefined
      ? await operatingDay(db, storeId, at, operatingClock(req.headers))
      : date(req.query.businessDate, 'businessDate');
    const itemId = req.params.itemId === undefined ? undefined : uuid(req.params.itemId, 'itemId');
    return listItems(db, storeId, at, day, req.query, itemId);
  });

  app.get(root + '/items', { onRequest }, readItems);
  app.get(root + '/items/:itemId', { onRequest }, readItems);
  app.get(root + '/stock-movements', { onRequest }, read(async (db, storeId, at, req) => {
    const day = req.query.businessDate ?? req.query.from;
    const current = day === undefined ? await operatingDay(db, storeId, at, operatingClock(req.headers)) : date(day, 'businessDate');
    return listMovements(db, storeId, at, current, req.query);
  }));
  app.get(root + '/stock-batches', { onRequest }, read((db, storeId, at, req) => listBatches(db, storeId, at, req.query)));
  app.post(root + '/items', writeOptions, write('create_item'));
  app.patch(root + '/items/:itemId', writeOptions, write('update_item', 'itemId'));
  app.delete(root + '/items/:itemId', writeOptions, write('archive_item', 'itemId'));
  app.post(root + '/channel-transfers', writeOptions, write('transfer'));
  app.post(root + '/stock-batches', writeOptions, write('register_batch'));
  app.post(root + '/stock-batches/:batchId/discard', writeOptions, write('discard_batch', 'batchId'));
  app.post(root + '/stock/receipts/:receiptId/undo', writeOptions, write('undo', 'receiptId'));
}
