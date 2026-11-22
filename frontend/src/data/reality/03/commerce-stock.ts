import { PortError, type PortReads } from '../00/port';
import type { CommerceStockView } from '../../../../../backend/services/inventory/reality/03/commerce-routes';
import type { StockItemDto } from './stock-dto';

export const commerceStockPath = (itemId: string) => '/inventory/items/' + encodeURIComponent(itemId) + '/commerce-stock';

/** A missing map entry is an explicitly unlinked item, null is unavailable. */
export async function loadCommerceQuantities(reads: PortReads, items: readonly StockItemDto[], signal: AbortSignal) {
  const ids = items.filter(item => item.kind === 'retail').map(item => item.itemId).values();
  const quantities = new Map<string, number | null>();

  async function read() {
    for (const itemId of ids) {
      signal.throwIfAborted();
      try {
        const result = await reads.one<CommerceStockView>(
          { resource: 'commerce-stock', path: commerceStockPath(itemId) }, { signal },
        );
        const quantity = result.stockQuantity;
        quantities.set(itemId, Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PortError) || error.reason !== 'COMMERCE_ITEM_NOT_LINKED') quantities.set(itemId, null);
      }
    }
  }

  // The catalogue can contain many unlinked items, so bound concurrent requests.
  await Promise.all([read(), read()]);
  return quantities;
}
