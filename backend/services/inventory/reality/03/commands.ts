import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { stockForItems } from '../../stock.ts';
import { itemForWrite, operatingDay, referenced, type ItemRecord } from './read.ts';
import { base, channel, confirmation, date, flag, object, quantity, revision, StockError, text, unit, units,
  uuid, type Channel, type Unit } from './wire.ts';

type Context = {
  storeId: string; actorId: string; key: string; now: () => Date; clock: { timezone?: string; dayStart?: string };
};
type Write = Context & { at: Date; day: string; receiptId: string };
type Fields = { name: string | null; thresholdBase: string | null; trackRestock: boolean; trackExpiry: boolean };
type Movement = { channel: Channel; delta: string; kind: 'adjust' | 'transfer' | 'waste' };
type Inverse = { archive?: boolean; fields?: Fields; movements?: Movement[] };
type Effect = {
  itemId: string; resourceId?: string; revision: number; inverse?: Inverse; changed?: boolean;
  currentStock?: number; adjustmentId?: string;
};
type Command =
  | { type: 'create_item'; sku: string; name: string; unit: Unit; stock: string; threshold: string; trackRestock: boolean }
  | { type: 'update_item'; itemId: string; expectedRevision: number; name?: string; stock?: number; threshold?: number; trackRestock?: boolean; trackExpiry?: boolean }
  | { type: 'archive_item'; itemId: string; expectedRevision: number }
  | { type: 'transfer'; itemId: string; from: Channel; to: Channel; qty: number; expectedRevision: number }
  | { type: 'register_batch'; itemId: string; quantity: number; expiresOn: string; expectedRevision: number }
  | { type: 'discard_batch'; batchId: string; expectedRevision: number }
  | { type: 'undo'; originalReceipt: string };

export function parseCommand(type: Command['type'], body: unknown, id?: string): Command {
  if (type === 'create_item') {
    const input = object(body, ['sku', 'name', 'unit', 'stock', 'threshold', 'trackRestock']);
    const display = unit(input.unit);
    return {
      type, sku: text(input.sku, 'sku', 80), name: text(input.name, 'name', 120), unit: display,
      stock: base(quantity(input.stock, 'stock'), display, 'stock').toString(),
      threshold: base(quantity(input.threshold, 'threshold'), display, 'threshold').toString(),
      trackRestock: input.trackRestock === undefined ? true : flag(input.trackRestock, 'trackRestock'),
    };
  }
  if (type === 'update_item') {
    const input = object(body, ['expectedRevision', 'name', 'stock', 'threshold', 'trackRestock', 'trackExpiry'], true);
    const changes = {
      name: input.name === undefined ? undefined : text(input.name, 'name', 120),
      stock: input.stock === undefined ? undefined : quantity(input.stock, 'stock'),
      threshold: input.threshold === undefined ? undefined : quantity(input.threshold, 'threshold'),
      trackRestock: input.trackRestock === undefined ? undefined : flag(input.trackRestock, 'trackRestock'),
      trackExpiry: input.trackExpiry === undefined ? undefined : flag(input.trackExpiry, 'trackExpiry'),
    };
    if (Object.values(changes).every(value => value === undefined)) throw new StockError(400, 'INVALID_REQUEST');
    return { type, itemId: uuid(id, 'itemId'), expectedRevision: revision(input.expectedRevision), ...changes };
  }
  if (type === 'archive_item' || type === 'discard_batch') {
    const input = object(body, ['expectedRevision', 'confirmed']);
    confirmation(input.confirmed);
    const expectedRevision = revision(input.expectedRevision);
    return type === 'archive_item'
      ? { type, itemId: uuid(id, 'itemId'), expectedRevision }
      : { type, batchId: uuid(id, 'batchId'), expectedRevision };
  }
  if (type === 'transfer') {
    const input = object(body, ['itemId', 'expectedRevision', 'qty', 'from', 'to']);
    const from = channel(input.from, 'from');
    const to = channel(input.to, 'to');
    const qty = quantity(input.qty, 'qty');
    if (from === to) throw new StockError(400, 'INVALID_REQUEST', 'to');
    if (!Number.isSafeInteger(qty) || qty === 0) throw new StockError(400, 'UNIT_PRECISION', 'qty');
    return { type, itemId: uuid(input.itemId, 'itemId'), expectedRevision: revision(input.expectedRevision), from, to, qty };
  }
  if (type === 'register_batch') {
    const input = object(body, ['itemId', 'expectedRevision', 'quantity', 'expiresOn']);
    return {
      type, itemId: uuid(input.itemId, 'itemId'), expectedRevision: revision(input.expectedRevision),
      quantity: quantity(input.quantity, 'quantity'), expiresOn: date(input.expiresOn, 'expiresOn'),
    };
  }
  object(body ?? {}, []);
  return { type, originalReceipt: uuid(id, 'receiptId') };
}

