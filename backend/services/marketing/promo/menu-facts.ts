import { ownerHeaders, type Actor } from '../reality/14/clients.ts';
import { isRecord } from '../reality/14/wire.ts';

export type PromoMenuPriceRead = (owner: Actor, name: string) => Promise<number | null>;

export function createPromoMenuPriceRead(origin: string, token: string, send: typeof fetch = fetch) {
  const base = new URL(origin);
  async function read(owner: Actor, path: string) {
    const url = new URL(`/internal/v1/inventory/stores/${owner.storeId}/${path}`, base);
    try {
      const response = await send(url, { headers: ownerHeaders(token, owner), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2500) });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const result: unknown = await response.json();
      return isRecord(result) ? result : null;
    } catch {
      return null;
    }
  }
  async function uniqueMenu(owner: Actor, name: string) {
    const page = await read(owner, 'menu?limit=100');
    if (!Array.isArray(page?.items) || page.nextCursor !== null) return null;
    const matching = page.items.filter((item): item is Record<string, unknown> => isRecord(item) && item.name === name);
    return matching.length === 1 ? matching[0] : null;
  }
  const price: PromoMenuPriceRead = async (owner, name) => {
    const menu = await uniqueMenu(owner, name);
    return menu?.saleStatus === 'selling' && typeof menu.price === 'number' && Number.isSafeInteger(menu.price) && menu.price > 0
      ? menu.price : null;
  };
  return price;
}
