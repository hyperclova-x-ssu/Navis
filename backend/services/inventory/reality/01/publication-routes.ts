import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApprovalError, approvalFingerprint, approvalInput, cardApprovals } from '../../../../packages/approvals/index.ts';
import { record } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { NaverError, type OwnerContext } from '../../../account/naver/wire.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { isUuid, StockError, uuid } from '../03/wire.ts';
import { PurchaseError } from '../04/wire.ts';
import { CardError, fingerprint } from './owner-card.ts';

export const publicationRoot = '/internal/v1/inventory/stores/:storeId';
const operations = {
  'place-menu': 'place.menu.publish',
  'place-venue': 'place.venue.publish',
  'commerce-stock': 'commerce.stock.set',
  'supplier-message': 'supplier.message.send',
} as const;
const approvals = cardApprovals('inventory');
type Kind = keyof typeof operations;
type Request = FastifyRequest<{ Params: { storeId: string; id?: string } }>;
type ViewResult<View> = { view: View; changed: boolean; expectedRevision: number };
type Action<Input> = { kind: Kind; path: string; input(body: unknown): Input };
type Preview = { previewId: string; expectedRevision: number; inputHash: string; snapshot: string; input: unknown; localSnapshot: string | null };
type Confirmation = { previewId: string; approvalId: string; expectedRevision: number };
type Receipt = Pick<Preview, 'input' | 'snapshot' | 'localSnapshot'> & { result: object | null; approvalExpiresAt: Date };

function expectedRevision(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new CardError(400, 'INVALID_REVISION');
  }
  return value;
}

function resourceKey(req: Request) {
  return req.params.id ? uuid(req.params.id, 'id') : 'venue';
}

function binding(scope: OwnerContext, kind: Kind, resourceId: string, preview: Preview) {
  return { ...scope, operation: operations[kind], targetRef: resourceId, expectedRevision: preview.expectedRevision,
    fingerprint: approvalFingerprint({ previewId: preview.previewId, inputHash: preview.inputHash }),
    requiresConfirmation: false };
}

function findPreview(db: PoolClient, scope: OwnerContext, kind: Kind, resourceId: string, previewId: string) {
  return db.query<Preview>(
    'SELECT preview_id AS "previewId", revision AS "expectedRevision", input_hash AS "inputHash", ' +
    'snapshot, request AS input, local_snapshot AS "localSnapshot" FROM inventory.publication_preview ' +
    'WHERE store_id=$1 AND actor_id=$2 AND kind=$3 AND resource_ref=$4 AND preview_id=$5 AND expires_at > clock_timestamp()',
    [scope.storeId, scope.actorId, kind, resourceId, previewId]);
}

async function requirePreview(db: PoolClient, scope: OwnerContext, kind: Kind, resourceId: string, previewId: string, revision: number) {
  const { rows: [preview] } = await findPreview(db, scope, kind, resourceId, previewId);
  if (!preview) throw new CardError(403, 'CARD_REQUIRED');
  if (preview.expectedRevision !== revision) throw new CardError(409, 'STALE_REVISION');
  return preview;
}

async function storePreview<View>(db: Pool, scope: OwnerContext, kind: Kind, resourceId: string, input: unknown,
  { view, changed, expectedRevision }: ViewResult<View>, localSnapshot: string | null) {
  if (!changed) throw new CardError(409, 'NO_CHANGES');
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const inputHash = approvalFingerprint(input);
  await withStoreTransaction(db, scope.storeId, async client => {
    await client.query('DELETE FROM inventory.publication_preview WHERE store_id=$1 AND expires_at <= clock_timestamp()', [scope.storeId]);
    await client.query(
      'INSERT INTO inventory.publication_preview ' +
      '(store_id, actor_id, preview_id, kind, resource_ref, revision, input_hash, snapshot, request, local_snapshot, expires_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [scope.storeId, scope.actorId, previewId, kind, resourceId, expectedRevision, inputHash, fingerprint(view),
        JSON.stringify(input), localSnapshot, expiresAt]);
  });
  return { previewId, expectedRevision, inputHash, diff: view, expiresAt };
}

