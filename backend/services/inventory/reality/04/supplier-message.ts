import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { eucKrBytes, validSmsNumber } from '../../../../../frontend/server/sens-sms.mjs';
import { appendPurchaseEvent, lockPurchasing } from '../../receipts.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { CardError, fingerprint } from '../01/owner-card.ts';
import { publicationHttp } from '../01/publication-routes.ts';
import { uuid } from '../03/wire.ts';
import { purchaseOrder, supplier, type OrderRow } from './read.ts';

export const supplierMessageRequested = 'inventory.supplier_message_requested.v1';
export const supplierMessageStatus = 'inventory.supplier_message_status_changed.v1';
export const supplierWorkerRoot = '/internal/v1/inventory/supplier-dispatch/stores/:storeId';
export type SupplierChannel = 'sms' | 'mail';
type DispatchState = 'queued' | 'ready' | 'dispatching' | 'unknown' | 'accepted' | 'delivered' | 'failed' | 'blocked';
export type SupplierMessageReceipt = {
  receiptId: string; resourceId: string; revision: number; channel: SupplierChannel;
  scheduledAt: string | null; state: Exclude<DispatchState, 'ready'>; providerMode: 'virtual' | 'live'; reason?: string;
};
type Dispatch = { receipt_id: string; po_id: string; order_revision: number; channel: SupplierChannel; snapshot: string;
  scheduled_at: Date | null; state: DispatchState; provider_id: string | null; started_at: Date | null;
  provider_live: boolean; block_reason: string | null };
const email = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/;
const quantityFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 3 });
const dateFormat = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' });
const title = '발주 요청';

export function supplierSendTime(now: Date) {
  const local = new Date(+now + 9 * 3_600_000);
  const hour = local.getUTCHours();
  if (hour >= 8 && hour < 21) return null;
  const next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 8);
  return new Date(next - 9 * 3_600_000).toISOString();
}

