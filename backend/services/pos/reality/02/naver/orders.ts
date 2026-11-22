import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NaverError, type OwnerApproval, type OwnerContext } from '../../../../account/naver/wire.ts';
import type { Order, OrderStatus } from '../../../../../packages/naver/contracts/pn02/wire.ts';
import { fingerprint, PosError, validKey } from '../../../wire.ts';

// NAVER linked-POS orders (PN02). Owner-visible fields are the order number, preparation time and the
// preparation/pickup progression. https://new.smartplace.naver.com/introduction/solution-market/payNPos
// Per-order preparation time: https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS
export type FulfillAction = { kind: 'prepare'; preparationMinutes: number } | { kind: 'pickup' };
export type NaverOrderPort = {
  orders(ctx: OwnerContext): Promise<Order[]>;
  order(ctx: OwnerContext, ref: string): Promise<Order>;
  fulfillOrder(ctx: OwnerContext, card: OwnerApproval, ref: string, action: FulfillAction): Promise<Order>;
};
export type OwnerScope = OwnerContext;

export const orderRefPattern = /^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,159}$/;
export const affectedSources = ['pos.naver-orders'];
const providerLimit = 5_000;
const pendingLifetimeMs = 5 * 60_000;
const next: Record<'prepare' | 'pickup', { from: OrderStatus; to: OrderStatus }> = {
  prepare: { from: 'received', to: 'preparing' },
  pickup: { from: 'preparing', to: 'picked-up' },
};

export class ProviderUnavailable extends PosError {
  constructor(reason: string) {
    super(503, reason);
  }
}

export function orderRevision(order: Order) {
  const digest = createHash('sha256').update(JSON.stringify([order.orderNumber, order.status, order.preparationMinutes])).digest('hex');
  return parseInt(digest.slice(0, 12), 16) + 1;
}

type OrderMetadata = {
  orderRef: string; preparingAt: Date | null; pickedUpAt: Date | null;
  naverPayPaymentId: string | null; smartstoreProductOrderId: string | null;
};
export function orderView(order: Order, metadata?: OrderMetadata) {
  return {
    orderNumber: order.orderNumber, source: 'naver' as const, status: order.status,
    preparationMinutes: order.preparationMinutes, revision: orderRevision(order),
    // Times Navis recorded for the owner's own confirmed presses. Progress made on NAVER's screen has none.
    preparingAt: metadata?.preparingAt?.toISOString() ?? null, pickedUpAt: metadata?.pickedUpAt?.toISOString() ?? null,
    ...(metadata?.naverPayPaymentId && { naverPayPaymentId: metadata.naverPayPaymentId }),
    ...(metadata?.smartstoreProductOrderId && { smartstoreProductOrderId: metadata.smartstoreProductOrderId }),
    actions: { prepare: order.status === next.prepare.from, pickup: order.status === next.pickup.from },
  };
}

const broken = new WeakSet<PoolClient>();
// A connection whose rollback failed must not return to the pool.
export const reusable = (db: PoolClient) => !broken.has(db);

export async function storeScope<T>(db: PoolClient, storeId: string, work: () => Promise<T>, readOnly = false) {
  await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  try {
    await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const result = await work();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      broken.add(db);
    }
    throw error;
  }
}

async function readMetadata(pool: Pool, storeId: string, refs: readonly string[]) {
  if (!refs.length) return new Map<string, OrderMetadata>();
  const db = await pool.connect();
  let failed = false;
  try {
    const { rows } = await storeScope(db, storeId, () => db.query<OrderMetadata>(`
      SELECT selected.order_ref AS "orderRef",
        max(command.settled_at) FILTER (WHERE command.action = 'prepare') AS "preparingAt",
        max(command.settled_at) FILTER (WHERE command.action = 'pickup') AS "pickedUpAt",
        link.naver_pay_payment_id AS "naverPayPaymentId", link.smartstore_product_order_id AS "smartstoreProductOrderId"
      FROM unnest($2::text[]) AS selected(order_ref)
      LEFT JOIN pos.naver_order_link link ON link.store_id = $1 AND link.order_ref = selected.order_ref
      LEFT JOIN pos.naver_order_command command
        ON command.store_id = $1 AND command.order_ref = selected.order_ref AND command.state = 'settled'
      GROUP BY selected.order_ref, link.naver_pay_payment_id, link.smartstore_product_order_id
    `, [storeId, refs]), true);
    return new Map(rows.map(row => [row.orderRef, row]));
  } catch (error) {
    failed = !reusable(db);
    throw error;
  } finally {
    db.release(failed);
  }
}

function listQuery(raw: unknown) {
  const query = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (Object.keys(query).some(key => !['status', 'cursor', 'limit'].includes(key))) throw new PosError(400, 'INVALID_REQUEST');
  const { status, cursor, limit = '30' } = query;
  if (status !== undefined && !['received', 'preparing', 'picked-up'].includes(status as string)) throw new PosError(400, 'INVALID_REQUEST');
  if (cursor !== undefined && (typeof cursor !== 'string' || !orderRefPattern.test(cursor))) throw new PosError(400, 'INVALID_REQUEST');
  if (typeof limit !== 'string' || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) throw new PosError(400, 'INVALID_REQUEST');
  return { status: status as OrderStatus | undefined, cursor: cursor as string | undefined, limit: Number(limit) };
}

