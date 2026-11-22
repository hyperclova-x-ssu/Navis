import type { PurchaseItem } from '../../db/management-types';
import type { DataTables, PurchaseOrder, PurchaseOrderLine, Receipt, Supplier } from '../../db/types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter } from '../00';

const suppliers = '/inventory/suppliers';
const terms = '/inventory/purchase-items';
const orders = '/inventory/purchase-orders';
const receiptBase = '/inventory/purchasing';
const pathFor = (base: string, id: string) => `${base}/${encodeURIComponent(id)}`;
const supplierKey = (id: string) => `supplier:${id}`;
const termsKey = (id: string) => `purchase-item:${id}`;
const orderKey = (id: string) => `purchase-order:${id}`;

type Versioned = { readonly revision: number };
type SupplierDto = Versioned & Pick<Supplier, 'supplierId' | 'phoneMask'> & {
  readonly name: string;
  readonly contact: string | null;
  readonly phone?: string | null;
  readonly memo: string | null;
  readonly deletedAt?: string | null;
};
type PurchaseItemDto = Versioned & Omit<PurchaseItem, 'purchaseUnit' | 'basePerUnit'> & {
  readonly purchaseUnit: PurchaseItem['purchaseUnit'] | null;
  readonly basePerUnit: number | null;
  readonly archivedAt?: string | null;
};
type OrderDto = Versioned & Omit<PurchaseOrder, 'variant'> & {
  readonly lines: readonly (Omit<PurchaseOrderLine, 'poId' | 'itemNameSnapshot' | 'basePerUnit'> & {
    readonly itemNameSnapshot: string | null;
    readonly basePerUnit: number | null;
  })[];
};
export type PurchasingReceipt = Receipt & { readonly businessDate?: string };
type ReceiptDto = Pick<Receipt, 'receiptId' | 'polId' | 'qty' | 'receivedAt'> & {
  readonly businessDate: string | null;
  readonly voidedAt: string | null;
};

const emptyTables = () => ({ supplier: [], purchaseItem: [], purchaseOrder: [], purchaseOrderLine: [], receipt: [] } satisfies Partial<DataTables>);
const raw = (value: string) => ({ raw: value });

