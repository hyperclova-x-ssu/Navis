import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withStoreTransaction } from '../../store-transaction.ts';
import { runMenuCommand, type VerifyMenuPhoto } from './commands.ts';
import { posSnapshot, readMenu } from './read.ts';
import {
  idempotencyPattern, isUuid, MenuError, object, parseArchive, parseCreate, parseList, parseOptions, parseRecipe, parseUpdate,
  uuid, type MenuCommand,
} from './wire.ts';

type Params = { storeId: string; menuId?: string; receiptId?: string };
type MenuRequest = FastifyRequest<{ Params: Params }>;
type MenuRoutesOptions = { now?: () => Date; verifyPhoto?: VerifyMenuPhoto; posCatalogToken?: string };
const prefix = '/internal/v1/inventory/stores/:storeId';
const digest = (value: string) => createHash('sha256').update(value).digest();
const errorCodes = { 400: 'VALIDATION', 404: 'NOT_FOUND', 409: 'CONFLICT', 503: 'SERVICE_UNAVAILABLE' };

function failure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof MenuError)) throw error;
  return reply.code(error.status).send({
    code: errorCodes[error.status], reason: error.reason, ...(error.field ? { field: error.field } : {}),
  });
}

export function registerMenuRoutes(
  app: FastifyInstance, pool: Pool, gatewayToken: string,
  { now = () => new Date(), verifyPhoto, posCatalogToken }: MenuRoutesOptions = {},
) {
  if (posCatalogToken === gatewayToken) throw new Error('Inventory workload credentials must be distinct');
  const authorize = (workloadDigest: Buffer) => async (req: MenuRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(workloadDigest, digest(bearer))) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    }
    if (!isUuid(req.params.storeId)) {
      return reply.code(400).send({ code: 'VALIDATION', reason: 'INVALID_REQUEST', field: 'storeId' });
    }
    const storeId = req.headers['x-navis-store-id'];
    if (!isUuid(storeId) || storeId.toLowerCase() !== req.params.storeId.toLowerCase()
        || req.headers['x-navis-store-role'] !== 'owner' || !isUuid(req.headers['x-navis-user-id'])) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  };

  const readOptions = { onRequest: authorize(digest(gatewayToken)) };
  const writeOptions = { ...readOptions, bodyLimit: 128 * 1024 };

  function write(parse: (req: MenuRequest) => MenuCommand) {
    return async (req: MenuRequest, reply: FastifyReply) => {
      try {
        const storeId = req.params.storeId.toLowerCase();
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !idempotencyPattern.test(key)) throw new MenuError(400, 'IDEMPOTENCY_KEY_REQUIRED');
        const actorId = uuid(req.headers['x-navis-user-id'], 'actorId');
        const command = parse(req);
        const result = await withStoreTransaction(pool, storeId, db =>
          runMenuCommand(db, { storeId, actorId, key, now, verifyPhoto }, command),
        );
        return reply.code(command.type === 'create' ? 201 : 200).send(result);
      } catch (error) {
        return failure(reply, error);
      }
    };
  }

  async function item(storeId: string, id: unknown) {
    const menuId = uuid(id, 'menuId');
    const { items: [row] } = await withStoreTransaction(
      pool, storeId, db => readMenu(db, storeId, now(), { menuIds: [menuId] }), { readOnly: true },
    );
    if (!row) throw new MenuError(404, 'MENU_NOT_FOUND');
    return row;
  }

  app.get<{ Params: Params }>(`${prefix}/menu`, readOptions, async (req, reply) => {
    try {
      const query = parseList(req.query);
      const storeId = req.params.storeId.toLowerCase();
      return await withStoreTransaction(pool, storeId, db => readMenu(db, storeId, now(), query), { readOnly: true });
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get<{ Params: Params }>(`${prefix}/menu/:menuId`, readOptions, async (req, reply) => {
    try {
      return await item(req.params.storeId.toLowerCase(), req.params.menuId);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get<{ Params: Params }>(`${prefix}/menu/:menuId/options`, readOptions, async (req, reply) => {
    try {
      const { groups, revision } = await item(req.params.storeId.toLowerCase(), req.params.menuId);
      return { groups, revision };
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get<{ Params: Params }>(`${prefix}/recipes`, readOptions, async (req, reply) => {
    try {
      const query = object(req.query, ['menuId']);
      const { menuId, recipeLines, recipeVersion, unitCost, revision } = await item(req.params.storeId.toLowerCase(), query.menuId);
      return { menuId, lines: recipeLines, recipeVersion, unitCost, revision };
    } catch (error) {
      return failure(reply, error);
    }
  });
  if (posCatalogToken) {
    app.get<{ Params: Params }>(`${prefix}/catalog-snapshot`, { onRequest: authorize(digest(posCatalogToken)) }, async (req, reply) => {
      try {
        const { menuId } = object(req.query, ['menuId']);
        const ids = Array.isArray(menuId) ? menuId : [menuId];
        if (ids.length > 25) throw new MenuError(400, 'INVALID_REQUEST', 'menuId');
        const menuIds = ids.map(id => uuid(id, 'menuId'));
        if (new Set(menuIds).size !== menuIds.length) throw new MenuError(400, 'INVALID_REQUEST', 'menuId');
        const storeId = req.params.storeId.toLowerCase();
        const { items, asOf, sourceRevision } = await withStoreTransaction(
          pool, storeId, db => readMenu(db, storeId, now(), { menuIds, limit: menuIds.length }), { readOnly: true },
        );
        return { items: items.map(posSnapshot), asOf, sourceRevision };
      } catch (error) {
        return failure(reply, error);
      }
    });
  }

  app.post<{ Params: Params }>(`${prefix}/menu`, writeOptions, write(req => parseCreate(req.body)));
  app.patch<{ Params: Params }>(`${prefix}/menu/:menuId`, writeOptions, write(req => parseUpdate(req.body, uuid(req.params.menuId, 'menuId'))));
  app.patch<{ Params: Params }>(`${prefix}/menu/:menuId/options`, writeOptions, write(req => parseOptions(req.body, uuid(req.params.menuId, 'menuId'))));
  app.patch<{ Params: Params }>(`${prefix}/recipes`, writeOptions, write(req => parseRecipe(req.body)));
  app.delete<{ Params: Params }>(`${prefix}/menu/:menuId`, writeOptions, write(req => parseArchive(req.body, uuid(req.params.menuId, 'menuId'))));
  app.post<{ Params: Params }>(`${prefix}/receipts/:receiptId/undo`, writeOptions, write(req => {
    object(req.body ?? {}, []);
    return { type: 'undo', receiptId: uuid(req.params.receiptId, 'receiptId') };
  }));
}
