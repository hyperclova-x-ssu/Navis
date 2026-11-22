import { ownerHeaders, type Actor } from '../14/clients.ts';
import type { TrendMenuItem } from './trend-menu-match.ts';

export function createTrendMenuReader(origin: string, token: string) {
  const base = new URL(origin);
  return async (owner: Actor): Promise<TrendMenuItem[] | null> => {
    const url = new URL(`/internal/v1/inventory/stores/${owner.storeId}/menu?limit=100`, base);
    const items: TrendMenuItem[] = [];
    const signal = AbortSignal.timeout(2500);
    try {
      for (let page = 0; page < 20; page++) {
        const response = await fetch(url, { headers: ownerHeaders(token, owner), redirect: 'error', signal });
        if (!response.ok) { await response.body?.cancel(); return null; }
        const data: { items?: unknown; nextCursor?: unknown } = await response.json();
        if (!Array.isArray(data?.items) || data.items.length > 100) return null;
        for (const row of data.items) {
          if (typeof row?.name !== 'string') return null;
          items.push({ name: row.name, category: typeof row.category === 'string' ? row.category : undefined,
            price: Number.isSafeInteger(row.price) ? row.price : undefined });
        }
        if (data.nextCursor === null) return items;
        if (typeof data.nextCursor !== 'string') return null;
        url.searchParams.set('cursor', data.nextCursor);
      }
    } catch { return null; }
    return null;
  };
}
