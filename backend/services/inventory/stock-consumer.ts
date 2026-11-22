import type { Pool, PoolClient } from 'pg';
import type { SaleUsageLine } from '../../packages/contracts/events.ts';
import { PermanentStreamError, StreamConsumer, type RedisStreams, type StreamEnvelope } from '../../packages/streams/index.ts';
import type { RecipeIngredient } from './recipes.ts';
import { advanceUsageRevision, allocateSaleLots, restoreSaleLots } from './reality/03/batch-usage.ts';
import { lockStockStore, publishStockChange } from './reality/03/commands.ts';

const saleType = 'pos.sale_recognized.v1';
const correctionType = 'pos.sale_corrected.v1';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const version = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isUsageLine(value: unknown, keep: boolean): value is SaleUsageLine {
  if (!record(value)) return false;
  const { allocationId, orderLineId, menuId, recipeVersion, quantity, options } = value;
  return uuid(allocationId) && uuid(orderLineId) && uuid(menuId) && version(recipeVersion)
    && typeof quantity === 'number' && Number.isInteger(quantity)
    && (keep ? quantity === 0 : quantity >= 1 && quantity <= 99)
    && Array.isArray(options) && options.length <= 20
    && options.every((option) => record(option) && uuid(option.optionId) && option.optionId !== menuId && version(option.recipeVersion))
    && new Set(options.map((option) => option.optionId)).size === options.length;
}

function readUsageEvent(event: StreamEnvelope) {
  const { payload, storeId, scopeKey, aggregateId, eventType } = event;
  const { settlementId, correctionId, billId, orderId, paymentId, memberId, businessDate, kind, usageEffect, target, lines } = payload;
  const corrected = eventType === correctionType;
  const hasPaymentIdentity = uuid(paymentId) || (paymentId === undefined && uuid(memberId));
  const keep = corrected && kind === 'refund' && usageEffect === 'keep';
  const restore = corrected && kind === 'cancel' && usageEffect === 'restore';
  if (!storeId || storeId !== scopeKey || !uuid(settlementId) || !uuid(billId) || !uuid(orderId) || !hasPaymentIdentity
      || typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)
      || (corrected ? !uuid(correctionId) || aggregateId !== correctionId || target !== 'recognized_sale' || (!keep && !restore)
        : aggregateId !== settlementId)
      || !Array.isArray(lines) || (!keep && lines.length === 0) || lines.length > 25
      || !lines.every((line) => isUsageLine(line, keep))
      || new Set(lines.map((line) => line.allocationId)).size !== lines.length) {
    throw new PermanentStreamError('SALE_USAGE_EVENT_INVALID');
  }
  const date = new Date(`${businessDate}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== businessDate || businessDate.startsWith('0000')) {
    throw new PermanentStreamError('SALE_USAGE_EVENT_INVALID');
  }
  return { storeId, settlementId, billId, orderId, paymentId, memberId, businessDate, lines, correctionId, restore };
}

const identity = ({ orderLineId, menuId, recipeVersion, options }: SaleUsageLine) =>
  ({ orderLineId, menuId, recipeVersion, options });

async function recognizeSale(db: PoolClient, event: StreamEnvelope) {
  const { storeId, settlementId, businessDate, lines } = readUsageEvent(event);
  await lockStockStore(db, storeId);
  const added = await db.query(`
    INSERT INTO inventory.sale_usage (store_id, settlement_id, business_date, sale, recorded_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [storeId, settlementId, businessDate, event.payload, event.occurredAt]);

  if (!added.rowCount) {
    const duplicate = await db.query(`
      SELECT 1 FROM inventory.sale_usage WHERE store_id = $1 AND settlement_id = $2 AND sale = $3
    `, [storeId, settlementId, event.payload]);
    if (!duplicate.rowCount) throw new PermanentStreamError('SALE_USAGE_MISMATCH');
    return;
  }

  const versionKey = (menuId: string, componentId: string, recipeVersion: string) =>
    `${menuId}/${componentId}/${recipeVersion}`;
  const required = lines.map((line) => [
    { menu_id: line.menuId, component_id: line.menuId, version: line.recipeVersion },
    ...line.options.map((option) => ({ menu_id: line.menuId, component_id: option.optionId, version: option.recipeVersion })),
  ]);
  const { rows } = await db.query<{
    menu_id: string; component_id: string; version: string; ingredients: RecipeIngredient[];
  }>(`
    SELECT v.menu_id, v.component_id, v.version, v.ingredients
    FROM inventory.recipe_version v JOIN (
      SELECT DISTINCT menu_id, component_id, version FROM jsonb_to_recordset($2::jsonb)
        AS r(menu_id uuid, component_id uuid, version text)
    ) requested USING (menu_id, component_id, version)
    WHERE v.store_id = $1
  `, [storeId, JSON.stringify(required.flat())]);
  const recipes = new Map(rows.map((row) => [versionKey(row.menu_id, row.component_id, row.version), row.ingredients]));
  const allocations = lines.map((line, index) => {
    const ingredients = required[index].flatMap((part) => {
      const snapshot = recipes.get(versionKey(part.menu_id, part.component_id, part.version));
      if (!snapshot) throw new PermanentStreamError('SALE_RECIPE_VERSION_MISSING');
      return snapshot;
    });
    return {
      allocation_id: line.allocationId, line_identity: identity(line),
      recognized_quantity: line.quantity, ingredients,
    };
  });

  await db.query(`
    INSERT INTO inventory.sale_usage_line
      (store_id, settlement_id, allocation_id, line_identity, recognized_quantity, ingredients)
    SELECT $1, $2, allocation_id, line_identity, recognized_quantity, ingredients
    FROM jsonb_to_recordset($3::jsonb)
      AS l(allocation_id uuid, line_identity jsonb, recognized_quantity integer, ingredients jsonb)
  `, [storeId, settlementId, JSON.stringify(allocations)]);
  const itemIds = await advanceUsageRevision(db, storeId, settlementId, event.occurredAt);
  await allocateSaleLots(db, storeId, settlementId, event.occurredAt);
  if (itemIds.length) {
    await publishStockChange(db, storeId, businessDate, settlementId, 'sale_recognized', itemIds, new Date(event.occurredAt));
  }
}