function requiredRevision(ctx: CommandContext, key: string): number {
  const revision = ctx.revision(key);
  if (revision === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return revision;
}

function toSupplier(row: SupplierDto): Supplier {
  return {
    supplierId: row.supplierId, name: raw(row.name), nameKey: '', contactKey: '',
    contact: raw(row.contact ?? ''), phone: row.phone ?? undefined, phoneMask: row.phoneMask,
    memo: row.memo === null ? null : raw(row.memo), deletedAt: row.deletedAt ?? undefined,
  };
}

function toPurchaseItem(row: PurchaseItemDto): PurchaseItem {
  const { purchaseItemId, itemId, supplierId, minimumQty, unitPrice, orderStep, leadDays, purchaseUnit, basePerUnit } = row;
  return { purchaseItemId, itemId, supplierId, minimumQty, unitPrice, orderStep, leadDays,
    purchaseUnit: purchaseUnit ?? undefined, basePerUnit: basePerUnit ?? undefined };
}

function toOrder({ poId, supplierId, orderedOn, dueDate, expectedTime, status }: OrderDto): PurchaseOrder {
  return { poId, supplierId, orderedOn, dueDate, expectedTime, status, variant: null };
}

function toLines(order: OrderDto): PurchaseOrderLine[] {
  return order.lines.map(({ polId, itemId, qtyOrdered, unitPrice, itemNameSnapshot, unitSnapshot, basePerUnit }) => ({
    polId, poId: order.poId, itemId, qtyOrdered, unitPrice, itemNameSnapshot: itemNameSnapshot === null ? undefined : raw(itemNameSnapshot),
    unitSnapshot, basePerUnit: basePerUnit ?? undefined,
  }));
}

function toReceipt({ receiptId, polId, qty, receivedAt, businessDate }: ReceiptDto): PurchasingReceipt {
  return { receiptId, polId, qty, receivedAt, businessDate: businessDate ?? undefined, idempotencyKey: null };
}

export const purchaseAdapter: DomainAdapter = {
  domain: 'purchase',
  sources: ['purchase', 'suppliers', 'purchasing'],
  tables: ['supplier', 'purchaseItem', 'purchaseOrder', 'purchaseOrderLine', 'receipt'],
  clear: emptyTables,
  errorKeys: {
    ...Object.fromEntries(['REFERENCED_SUPPLIER', 'REFERENCED_ITEM', 'PURCHASE_INVALID', 'PURCHASE_ITEM_EXISTS',
      'SUPPLIER_INVALID', 'STALE_SUGGESTION', 'ORDER_QTY_INVALID', 'ORDER_CLOSED', 'DUE_DATE_PAST',
      'LIKELY_DUPLICATE_ORDER', 'ORDER_QTY_MIN', 'ORDER_QTY_STEP', 'UNIT_PRECISION'].map(code => [code, `data.management.error.${code}`])),
    RECEIPT_QUANTITY_UNAVAILABLE: 'data.error.qtyOverRemaining',
  },
  async load({ reads, signal }) {
    const query = { limit: 200 };
    const [supplierRows, itemRows, orderRows, receiptRows] = await Promise.all([
      reads.all<SupplierDto>({ resource: 'suppliers', path: suppliers, query }, { signal }),
      reads.all<PurchaseItemDto>({ resource: 'purchase-items', path: terms, query }, { signal }),
      reads.all<OrderDto>({ resource: 'purchase-orders', path: orders, query }, { signal }),
      reads.all<ReceiptDto>({ resource: 'purchase-receipts', path: `${receiptBase}/receipts`, query }, { signal }),
    ]);
    return {
      tables: {
        supplier: supplierRows.items.map(toSupplier),
        purchaseItem: itemRows.items.filter(row => !row.archivedAt).map(toPurchaseItem),
        purchaseOrder: orderRows.items.map(toOrder),
        purchaseOrderLine: orderRows.items.flatMap(toLines),
        receipt: receiptRows.items.filter(row => row.voidedAt === null).map(toReceipt),
      },
      revisions: Object.fromEntries([
        ...supplierRows.items.map(row => [supplierKey(row.supplierId), row.revision]),
        ...itemRows.items.map(row => [termsKey(row.purchaseItemId), row.revision]),
        ...orderRows.items.map(row => [orderKey(row.poId), row.revision]),
      ]),
      asOf: orderRows.asOf,
      sourceRevision: Math.max(supplierRows.sourceRevision, itemRows.sourceRevision, orderRows.sourceRevision, receiptRows.sourceRevision),
      complete: [supplierRows, itemRows, orderRows, receiptRows].every(page => page.complete),
    };
  },
  commands: [
    defineBinding({ type: 'suppliers.createSupplier', receiptBase, request: ({ name, contact, phone, memo }) => ({
      method: 'POST', path: suppliers, body: { name, contact, phone, memo },
    }) }),
    defineBinding({ type: 'suppliers.updateSupplier', receiptBase, request: ({ supplierId, patch }, ctx) => ({
      method: 'PATCH', path: pathFor(suppliers, supplierId), body: { ...patch }, expectedRevision: requiredRevision(ctx, supplierKey(supplierId)),
    }) }),
    defineBinding({ type: 'suppliers.deleteSupplier', receiptBase, request: ({ supplierId }, ctx) => ({
      method: 'DELETE', path: pathFor(suppliers, supplierId), body: { confirmed: true }, expectedRevision: requiredRevision(ctx, supplierKey(supplierId)),
    }) }),
    defineBinding({ type: 'suppliers.createPurchaseItem', receiptBase, request: ({ itemId, supplierId, minimumQty, unitPrice, orderStep, leadDays }) => ({
      method: 'POST', path: terms, body: { itemId, supplierId, minimumQty, unitPrice, orderStep, leadDays },
    }) }),
    defineBinding({ type: 'suppliers.updatePurchaseItem', receiptBase, request: ({ purchaseItemId, patch }, ctx) => ({
      method: 'PATCH', path: pathFor(terms, purchaseItemId), body: { ...patch }, expectedRevision: requiredRevision(ctx, termsKey(purchaseItemId)),
    }) }),
    defineBinding({ type: 'suppliers.deletePurchaseItem', receiptBase, request: ({ purchaseItemId }, ctx) => ({
      method: 'DELETE', path: pathFor(terms, purchaseItemId), body: { confirmed: true }, expectedRevision: requiredRevision(ctx, termsKey(purchaseItemId)),
    }) }),
    defineBinding({ type: 'suppliers.createOrder', receiptBase, noticeKey: 'data.management.notice.saved', request: ({ purchaseItemId, qty, dueDate, suggestionItemId, confirmDuplicate }, ctx) => ({
      method: 'POST', path: orders, body: { purchaseItemId, qty, dueDate, suggestionItemId, confirmDuplicate },
      expectedRevision: requiredRevision(ctx, termsKey(purchaseItemId)),
    }) }),
    defineBinding({ type: 'suppliers.changeDueDate', receiptBase, noticeKey: 'data.notice.dueDateChanged', request: ({ poId, date }, ctx) => ({
      method: 'PATCH', path: pathFor(orders, poId), body: { dueDate: date }, expectedRevision: requiredRevision(ctx, orderKey(poId)),
    }) }),
    defineBinding({ type: 'suppliers.cancelOrder', receiptBase, request: ({ poId }, ctx) => ({
      method: 'POST', path: `${pathFor(orders, poId)}/cancel`, body: { confirmed: true }, expectedRevision: requiredRevision(ctx, orderKey(poId)),
    }) }),
    defineBinding({ type: 'suppliers.recordReceipt', receiptBase, request: ({ polId, qty }, ctx) => {
      const line = ctx.snapshot.tables.purchaseOrderLine.find(row => row.polId === polId);
      if (!line) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND', 'polId');
      return { method: 'POST', path: `${pathFor(orders, line.poId)}/receipts`, body: { polId, qty },
        expectedRevision: requiredRevision(ctx, orderKey(line.poId)) };
    } }),
  ],
};
