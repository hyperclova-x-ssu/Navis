import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { readForecast } from '../../forecast/forecast.ts';
import { appendPurchaseEvent, lockPurchasing, recordReceipt } from '../../receipts.ts';
import { stockForItem } from '../../stock.ts';
import { itemForWrite, operatingDay } from '../03/read.ts';
import { units } from '../03/wire.ts';
import { orderOpen, purchaseOrder, supplier, terms, type OrderRow, type TermsRow } from './read.ts';
import { maxSafe, milliquantity, PurchaseError, type Command, type SupplierFields, type TermsFields } from './wire.ts';

type Clock = Parameters<typeof operatingDay>[3];
type Context = { store: string; actor: string; key: string; now: () => Date; clock: Clock };
type ChangeContext = Context & { at: Date; commandId: string };
type Inverse =
  | { kind: 'supplier_fields'; value: SupplierFields }
  | { kind: 'supplier_archive'; archived: boolean }
  | { kind: 'terms_fields'; value: TermsFields }
  | { kind: 'terms_archive'; archived: boolean }
  | { kind: 'order_due'; dueDate: string | null }
  | { kind: 'order_cancel'; canceled: boolean }
  | { kind: 'receipt_void'; goodsReceiptId: string; itemRevision: number };

type Resource = {
  resourceId: string; revision: number; supplierId?: string; purchaseItemId?: string; poId?: string;
  polId?: string; total?: number; dueDate?: string | null; qtyRemaining?: number; expenseCandidateReceiptId?: string;
};
type Change = Resource & { channel: 'supplier' | 'terms' | 'order' | 'receipt'; inverse?: Inverse;
  changed?: boolean; goodsReceiptId?: string; undoUntil?: string; businessDate?: string };
type Receipt = Resource & { receiptId: string; changed: boolean; affectedSources: string[]; undoUntil?: string };

const sources = {
  supplier: ['suppliers'],
  terms: ['suppliers', 'purchase', 'menu', 'margin', 'pos'],
  order: ['suppliers', 'purchase', 'calendar', 'briefing'],
  receipt: ['suppliers', 'purchase', 'calendar', 'briefing', 'inventory', 'stock', 'ledger', 'money', 'pos'],
};

function requireRevision(expected: number, actual: number) {
  if (expected !== actual) throw new PurchaseError(409, 'STALE_REVISION', 'expectedRevision', { revision: actual });
}

function requireOpen(row: OrderRow) {
  if (!orderOpen(row) || !row.lines.some(line => line.remaining > 0)) throw new PurchaseError(409, 'ORDER_CLOSED', 'poId');
}

function nameKey(name: string) {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function requireUniqueName(db: PoolClient, store: string, id: string, name: string) {
  const { rows: [prior] } = await db.query<{ supplier_id: string }>(`
    SELECT supplier_id FROM inventory.supplier WHERE store_id = $1 AND supplier_id <> $2 AND archived_at IS NULL
      AND coalesce(name_key, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))) = $3 LIMIT 1
  `, [store, id, nameKey(name)]);
  if (prior) throw new PurchaseError(409, 'NAME_EXISTS', 'name', { supplierId: prior.supplier_id });
}

async function requireUnreferencedSupplier(db: PoolClient, store: string, id: string) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM inventory.purchase_item WHERE store_id = $1 AND supplier_id = $2 AND archived_at IS NULL
    UNION ALL
    SELECT 1 FROM inventory.purchase_order o JOIN inventory.purchase_order_line l USING (store_id, po_id)
    WHERE o.store_id = $1 AND o.supplier_id = $2 AND o.canceled_at IS NULL
      AND l.qty_ordered > coalesce((SELECT sum(qty) FROM inventory.goods_receipt r
        WHERE r.store_id = l.store_id AND r.pol_id = l.pol_id AND r.voided_at IS NULL), 0)
    LIMIT 1
  `, [store, id]);
  if (rowCount) throw new PurchaseError(409, 'REFERENCED_SUPPLIER', 'supplierId');
}

async function requireUnreferencedTerms(db: PoolClient, store: string, itemId: string) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM inventory.recipe_current c JOIN inventory.recipe_version v USING (store_id, menu_id, component_id, version)
    WHERE c.store_id = $1 AND v.ingredients @> jsonb_build_array(jsonb_build_object('item_id', $2::uuid)) LIMIT 1
  `, [store, itemId]);
  if (rowCount) throw new PurchaseError(409, 'REFERENCED_ITEM', 'purchaseItemId');
}