async function providerRead<T>(read: () => Promise<T>, unknownOutcome = false): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!unknownOutcome && error instanceof NaverError && error.status === 404) throw new PosError(404, 'NOT_FOUND');
    throw new ProviderUnavailable(unknownOutcome ? 'ORDER_PROVIDER_OUTCOME_UNKNOWN' : 'NAVER_ORDERS_UNAVAILABLE');
  }
}

export async function listOrders(pool: Pool, naver: NaverOrderPort, scope: OwnerScope, raw: unknown, at: Date) {
  const { status, cursor, limit } = listQuery(raw);
  const orders = await providerRead(() => naver.orders(scope));
  const matching = orders.filter(order => orderRefPattern.test(order.orderNumber) && (!status || order.status === status))
    .sort((a, b) => a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0);
  const after = cursor ? matching.filter(order => order.orderNumber > cursor) : matching;
  const page = after.slice(0, limit);
  const metadata = await readMetadata(pool, scope.storeId, page.map(order => order.orderNumber));
  const items = page.map(order => orderView(order, metadata.get(order.orderNumber)));
  const sourceFingerprint = fingerprint(matching.map(orderRevision));
  return {
    items, nextCursor: after.length > limit ? page[page.length - 1].orderNumber : null, asOf: at.toISOString(),
    sourceRevision: parseInt(sourceFingerprint.slice(0, 12), 16), sourceFingerprint,
    status: orders.length >= providerLimit ? 'partial' as const : 'ready' as const,
  };
}

export async function readOrder(pool: Pool, naver: NaverOrderPort, scope: OwnerScope, ref: string) {
  const order = await providerRead(() => naver.order(scope, ref));
  if (order.orderNumber !== ref) throw new ProviderUnavailable('NAVER_ORDERS_UNAVAILABLE');
  return orderView(order, (await readMetadata(pool, scope.storeId, [ref])).get(ref));
}

function input(kind: 'prepare' | 'pickup', raw: unknown) {
  const fields = kind === 'prepare' ? ['expectedRevision', 'preparationMinutes'] : ['expectedRevision'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) {
    throw new PosError(400, 'INVALID_REQUEST');
  }
  const body = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new PosError(400, 'INVALID_REQUEST');
  const expectedRevision = body.expectedRevision as number;
  if (kind === 'pickup') return { expectedRevision, action: { kind } as FulfillAction };
  // The provider contract accepts a positive 32-bit integer number of minutes.
  const minutes = body.preparationMinutes;
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 2_147_483_647) {
    throw new PosError(400, 'INVALID_PREPARATION_TIME');
  }
  return { expectedRevision, action: { kind, preparationMinutes: minutes } as FulfillAction };
}

type Journal = {
  command_key: string; actor_id: string; fingerprint: string; receipt_id: string; order_ref: string;
  action: 'prepare' | 'pickup'; preparation_minutes: number | null; before_revision: string;
  state: 'pending' | 'settled' | 'refused' | 'expired'; pending_until: Date; failure: string | null; receipt: Receipt | null;
};
export type Receipt = {
  resourceId: string; orderNumber: string; revision: number; receiptId: string; status: OrderStatus;
  preparationMinutes: number | null; affectedSources: string[];
};

const effectOf = (entry: Journal): FulfillAction => entry.action === 'prepare'
  ? { kind: 'prepare', preparationMinutes: entry.preparation_minutes! } : { kind: 'pickup' };
const observed = (order: Order, entry: Journal) => order.status === next[entry.action].to
  && (entry.action !== 'prepare' || order.preparationMinutes === entry.preparation_minutes);

type Command = { pool: Pool; naver: NaverOrderPort; scope: OwnerScope; ref: string; kind: 'prepare' | 'pickup';
  key: unknown; raw: unknown; now: () => Date };