async function correctSale(db: PoolClient, event: StreamEnvelope) {
  const { storeId, settlementId, businessDate, correctionId, billId, orderId, paymentId, memberId, restore, lines } = readUsageEvent(event);
  const originalIdentity = paymentId === undefined ? { billId, orderId, memberId } : { billId, orderId, paymentId };
  await lockStockStore(db, storeId);
  const original = await db.query(`
    SELECT 1 FROM inventory.sale_usage WHERE store_id = $1 AND settlement_id = $2 AND business_date = $3
      AND sale @> $4::jsonb AND (sale ? 'paymentId') = $5
  `, [storeId, settlementId, businessDate, originalIdentity, paymentId !== undefined]);
  if (!original.rowCount) throw new PermanentStreamError('SALE_USAGE_ORIGINAL_MISSING');

  const added = await db.query(`
    INSERT INTO inventory.sale_usage_correction (store_id, correction_id, settlement_id, correction, recorded_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [storeId, correctionId, settlementId, event.payload, event.occurredAt]);
  if (!added.rowCount) {
    const duplicate = await db.query(`
      SELECT 1 FROM inventory.sale_usage_correction WHERE store_id = $1 AND correction_id = $2 AND correction = $3
    `, [storeId, correctionId, event.payload]);
    if (!duplicate.rowCount) throw new PermanentStreamError('SALE_USAGE_CORRECTION_MISMATCH');
    return;
  }
  if (!restore) return;

  const restores = lines.map((line) => ({
    allocation_id: line.allocationId, line_identity: identity(line), quantity: line.quantity,
  }));
  const result = await db.query(`
    UPDATE inventory.sale_usage_line l SET restored_quantity = l.restored_quantity + r.quantity
    FROM jsonb_to_recordset($3::jsonb) AS r(allocation_id uuid, line_identity jsonb, quantity integer)
    WHERE l.store_id = $1 AND l.settlement_id = $2 AND l.allocation_id = r.allocation_id
      AND l.line_identity = r.line_identity AND r.quantity <= l.recognized_quantity - l.restored_quantity
  `, [storeId, settlementId, JSON.stringify(restores)]);
  if (result.rowCount !== lines.length) throw new PermanentStreamError('SALE_USAGE_RESTORE_INVALID');
  const allocationIds = lines.map(line => line.allocationId);
  const itemIds = await advanceUsageRevision(db, storeId, settlementId, event.occurredAt, allocationIds);
  await restoreSaleLots(db, storeId, settlementId, allocationIds);
  if (itemIds.length) {
    await publishStockChange(db, storeId, businessDate, event.aggregateId, 'sale_corrected', itemIds, new Date(event.occurredAt));
  }
}

export function createInventoryStockConsumer(database: Pool, redis: RedisStreams, name: string) {
  return new StreamConsumer({
    database, service: 'inventory', producer: 'pos', group: 'inventory', redis, name,
    handlers: { [saleType]: recognizeSale, [correctionType]: correctSale },
  });
}