async function requireAvailableTermsSlot(db: PoolClient, store: string, id: string, itemId: string) {
  const { rowCount } = await db.query(`SELECT 1 FROM inventory.purchase_item
    WHERE store_id = $1 AND item_id = $2 AND purchase_item_id <> $3 AND archived_at IS NULL`, [store, itemId, id]);
  if (rowCount) throw new PurchaseError(409, 'PURCHASE_ITEM_EXISTS', 'itemId');
}

function baseQuantity(qty: number, factor: number, field: string) {
  const scaled = milliquantity(qty) * BigInt(factor);
  if (scaled % 1000n !== 0n || scaled / 1000n > maxSafe) throw new PurchaseError(400, 'UNIT_PRECISION', field);
  return scaled / 1000n;
}

function requireExactTerms(fields: TermsFields, factor: number) {
  baseQuantity(fields.minimumQty, factor, 'minimumQty');
  baseQuantity(fields.orderStep, factor, 'orderStep');
}

async function updateSupplier(db: PoolClient, store: string, id: string, value: SupplierFields) {
  await requireUniqueName(db, store, id, value.name);
  await db.query(`UPDATE inventory.supplier
    SET name = $3, name_key = $4, contact = $5, phone = $6, memo = $7, revision = revision + 1
    WHERE store_id = $1 AND supplier_id = $2`, [store, id, value.name, nameKey(value.name), value.contact, value.phone, value.memo]);
}

async function updateTerms(db: PoolClient, store: string, row: TermsRow, value: TermsFields) {
  await supplier(db, store, value.supplierId);
  requireExactTerms(value, row.basePerUnit);
  await db.query(`UPDATE inventory.purchase_item SET supplier_id = $3,
    minimum_qty = $4, order_step = $5, unit_price = $6, lead_days = $7, revision = revision + 1
    WHERE store_id = $1 AND purchase_item_id = $2`,
  [store, row.purchaseItemId, value.supplierId, value.minimumQty, value.orderStep, value.unitPrice, value.leadDays]);
}

async function setSupplierArchive(db: PoolClient, store: string, row: Awaited<ReturnType<typeof supplier>>, at: Date | null) {
  if (at) await requireUnreferencedSupplier(db, store, row.supplierId);
  else await requireUniqueName(db, store, row.supplierId, row.name);
  await db.query(`UPDATE inventory.supplier SET archived_at = $3, revision = revision + 1
    WHERE store_id = $1 AND supplier_id = $2`, [store, row.supplierId, at]);
}

async function setTermsArchive(db: PoolClient, store: string, row: TermsRow, at: Date | null) {
  if (at) await requireUnreferencedTerms(db, store, row.itemId);
  else {
    await requireAvailableTermsSlot(db, store, row.purchaseItemId, row.itemId);
    await supplier(db, store, row.supplierId);
    await itemForWrite(db, store, row.itemId);
  }
  await db.query(`UPDATE inventory.purchase_item SET archived_at = $3, revision = revision + 1
    WHERE store_id = $1 AND purchase_item_id = $2`, [store, row.purchaseItemId, at]);
}

async function setOrderDate(db: PoolClient, store: string, id: string, dueDate: string | null) {
  await db.query(`UPDATE inventory.purchase_order SET due_date = $3, revision = revision + 1
    WHERE store_id = $1 AND po_id = $2`, [store, id, dueDate]);
}

async function setOrderCancel(db: PoolClient, store: string, id: string, canceledAt: Date | null) {
  await db.query(`UPDATE inventory.purchase_order SET canceled_at = $3, revision = revision + 1
    WHERE store_id = $1 AND po_id = $2`, [store, id, canceledAt]);
}

