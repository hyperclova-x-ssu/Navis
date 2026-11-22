import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { inStore, InsightError, isDate, requireOwner, type StoreParams } from '../../scope.ts';
import { bizinfoProvider } from './bizinfo.ts';
import { businessDay, integer, invalid, object, perform, uuid, type CommandOptions, type Operation } from './commands.ts';
import { briefingFacts, byId, dto, history, list, lockCommands, missing, run, sourceRevision, type Context, type Kind } from './records.ts';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Params = StoreParams & { id?: string };
type Request = FastifyRequest<{ Params: Params }>;
const prefix = '/internal/v1/insight/stores/:storeId/insight';
const collections = {
  '/manuals': 'manual', '/manual-drafts': 'draft', '/checklists': 'checklist',
  '/grant-notices': 'notice', '/grant-applications': 'application',
} as const satisfies Record<string, Kind>;
const writes = [
  ['POST', '/manuals', 'create-manual'], ['PATCH', '/manuals/:id', 'edit-manual'], ['DELETE', '/manuals/:id', 'archive-manual'],
  ['POST', '/manuals/:id/publish', 'publish'], ['POST', '/manual-drafts', 'create-draft'],
  ['POST', '/manual-drafts/:id/save', 'save-draft'], ['DELETE', '/manual-drafts/:id', 'archive-draft'],
  ['POST', '/checklists', 'check'], ['POST', '/grant-notices/sync', 'sync'], ['POST', '/grant-notices/:id/review', 'review'],
  ['POST', '/grant-applications', 'apply'], ['PATCH', '/grant-applications/:id', 'edit-application'],
  ['DELETE', '/grant-applications/:id', 'archive-application'], ['POST', '/receipts/:id/undo', 'undo'],
] as const satisfies readonly [Method, string, Operation][];

// Gateway owns the public allowlist. This export keeps integration tests and
// registration handoff aligned with the service's actual paths.
export const manualsGrantsRoutes: ReadonlyArray<readonly [Method, string]> = [
  ['GET', '/manuals-grants-briefing'],
  ...Object.keys(collections).flatMap(path => [['GET', path], ['GET', `${path}/:id`], ['GET', `${path}/:id/history`]] as const),
  ...writes.map(([method, path]) => [method, path] as const),
];

const readInteger = (value: unknown, field: string, fallback: number, max: number) =>
  value === undefined ? fallback : integer(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN, field, max);

export function registerManualsGrants(app: FastifyInstance, pool: Pool, options: {
  gatewayToken: string; now?: () => Date;
  undoObservation?: (ctx: Context, id: string, body: unknown, query: unknown, key: string) => Promise<{ receiptId: string } | undefined>;
} & Partial<CommandOptions>) {
  const { gatewayToken, now = () => new Date(), provider = bizinfoProvider(), verifyPhoto, undoObservation } = options;
  const onRequest = async (req: Request) => { requireOwner(req, gatewayToken); };
  const transact = <T>(req: Request, work: (context: Context) => Promise<T>, readOnly: boolean) => {
    const scope = requireOwner(req, gatewayToken);
    return inStore(pool, scope.storeId, async db => {
      if (!readOnly) await lockCommands(db, scope.storeId);
      const at = now();
      const day = businessDay(at, req.headers['x-navis-store-timezone'], req.headers['x-navis-business-day-start']);
      return work({ ...scope, db, now: at, businessDay: day });
    }, readOnly);
  };
  app.get<{ Params: Params }>(prefix + '/manuals-grants-briefing', { onRequest }, req => transact(req, briefingFacts, true));
  for (const [path, kind] of Object.entries(collections)) {
    app.get<{ Params: Params }>(prefix + path, { onRequest }, req => {
      const query = object(req.query, kind === 'checklist' ? ['limit', 'cursor', 'from', 'to', 'manualId'] : ['limit', 'cursor']);
      const limit = readInteger(query.limit, 'limit', 50, 100);
      const cursor = query.cursor === undefined ? null : uuid(query.cursor, 'cursor');
      const { from = null, to = null } = query;
      if ((from !== null && !isDate(from)) || (to !== null && !isDate(to)) || (from && to && from > to)) throw invalid('date_range');
      const parentId = query.manualId === undefined ? null : uuid(query.manualId, 'manual');
      return transact(req, async ctx => {
        const rows = await list(ctx, kind, { cursor, limit, from, to, parentId });
        return { items: rows.slice(0, limit).map(dto), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
          asOf: ctx.now.toISOString(), sourceRevision: await sourceRevision(ctx) };
      }, true);
    });
    app.get<{ Params: Params }>(`${prefix}${path}/:id`, { onRequest }, req => transact(req, async ctx => {
      const row = await byId(ctx, kind, uuid(req.params.id));
      if (!row) throw missing();
      return dto(row);
    }, true));
    app.get<{ Params: Params }>(`${prefix}${path}/:id/history`, { onRequest }, req => {
      const input = object(req.query, ['limit', 'cursor']);
      const limit = readInteger(input.limit, 'limit', 50, 100);
      const cursor = readInteger(input.cursor, 'cursor', 0, 2_147_483_647) || null;
      return transact(req, async ctx => {
        const rows = await history(ctx, kind, uuid(req.params.id), cursor, limit);
        return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]!.revision) : null,
          asOf: ctx.now.toISOString(), sourceRevision: await sourceRevision(ctx) };
      }, true);
    });
  }
  for (const [method, path, operation] of writes) {
    app.route<{ Params: Params }>({
      method, url: prefix + path, onRequest, bodyLimit: 192 * 1024,
      handler: (req, reply) => {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(key)) throw invalid('idempotency_key');
        const id = req.params.id === undefined ? null : uuid(req.params.id);
        const body = req.body === undefined ? {} : req.body;
        if (body === null) throw new InsightError(400, 'INVALID_REQUEST');
        return transact(req, async ctx => {
          if (operation === 'undo' && id && undoObservation) {
            const receipt = await undoObservation(ctx, id, req.body, req.query, key);
            if (receipt) {
              reply.code(201);
              return receipt;
            }
          }
          return run(ctx, key, { operation, id, body }, operation,
            () => perform(ctx, operation, id, body, { provider, verifyPhoto }));
        }, false);
      },
    });
  }
}