// Only the owner's own press reaches this command: the gateway authenticates the owner, the press carries a
// durable Idempotency-Key and the revision the owner saw. The journal is committed before the provider call,
// so a retry with the same key reconciles an uncertain outcome instead of repeating it.
export async function runFulfillment({ pool, naver, scope, ref, kind, key, raw, now }: Command): Promise<Receipt> {
  if (!validKey(key)) throw new PosError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  const { expectedRevision, action } = input(kind, raw);
  const hash = fingerprint({ ref, action, expectedRevision });
  const { storeId, actorId } = scope;
  const db = await pool.connect();
  const lock = JSON.stringify(['pos-naver-order', storeId, ref]);
  let locked = false;
  let discard = true;
  const inStore = <T>(work: () => Promise<T>) => storeScope(db, storeId, work);
  const close = (entry: Journal, state: 'refused' | 'expired', failure: string) => inStore(() => db.query(`
    UPDATE pos.naver_order_command SET state = $3, failure = $4 WHERE store_id = $1 AND receipt_id = $2 AND state = 'pending'
  `, [storeId, entry.receipt_id, state, failure]));
  const settle = (entry: Journal, order: Order) => inStore(async () => {
    const receipt: Receipt = { resourceId: ref, orderNumber: ref, revision: orderRevision(order), receiptId: entry.receipt_id,
      status: order.status, preparationMinutes: order.preparationMinutes, affectedSources };
    await db.query(`UPDATE pos.naver_order_command SET state = 'settled', receipt = $3, settled_at = $4
      WHERE store_id = $1 AND receipt_id = $2 AND state = 'pending'`, [storeId, entry.receipt_id, receipt, now()]);
    return receipt;
  });

  try {
    locked = (await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock])).rows[0].locked;
    discard = false;
    if (!locked) throw new PosError(409, 'ORDER_PROVIDER_PENDING');
    const { previous, pending } = await inStore(async () => {
      const columns = `command_key, actor_id, fingerprint, receipt_id, order_ref, action, preparation_minutes, before_revision,
        state, pending_until, failure, receipt`;
      const { rows: [previous] } = await db.query<Journal>(
        `SELECT ${columns} FROM pos.naver_order_command WHERE store_id = $1 AND command_key = $2`, [storeId, key]);
      const { rows: [pending] } = await db.query<Journal>(
        `SELECT ${columns} FROM pos.naver_order_command WHERE store_id = $1 AND order_ref = $2 AND state = 'pending'`, [storeId, ref]);
      return { previous, pending };
    });
    if (previous) {
      if (previous.actor_id !== actorId || previous.fingerprint !== hash) throw new PosError(409, 'IDEMPOTENCY_MISMATCH');
      if (previous.state === 'settled') return previous.receipt!;
      if (previous.state !== 'pending') throw new PosError(previous.failure === 'ORDER_NOT_FOUND' ? 404 : 409, previous.failure!);
    }
    const order = await providerRead(() => naver.order(scope, ref), Boolean(pending));
    if (order.orderNumber !== ref) throw new ProviderUnavailable(pending ? 'ORDER_PROVIDER_OUTCOME_UNKNOWN' : 'NAVER_ORDERS_UNAVAILABLE');
    let entry: Journal | undefined = pending;
    if (entry) {
      const same = entry.command_key === key;
      if (observed(order, entry)) {
        const receipt = await settle(entry, order);
        if (same) return receipt;
        entry = undefined;
      } else if (orderRevision(order) !== Number(entry.before_revision) || (!same && entry.pending_until.getTime() <= now().getTime())) {
        await close(entry, 'expired', 'ORDER_PROVIDER_RETRY');
        if (same) throw new PosError(409, 'ORDER_PROVIDER_RETRY');
        entry = undefined;
      } else if (!same) {
        throw new PosError(409, 'ORDER_PROVIDER_PENDING');
      }
    }

    if (!entry) {
      const revision = orderRevision(order);
      if (expectedRevision !== revision) throw new PosError(409, 'STALE_REVISION', { revision });
      if (order.status !== next[kind].from) throw new PosError(409, 'ORDER_TRANSITION', { status: order.status });
      const at = now();
      const created: Journal = { command_key: key, actor_id: actorId, fingerprint: hash, receipt_id: randomUUID(), order_ref: ref,
        action: kind, preparation_minutes: action.kind === 'prepare' ? action.preparationMinutes : null, before_revision: String(revision),
        state: 'pending', pending_until: new Date(at.getTime() + pendingLifetimeMs), failure: null, receipt: null };
      await inStore(async () => {
        await db.query('INSERT INTO pos.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [storeId]);
        const { rowCount } = await db.query(`
          INSERT INTO pos.naver_order_command (store_id, command_key, actor_id, fingerprint, receipt_id, order_ref, action,
            preparation_minutes, before_revision, state, pending_until, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11) ON CONFLICT DO NOTHING
        `, [storeId, key, actorId, hash, created.receipt_id, ref, kind, created.preparation_minutes, revision, created.pending_until, at]);
        if (!rowCount) throw new PosError(409, 'IDEMPOTENCY_MISMATCH');
      });
      entry = created;
    }

    let result: Order;
    try {
      result = await naver.fulfillOrder(scope, { key: 'pos-naver-order:' + entry.receipt_id }, ref, effectOf(entry));
    } catch (error) {
      // A transport failure or a missing read-back can follow an applied write: keep the journal for reconciliation.
      if (!(error instanceof NaverError) || ![400, 403, 404, 409].includes(error.status)) {
        throw new ProviderUnavailable('ORDER_PROVIDER_OUTCOME_UNKNOWN');
      }
      const failure = error.status === 404 ? 'ORDER_NOT_FOUND' : 'ORDER_PROVIDER_REFUSED';
      await close(entry, 'refused', failure);
      throw new PosError(error.status === 404 ? 404 : 409, failure);
    }
    if (result.orderNumber !== ref || !observed(result, entry)) throw new ProviderUnavailable('ORDER_PROVIDER_OUTCOME_UNKNOWN');
    return await settle(entry, result);
  } finally {
    try {
      if (locked && !discard) await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    } catch {
      discard = true;
    } finally {
      db.release(discard || !reusable(db));
    }
  }
}