function addDays(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function ensureUpcoming(due: string, day: string) {
  if (due < day) throw new PurchaseError(400, 'DUE_DATE_PAST', 'dueDate', { businessDate: day });
}

async function requireCurrentSuggestion(
  db: PoolClient, store: string, day: string, item: Awaited<ReturnType<typeof itemForWrite>>, suggested: string,
) {
  const stale = () => new PurchaseError(409, 'STALE_SUGGESTION', 'suggestionItemId');
  if (item.itemId !== suggested || !item.trackRestock) throw stale();
  const { rows: [guard] } = await db.query<{ existing: boolean; expired: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM inventory.purchase_order_line l JOIN inventory.purchase_order o USING (store_id, po_id)
      WHERE l.store_id = $1 AND l.item_id = $2 AND o.canceled_at IS NULL AND l.qty_ordered > coalesce((
        SELECT sum(r.qty) FROM inventory.goods_receipt r WHERE r.store_id = l.store_id AND r.pol_id = l.pol_id AND r.voided_at IS NULL
      ), 0)
    ) AS existing, coalesce((SELECT min(expires_on) <= $3 FROM inventory.stock_batch
      WHERE store_id = $1 AND item_id = $2 AND discarded_at IS NULL AND remaining_base > 0), false) AS expired
  `, [store, item.itemId, day]);
  if (guard.existing || (item.trackExpiry && guard.expired)) throw stale();
  const stock = await stockForItem(db, store, day, item.itemId);
  if (!stock) throw stale();
  if (item.thresholdBase !== null && Number(stock.availableQuantityBase) <= Number(item.thresholdBase)) return;
  const forecast = await readForecast(db, { storeId: store, targetDate: day, modelVersion: 'weekday-4w-v1' });
  const expected = Number(forecast.results.find(row => row.scope === 'ingredient' && row.targetId === item.itemId)?.expected ?? 0);
  const remaining = expected - Number(stock.usedQuantityBase);
  if (forecast.stale || remaining <= 0 || Number(stock.rawQuantityBase) >= remaining) throw stale();
}

async function createOrder(db: PoolClient, ctx: ChangeContext, cmd: Extract<Command, { operation: 'create_order' }>): Promise<Change> {
  const { store, at } = ctx;
  const row = await terms(db, store, cmd.id);
  requireRevision(cmd.expected, row.revision);
  await supplier(db, store, row.supplierId);
  const item = await itemForWrite(db, store, row.itemId);
  const quantity = baseQuantity(cmd.qty, row.basePerUnit, 'qty');
  if (quantity < baseQuantity(row.minimumQty, row.basePerUnit, 'minimumQty')) {
    throw new PurchaseError(400, 'ORDER_QTY_MIN', 'qty', { minimum: row.minimumQty, unit: row.purchaseUnit });
  }
  if (quantity % baseQuantity(row.orderStep, row.basePerUnit, 'orderStep') !== 0n) {
    throw new PurchaseError(400, 'ORDER_QTY_STEP', 'qty', { step: row.orderStep, unit: row.purchaseUnit });
  }
  const total = (milliquantity(cmd.qty) * BigInt(row.unitPrice) + 500n) / 1000n;
  if (total > maxSafe) throw new PurchaseError(400, 'ORDER_VALUE_UNSUPPORTED', 'qty');
  const day = await operatingDay(db, store, at, ctx.clock, true);
  if (cmd.suggestionItemId) await requireCurrentSuggestion(db, store, day, item, cmd.suggestionItemId);
  const dueDate = cmd.dueDate ?? addDays(day, row.leadDays);
  ensureUpcoming(dueDate, day);
  if (!cmd.confirmDuplicate) {
    const { rows: [duplicate] } = await db.query<{ po_id: string }>(`
      SELECT o.po_id FROM inventory.purchase_order o JOIN inventory.purchase_order_line l USING (store_id, po_id)
      WHERE o.store_id = $1 AND o.supplier_id = $2 AND o.due_date = $3 AND l.item_id = $4 AND l.qty_ordered = $5
        AND o.canceled_at IS NULL AND l.qty_ordered > coalesce((SELECT sum(qty) FROM inventory.goods_receipt r
          WHERE r.store_id = l.store_id AND r.pol_id = l.pol_id AND r.voided_at IS NULL), 0)
      ORDER BY o.po_id LIMIT 1
    `, [store, row.supplierId, dueDate, item.itemId, cmd.qty]);
    if (duplicate) throw new PurchaseError(409, 'LIKELY_DUPLICATE_ORDER', 'qty', { poId: duplicate.po_id, dueDate });
  }
  const poId = randomUUID();
  const polId = randomUUID();
  await db.query(`INSERT INTO inventory.purchase_order (store_id, po_id, supplier_id, ordered_on, due_date)
    VALUES ($1, $2, $3, $4, $5)`, [store, poId, row.supplierId, day, dueDate]);
  await db.query(`INSERT INTO inventory.purchase_order_line
    (store_id, pol_id, po_id, item_id, qty_ordered, unit_snapshot, base_per_unit, unit_price, item_name_snapshot)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [store, polId, poId, item.itemId, cmd.qty, row.purchaseUnit, row.basePerUnit, row.unitPrice, item.name]);
  return { channel: 'order', resourceId: poId, poId, polId, total: Number(total), dueDate, revision: 1,
    inverse: { kind: 'order_cancel', canceled: true } };
}