function messageBody(order: OrderRow, legacy = false) {
  const lines = order.lines.map(line => {
    const quantity = legacy ? String(line.qtyOrdered) : quantityFormat.format(line.qtyOrdered);
    const unit = !legacy && line.unitSnapshot === 'pcs' ? '개' : ' ' + line.unitSnapshot;
    return `${line.itemNameSnapshot ?? '품목'} ${quantity}${unit}`;
  });
  if (order.dueDate) {
    const at = new Date(`${order.dueDate}T00:00:00Z`);
    const date = legacy ? order.dueDate : `${at.getUTCMonth() + 1}/${at.getUTCDate()}(${dateFormat.format(at)})`;
    lines.push(`납기: ${date}${order.expectedTime ? ` ${order.expectedTime}` : ''}`);
  }
  const reference = legacy ? order.poId : `PO-${order.poId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  return [title, ...lines, `발주 번호: ${reference}`].join('\n');
}

async function source(db: PoolClient, store: string, id: string, channel: SupplierChannel) {
  const order = await purchaseOrder(db, store, id);
  if (order.status !== 'scheduled' || !order.lines.length) throw new CardError(409, 'SUPPLIER_ORDER_NOT_SENDABLE');
  const recipient = await supplier(db, store, order.supplierId);
  const target = channel === 'sms' ? recipient.phone?.replace(/[- ]/g, '') : recipient.contact?.trim();
  if (!target || !(channel === 'sms' ? validSmsNumber(target) : email.test(target))) {
    throw new CardError(409, 'SUPPLIER_CHANNEL_UNAVAILABLE');
  }
  const body = messageBody(order);
  return { order, supplierRevision: recipient.revision, target,
    display: { orderRevision: order.revision, supplierName: recipient.name, title, body } };
}

function receipt(row: Dispatch): SupplierMessageReceipt {
  return { receiptId: row.receipt_id, resourceId: row.po_id, revision: row.order_revision, channel: row.channel,
    scheduledAt: row.scheduled_at?.toISOString() ?? null, state: row.state === 'ready' ? 'queued' : row.state,
    providerMode: row.provider_live ? 'live' : 'virtual',
    ...(row.block_reason && { reason: row.block_reason }) };
}

async function statusEvent(db: PoolClient, store: string, row: Dispatch, state: DispatchState) {
  await appendPurchaseEvent(db, store, new Date(), supplierMessageStatus, randomUUID(),
    { receiptId: row.receipt_id, purchaseOrderId: row.po_id, state });
}

export function registerSupplierMessages(
  app: FastifyInstance, pool: Pool, gatewayToken: string,
  { workerToken, storeId, now = () => new Date(), live = process.env.NAVIS_NCP_SENS_PROVIDER === 'live' }:
    { workerToken: string; storeId: string; now?: () => Date; live?: boolean },
) {
  if (!workerToken || workerToken === gatewayToken) throw new Error('Supplier worker requires a distinct private workload token');
  const configuredStore = uuid(storeId, 'storeId');
  function boundStore(value: unknown) {
    const store = uuid(value, 'storeId');
    if (store !== configuredStore) throw new CardError(403, 'SUPPLIER_PERSONA_STORE_FORBIDDEN');
    return store;
  }
  const http = publicationHttp(app, pool, gatewayToken);
  const path = '/purchase-orders/:id/supplier-message';
  http.route('GET', path, (db, scope, req) => withStoreTransaction(db, scope.storeId, async client => {
    const { rows } = await client.query<Dispatch>(`
      SELECT * FROM inventory.supplier_dispatch WHERE store_id=$1 AND po_id=$2
      ORDER BY order_revision DESC, created_at DESC, receipt_id LIMIT 20
    `, [scope.storeId, uuid(req.params.id, 'poId')]);
    return { items: rows.map(receipt) };
  }, { readOnly: true }));
  http.command({
    kind: 'supplier-message', path,
    input(body): { channel: SupplierChannel } {
      const channel = (body as { channel?: unknown } | undefined)?.channel;
      if ((channel !== 'sms' && channel !== 'mail') || Object.keys(body as object).length !== 1) {
        throw new CardError(400, 'INVALID_SUPPLIER_CHANNEL');
      }
      return { channel };
    },
    async view(db, scope, id, { channel }) {
      boundStore(scope.storeId);
      const { target, supplierRevision, display } = await source(db, scope.storeId, id, channel);
      if (channel === 'sms' && eucKrBytes(display.body) > 2000) throw new CardError(409, 'SUPPLIER_MESSAGE_TOO_LONG');
      return { expectedRevision: display.orderRevision, changed: true, view: { ...display, targetHint: '••••' + target.slice(-4),
        sourceRevision: fingerprint([supplierRevision, target, display]), scheduledAt: supplierSendTime(now()) } };
    },
    async apply(db, scope, id, { channel }, view, receiptId) {
      await lockPurchasing(db, scope.storeId);
      const { target, supplierRevision, display } = await source(db, scope.storeId, id, channel);
      if (fingerprint([supplierRevision, target, display]) !== view.sourceRevision) throw new CardError(409, 'STALE_REVISION');
      const { rows: [created] } = await db.query<Dispatch>(`
        INSERT INTO inventory.supplier_dispatch (store_id, receipt_id, po_id, order_revision, channel, snapshot, scheduled_at, provider_live)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (store_id, po_id, order_revision, channel)
          WHERE state NOT IN ('failed', 'blocked') DO NOTHING RETURNING *
      `, [scope.storeId, receiptId, id, display.orderRevision, channel, view.sourceRevision, view.scheduledAt, live]);
      if (!created) throw new CardError(409, 'SUPPLIER_ORDER_ALREADY_QUEUED');
      await appendPurchaseEvent(db, scope.storeId, new Date(), supplierMessageRequested, receiptId, { receiptId });
      return { ...receipt(created), affectedSources: ['inventory.supplier-message'] };
    },
  });

  const expected = Buffer.from(fingerprint('Bearer ' + workerToken), 'hex');
  app.register(async routes => {
    type Params = { storeId: string; receiptId?: string };
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const value = request.headers.authorization;
      if (!value || !timingSafeEqual(Buffer.from(fingerprint(value), 'hex'), expected)) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
    });
    routes.setErrorHandler((error, _req, reply) => {
      if (error instanceof CardError) return reply.code(error.status).send({ code: error.code });
      return reply.code(503).send({ code: 'SUPPLIER_DISPATCH_UNAVAILABLE' });
    });
    routes.get<{ Params: Params }>(supplierWorkerRoot, async req => {
      const store = boundStore(req.params.storeId);
      return withStoreTransaction(pool, store, async db => {
        const { rows } = await db.query<Dispatch>(`
          SELECT * FROM inventory.supplier_dispatch WHERE store_id=$1 AND
          ((state='ready' AND coalesce(scheduled_at, '-infinity') <= $2)
           OR state='accepted' OR (state='dispatching' AND started_at < clock_timestamp() - interval '2 minutes'))
          ORDER BY CASE WHEN state='ready' THEN 0 ELSE 1 END, receipt_id LIMIT 20
        `, [store, now()]);
        return rows.map(row => ({ ...receipt(row), state: row.state, providerId: row.provider_id,
          ...(row.provider_live && { providerLive: true }) }));
      }, { readOnly: true });
    });
    routes.post<{ Params: Params }>(supplierWorkerRoot + '/:receiptId/ready', async (req, reply) => {
      const store = boundStore(req.params.storeId);
      await withStoreTransaction(pool, store, db => db.query(
        "UPDATE inventory.supplier_dispatch SET state='ready' WHERE store_id=$1 AND receipt_id=$2 AND state='queued'",
        [store, uuid(req.params.receiptId, 'receiptId')]));
      return reply.code(204).send();
    });
    routes.post<{ Params: Params }>(supplierWorkerRoot + '/:receiptId/claim', async req => {
      const store = boundStore(req.params.storeId);
      return withStoreTransaction(pool, store, async db => {
        await lockPurchasing(db, store);
        const { rows: [row] } = await db.query<Dispatch>(`
          UPDATE inventory.supplier_dispatch SET state='dispatching', started_at=clock_timestamp()
          WHERE store_id=$1 AND receipt_id=$2 AND state='ready' AND coalesce(scheduled_at, '-infinity') <= $3
          RETURNING *
        `, [store, uuid(req.params.receiptId, 'receiptId'), now()]);
        if (!row) return null;
        try {
          const { target, supplierRevision, display, order } = await source(db, store, row.po_id, row.channel);
          // A queued receipt can still carry the exact text the owner approved before this format changed.
          const accepted = [display, { ...display, body: messageBody(order, true) }]
            .find(candidate => fingerprint([supplierRevision, target, candidate]) === row.snapshot);
          if (accepted) return { channel: row.channel, target, title: accepted.title, body: accepted.body,
            ...(row.provider_live && { providerLive: true }) };
        } catch (error) {
          if (!(error instanceof CardError) && !(error instanceof Error && 'status' in error && error.status === 404)) throw error;
        }
        await db.query("UPDATE inventory.supplier_dispatch SET state='blocked' WHERE store_id=$1 AND receipt_id=$2", [store, row.receipt_id]);
        await statusEvent(db, store, row, 'blocked');
        return null;
      });
    });
    routes.post<{ Params: Params; Body: { state?: string; providerId?: string; reason?: string } }>(supplierWorkerRoot + '/:receiptId/result',
      { bodyLimit: 1024 }, async (req, reply) => {
        const store = boundStore(req.params.storeId);
        const { state, providerId, reason } = req.body ?? {};
        if ((state !== 'accepted' && state !== 'delivered' && state !== 'failed' && state !== 'unknown' && state !== 'blocked')
          || (state === 'blocked' ? !['NOT_SENT_TEST_MODE', 'SMS_SETTINGS_REQUIRED'].includes(reason ?? '') : reason !== undefined)
          || (state === 'accepted' && (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(providerId)))) {
          throw new CardError(400, 'INVALID_SUPPLIER_STATUS');
        }
        await withStoreTransaction(pool, store, async db => {
          const { rows: [row] } = await db.query<Dispatch>(`
            UPDATE inventory.supplier_dispatch SET state=$3, provider_id=coalesce($4,provider_id), block_reason=$5
            WHERE store_id=$1 AND receipt_id=$2 AND
              (($3 IN ('accepted','unknown') AND state='dispatching') OR
               ($3='blocked' AND provider_live AND state='dispatching') OR
               ($3='failed' AND state IN ('dispatching','accepted')) OR ($3='delivered' AND state='accepted'))
            RETURNING *
          `, [store, uuid(req.params.receiptId, 'receiptId'), state, state === 'accepted' ? providerId : null, reason ?? null]);
          if (row) await statusEvent(db, store, row, state);
        });
        return reply.code(204).send();
      });
  });
}
