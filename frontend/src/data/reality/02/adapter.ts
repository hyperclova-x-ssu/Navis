/**
 * REAL-PLAN F02 — the `pos` domain on the F00 port. The rows are not `DataTables`: they are published into the run's `PosState`
 * by the bridge (`bridge.ts`), so `tables` stays empty and `load()` only drives a bridge sync. That keeps the port's lifecycle
 * (first load, retry, store change reset, `affectedSources` re-reads, per-domain state) without a second copy of the data.
 */
import type { DomainAdapter } from '../00/port';
import type { PosBridge } from './bridge';

let current: PosBridge | undefined;
/** The run host binds its bridge on mount and unbinds on unmount. */
export function bindPosBridge(bridge: PosBridge | undefined): void { current = bridge; }

const EPOCH = '1970-01-01T00:00:00.000Z';

export const posAdapter: DomainAdapter = {
  domain: 'pos',
  sources: ['pos', 'pos.bills', 'pos.orders', 'pos.receipts', 'pos.sales', 'pos.tables'],
  tables: [],
  errorKeys: {
    DAY_CLOSED: 'order.closed.reason', QUOTE_CHANGED: 'pos.quoteChanged', STALE_REVISION: 'data.management.error.STALE_REVISION',
    CATALOG_UNAVAILABLE: 'order.menu.loadError', CATALOG_RECIPE_UNAVAILABLE: 'order.menu.loadError',
  },
  async load() {
    const state = current ? await current.sync({ force: true }) : undefined;
    if (state?.status === 'error' && state.error) throw state.error;
    return { tables: {}, asOf: state?.asOf ?? EPOCH, sourceRevision: state?.sourceRevision ?? 0, complete: state?.complete ?? true };
  },
  /** F00 scope reset (401/403, sign-out, store switch): the rows live in the run's POS state, not in `DataTables`. */
  clear() { current?.clearRows(); return {}; },
  commands: [],
};