async function receive(db: PoolClient, ctx: ChangeContext, cmd: Extract<Command, { operation: 'receive' }>): Promise<Change> {
  const { store, at } = ctx;
  const row = await purchaseOrder(db, store, cmd.id);
  requireRevision(cmd.expected, row.revision);
  requireOpen(row);
  const line = row.lines.find(candidate => candidate.polId === cmd.polId);
  if (!line) throw new PurchaseError(404, 'ORDER_LINE_NOT_FOUND', 'polId');
  if (cmd.qty > line.remaining) throw new PurchaseError(409, 'QTY_OVER_REMAINING', 'qty', { remaining: line.remaining });
  const item = await itemForWrite(db, store, line.itemId);
  const businessDate = await operatingDay(db, store, at, ctx.clock, true);
  const undoUntil = new Date(ctx.now().getTime() + 6000).toISOString();
  const goods = await recordReceipt(db, store, at, `purchasing~${ctx.commandId}`, { ...cmd, poId: row.poId, undoUntil });
  return { channel: 'receipt', resourceId: row.poId, poId: row.poId, polId: line.polId, revision: row.revision + 1,
    qtyRemaining: goods.qtyRemaining, goodsReceiptId: goods.receiptId, expenseCandidateReceiptId: goods.receiptId,
    undoUntil, businessDate, inverse: { kind: 'receipt_void', goodsReceiptId: goods.receiptId, itemRevision: item.revision + 1 } };
}

