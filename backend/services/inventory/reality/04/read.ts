import type { PoolClient } from 'pg';
import { date, pageInput, type Unit } from '../03/wire.ts';
import { PurchaseError } from './wire.ts';

export type SupplierRow = {
  supplierId: string; name: string; contact: string | null; phone: string | null; memo: string | null;
  archivedAt: Date | null; revision: number;
};
export type TermsRow = {
  purchaseItemId: string; itemId: string; supplierId: string; purchaseUnit: Unit; basePerUnit: number;
  minimumQty: number; orderStep: number; unitPrice: number; leadDays: number; archivedAt: Date | null; revision: number;
};
export type OrderLine = {
  polId: string; poId: string; itemId: string; itemNameSnapshot: string | null; unitSnapshot: string;
  basePerUnit: number; unitPrice: number; qtyOrdered: number; received: number; remaining: number;
};
export type OrderRow = {
  poId: string; supplierId: string; orderedOn: string; dueDate: string | null; expectedTime: string | null;
  status: 'scheduled' | 'partial' | 'complete' | 'canceled'; canceledAt: Date | null; revision: number; lines: OrderLine[];
};
export type ReceiptRow = {
  receiptId: string; poId: string; polId: string; qty: number; qtyRemaining: number; receivedAt: Date;
  businessDate: string | null; amount: number; voidedAt: Date | null;
};

const supplierColumns = `s.supplier_id AS "supplierId", s.name, s.contact, s.phone,
  s.memo, s.archived_at AS "archivedAt", s.revision`;
const termsColumns = `p.purchase_item_id AS "purchaseItemId", p.item_id AS "itemId", p.supplier_id AS "supplierId",
  p.purchase_unit AS "purchaseUnit", p.base_per_unit::double precision AS "basePerUnit",
  p.minimum_qty::double precision AS "minimumQty", p.order_step::double precision AS "orderStep",
  p.unit_price::double precision AS "unitPrice", p.lead_days AS "leadDays", p.archived_at AS "archivedAt", p.revision`;
const orderColumns = `o.po_id AS "poId", o.supplier_id AS "supplierId", o.ordered_on::text AS "orderedOn",
  o.due_date::text AS "dueDate", left(o.expected_time::text, 5) AS "expectedTime", o.canceled_at AS "canceledAt", o.revision`;

async function page<T>(db: PoolClient, store: string, at: Date, rows: T[], limit: number, id: (row: T) => string) {
  const { rows: [head] } = await db.query<{ last_seq: string }>(
    'SELECT last_seq FROM inventory.outbox_scope WHERE scope_key = $1', [store],
  );
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? id(items.at(-1)!) : null,
    asOf: at.toISOString(), sourceRevision: Number(head?.last_seq ?? 0) };
}

const publicSupplier = ({ archivedAt, ...row }: SupplierRow) => ({ ...row, archivedAt, deletedAt: archivedAt,
  phoneMask: row.phone?.replace(/\d(?=\D*(?:\d\D*){4})/g, '*') ?? '' });

export async function supplier(db: PoolClient, store: string, id: string, archived = false) {
  const { rows: [row] } = await db.query<SupplierRow>(`
    SELECT ${supplierColumns} FROM inventory.supplier s
    WHERE s.store_id = $1 AND s.supplier_id = $2 AND ($3 OR s.archived_at IS NULL)
  `, [store, id, archived]);
  if (!row) throw new PurchaseError(404, 'SUPPLIER_NOT_FOUND', 'supplierId');
  return publicSupplier(row);
}

export async function listSuppliers(db: PoolClient, store: string, at: Date, query: unknown) {
  const { cursor, limit } = pageInput(query, []);
  const { rows } = await db.query<SupplierRow>(`
    SELECT ${supplierColumns} FROM inventory.supplier s
    WHERE s.store_id = $1 AND ($2::uuid IS NULL OR s.supplier_id > $2)
    ORDER BY s.supplier_id LIMIT $3
  `, [store, cursor, limit + 1]);
  return page(db, store, at, rows.map(publicSupplier), limit, row => row.supplierId);
}

export async function terms(db: PoolClient, store: string, id: string, archived = false) {
  const { rows: [row] } = await db.query<TermsRow>(`
    SELECT ${termsColumns} FROM inventory.purchase_item p
    WHERE p.store_id = $1 AND p.purchase_item_id = $2 AND ($3 OR p.archived_at IS NULL)
  `, [store, id, archived]);
  if (!row) throw new PurchaseError(404, 'PURCHASE_ITEM_NOT_FOUND', 'purchaseItemId');
  return row;
}

