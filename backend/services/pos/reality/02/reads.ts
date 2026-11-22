import type { BillQuote, SaleLine } from '../../catalog.ts';
import { fingerprint, object, PosError, uuid, type PosTx } from '../../wire.ts';
import { validDate } from './terminal.ts';

export function listInput<Filter extends string>(value: unknown, filters: readonly Filter[], period = false) {
  const options = object(value, period ? ['cursor', 'limit', 'status', 'businessDate', 'from', 'to'] : ['cursor', 'limit', 'status']);
  const limit = options.limit === undefined ? 30 : typeof options.limit === 'string' && /^[1-9]\d?$/.test(options.limit) ? Number(options.limit) : 0;
  if (!limit || limit > 50) throw new PosError(400, 'INVALID_LIMIT');
  const filter = filters.find((candidate) => candidate === options.status) ?? null;
  if (options.status !== undefined && !filter) throw new PosError(400, 'INVALID_STATUS');
  const cursor = options.cursor === undefined ? null : uuid(options.cursor);
  if (options.businessDate !== undefined && (options.from !== undefined || options.to !== undefined)) {
    throw new PosError(400, 'INVALID_PERIOD');
  }
  const from = options.businessDate ?? options.from ?? null;
  const to = options.businessDate ?? options.to ?? null;
  if (from !== null || to !== null) {
    if (typeof from !== 'string' || typeof to !== 'string' || !validDate(from) || !validDate(to)
      || from > to || Date.parse(to) - Date.parse(from) > 92 * 86_400_000) {
      throw new PosError(400, 'INVALID_PERIOD');
    }
    return { limit, cursor, filter, from, to };
  }
  return { limit, cursor, filter, from: null, to: null };
}

export function page<Row>(tx: PosTx, rows: Row[], limit: number, id: (row: Row) => string) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? id(items[limit - 1]) : null;
  const sourceFingerprint = fingerprint({ items, nextCursor });
  return { items, nextCursor, asOf: tx.at.toISOString(), sourceRevision: Number.parseInt(sourceFingerprint.slice(0, 13), 16), sourceFingerprint };
}

type BillRow = {
  billId: string; businessDate: string; status: 'open' | 'paid' | 'void'; revision: number;
  type: 'dine_in' | 'takeout'; createdAt: Date; recognizedAt: Date | null; tableId: string | null; quote: BillQuote;
};

const billSelect = `SELECT b.bill_id AS "billId", b.business_date::text AS "businessDate", b.status,
    b.revision + (b.status <> 'open')::integer AS revision, b.draft->'request'->>'type' AS type,
    b.created_at AS "createdAt", b.recognized_at AS "recognizedAt", session.table_id AS "tableId",
    b.draft->'quote' AS quote, coalesce(orders.ids, '[]'::jsonb) AS "orderIds",
    s.settlement_id AS "settlementId", p.payment_id AS "paymentId",
    coalesce(p.source, CASE WHEN link.order_ref IS NOT NULL THEN 'naver' END) AS source,
    link.naver_pay_payment_id AS "naverPayPaymentId", link.smartstore_product_order_id AS "smartstoreProductOrderId",
    (CASE WHEN b.status = 'void' THEN 0 ELSE coalesce(s.amount - c.returned, (b.draft->'quote'->>'payable')::bigint) END)::double precision AS remaining
  FROM pos.bill b
  LEFT JOIN pos.settlement s USING (store_id, bill_id)
  LEFT JOIN pos.payment p USING (store_id, settlement_id)
  LEFT JOIN pos.naver_order_link link USING (store_id, payment_id)
  CROSS JOIN LATERAL (SELECT coalesce(sum(coalesce(member_sale_amount, amount)), 0) AS returned FROM pos.payment_correction
    WHERE store_id = s.store_id AND (payment_id = p.payment_id OR member_sale_settlement_id = s.settlement_id)) c
  LEFT JOIN LATERAL (SELECT table_id FROM pos.table_session
    WHERE store_id = b.store_id AND bill_id = b.bill_id
    ORDER BY open_ordinal DESC LIMIT 1) session ON true
  LEFT JOIN LATERAL (SELECT jsonb_agg(m.order_id ORDER BY m.order_no) AS ids FROM (
    SELECT DISTINCT l.order_id, o.order_no
    FROM pos.bill_allocation a JOIN pos.order_line l USING (store_id, order_line_id)
    JOIN pos.pos_order o USING (store_id, order_id)
    WHERE a.store_id = b.store_id AND a.bill_id = b.bill_id
  ) m) orders ON true`;

export async function billDetail({ db, storeId }: PosTx, billId: string) {
  const { rows: [bill] } = await db.query<BillRow>(`${billSelect} WHERE b.store_id = $1 AND b.bill_id = $2`, [storeId, billId]);
  if (!bill) throw new PosError(404, 'BILL_NOT_FOUND');
  return bill;
}

export async function listBills(tx: PosTx, query: unknown) {
  const { limit, cursor, filter, from, to } = listInput(query, ['open', 'paid', 'void'], true);
  const { rows } = await tx.db.query<BillRow>(`${billSelect} WHERE b.store_id = $1
    AND ($2::uuid IS NULL OR (b.created_at, b.bill_id) < ((SELECT created_at FROM pos.bill WHERE store_id = $1 AND bill_id = $2), $2))
    AND ($3::text IS NULL OR b.status = $3) AND ($4::date IS NULL OR b.business_date BETWEEN $4 AND $5)
    ORDER BY b.created_at DESC, b.bill_id DESC LIMIT $6`, [tx.storeId, cursor, filter, from, to, limit + 1]);
  return page(tx, rows, limit, (row) => row.billId);
}

