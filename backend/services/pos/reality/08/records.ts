import { randomUUID } from 'node:crypto';
import type { CustomHistory, CustomOrder, CustomOrderView, CustomReceipt, CustomTemplate, PickupReservation }
  from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { appendOutbox } from '../../ledger.ts';
import { commandReceipt, fingerprint, object, PosError, type PosTx } from '../../wire.ts';
import { listInput } from '../02/reads.ts';
import { duplicateIdentity, pickupStatuses, stages, text } from './input.ts';

export const customSources = ['custom-order', 'voice-booking', 'calendar', 'briefing'];
export const financeSources = ['pos.deposits', 'pos.ledger', 'pos.margins', 'pos.closings', 'pos.receipts'];
export const templateSources = ['custom-order'];
export const approved = (order: Order) => order.customerDecision === 'approved' && order.approvedQuoteRevision === order.quoteRevision && order.quoteAmount !== null;
export const active = (stage: CustomOrder['stage']) => stage !== 'canceled' && stage !== 'received_by_customer';

export type Order = Pick<CustomOrder, 'customOrderId' | 'templateId' | 'templateSnapshot' | 'proposedPickupAt' | 'productionAt'
  | 'quoteAmount' | 'quoteRevision' | 'customerDecision' | 'approvedQuoteRevision' | 'stage' | 'paymentTiming' | 'settlementId' | 'history'> & {
  orderNo: number;
  revision: number;
  receipt: CustomReceipt;
  pickup: PickupReservation | null;
  paymentId: string | null;
  amountSettled: number;
  amountReturned: number;
  realDeposits: number;
  chargeApplied: number;
  receivableAmount: number;
  hasRefund: boolean;
};
type OrderRecord = Order & {
  reservationId: string | null; pickupDate: string | null; pickupTime: string | null;
  pickupStatus: PickupReservation['status'] | null; pickupUpdatedAt: Date | null;
};
type OrderWrite = Pick<Order, 'customOrderId' | 'templateId' | 'templateSnapshot' | 'receipt' | 'proposedPickupAt' | 'productionAt'
  | 'stage' | 'customerDecision' | 'paymentTiming' | 'quoteAmount' | 'quoteRevision' | 'approvedQuoteRevision' | 'settlementId' | 'revision'>;
type WriteEvent = { kind: CustomHistory['kind']; detail: string; referenceId?: string };

const templateColumns = 'template_id AS "templateId", name, fields, revision, archived_at AS "archivedAt"';

export async function customPage<T>(tx: PosTx, rows: T[], limit: number, id: (row: T) => string) {
  const { rows: [scope] } = await tx.db.query<{ seq: string }>(
    'SELECT last_seq AS seq FROM pos.outbox_scope WHERE store_id = $1', [tx.storeId]);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? id(items[limit - 1]) : null,
    asOf: tx.at.toISOString(), sourceRevision: Number(scope?.seq ?? 0) };
}

export async function templateDetail(tx: PosTx, id: string, includeArchived = false) {
  const { rows: [row] } = await tx.db.query<CustomTemplate>(`SELECT ${templateColumns}
    FROM pos.custom_template WHERE store_id = $1 AND template_id = $2 AND ($3 OR archived_at IS NULL)`,
  [tx.storeId, id, includeArchived]);
  if (!row) throw new PosError(404, 'TEMPLATE_NOT_FOUND');
  return row;
}

export async function listTemplates(tx: PosTx, query: unknown) {
  const { cursor, limit } = listInput(query, []);
  const { rows } = await tx.db.query<CustomTemplate>(`SELECT ${templateColumns} FROM pos.custom_template
    WHERE store_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR template_id > $2)
    ORDER BY template_id LIMIT $3`, [tx.storeId, cursor, limit + 1]);
  return customPage(tx, rows, limit, item => item.templateId);
}

export async function putTemplate(tx: PosTx, row: CustomTemplate) {
  await tx.db.query(`INSERT INTO pos.custom_template (store_id, template_id, name, fields, revision, archived_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (store_id, template_id) DO UPDATE SET name = EXCLUDED.name, fields = EXCLUDED.fields,
       revision = EXCLUDED.revision, archived_at = EXCLUDED.archived_at`,
  [tx.storeId, row.templateId, row.name, JSON.stringify(row.fields), row.revision, row.archivedAt]);
  await appendOutbox(tx, 'pos.custom_template_changed.v1', row.templateId,
    { templateId: row.templateId, revision: row.revision, archived: row.archivedAt !== null });
  return { ...commandReceipt(row.templateId, row.revision, templateSources), templateId: row.templateId, changed: true };
}