async function claimApproval(db: PoolClient, scope: OwnerContext, kind: Kind, resourceId: string,
  preview: Preview, approvalId: string, external: boolean): Promise<Receipt> {
  const now = new Date();
  if (!await approvals.consume(db, binding(scope, kind, resourceId, preview), approvalId, now)) {
    throw new CardError(403, 'CARD_REQUIRED');
  }
  const { rows: [approval] } = await db.query<{ expiresAt: Date }>(
    'SELECT expires_at AS "expiresAt" FROM inventory.card_approval WHERE store_id=$1 AND approval_id=$2',
    [scope.storeId, approvalId]);
  await db.query(
    'INSERT INTO inventory.owner_publication ' +
    '(store_id, receipt_id, actor_id, kind, resource_id, snapshot, request, local_snapshot, preview_id, preview_revision, approval_expires_at, running_until) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12 THEN clock_timestamp() + interval '15 minutes' END)",
    [scope.storeId, approvalId, scope.actorId, kind, resourceId === 'venue' ? scope.storeId : resourceId,
      preview.snapshot, JSON.stringify(preview.input), preview.localSnapshot, preview.previewId, preview.expectedRevision, approval.expiresAt, external]);
  await db.query('DELETE FROM inventory.publication_preview WHERE store_id=$1 AND actor_id=$2 AND preview_id=$3',
    [scope.storeId, scope.actorId, preview.previewId]);
  return { input: preview.input, snapshot: preview.snapshot, localSnapshot: preview.localSnapshot,
    approvalExpiresAt: approval.expiresAt, result: null };
}

function confirmation(req: Request): Confirmation {
  if (!record(req.body) || Object.keys(req.body).length !== 3 || !isUuid(req.body.approvalId) || !isUuid(req.body.previewId)
    || !('expectedRevision' in req.body)) throw new CardError(403, 'CARD_REQUIRED');
  const approvalId = req.body.approvalId.toLowerCase();
  if (req.headers['idempotency-key'] !== approvalId) throw new CardError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  return { approvalId, previewId: req.body.previewId.toLowerCase(), expectedRevision: expectedRevision(req.body.expectedRevision) };
}

async function findReceipt(db: PoolClient, scope: OwnerContext, kind: Kind, resourceId: string, card: Confirmation) {
  const { rows: [receipt] } = await db.query<Receipt>(
    'SELECT result, request AS input, snapshot, local_snapshot AS "localSnapshot", approval_expires_at AS "approvalExpiresAt" ' +
    'FROM inventory.owner_publication WHERE store_id=$1 AND receipt_id=$2 AND actor_id=$3 AND kind=$4 ' +
    'AND resource_id=$5 AND preview_id=$6 AND preview_revision=$7',
    [scope.storeId, card.approvalId, scope.actorId, kind, resourceId === 'venue' ? scope.storeId : resourceId,
      card.previewId, card.expectedRevision]);
  return receipt;
}

const withPublicationLock = <T>(pool: Pool, scope: OwnerContext, run: (db: PoolClient) => Promise<T>) =>
  withStoreTransaction(pool, scope.storeId, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 409))', [scope.storeId]);
    return run(db);
  });

export function registerPublicationApprovals(app: FastifyInstance, pool: Pool, token: string) {
  publicationHttp(app, pool, token).route('POST', '/approvals', (db, scope, req) => {
    if (!record(req.body) || Object.keys(req.body).length !== 5 || req.body.stage !== 'press'
      || !isUuid(req.body.previewId)) throw new CardError(400, 'INVALID_REQUEST');
    const { operation } = req.body;
    const kind = (Object.keys(operations) as Kind[]).find(key => operations[key] === operation);
    if (!kind) throw new CardError(400, 'INVALID_REQUEST');
    const resourceId = kind === 'place-venue' && req.body.resourceId === 'venue' ? 'venue' : uuid(req.body.resourceId, 'resourceId');
    if (kind === 'place-venue' && resourceId !== 'venue') throw new CardError(400, 'INVALID_REQUEST');
    const previewId = req.body.previewId.toLowerCase();
    const revision = expectedRevision(req.body.expectedRevision);
    const input = approvalInput({ stage: 'press', operation, targetRef: resourceId, expectedRevision: revision, command: {} });
    return withPublicationLock(db, scope, async client => {
      const preview = await requirePreview(client, scope, kind, resourceId, previewId, revision);
      return approvals.issue(client, input, binding(scope, kind, resourceId, preview), new Date());
    });
  });
}