export async function lockStockStore(db: PoolClient, storeId: string) {
  // Catalog recipe edits take this lock too, so the archive guard sees a consistent reference set.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('navis:inventory:menu:' || $1, 0))", [storeId]);
}

export async function publishStockChange(
  db: PoolClient, storeId: string, businessDate: string, sourceId: string, operation: string, itemIds: string[], at: Date,
) {
  await db.query(`
    WITH sequence AS (
      INSERT INTO inventory.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
      ON CONFLICT (scope_key) DO UPDATE SET last_seq = inventory.outbox_scope.last_seq + 1
      RETURNING last_seq
    )
    INSERT INTO inventory.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    SELECT gen_random_uuid(), $1::uuid, $1, last_seq, 'inventory.stock_changed.v1', $2, $3, $4 FROM sequence
  `, [storeId, sourceId, at, { storeId, businessDate, sourceId, operation, itemIds }]);
}

function checkRevision(actual: number, expected: number) {
  if (actual !== expected) throw new StockError(409, 'STALE_REVISION');
}

async function checkUnique(db: PoolClient, storeId: string, name: string, itemId: string, sku?: string) {
  const { rows: [conflict] } = await db.query<{ sku: boolean; name: boolean }>(`
    SELECT coalesce(bool_or(lower(sku) = lower($4)), false) AS sku,
      coalesce(bool_or(lower(name) = lower($3) AND archived_at IS NULL), false) AS name
    FROM inventory.inventory_item WHERE store_id = $1 AND item_id <> $2
      AND (lower(sku) = lower($4) OR (lower(name) = lower($3) AND archived_at IS NULL))
  `, [storeId, itemId, name, sku ?? null]);
  if (conflict.sku) throw new StockError(409, 'SKU_EXISTS', 'sku');
  if (conflict.name) throw new StockError(409, 'NAME_EXISTS', 'name');
}

async function activeLots(db: PoolClient, storeId: string, itemId: string) {
  const { rows: [row] } = await db.query<{ total: string }>(`
    SELECT coalesce(sum(remaining_base), 0)::text AS total
    FROM inventory.stock_batch WHERE store_id = $1 AND item_id = $2 AND remaining_base > 0 AND discarded_at IS NULL
  `, [storeId, itemId]);
  return BigInt(row.total);
}

async function archiveGuard(db: PoolClient, storeId: string, itemId: string) {
  if (await referenced(db, storeId, itemId)) throw new StockError(409, 'REFERENCED_ITEM');
  if (await activeLots(db, storeId, itemId) > 0n) throw new StockError(409, 'ACTIVE_STOCK_BATCH');
}

async function opening(db: PoolClient, ctx: Write, itemId: string, qty: string) {
  await db.query(`
    INSERT INTO inventory.stock_daily_opening (store_id, business_date, item_id, channel, quantity_base)
    VALUES ($1, $2, $3, 'store', $4) ON CONFLICT DO NOTHING
  `, [ctx.storeId, ctx.day, itemId, qty]);
}