const orderSelect = `
  SELECT o.custom_order_id AS "customOrderId", o.order_no AS "orderNo", o.template_id AS "templateId",
    o.template_snapshot AS "templateSnapshot", o.receipt, o.revision, o.stage,
    to_char(o.proposed_pickup_at, 'YYYY-MM-DD"T"HH24:MI') AS "proposedPickupAt",
    to_char(o.production_at, 'YYYY-MM-DD"T"HH24:MI') AS "productionAt",
    o.quote_amount::double precision AS "quoteAmount", o.quote_revision AS "quoteRevision",
    o.customer_decision AS "customerDecision", o.approved_quote_revision AS "approvedQuoteRevision",
    o.payment_timing AS "paymentTiming", o.settlement_id AS "settlementId",
    p.reservation_id AS "reservationId", to_char(p.scheduled_at, 'YYYY-MM-DD') AS "pickupDate",
    to_char(p.scheduled_at, 'HH24:MI') AS "pickupTime", p.status AS "pickupStatus", p.updated_at AS "pickupUpdatedAt",
    pay.payment_id AS "paymentId", coalesce(s.amount, 0)::double precision AS "amountSettled",
    coalesce(c.returned, 0)::double precision AS "amountReturned", coalesce(c.refunded, false) AS "hasRefund",
    (coalesce(pay.amount, 0) - coalesce(c.cash_returned, 0))::double precision AS "realDeposits",
    coalesce(m.charge_applied, 0)::double precision AS "chargeApplied",
    coalesce(m.receivable_amount, 0)::double precision AS "receivableAmount",
    coalesce(h.records, '[]'::jsonb) AS history
  FROM pos.custom_order o
  LEFT JOIN pos.custom_pickup p USING (store_id, custom_order_id)
  LEFT JOIN pos.settlement s USING (store_id, settlement_id)
  LEFT JOIN pos.payment pay USING (store_id, settlement_id)
  LEFT JOIN LATERAL (
    SELECT sum(coalesce(custom_order_amount, amount)) AS returned, sum(amount) AS cash_returned,
      bool_or(kind = 'refund') AS refunded
    FROM pos.payment_correction
    WHERE store_id = o.store_id AND (payment_id = pay.payment_id OR custom_order_settlement_id = s.settlement_id)
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT -sum(amount) FILTER (WHERE account = 'charge') AS charge_applied,
      sum(amount) FILTER (WHERE account = 'receivable') AS receivable_amount
    FROM pos.member_account_entry
    WHERE store_id = o.store_id AND settlement_id = s.settlement_id
  ) m ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(record ORDER BY order_revision) AS records FROM pos.custom_order_history
    WHERE store_id = o.store_id AND custom_order_id = o.custom_order_id
  ) h ON true`;

function withPickup(row: OrderRecord): Order {
  const { reservationId, pickupDate: date, pickupTime: time, pickupStatus: status, pickupUpdatedAt, ...order } = row;
  const pickup = reservationId && date && time && status && pickupUpdatedAt
    ? { kind: 'pickup' as const, reservationId, customOrderId: order.customOrderId, date, time, status, updatedAt: pickupUpdatedAt.toISOString() }
    : null;
  return { ...order, pickup };
}

function orderView(order: Order): CustomOrderView & { orderNo: number; revision: number; paymentId: string | null } {
  const { receipt, amountSettled, amountReturned, realDeposits, chargeApplied, receivableAmount, hasRefund, ...fields } = order;
  const pickup = fields.pickup;
  const status = hasRefund ? 'refunded' : amountReturned ? 'canceled' : amountSettled ? 'paid' : 'unpaid';
  return {
    ...receipt, ...fields, templateRevision: order.templateSnapshot.revision,
    pickupReservationId: pickup?.reservationId ?? null,
    confirmedPickupAt: pickup ? pickupStamp(pickup) : null,
    payment: { status, amountSettled, amountReturned, realDeposits, chargeApplied, receivableAmount },
  };
}

export async function readOrder(tx: PosTx, id: string, byPickup = false) {
  const { rows: [row] } = await tx.db.query<OrderRecord>(`${orderSelect}
    WHERE o.store_id = $1 AND ${byPickup ? 'p.reservation_id' : 'o.custom_order_id'} = $2`, [tx.storeId, id]);
  if (!row) throw new PosError(404, byPickup ? 'PICKUP_NOT_FOUND' : 'CUSTOM_ORDER_NOT_FOUND');
  return withPickup(row);
}

export async function orderDetail(tx: PosTx, id: string) {
  return orderView(await readOrder(tx, id));
}