export function publicationHttp(app: FastifyInstance, pool: Pool, token: string) {
  if (!token) throw new Error('Inventory publication requires the gateway workload token');
  const expected = Buffer.from(fingerprint('Bearer ' + token), 'hex');
  function authorize(request: Request) {
    const header = request.headers.authorization;
    if (!header || !timingSafeEqual(Buffer.from(fingerprint(header), 'hex'), expected)) {
      throw new CardError(401, 'UNAUTHENTICATED');
    }
    const storeId = uuid(request.params.storeId, 'storeId');
    const actor = request.headers['x-navis-user-id'];
    if (request.headers['x-navis-store-id'] !== storeId || !isUuid(actor) || request.headers['x-navis-store-role'] !== 'owner') {
      throw new CardError(403, 'STORE_FORBIDDEN');
    }
    return { storeId, actorId: actor.toLowerCase() };
  }

  function route(method: 'GET' | 'POST', path: string, run: (db: Pool, scope: OwnerContext, req: Request) => Promise<unknown>) {
    app.route<{ Params: Request['params'] }>({
      method, url: publicationRoot + path, bodyLimit: 8192,
      async handler(req, reply) {
        reply.header('cache-control', 'no-store');
        try { return await run(pool, authorize(req), req); }
        catch (error) {
          if (error instanceof CardError || error instanceof NaverError || error instanceof ApprovalError) {
            return reply.code(error.status).send({ code: error.code });
          }
          if (error instanceof StockError || error instanceof PurchaseError) return reply.code(error.status).send({ code: error.reason });
          req.log.error('Inventory publication unavailable');
          return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' });
        }
      },
    });
  }

  function preview<Input, View>(action: Action<Input>, inspect: (db: Pool, scope: OwnerContext, resourceId: string, input: Input) =>
    Promise<{ inspected: ViewResult<View>; localSnapshot: string | null }>) {
    route('POST', action.path + '/preview', async (db, scope, req) => {
      if (!record(req.body) || Object.keys(req.body).length !== 1 || !('input' in req.body)) {
        throw new CardError(400, 'INVALID_REQUEST');
      }
      const resourceId = resourceKey(req);
      const input = action.input(req.body.input);
      const { inspected, localSnapshot } = await inspect(db, scope, resourceId, input);
      return storePreview(db, scope, action.kind, resourceId, input, inspected, localSnapshot);
    });
  }

  function command<Input, View>(action: Action<Input> & {
    view(db: PoolClient, scope: OwnerContext, id: string, input: Input): Promise<ViewResult<View>>;
    apply(db: PoolClient, scope: OwnerContext, id: string, input: Input, view: View, receiptId: string): Promise<object>;
  }) {
    const { kind, path } = action;
    preview(action, async (db, scope, id, input) => ({
      inspected: await withStoreTransaction(db, scope.storeId, client => action.view(client, scope, id, input), { readOnly: true }),
      localSnapshot: null,
    }));
    route('POST', path + '/confirm', (db, scope, req) => {
      const id = resourceKey(req);
      const card = confirmation(req);
      const receipt = { receiptId: card.approvalId, resourceId: id };
      return withPublicationLock(db, scope, async client => {
        const prior = await findReceipt(client, scope, kind, id, card);
        if (prior?.result) return { ...receipt, ...prior.result };
        const proposed = await requirePreview(client, scope, kind, id, card.previewId, card.expectedRevision);
        await claimApproval(client, scope, kind, id, proposed, card.approvalId, false);
        const input = action.input(proposed.input);
        const { view, changed, expectedRevision: revision } = await action.view(client, scope, id, input).catch(error => {
          if ((error instanceof PurchaseError && error.status === 404) || (error instanceof CardError && error.status === 409)) {
            throw new CardError(409, 'STALE_REVISION');
          }
          throw error;
        });
        if (!changed || revision !== card.expectedRevision || fingerprint(view) !== proposed.snapshot) {
          throw new CardError(409, 'STALE_REVISION');
        }
        const result = await action.apply(client, scope, id, input, view, card.approvalId);
        await client.query('UPDATE inventory.owner_publication SET result=$3 WHERE store_id=$1 AND receipt_id=$2',
          [scope.storeId, card.approvalId, result]);
        return { ...receipt, ...result };
      });
    });
  }

  function external<Input, View, Snapshot>(action: Action<Input> & {
    snapshot(db: PoolClient, scope: OwnerContext, id: string): Promise<Snapshot>;
    inspect(scope: OwnerContext, input: Input, snapshot: Snapshot): Promise<ViewResult<View>>;
    publish(scope: OwnerContext, input: Input, view: View, receiptId: string): Promise<object>;
  }) {
    const { kind, path } = action;
    preview(action, async (db, scope, id, input) => {
      const snapshot = await withStoreTransaction(db, scope.storeId, client => action.snapshot(client, scope, id), { readOnly: true });
      return { inspected: await action.inspect(scope, input, snapshot), localSnapshot: fingerprint(snapshot) };
    });
    route('POST', path + '/confirm', async (db, scope, req) => {
      const id = resourceKey(req);
      const card = confirmation(req);
      const receipt = { receiptId: card.approvalId, resourceId: id };
      const transact = <T>(run: (client: PoolClient) => Promise<T>) => withPublicationLock(db, scope, run);
      const localSnapshot = async (client: PoolClient) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('navis:inventory:menu:' || $1, 0))", [scope.storeId]);
        try {
          return { current: await action.snapshot(client, scope, id) };
        } catch (error) {
          if ((error instanceof CardError || error instanceof StockError) && error.status === 404) return null;
          throw error;
        }
      };
      const prepared = await transact(async client => {
        const prior = await findReceipt(client, scope, kind, id, card);
        if (prior?.result) return { completed: true as const, result: prior.result };
        const proposed = prior ? null : await requirePreview(client, scope, kind, id, card.previewId, card.expectedRevision);
        const active = await client.query(
          'SELECT 1 FROM inventory.owner_publication WHERE store_id=$1 AND running_until > clock_timestamp()', [scope.storeId]);
        if (active.rowCount) throw new CardError(409, 'PUBLICATION_IN_PROGRESS');
        const snapshot = await localSnapshot(client);
        if (!snapshot || fingerprint(snapshot.current) !== (prior ?? proposed)?.localSnapshot) throw new CardError(409, 'STALE_REVISION');
        let intent: Receipt;
        if (prior) {
          intent = prior;
          await client.query(
            "UPDATE inventory.owner_publication SET running_until=clock_timestamp() + interval '15 minutes' WHERE store_id=$1 AND receipt_id=$2",
            [scope.storeId, card.approvalId]);
        } else if (proposed) {
          intent = await claimApproval(client, scope, kind, id, proposed, card.approvalId, true);
        } else {
          throw new CardError(403, 'CARD_REQUIRED');
        }
        return { completed: false as const, snapshot: snapshot.current, intent, resumed: Boolean(prior) };
      });
      const outcome = (result: object) => {
        if ('state' in result && result.state === 'stale') throw new CardError(409, 'STALE_REVISION');
        return { ...receipt, ...result };
      };
      if (prepared.completed) return outcome(prepared.result);
      const input = action.input(prepared.intent.input);
      const snapshotMatches = async (client: PoolClient) => {
        const snapshot = await localSnapshot(client);
        return snapshot !== null && fingerprint(snapshot.current) === prepared.intent.localSnapshot;
      };
      let result: object;
      try {
        const { view, changed, expectedRevision: revision } = await action.inspect(scope, input, prepared.snapshot);
        if (revision !== card.expectedRevision || (!changed && !prepared.resumed)
          || (changed && fingerprint(view) !== prepared.intent.snapshot)
          || !await transact(snapshotMatches)) throw new CardError(409, 'STALE_REVISION');
        if (changed) {
          if (+prepared.intent.approvalExpiresAt <= Date.now()) throw new CardError(409, 'CARD_EXPIRED');
          result = await action.publish(scope, input, view, card.approvalId);
        } else {
          result = { state: 'observed' };
        }
      } catch (error) {
        await transact(client => client.query(
          'UPDATE inventory.owner_publication SET running_until=NULL WHERE store_id=$1 AND receipt_id=$2', [scope.storeId, card.approvalId]));
        throw error;
      }
      return outcome(await transact(async client => {
        const final = await snapshotMatches(client) ? result : { ...result, state: 'stale' };
        await client.query(
          'UPDATE inventory.owner_publication SET result=$3, running_until=NULL WHERE store_id=$1 AND receipt_id=$2',
          [scope.storeId, card.approvalId, final]);
        return final;
      }));
    });
  }

  return { route, command, external };
}