async function movement(db: PoolClient, ctx: Write, itemId: string, entry: Movement, reason: string) {
  const id = randomUUID();
  await db.query(`
    INSERT INTO inventory.stock_movement (store_id, movement_id, item_id, business_date, kind, delta_base, channel, at, source_id, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [ctx.storeId, id, itemId, ctx.day, entry.kind, entry.delta, entry.channel, ctx.at, ctx.receiptId, reason]);
  return id;
}

const maximum = BigInt(Number.MAX_SAFE_INTEGER);
function displayQuantity(raw: bigint, display: Unit) {
  const available = raw > 0n ? raw : 0n;
  return available <= maximum ? Number(available) / units[display][1] : undefined;
}

async function adjustItem(db: PoolClient, ctx: Write, item: ItemRecord, c: Extract<Command, { type: 'update_item' }>): Promise<Effect> {
  const { itemId, unit: display } = item;
  if (!display) throw new StockError(409, 'STOCK_UNIT_UNAVAILABLE');
  const fields: Fields = {
    name: c.name ?? item.storedName,
    thresholdBase: c.threshold === undefined ? item.thresholdBase : base(c.threshold, display, 'threshold').toString(),
    trackRestock: c.trackRestock ?? item.trackRestock,
    trackExpiry: c.trackExpiry ?? item.trackExpiry,
  };
  if (c.name) await checkUnique(db, ctx.storeId, c.name, itemId);
  const prior: Fields = { name: item.storedName, thresholdBase: item.thresholdBase,
    trackRestock: item.trackRestock, trackExpiry: item.trackExpiry };
  let [{ stock }] = await stockForItems(db, ctx.storeId, ctx.day, [itemId]);
  const missingOpening = stock === null;
  const target = c.stock === undefined ? undefined : base(c.stock, display, 'stock');
  let currentStock = stock ? displayQuantity(BigInt(stock.rawQuantityBase), display) : undefined;
  const inverse: Inverse = { fields: prior };
  let adjustmentId: string | undefined;
  if (target !== undefined) {
    if (target < await activeLots(db, ctx.storeId, itemId)) throw new StockError(409, 'ACTIVE_STOCK_BATCH', 'stock');
    if (missingOpening) {
      await opening(db, ctx, itemId, '0');
      [{ stock }] = await stockForItems(db, ctx.storeId, ctx.day, [itemId]);
    }
    const delta = target - BigInt(stock!.rawQuantityBase);
    if (delta !== 0n) {
      if (delta > maximum || delta < -maximum) throw new StockError(409, 'STOCK_RANGE', 'stock');
      adjustmentId = await movement(db, ctx, itemId, { delta: delta.toString(), channel: 'store', kind: 'adjust' }, 'cell-edit');
      inverse.movements = [{ delta: (-delta).toString(), channel: 'store', kind: 'adjust' }];
    }
    currentStock = displayQuantity(target, display);
  }
  const changed = adjustmentId !== undefined || (missingOpening && target !== undefined)
    || fields.name !== prior.name || fields.thresholdBase !== prior.thresholdBase
    || fields.trackRestock !== prior.trackRestock || fields.trackExpiry !== prior.trackExpiry;
  if (changed) await setFields(db, ctx, itemId, fields);
  return {
    itemId, revision: item.revision + Number(changed), changed, adjustmentId, currentStock,
    // A previously unknown count becomes known; a compensating quantity cannot restore that state.
    inverse: changed && (!missingOpening || target === undefined) ? inverse : undefined,
  };
}

async function setFields(db: PoolClient, ctx: Write, itemId: string, fields: Fields) {
  await db.query(`
    UPDATE inventory.inventory_item SET name = $3, threshold_base = $4, track_restock = $5, track_expiry = $6,
      revision = revision + 1, updated_at = $7 WHERE store_id = $1 AND item_id = $2
  `, [ctx.storeId, itemId, fields.name, fields.thresholdBase, fields.trackRestock, fields.trackExpiry, ctx.at]);
}

async function bumpItem(db: PoolClient, ctx: Write, itemId: string) {
  await db.query(`
    UPDATE inventory.inventory_item SET revision = revision + 1, updated_at = $3 WHERE store_id = $1 AND item_id = $2
  `, [ctx.storeId, itemId, ctx.at]);
}

async function setArchive(db: PoolClient, ctx: Write, itemId: string, at: Date | null) {
  await db.query(`
    UPDATE inventory.inventory_item SET archived_at = $3, revision = revision + 1, updated_at = $4
    WHERE store_id = $1 AND item_id = $2
  `, [ctx.storeId, itemId, at, ctx.at]);
}

async function transfer(db: PoolClient, ctx: Write, item: ItemRecord, c: Extract<Command, { type: 'transfer' }>): Promise<Effect> {
  if (item.kind !== 'retail' || item.unit !== 'pcs') throw new StockError(409, 'INVALID_TRANSFER_ITEM');
  const [{ stock, onlineStock }] = await stockForItems(db, ctx.storeId, ctx.day, [item.itemId]);
  if (!stock || !onlineStock) throw new StockError(409, 'STOCK_BALANCE_UNAVAILABLE');
  const balances = { store: BigInt(stock.rawQuantityBase), online: BigInt(onlineStock.rawQuantityBase) };
  const qty = BigInt(c.qty);
  const available = balances[c.from] - (c.from === 'store' ? await activeLots(db, ctx.storeId, item.itemId) : 0n);
  if (available < qty) throw new StockError(409, 'INSUFFICIENT_STOCK', 'qty');
  if (balances[c.to] + qty > maximum) throw new StockError(409, 'STOCK_RANGE', 'qty');
  const sides: Movement[] = [
    { channel: c.from, delta: (-qty).toString(), kind: 'transfer' },
    { channel: c.to, delta: qty.toString(), kind: 'transfer' },
  ];
  for (const side of sides) await movement(db, ctx, item.itemId, side, 'channel-transfer');
  await bumpItem(db, ctx, item.itemId);
  return { itemId: item.itemId, revision: item.revision + 1,
    inverse: { movements: sides.map(side => ({ ...side, delta: (-BigInt(side.delta)).toString() })) } };
}

async function registerBatch(db: PoolClient, ctx: Write, item: ItemRecord, c: Extract<Command, { type: 'register_batch' }>): Promise<Effect> {
  if (!item.unit) throw new StockError(409, 'STOCK_UNIT_UNAVAILABLE');
  const qty = base(c.quantity, item.unit, 'quantity');
  if (qty <= 0n) throw new StockError(400, 'NUMBER_INVALID', 'quantity');
  if (c.expiresOn < ctx.day) throw new StockError(400, 'BATCH_ALREADY_EXPIRED', 'expiresOn');
  const [{ stock }] = await stockForItems(db, ctx.storeId, ctx.day, [item.itemId]);
  if (!stock) throw new StockError(409, 'STOCK_BALANCE_UNAVAILABLE');
  if (BigInt(stock.availableQuantityBase) - await activeLots(db, ctx.storeId, item.itemId) < qty) {
    throw new StockError(409, 'INSUFFICIENT_STOCK', 'quantity');
  }
  const batchId = randomUUID();
  await db.query(`
    INSERT INTO inventory.stock_batch (store_id, batch_id, item_id, quantity_base, remaining_base, expires_on, received_at)
    VALUES ($1, $2, $3, $4, $4, $5, $6)
  `, [ctx.storeId, batchId, item.itemId, qty.toString(), c.expiresOn, ctx.at]);
  await bumpItem(db, ctx, item.itemId);
  return { itemId: item.itemId, resourceId: batchId, revision: 1 };
}

async function discardBatch(db: PoolClient, ctx: Write, c: Extract<Command, { type: 'discard_batch' }>): Promise<Effect> {
  const { rows: [batch] } = await db.query<{
    item_id: string; revision: number; remaining_base: string; discarded_at: Date | null;
  }>(`
    SELECT item_id, revision, remaining_base, discarded_at FROM inventory.stock_batch
    WHERE store_id = $1 AND batch_id = $2
  `, [ctx.storeId, c.batchId]);
  if (!batch) throw new StockError(404, 'STOCK_BATCH_NOT_FOUND');
  await itemForWrite(db, ctx.storeId, batch.item_id);
  checkRevision(batch.revision, c.expectedRevision);
  if (batch.discarded_at || batch.remaining_base === '0') throw new StockError(409, 'BATCH_EMPTY');
  const [{ stock }] = await stockForItems(db, ctx.storeId, ctx.day, [batch.item_id]);
  if (!stock || BigInt(stock.availableQuantityBase) < BigInt(batch.remaining_base)) throw new StockError(409, 'INSUFFICIENT_STOCK');
  await movement(db, ctx, batch.item_id, { channel: 'store', kind: 'waste', delta: (-BigInt(batch.remaining_base)).toString() }, 'batch-discard');
  await db.query(`
    UPDATE inventory.stock_batch SET discarded_at = $3, remaining_base = 0, revision = revision + 1
    WHERE store_id = $1 AND batch_id = $2
  `, [ctx.storeId, c.batchId, ctx.at]);
  await bumpItem(db, ctx, batch.item_id);
  return { itemId: batch.item_id, resourceId: c.batchId, revision: batch.revision + 1 };
}

async function undo(db: PoolClient, ctx: Write, originalReceipt: string): Promise<Effect> {
  const { rows: [saved] } = await db.query<{
    item_id: string; result: { undoUntil?: string; revision: number; businessDate: string }; inverse: Inverse | null;
  }>(`
    SELECT item_id, result, inverse FROM inventory.stock_command WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3
  `, [ctx.storeId, ctx.actorId, originalReceipt]);
  if (!saved) throw new StockError(404, 'RECEIPT_NOT_FOUND');
  if (!saved.result.undoUntil) throw new StockError(409, 'UNDO_UNAVAILABLE');
  if (ctx.at >= new Date(saved.result.undoUntil)) throw new StockError(409, 'UNDO_EXPIRED');
  if (!saved.inverse) throw new StockError(409, 'UNDO_ALREADY_APPLIED');
  if (ctx.day !== saved.result.businessDate) throw new StockError(409, 'DAY_CLOSED');
  const item = await itemForWrite(db, ctx.storeId, saved.item_id, true);
  if (ctx.now() >= new Date(saved.result.undoUntil)) throw new StockError(409, 'UNDO_EXPIRED');
  checkRevision(item.revision, saved.result.revision);
  if (saved.inverse.archive !== undefined) {
    if (saved.inverse.archive) await archiveGuard(db, ctx.storeId, item.itemId);
    else if (item.name) await checkUnique(db, ctx.storeId, item.name, item.itemId);
    await setArchive(db, ctx, item.itemId, saved.inverse.archive ? ctx.at : null);
  } else if (saved.inverse.fields) {
    if (saved.inverse.fields.name) await checkUnique(db, ctx.storeId, saved.inverse.fields.name, item.itemId);
    await setFields(db, ctx, item.itemId, saved.inverse.fields);
  } else {
    await bumpItem(db, ctx, item.itemId);
  }
  for (const entry of saved.inverse.movements ?? []) await movement(db, ctx, item.itemId, entry, 'undo');
  await db.query(`
    UPDATE inventory.stock_command SET inverse = NULL, undone_at = $3 WHERE store_id = $1 AND receipt_id = $2
  `, [ctx.storeId, originalReceipt, ctx.at]);
  return { itemId: item.itemId, revision: item.revision + 1 };
}

async function apply(db: PoolClient, ctx: Write, c: Command): Promise<Effect> {
  if (c.type === 'undo') return undo(db, ctx, c.originalReceipt);
  if (c.type === 'discard_batch') return discardBatch(db, ctx, c);
  if (c.type === 'create_item') {
    const itemId = randomUUID();
    await checkUnique(db, ctx.storeId, c.name, itemId, c.sku);
    await db.query(`
      INSERT INTO inventory.inventory_item
        (store_id, item_id, recipe_key, base_unit, sku, name, display_unit, threshold_base, track_restock, updated_at)
      VALUES ($1, $2, $2::uuid::text, $3, $4, $5, $6, $7, $8, $9)
    `, [ctx.storeId, itemId, units[c.unit][0], c.sku, c.name, c.unit, c.threshold, c.trackRestock, ctx.at]);
    await opening(db, ctx, itemId, c.stock);
    return { itemId, revision: 1, currentStock: displayQuantity(BigInt(c.stock), c.unit), inverse: { archive: true } };
  }
  const item = await itemForWrite(db, ctx.storeId, c.itemId);
  checkRevision(item.revision, c.expectedRevision);
  if (c.type === 'transfer') return transfer(db, ctx, item, c);
  if (c.type === 'register_batch') return registerBatch(db, ctx, item, c);
  if (item.kind !== 'ingredient') throw new StockError(409, 'INVALID_STOCK_ITEM');
  if (c.type === 'update_item') return adjustItem(db, ctx, item, c);
  await archiveGuard(db, ctx.storeId, item.itemId);
  await setArchive(db, ctx, item.itemId, ctx.at);
  return { itemId: item.itemId, revision: item.revision + 1, inverse: { archive: false } };
}

export async function runStockCommand(db: PoolClient, ctx: Context, command: Command) {
  const { storeId, actorId, key } = ctx;
  await lockStockStore(db, storeId);
  const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
  const { rows: [saved] } = await db.query<{ result: unknown; fingerprint: string }>(`
    SELECT result, fingerprint FROM inventory.stock_command WHERE store_id = $1 AND actor_id = $2 AND idempotency_key = $3
  `, [storeId, actorId, key]);
  if (saved) {
    if (saved.fingerprint !== fingerprint) throw new StockError(409, 'IDEMPOTENCY_MISMATCH');
    return saved.result;
  }
  const at = ctx.now();
  const day = await operatingDay(db, storeId, at, ctx.clock, true);
  const receiptId = randomUUID();
  const { itemId, resourceId = itemId, revision, inverse, changed = true, currentStock, adjustmentId } =
    await apply(db, { ...ctx, at, day, receiptId }, command);
  const result = {
    resourceId, itemId, revision, receiptId, businessDate: day, changed, currentStock, adjustmentId,
    ...(inverse ? { undoUntil: new Date(ctx.now().getTime() + 6000).toISOString() } : {}),
    affectedSources: ['inventory', 'inventory-booking', 'menu', 'suppliers', 'expiry-coupon'],
  };
  if (changed) await publishStockChange(db, storeId, day, receiptId, command.type, [itemId], at);
  await db.query(`
    INSERT INTO inventory.stock_command (store_id, receipt_id, item_id, actor_id, idempotency_key, fingerprint, result, inverse)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [storeId, receiptId, itemId, actorId, key, fingerprint, result, inverse ?? null]);
  return result;
}