export async function listTerms(db: PoolClient, store: string, at: Date, query: unknown) {
  const { cursor, limit } = pageInput(query, []);
  const { rows } = await db.query<TermsRow>(`
    SELECT ${termsColumns} FROM inventory.purchase_item p
    WHERE p.store_id = $1 AND p.archived_at IS NULL AND ($2::uuid IS NULL OR p.purchase_item_id > $2)
    ORDER BY p.purchase_item_id LIMIT $3
  `, [store, cursor, limit + 1]);
  return page(db, store, at, rows, limit, row => row.purchaseItemId);
}

export const orderOpen = (row: OrderRow) => row.status === 'scheduled' || row.status === 'partial';

async function orderRows(
  db: PoolClient, store: string, id: string | null, cursor: string | null, limit: number,
  from: string | null = null, to: string | null = null,
) {
  const { rows } = await db.query<Omit<OrderRow, 'status'>>(`
    SELECT ${orderColumns}, coalesce(lines.items, '[]'::jsonb) AS lines
    FROM (
      SELECT * FROM inventory.purchase_order
      WHERE store_id = $1 AND ($2::uuid IS NULL OR po_id = $2) AND ($3::uuid IS NULL OR po_id > $3)
        AND ($5::date IS NULL OR ordered_on >= $5) AND ($6::date IS NULL OR ordered_on <= $6)
      ORDER BY po_id LIMIT $4
    ) o LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'polId', l.pol_id, 'poId', l.po_id, 'itemId', l.item_id,
        'itemNameSnapshot', coalesce(l.item_name_snapshot, i.name), 'unitSnapshot', l.unit_snapshot,
        'basePerUnit', l.base_per_unit, 'unitPrice', l.unit_price, 'qtyOrdered', l.qty_ordered,
        'received', coalesce(r.qty, 0), 'remaining', greatest(l.qty_ordered - coalesce(r.qty, 0), 0)
      ) ORDER BY l.pol_id) AS items
      FROM inventory.purchase_order_line l
      JOIN inventory.inventory_item i USING (store_id, item_id)
      LEFT JOIN LATERAL (
        SELECT sum(qty) AS qty FROM inventory.goods_receipt g
        WHERE g.store_id = l.store_id AND g.pol_id = l.pol_id AND g.voided_at IS NULL
      ) r ON true
      WHERE l.store_id = o.store_id AND l.po_id = o.po_id
    ) lines ON true ORDER BY o.po_id
  `, [store, id, cursor, limit, from, to]);
  return rows.map((order): OrderRow => {
    if (order.canceledAt) return { ...order, status: 'canceled' };
    if (order.lines.length && order.lines.every(line => line.remaining === 0)) return { ...order, status: 'complete' };
    return { ...order, status: order.lines.some(line => line.received > 0) ? 'partial' : 'scheduled' };
  });
}

export async function purchaseOrder(db: PoolClient, store: string, id: string) {
  const [row] = await orderRows(db, store, id, null, 1);
  if (!row) throw new PurchaseError(404, 'ORDER_NOT_FOUND', 'poId');
  return row;
}

export async function listOrders(db: PoolClient, store: string, at: Date, query: unknown) {
  const { cursor, limit, filters } = pageInput(query, ['from', 'to']);
  const from = filters.from === undefined ? null : date(filters.from, 'from');
  const to = filters.to === undefined ? null : date(filters.to, 'to');
  if (from && to && (from > to || (+new Date(to) - +new Date(from)) / 86_400_000 > 365)) {
    throw new PurchaseError(400, 'INVALID_REQUEST', 'to');
  }
  const rows = await orderRows(db, store, null, cursor, limit + 1, from, to);
  return page(db, store, at, rows, limit, row => row.poId);
}

export async function listReceipts(db: PoolClient, store: string, at: Date, query: unknown, orderId?: string) {
  const { cursor, limit } = pageInput(query, []);
  if (orderId) await purchaseOrder(db, store, orderId);
  const { rows } = await db.query<ReceiptRow>(`
    SELECT r.receipt_id AS "receiptId", l.po_id AS "poId", l.pol_id AS "polId", r.qty::double precision,
      r.qty_remaining::double precision AS "qtyRemaining", r.received_at AS "receivedAt", r.voided_at AS "voidedAt",
      m.business_date::text AS "businessDate", round(r.qty * l.unit_price)::double precision AS amount
    FROM inventory.goods_receipt r JOIN inventory.purchase_order_line l USING (store_id, pol_id)
    LEFT JOIN inventory.stock_movement m ON m.store_id = r.store_id AND m.receipt_id = r.receipt_id
    WHERE r.store_id = $1 AND ($2::uuid IS NULL OR r.receipt_id > $2) AND ($3::uuid IS NULL OR l.po_id = $3)
    ORDER BY r.receipt_id LIMIT $4
  `, [store, cursor, orderId ?? null, limit + 1]);
  return page(db, store, at, rows, limit, row => row.receiptId);
}
