import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ReceiptError } from '../../receipts.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { isUuid, StockError, uuid } from '../03/wire.ts';
import { receiptStatus, runPurchaseCommand } from './commands.ts';
import { listOrders, listReceipts, listSuppliers, listTerms, purchaseOrder, supplier, terms } from './read.ts';
import { parseCommand, PurchaseError, type Operation } from './wire.ts';

type Params = { storeId: string; supplierId?: string; purchaseItemId?: string; poId?: string; receiptId?: string };
type Request = FastifyRequest<{ Params: Params; Querystring: Record<string, unknown> }>;
const root = '/internal/v1/inventory/stores/:storeId';
const digest = (value: string) => createHash('sha256').update(value).digest();
const codes = { 400: 'VALIDATION', 404: 'NOT_FOUND', 409: 'CONFLICT', 503: 'SERVICE_UNAVAILABLE' };

function failure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof StockError) && !(error instanceof ReceiptError)) throw error;
  return reply.code(error.status).send({ code: codes[error.status], reason: error.reason,
    field: error instanceof StockError ? error.field : undefined,
    details: error instanceof PurchaseError ? error.details : undefined });
}

function authorize(token: string) {
  const expected = digest(token);
  return async (req: Request, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]{1,512})$/i)?.[1];
    if (!bearer || !timingSafeEqual(digest(bearer), expected)) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (!isUuid(req.params.storeId)) return failure(reply, new PurchaseError(400, 'INVALID_REQUEST', 'storeId'));
    const store = req.headers['x-navis-store-id'];
    if (!isUuid(store) || store.toLowerCase() !== req.params.storeId.toLowerCase()
        || req.headers['x-navis-store-role'] !== 'owner' || !isUuid(req.headers['x-navis-user-id'])) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  };
}

export function registerPurchaseRoutes(
  app: FastifyInstance, pool: Pool, gatewayToken: string,
  { now = () => new Date(), receiptStatusToken }: { now?: () => Date; receiptStatusToken?: string } = {},
) {
  const onRequest = authorize(gatewayToken);
  const writeOptions = { onRequest, bodyLimit: 16 * 1024 };
  const header = (request: Request, name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  };

  function read(query: (db: PoolClient, store: string, req: Request) => Promise<unknown>) {
    return async (req: Request, reply: FastifyReply) => {
      try {
        const store = req.params.storeId.toLowerCase();
        return await withStoreTransaction(pool, store, db => query(db, store, req), { readOnly: true });
      } catch (error) {
        return failure(reply, error);
      }
    };
  }

  function write(operation: Operation, target?: keyof Params) {
    return async (req: Request, reply: FastifyReply) => {
      try {
        const key = header(req, 'idempotency-key');
        if (!key || !/^[A-Za-z0-9_:.~-]{1,160}$/.test(key)) throw new PurchaseError(400, 'IDEMPOTENCY_KEY_REQUIRED');
        const command = parseCommand(operation, req.body, target ? req.params[target] : undefined);
        const store = req.params.storeId.toLowerCase();
        const actor = uuid(req.headers['x-navis-user-id'], 'actorId');
        const clock = { timezone: header(req, 'x-navis-store-timezone'), dayStart: header(req, 'x-navis-business-day-start') };
        const result = await withStoreTransaction(pool, store, db => runPurchaseCommand(db, { store, actor, key, clock, now }, command));
        const created = operation.startsWith('create_') || operation === 'receive';
        return reply.code(created ? 201 : 200).send(result);
      } catch (error) {
        return failure(reply, error);
      }
    };
  }

  app.get(root + '/suppliers', { onRequest }, read((db, store, req) => listSuppliers(db, store, now(), req.query)));
  app.get(root + '/suppliers/:supplierId', { onRequest }, read((db, store, req) => supplier(db, store, uuid(req.params.supplierId, 'supplierId'), true)));
  app.post(root + '/suppliers', writeOptions, write('create_supplier'));
  app.patch(root + '/suppliers/:supplierId', writeOptions, write('update_supplier', 'supplierId'));
  app.delete(root + '/suppliers/:supplierId', writeOptions, write('archive_supplier', 'supplierId'));
  app.get(root + '/purchase-items', { onRequest }, read((db, store, req) => listTerms(db, store, now(), req.query)));
  app.get(root + '/purchase-items/:purchaseItemId', { onRequest }, read((db, store, req) => terms(db, store, uuid(req.params.purchaseItemId, 'purchaseItemId'))));
  app.post(root + '/purchase-items', writeOptions, write('create_terms'));
  app.patch(root + '/purchase-items/:purchaseItemId', writeOptions, write('update_terms', 'purchaseItemId'));
  app.delete(root + '/purchase-items/:purchaseItemId', writeOptions, write('archive_terms', 'purchaseItemId'));
  app.get(root + '/purchase-orders', { onRequest }, read((db, store, req) => listOrders(db, store, now(), req.query)));
  app.get(root + '/purchase-orders/:poId', { onRequest }, read((db, store, req) => purchaseOrder(db, store, uuid(req.params.poId, 'poId'))));
  app.post(root + '/purchase-orders', writeOptions, write('create_order'));
  app.patch(root + '/purchase-orders/:poId', writeOptions, write('change_due_date', 'poId'));
  app.post(root + '/purchase-orders/:poId/cancel', writeOptions, write('cancel_order', 'poId'));
  app.get(root + '/purchase-orders/:poId/receipts', { onRequest }, read((db, store, req) => listReceipts(db, store, now(), req.query, uuid(req.params.poId, 'poId'))));
  app.post(root + '/purchase-orders/:poId/receipts', writeOptions, write('receive', 'poId'));
  app.get(root + '/purchasing/receipts', { onRequest }, read((db, store, req) => listReceipts(db, store, now(), req.query)));
  app.post(root + '/purchasing/receipts/:receiptId/undo', writeOptions, write('undo', 'receiptId'));

  if (receiptStatusToken) app.get(root + '/purchase-receipt-status/:receiptId', { onRequest: authorize(receiptStatusToken) },
    read((db, store, req) => receiptStatus(db, store, uuid(req.params.receiptId, 'receiptId'), now)));
}