type OrderRow = {
  orderId: string; orderNo: number; billId: string; businessDate: string; orderedAt: Date; revision: number;
  preparation: 'accepted' | 'preparing' | 'completed'; tableId: string | null; settlementId: string | null;
  paymentId: string | null; amount: number; remaining: number; lines: SaleLine[];
};

const orderSelect = `SELECT o.order_id AS "orderId", o.order_no AS "orderNo", o.origin_bill_id AS "originBillId",
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.bill_ids[1] ELSE o.origin_bill_id END AS "billId",
    placements.bill_ids AS "billIds",
    o.business_date::text AS "businessDate", o.ordered_at AS "orderedAt", o.revision, o.preparation,
    o.preparing_at AS "preparingAt", o.completed_at AS "completedAt", o.status_history AS "statusHistory",
    placements.table_ids AS "tableIds", CASE WHEN cardinality(placements.table_ids) = 1 THEN placements.table_ids[1] END AS "tableId",
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.settlements[1] END AS "settlementId",
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.payments[1] END AS "paymentId",
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.sources[1] END AS source,
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.naver_payments[1] END AS "naverPayPaymentId",
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.smartstore_orders[1] END AS "smartstoreProductOrderId",
    coalesce(placements.amount, 0)::double precision AS amount,
    coalesce(placements.remaining, 0)::double precision AS remaining,
    CASE WHEN placements.all_void THEN 'void' WHEN placements.all_paid THEN 'paid' ELSE 'open' END AS status,
    CASE WHEN cardinality(placements.bill_ids) = 1 THEN placements.lines ELSE original.lines END AS lines
  FROM pos.pos_order o
  CROSS JOIN LATERAL (
    SELECT coalesce(array_agg(DISTINCT b.bill_id), '{}') AS bill_ids,
      coalesce(array_agg(DISTINCT t.table_id) FILTER (WHERE t.table_id IS NOT NULL AND b.status <> 'void'), '{}') AS table_ids,
      array_agg(DISTINCT s.settlement_id) AS settlements, array_agg(DISTINCT p.payment_id) AS payments,
      array_agg(DISTINCT coalesce(p.source, CASE WHEN link.order_ref IS NOT NULL THEN 'naver' END)) AS sources,
      array_agg(DISTINCT link.naver_pay_payment_id) AS naver_payments,
      array_agg(DISTINCT link.smartstore_product_order_id) AS smartstore_orders,
      bool_and(b.status = 'void') AS all_void, bool_and(b.status = 'paid') AS all_paid,
      jsonb_agg(snapshot.line ORDER BY l.order_line_id, a.allocation_id) AS lines,
      sum((snapshot.line->>'amount')::bigint) AS amount,
      sum(CASE WHEN b.status = 'void' THEN 0 ELSE (snapshot.line->>'amount')::bigint - c.returned END) AS remaining
    FROM pos.order_line l
    JOIN pos.bill_allocation a USING (store_id, order_line_id)
    JOIN pos.bill b USING (store_id, bill_id)
    LEFT JOIN pos.settlement s USING (store_id, bill_id)
    LEFT JOIN pos.payment p USING (store_id, settlement_id)
    LEFT JOIN pos.naver_order_link link USING (store_id, payment_id)
    LEFT JOIN pos.settlement_line sl USING (store_id, settlement_id, allocation_id)
    LEFT JOIN LATERAL (SELECT table_id FROM pos.table_session WHERE store_id = b.store_id AND bill_id = b.bill_id
      ORDER BY open_ordinal DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(b.draft->'quote'->'lines')
      WHERE value->>'allocationId' = a.allocation_id::text) draft ON sl.snapshot IS NULL
    CROSS JOIN LATERAL (SELECT coalesce(sl.snapshot, draft.value, l.snapshot) AS line) snapshot
    CROSS JOIN LATERAL (SELECT coalesce(sum((entry->>'amount')::bigint), 0) AS returned
      FROM pos.payment_correction pc CROSS JOIN LATERAL jsonb_array_elements(pc.allocations) entry
      WHERE pc.store_id = s.store_id AND (pc.payment_id = p.payment_id OR pc.member_sale_settlement_id = s.settlement_id)
      AND entry->>'allocationId' = a.allocation_id::text) c
    WHERE l.store_id = o.store_id AND l.order_id = o.order_id
  ) placements
  CROSS JOIN LATERAL (SELECT jsonb_agg(snapshot ORDER BY order_line_id) AS lines FROM pos.order_line
    WHERE store_id = o.store_id AND order_id = o.order_id) original`;

export async function orderDetail({ db, storeId }: PosTx, orderId: string) {
  const { rows: [order] } = await db.query<OrderRow>(`${orderSelect} WHERE o.store_id = $1 AND o.order_id = $2`, [storeId, orderId]);
  if (!order) throw new PosError(404, 'ORDER_NOT_FOUND');
  return order;
}

export async function listOrders(tx: PosTx, query: unknown) {
  const { limit, cursor, filter, from, to } = listInput(query, ['accepted', 'preparing', 'completed'], true);
  const { rows } = await tx.db.query<OrderRow>(`${orderSelect} WHERE o.store_id = $1
    AND ($2::uuid IS NULL OR (o.ordered_at, o.order_id) < ((SELECT ordered_at FROM pos.pos_order WHERE store_id = $1 AND order_id = $2), $2))
    AND ($3::text IS NULL OR o.preparation = $3) AND ($4::date IS NULL OR o.business_date BETWEEN $4 AND $5)
    ORDER BY o.ordered_at DESC, o.order_id DESC LIMIT $6`, [tx.storeId, cursor, filter, from, to, limit + 1]);
  return page(tx, rows, limit, (row) => row.orderId);
}