async function change(db: PoolClient, ctx: ChangeContext, cmd: Exclude<Command, { operation: 'undo' }>): Promise<Change> {
  const { store, at } = ctx;
  switch (cmd.operation) {
    case 'create_supplier': {
      const id = randomUUID();
      const { name, contact, phone, memo } = cmd.fields;
      await db.query('INSERT INTO inventory.store (store_id) VALUES ($1) ON CONFLICT DO NOTHING', [store]);
      await requireUniqueName(db, store, id, name);
      await db.query(`INSERT INTO inventory.supplier (store_id, supplier_id, name, name_key, contact, phone, memo)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [store, id, name, nameKey(name), contact, phone, memo]);
      return { channel: 'supplier', resourceId: id, supplierId: id, revision: 1, inverse: { kind: 'supplier_archive', archived: true } };
    }
    case 'update_supplier': {
      const row = await supplier(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      const { name, contact, phone, memo } = row;
      const value = { name, contact, phone, memo };
      await updateSupplier(db, store, cmd.id, { ...value, ...cmd.fields });
      return { channel: 'supplier', resourceId: cmd.id, supplierId: cmd.id, revision: row.revision + 1,
        inverse: { kind: 'supplier_fields', value } };
    }
    case 'archive_supplier': {
      const row = await supplier(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      await setSupplierArchive(db, store, row, at);
      return { channel: 'supplier', resourceId: cmd.id, supplierId: cmd.id, revision: row.revision + 1,
        inverse: { kind: 'supplier_archive', archived: false } };
    }
    case 'create_terms': {
      const id = randomUUID();
      const item = await itemForWrite(db, store, cmd.itemId);
      if (item.kind !== 'ingredient' || !item.unit) throw new PurchaseError(409, 'PURCHASE_INVALID', 'itemId');
      await requireAvailableTermsSlot(db, store, id, item.itemId);
      const { supplierId, minimumQty, orderStep, unitPrice, leadDays } = cmd.fields;
      await supplier(db, store, supplierId);
      const factor = units[item.unit][1];
      requireExactTerms(cmd.fields, factor);
      await db.query(`INSERT INTO inventory.purchase_item (store_id, purchase_item_id, item_id, supplier_id,
        purchase_unit, base_per_unit, minimum_qty, order_step, unit_price, lead_days)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [store, id, item.itemId, supplierId, item.unit, factor, minimumQty, orderStep, unitPrice, leadDays]);
      return { channel: 'terms', resourceId: id, purchaseItemId: id, supplierId, revision: 1,
        inverse: { kind: 'terms_archive', archived: true } };
    }
    case 'update_terms': {
      const row = await terms(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      const { supplierId, minimumQty, orderStep, unitPrice, leadDays } = row;
      const value = { supplierId, minimumQty, orderStep, unitPrice, leadDays };
      const updated = { ...value, ...cmd.fields };
      await updateTerms(db, store, row, updated);
      return { channel: 'terms', resourceId: cmd.id, purchaseItemId: cmd.id, supplierId: updated.supplierId, revision: row.revision + 1,
        inverse: { kind: 'terms_fields', value } };
    }
    case 'archive_terms': {
      const row = await terms(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      await setTermsArchive(db, store, row, at);
      return { channel: 'terms', resourceId: cmd.id, purchaseItemId: cmd.id, supplierId: row.supplierId,
        revision: row.revision + 1, inverse: { kind: 'terms_archive', archived: false } };
    }
    case 'create_order': return createOrder(db, ctx, cmd);
    case 'change_due_date': {
      const row = await purchaseOrder(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      requireOpen(row);
      const day = await operatingDay(db, store, at, ctx.clock);
      ensureUpcoming(cmd.dueDate, day);
      const result = { channel: 'order' as const, resourceId: cmd.id, poId: cmd.id, dueDate: cmd.dueDate };
      if (row.dueDate === cmd.dueDate) return { ...result, revision: row.revision, changed: false };
      await setOrderDate(db, store, cmd.id, cmd.dueDate);
      return { ...result, revision: row.revision + 1, inverse: { kind: 'order_due', dueDate: row.dueDate } };
    }
    case 'cancel_order': {
      const row = await purchaseOrder(db, store, cmd.id);
      requireRevision(cmd.expected, row.revision);
      requireOpen(row);
      await setOrderCancel(db, store, cmd.id, at);
      return { channel: 'order', resourceId: cmd.id, poId: cmd.id, revision: row.revision + 1,
        inverse: { kind: 'order_cancel', canceled: false } };
    }
    case 'receive': return receive(db, ctx, cmd);
  }
}

async function voidReceipt(
  db: PoolClient, ctx: ChangeContext, row: OrderRow, inverse: Extract<Inverse, { kind: 'receipt_void' }>,
): Promise<Change> {
  const { store, at } = ctx;
  const { rows: [goods] } = await db.query<{ item_id: string; pol_id: string; business_date: string; delta_base: string }>(`
    SELECT m.item_id, g.pol_id, m.business_date::text, m.delta_base FROM inventory.goods_receipt g
    JOIN inventory.stock_movement m USING (store_id, receipt_id)
    JOIN inventory.purchase_order_line l USING (store_id, pol_id)
    WHERE g.store_id = $1 AND g.receipt_id = $2 AND l.po_id = $3 AND g.voided_at IS NULL
  `, [store, inverse.goodsReceiptId, row.poId]);
  if (!goods) throw new PurchaseError(409, 'UNDO_UNAVAILABLE');
  const item = await itemForWrite(db, store, goods.item_id);
  requireRevision(inverse.itemRevision, item.revision);
  const day = await operatingDay(db, store, at, ctx.clock, true);
  if (day !== goods.business_date) throw new PurchaseError(409, 'DAY_CLOSED');
  await db.query(`UPDATE inventory.goods_receipt SET voided_at = $3 WHERE store_id = $1 AND receipt_id = $2`,
    [store, inverse.goodsReceiptId, at]);
  await db.query(`INSERT INTO inventory.stock_movement
    (store_id, movement_id, item_id, business_date, kind, delta_base, channel, at, source_id, reason)
    VALUES ($1, $2, $3, $4, 'adjust', -$5::bigint, 'store', $6, $7, 'receipt_undo')`,
  [store, randomUUID(), goods.item_id, day, goods.delta_base, at, inverse.goodsReceiptId]);
  await db.query(`UPDATE inventory.inventory_item SET revision = revision + 1, updated_at = greatest(updated_at, $3)
    WHERE store_id = $1 AND item_id = $2`, [store, goods.item_id, at]);
  await db.query(`UPDATE inventory.purchase_order SET revision = revision + 1 WHERE store_id = $1 AND po_id = $2`,
    [store, row.poId]);
  await appendPurchaseEvent(db, store, at, 'inventory.receipt_voided.v1', inverse.goodsReceiptId, { receiptId: inverse.goodsReceiptId });
  await appendPurchaseEvent(db, store, at, 'inventory.stock_changed.v1', ctx.commandId,
    { storeId: store, businessDate: day, sourceId: inverse.goodsReceiptId, operation: 'receipt_undo', itemIds: [goods.item_id] });
  return { channel: 'receipt', poId: row.poId, resourceId: row.poId, polId: goods.pol_id,
    revision: row.revision + 1, expenseCandidateReceiptId: inverse.goodsReceiptId, businessDate: day };
}

async function undo(db: PoolClient, ctx: ChangeContext, originalId: string): Promise<Change> {
  const { store, actor, at } = ctx;
  const { rows: [saved] } = await db.query<{ result: Receipt; undo_until: Date | null; inverse: Inverse | null; undone_at: Date | null }>(`
    SELECT result, undo_until, inverse, undone_at FROM inventory.purchase_command
    WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3
  `, [store, actor, originalId]);
  if (!saved) throw new PurchaseError(404, 'RECEIPT_NOT_FOUND');
  if (saved.undone_at) throw new PurchaseError(409, 'UNDO_ALREADY_APPLIED');
  if (saved.undo_until && ctx.now() >= saved.undo_until) throw new PurchaseError(409, 'UNDO_EXPIRED');
  if (!saved.inverse || !saved.undo_until) throw new PurchaseError(409, 'UNDO_UNAVAILABLE');
  const { inverse, result: { resourceId: id, revision } } = saved;
  let restored: Change;
  switch (inverse.kind) {
    case 'supplier_fields':
    case 'supplier_archive': {
      const row = await supplier(db, store, id, true);
      requireRevision(revision, row.revision);
      if (inverse.kind === 'supplier_fields') await updateSupplier(db, store, id, inverse.value);
      else await setSupplierArchive(db, store, row, inverse.archived ? at : null);
      restored = { channel: 'supplier', resourceId: id, supplierId: id, revision: revision + 1 };
      break;
    }
    case 'terms_fields':
    case 'terms_archive': {
      const row = await terms(db, store, id, true);
      requireRevision(revision, row.revision);
      if (inverse.kind === 'terms_fields') await updateTerms(db, store, row, inverse.value);
      else await setTermsArchive(db, store, row, inverse.archived ? at : null);
      restored = { channel: 'terms', resourceId: id, purchaseItemId: id,
        supplierId: inverse.kind === 'terms_fields' ? inverse.value.supplierId : row.supplierId, revision: revision + 1 };
      break;
    }
    case 'order_cancel':
    case 'order_due':
    case 'receipt_void': {
      const row = await purchaseOrder(db, store, id);
      requireRevision(revision, row.revision);
      if (inverse.kind === 'receipt_void') {
        restored = await voidReceipt(db, ctx, row, inverse);
        break;
      }
      if (inverse.kind === 'order_due') await setOrderDate(db, store, id, inverse.dueDate);
      else {
        if (!inverse.canceled) {
          await supplier(db, store, row.supplierId);
          for (const itemId of new Set(row.lines.map(line => line.itemId))) await itemForWrite(db, store, itemId);
        }
        await setOrderCancel(db, store, id, inverse.canceled ? at : null);
      }
      restored = { channel: 'order', resourceId: id, poId: id, revision: revision + 1 };
      break;
    }
  }
  if (ctx.now() >= saved.undo_until) throw new PurchaseError(409, 'UNDO_EXPIRED');
  await db.query(`UPDATE inventory.purchase_command SET undone_at = $3, inverse = NULL
    WHERE store_id = $1 AND receipt_id = $2`, [store, originalId, at]);
  return restored;
}

async function publish(db: PoolClient, ctx: ChangeContext, operation: Command['operation'], result: Change) {
  const { store, at } = ctx;
  if (result.channel === 'supplier' || result.channel === 'terms') {
    await appendPurchaseEvent(db, store, at, 'inventory.supplier_changed.v1', ctx.commandId, {
      supplierId: result.supplierId, resourceId: result.resourceId, operation, revision: result.revision,
      ...(result.purchaseItemId ? { purchaseItemId: result.purchaseItemId } : {}),
    });
    return;
  }
  const row = await purchaseOrder(db, store, result.resourceId);
  await appendPurchaseEvent(db, store, at, 'inventory.purchase_order_changed.v1', row.poId, {
    poId: row.poId, revision: row.revision, status: row.status, dueDate: row.dueDate, operation,
    calendarProjection: { source: 'purchase-order', sourceId: row.poId, revision: row.revision,
      entry: orderOpen(row) && row.dueDate ? { date: row.dueDate, time: row.expectedTime } : null },
  });
}

export async function runPurchaseCommand(db: PoolClient, input: Context, cmd: Command): Promise<Receipt> {
  const { store, key, actor } = input;
  await lockPurchasing(db, store);
  const fingerprint = createHash('sha256').update(JSON.stringify(cmd)).digest('hex');
  const { rows: [prior] } = await db.query<{ actor_id: string; fingerprint: string; result: Receipt }>(`
    SELECT actor_id, fingerprint, result FROM inventory.purchase_command WHERE store_id = $1 AND idempotency_key = $2
  `, [store, key]);
  if (prior) {
    if (prior.actor_id !== actor || prior.fingerprint !== fingerprint) throw new PurchaseError(409, 'IDEMPOTENCY_MISMATCH');
    return prior.result;
  }

  const ctx = { ...input, at: input.now(), commandId: randomUUID() };
  const mutation = cmd.operation === 'undo' ? await undo(db, ctx, cmd.id) : await change(db, ctx, cmd);
  const { channel, inverse, changed = true, goodsReceiptId, undoUntil: committedDeadline, ...fields } = mutation;
  const undoUntil = inverse ? committedDeadline ?? new Date(input.now().getTime() + 6000).toISOString() : undefined;
  const result = { ...fields, changed, affectedSources: changed ? sources[channel] : [],
    receiptId: goodsReceiptId ?? ctx.commandId, ...(undoUntil ? { undoUntil } : {}) };
  if (changed) await publish(db, ctx, cmd.operation, mutation);

  // Expired inverse data is no longer needed, while the original response remains durable for retries.
  await db.query(`UPDATE inventory.purchase_command SET inverse = NULL
    WHERE store_id = $1 AND undo_until <= $2 AND inverse IS NOT NULL`, [store, ctx.at]);
  await db.query(`INSERT INTO inventory.purchase_command
    (store_id, actor_id, idempotency_key, fingerprint, receipt_id, result, undo_until, inverse)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [store, actor, key, fingerprint, result.receiptId, result, undoUntil ?? null, inverse ?? null]);
  return result;
}

export async function receiptStatus(db: PoolClient, store: string, id: string, now: () => Date) {
  // This read linearizes with an in-flight undo. Once active is visible, the undo deadline is past.
  await lockPurchasing(db, store);
  const { rows: [row] } = await db.query<{ undo_until: Date | null; voided_at: Date | null }>(`
    SELECT undo_until, voided_at FROM inventory.goods_receipt WHERE store_id = $1 AND receipt_id = $2
  `, [store, id]);
  if (!row) throw new PurchaseError(404, 'RECEIPT_NOT_FOUND');
  if (row.voided_at) return { status: 'voided' };
  if (row.undo_until && row.undo_until > now()) return { status: 'pending' };
  return { status: 'active' };
}
