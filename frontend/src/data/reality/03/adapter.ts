import { loadCommerceQuantities } from './commerce-stock';
import { addDays, dateRange, isIsoDate } from '../../db/time';
import { defineBinding, PortError, type CommandContext, type DomainAdapter, type ListPage, type LoadContext } from '../00';
import { toInventoryItem, toInventoryStock, toStockOpening, type StockBatchDto, type StockForecastDto, type StockItemDto, type StockMovementDto } from './stock-dto';

const itemsPath = '/inventory/items';
const batchesPath = '/inventory/stock-batches';
const receiptBase = '/inventory/stock';
const itemKey = (id: string) => `inventory-item:${id}`;
const batchKey = (id: string) => `inventory-batch:${id}`;

function revision(context: CommandContext, key: string): number {
  const current = context.revision(key);
  if (current === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return current;
}

async function itemPages({ reads, signal }: LoadContext) {
  const read = { resource: 'inventory-items', path: itemsPath, query: { limit: 200 } };
  let page = await reads.page<StockItemDto>(read, { signal }) as ListPage<StockItemDto> & { businessDate?: string };
  const day = page.businessDate ?? page.items[0]?.businessDate;
  if (!isIsoDate(day)) throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  const items = [...page.items];
  for (let pages = 1; page.nextCursor !== null && pages < 20; pages += 1) {
    page = await reads.page<StockItemDto>({ ...read, query: { ...read.query, businessDate: day } }, { cursor: page.nextCursor, signal });
    items.push(...page.items);
  }
  return { items, day, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: page.nextCursor === null };
}

async function movementDays({ reads, signal }: LoadContext, day: string) {
  const days = dateRange(addDays(day, -6), day);
  const loadDay = (businessDate: string) => reads.all<StockMovementDto>({
    resource: 'inventory-movements', path: '/inventory/stock-movements', query: { businessDate, limit: 200 },
  }, { signal });
  // Scope each cursor to a business day and keep at most two days in flight.
  const pages: Awaited<ReturnType<typeof loadDay>>[] = [];
  for (let index = 0; index < days.length; index += 2) {
    pages.push(...await Promise.all(days.slice(index, index + 2).map(loadDay)));
  }
  return { items: pages.flatMap(page => page.items), complete: pages.every(page => page.complete) };
}

export const stockAdapter: DomainAdapter = {
  domain: 'stock',
  sources: ['stock', 'inventory', 'inventory-booking', 'pos', 'menu', 'purchase', 'suppliers'],
  tables: ['inventoryItem', 'inventoryStock', 'inventoryTxn', 'stockOpening', 'stockAdjustment', 'realStock'],
  errorKeys: {
    NAME_EXISTS: 'data.management.error.NAME_EXISTS',
    SKU_EXISTS: 'data.management.error.SKU_EXISTS',
    NUMBER_INVALID: 'data.error.numberInvalid',
    UNIT_PRECISION: 'data.management.error.UNIT_PRECISION',
  },
  async load(context) {
    const { reads, signal } = context;
    const { items, day, asOf, sourceRevision, complete } = await itemPages(context);
    const [movements, batches, forecast, commerce] = await Promise.all([
      movementDays(context, day),
      reads.all<StockBatchDto>({ resource: 'inventory-batches', path: batchesPath, query: { limit: 200 } }, { signal }),
      reads.one<StockForecastDto>({ resource: 'inventory-forecast', path: `/inventory/forecasts/${day}/weekday-4w-v1` }, { signal })
        .catch(error => {
          if (!(error instanceof PortError) || !error.retryable) throw error;
          return null;
        }),
      loadCommerceQuantities(reads, items, signal),
    ]);
    return {
      tables: {
        inventoryItem: items.map(toInventoryItem), inventoryStock: items.flatMap(item => toInventoryStock(item, commerce.get(item.itemId))),
        inventoryTxn: [], stockOpening: items.flatMap(toStockOpening), stockAdjustment: [],
        realStock: [{ businessDate: day, items, movements: movements.items, movementsComplete: movements.complete,
          batches: batches.items, batchesComplete: batches.complete, forecast }],
      },
      asOf, sourceRevision, complete: complete && movements.complete && batches.complete && forecast !== null,
      revisions: Object.fromEntries([...items.map(item => [itemKey(item.itemId), item.revision]),
        ...batches.items.map(batch => [batchKey(batch.batchId), batch.revision])]),
    };
  },
  commands: [
    defineBinding({ type: 'inventory.createItem', receiptBase, request: ({ sku, name, unit, stock, threshold, trackRestock }) => ({
      method: 'POST', path: itemsPath, body: { sku, name, unit, stock, threshold, trackRestock },
    }) }),
    defineBinding({ type: 'inventory.updateItem', receiptBase, request: ({ itemId, name, stock, threshold }, context) => ({
      method: 'PATCH', path: `${itemsPath}/${encodeURIComponent(itemId)}`, body: { name, stock, threshold }, expectedRevision: revision(context, itemKey(itemId)),
    }) }),
    defineBinding({ type: 'inventory.setTracking', receiptBase, request: ({ itemId, trackRestock, trackExpiry }, context) => ({
      method: 'PATCH', path: `${itemsPath}/${encodeURIComponent(itemId)}`, body: { trackRestock, trackExpiry }, expectedRevision: revision(context, itemKey(itemId)),
    }) }),
    defineBinding({ type: 'inventory.deleteItem', receiptBase, request: ({ itemId }, context) => ({
      method: 'DELETE', path: `${itemsPath}/${encodeURIComponent(itemId)}`, body: { confirmed: true }, expectedRevision: revision(context, itemKey(itemId)),
    }) }),
    defineBinding({ type: 'inventory.moveChannel', receiptBase, request: ({ itemId, from, to, qty }, context) => ({
      method: 'POST', path: '/inventory/channel-transfers', body: { itemId, from, to, qty }, expectedRevision: revision(context, itemKey(itemId)),
    }) }),
    defineBinding({ type: 'inventory.registerBatch', request: ({ itemId, quantity, expiresOn }, context) => ({
      method: 'POST', path: batchesPath, body: { itemId, quantity, expiresOn }, expectedRevision: revision(context, itemKey(itemId)),
    }) }),
    defineBinding({ type: 'inventory.discardBatch', request: ({ batchId }, context) => ({
      method: 'POST', path: `${batchesPath}/${encodeURIComponent(batchId)}/discard`, body: { confirmed: true }, expectedRevision: revision(context, batchKey(batchId)),
    }) }),
  ],
};