export async function listOrders(tx: PosTx, query: unknown) {
  const { query: search, ...list } = object(query, ['cursor', 'limit', 'status', 'businessDate', 'from', 'to', 'query']);
  const { cursor, limit, filter, from, to } = listInput(list, stages, true);
  const term = search === undefined ? null : text(search, 'query', 120, true);
  const schedule = "coalesce(p.scheduled_at, o.proposed_pickup_at, o.desired_pickup_at)::date";
  const { rows } = await tx.db.query<OrderRecord>(`${orderSelect}
    WHERE o.store_id = $1 AND ($2::uuid IS NULL OR o.custom_order_id > $2) AND ($3::text IS NULL OR o.stage = $3)
      AND ($4::date IS NULL OR ${schedule} BETWEEN $4 AND $5)
      AND ($6::text IS NULL OR strpos(lower(o.receipt->>'productLabel'), lower($6)) > 0
        OR strpos(lower(o.receipt->'guest'->>'name'), lower($6)) > 0
        OR strpos('co-' || lpad(o.order_no::text, greatest(3,length(o.order_no::text)), '0'), lower($6)) > 0)
    ORDER BY o.custom_order_id LIMIT $7`, [tx.storeId, cursor, filter, from, to, term || null, limit + 1]);
  return customPage(tx, rows.map(row => orderView(withPickup(row))), limit, item => item.customOrderId);
}

export async function listPickups(tx: PosTx, query: unknown) {
  const { cursor, limit, filter, from, to } = listInput(query, pickupStatuses, true);
  const { rows } = await tx.db.query<PickupReservation & { revision: number }>(`
    SELECT 'pickup' AS kind, p.reservation_id AS "reservationId", p.custom_order_id AS "customOrderId", o.revision,
      to_char(p.scheduled_at, 'YYYY-MM-DD') AS date, to_char(p.scheduled_at, 'HH24:MI') AS time, p.status, p.updated_at AS "updatedAt"
    FROM pos.custom_pickup p JOIN pos.custom_order o USING (store_id, custom_order_id)
    WHERE p.store_id = $1 AND ($2::uuid IS NULL OR p.reservation_id > $2) AND ($3::text IS NULL OR p.status = $3)
      AND ($4::date IS NULL OR p.scheduled_at::date BETWEEN $4 AND $5)
    ORDER BY p.reservation_id LIMIT $6`, [tx.storeId, cursor, filter, from, to, limit + 1]);
  return customPage(tx, rows, limit, item => item.reservationId);
}

export function requestFingerprint(templateId: string, receipt: CustomReceipt) {
  return fingerprint(duplicateIdentity(templateId, receipt));
}

export async function assertUniqueRequest(tx: PosTx, digest: string, orderId?: string) {
  const { rows: [duplicate] } = await tx.db.query<{ customOrderId: string }>(`
    SELECT custom_order_id AS "customOrderId" FROM pos.custom_order
    WHERE store_id = $1 AND request_fingerprint = $2 AND ($3::uuid IS NULL OR custom_order_id <> $3)
      AND stage NOT IN ('canceled', 'received_by_customer')`, [tx.storeId, digest, orderId ?? null]);
  if (duplicate) throw new PosError(409, 'DUPLICATE_CUSTOM_ORDER', duplicate);
}

function orderValues(tx: PosTx, order: OrderWrite) {
  return [tx.storeId, order.customOrderId, order.templateId, order.templateSnapshot, order.receipt,
    requestFingerprint(order.templateId, order.receipt), order.receipt.desiredPickupAt, order.proposedPickupAt,
    order.productionAt, order.stage, order.customerDecision, order.paymentTiming, order.quoteAmount,
    order.quoteRevision, order.approvedQuoteRevision, order.settlementId, order.revision];
}

export async function insertOrder(tx: PosTx, order: OrderWrite): Promise<number> {
  const { rows: [inserted] } = await tx.db.query<{ orderNo: number }>(`
    INSERT INTO pos.custom_order (store_id,custom_order_id,template_id,template_snapshot,receipt,request_fingerprint,
      desired_pickup_at,proposed_pickup_at,production_at,stage,customer_decision,payment_timing,
      quote_amount,quote_revision,approved_quote_revision,settlement_id,revision,order_no)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       (SELECT coalesce(max(order_no), 0) + 1 FROM pos.custom_order WHERE store_id = $1))
    RETURNING order_no AS "orderNo"`, orderValues(tx, order));
  await recordOrderEvent(tx, order, null, { kind: 'created', detail: 'received' });
  return inserted.orderNo;
}

export function pickupFor(tx: PosTx, order: Order, scheduled: string, status: PickupReservation['status']): PickupReservation {
  return { kind: 'pickup', customOrderId: order.customOrderId, reservationId: order.pickup?.reservationId ?? randomUUID(),
    date: scheduled.slice(0, 10), time: scheduled.slice(11), status, updatedAt: tx.at.toISOString() };
}

export function pickupStamp(pickup: PickupReservation) {
  return `${pickup.date}T${pickup.time}`;
}

export function closePickup(tx: PosTx, pickup: PickupReservation | null, status: 'completed' | 'canceled') {
  return pickup?.status === 'confirmed' ? { ...pickup, status, updatedAt: tx.at.toISOString() } : pickup;
}

export async function writeOrder(tx: PosTx, order: Order, patch: Partial<Order>, event: WriteEvent,
  pickup = order.pickup, { money = false, receiptId }: { money?: boolean; receiptId?: string } = {}) {
  const next = { ...order, ...patch, revision: order.revision + 1 };
  if (!active(next.stage) && next.receipt.guest?.phone) {
    next.receipt = { ...next.receipt, guest: { ...next.receipt.guest, phone: '' } };
  }
  await tx.db.query(`UPDATE pos.custom_order SET receipt=$3, request_fingerprint=$4, desired_pickup_at=$5,
    proposed_pickup_at=$6, production_at=$7, stage=$8, customer_decision=$9, payment_timing=$10,
    quote_amount=$11, quote_revision=$12, approved_quote_revision=$13, settlement_id=$14, revision=$15
    WHERE store_id=$1 AND custom_order_id=$2`, [
    tx.storeId, next.customOrderId, next.receipt, requestFingerprint(next.templateId, next.receipt), next.receipt.desiredPickupAt,
    next.proposedPickupAt, next.productionAt, next.stage, next.customerDecision, next.paymentTiming, next.quoteAmount,
    next.quoteRevision, next.approvedQuoteRevision, next.settlementId, next.revision,
  ]);
  if (pickup && pickup !== order.pickup) {
    await tx.db.query(`INSERT INTO pos.custom_pickup (store_id,custom_order_id,reservation_id,scheduled_at,status,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (store_id,custom_order_id) DO UPDATE
      SET scheduled_at=EXCLUDED.scheduled_at, status=EXCLUDED.status, updated_at=EXCLUDED.updated_at`,
    [tx.storeId, order.customOrderId, pickup.reservationId, pickupStamp(pickup), pickup.status, pickup.updatedAt]);
  }
  await recordOrderEvent(tx, next, pickup, event);
  return orderReceipt(next, pickup, money, receiptId);
}

export function orderReceipt(order: Pick<Order, 'customOrderId' | 'orderNo' | 'revision' | 'stage' | 'quoteRevision' | 'settlementId'>,
  pickup: PickupReservation | null, money = false, receiptId?: string, changed = true) {
  return { ...commandReceipt(order.customOrderId, order.revision, money ? [...customSources, ...financeSources] : customSources, receiptId),
    customOrderId: order.customOrderId, orderNo: order.orderNo, stage: order.stage, quoteRevision: order.quoteRevision, changed,
    ...(pickup && { pickupReservationId: pickup.reservationId, reservationId: pickup.reservationId }),
    ...(order.settlementId && { settlementId: order.settlementId }) };
}

async function recordOrderEvent(tx: PosTx, order: OrderWrite, pickup: PickupReservation | null, event: WriteEvent) {
  const { customOrderId, revision, stage, quoteRevision, productionAt } = order;
  const history: CustomHistory = { historyId: randomUUID(), at: tx.at.toISOString(),
    kind: event.kind, detail: event.detail, referenceId: event.referenceId ?? null, stage, quoteRevision };
  await tx.db.query(`INSERT INTO pos.custom_order_history (store_id,custom_order_id,order_revision,record) VALUES ($1,$2,$3,$4)`,
    [tx.storeId, customOrderId, revision, history]);
  const scheduled = pickup?.status === 'confirmed';
  await appendOutbox(tx, 'pos.custom_pickup_changed.v1', customOrderId, {
    revision, stage, pickupProjection: pickup,
    calendarProjection: { source: 'custom-pickup', sourceId: customOrderId, revision,
      entry: scheduled ? { date: pickup.date, time: pickup.time } : null },
    productionProjection: { source: 'custom-production', sourceId: customOrderId, revision,
      entry: scheduled && productionAt
        ? { date: productionAt.slice(0, 10), time: productionAt.slice(11) } : null },
  });
}
