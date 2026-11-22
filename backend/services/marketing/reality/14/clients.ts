import { isRecord, isUuid } from './wire.ts';
import type { createCouponPort } from '../../naver/pn05-coupons.ts';

/** Owner identity forwarded to sibling owner reads (actor, store, owner role). */
export type Actor = { storeId: string; actorId: string; timezone?: string; dayStart?: string };
/** Owner identity plus the gateway-supplied store clock, so the owning service resolves the same business day. */
export function ownerHeaders(token: string, actor: Actor): Record<string, string> {
  return {
    authorization: `Bearer ${token}`, 'x-navis-store-id': actor.storeId, 'x-navis-user-id': actor.actorId, 'x-navis-store-role': 'owner',
    ...(actor.timezone && { 'x-navis-store-timezone': actor.timezone }),
    ...(actor.dayStart && { 'x-navis-business-day-start': actor.dayStart }),
  };
}
export type Recipient = { customerId: string; marketingAllowed: boolean; visitCount: number; recentVisitCount: number; lastVisitAt: string | null };
export type ExpiryLot = { itemId: string; batchId: string | null; name: string; expiresOn: string; remainingBase: number; unit: string };
export type MenuBasis = { menuId: string; name: string; price: number; unitCost: number | null; revision: number; itemIds: string[] };

/**
 * Live reads from Customer (B05 members and consent) and Inventory (B01 menu, B03 lots). `null` means the
 * source is unreachable, which closes the write (consent is checked at commit, never cached).
 */
export interface CouponSources {
  recipients(actor: Actor, customerIds: readonly string[]): Promise<Map<string, Recipient> | null>;
  regulars(actor: Actor): Promise<Recipient[] | null>;
  expiryLot(actor: Actor, itemId: string, batchId: string | null): Promise<ExpiryLot | null | 'missing'>;
  menuForItem(actor: Actor, itemId: string, menuId: string | null): Promise<MenuBasis | null | 'missing'>;
}

export type SaleLink = { settlementId: string; billId: string; orderId: string };
export type PosBillLine = { lineId: string; menuId: string; gross: number; basePrice: number; options: { optionId: string; extraPrice: number }[] };
/** The authoritative POS bill (B02 `GET /bills/:id`): status, whole-bill discount, quote lines and the sale once paid. */
export type PosBill = { billId: string; status: 'open' | 'paid' | 'void'; discount: number; lines: PosBillLine[];
  settlementId: string | null; orderId: string | null };

export interface PosBillReader {
  bill(actor: Actor, billId: string): Promise<PosBill | 'missing' | null>;
}

export function parsePosBill(body: unknown): PosBill | null {
  if (!isRecord(body) || !isUuid(body.billId) || !['open', 'paid', 'void'].includes(String(body.status)) || !isRecord(body.quote)) return null;
  const { quote } = body;
  if (typeof quote.discount !== 'number' || !Array.isArray(quote.lines)) return null;
  const lines: PosBillLine[] = [];
  for (const raw of quote.lines) {
    if (!isRecord(raw) || typeof raw.allocationId !== 'string' || typeof raw.menuId !== 'string' || typeof raw.gross !== 'number'
      || typeof raw.basePrice !== 'number') return null;
    const options = Array.isArray(raw.options) ? raw.options.filter(isRecord).map(option => ({
      optionId: String(option.optionId), extraPrice: typeof option.extraPrice === 'number' ? option.extraPrice : 0 })) : [];
    lines.push({ lineId: raw.allocationId, menuId: raw.menuId.toLowerCase(), gross: raw.gross, basePrice: raw.basePrice, options });
  }
  const orderIds = Array.isArray(body.orderIds) ? body.orderIds : [];
  return { billId: body.billId.toLowerCase(), status: body.status as PosBill['status'], discount: quote.discount, lines,
    settlementId: isUuid(body.settlementId) ? body.settlementId.toLowerCase() : null,
    orderId: isUuid(orderIds[0]) ? String(orderIds[0]).toLowerCase() : null };
}

function privateOrigin(origin: string) {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Invalid private service origin');
  }
  return base.origin;
}

async function getJson(transport: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await transport(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (response.status === 404) {
      await response.body?.cancel();
      return { status: 404, body: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  }
}

/** Reads the bill through the POS owner route with a marketing workload credential and the acting owner. */
export function createPosBillReader(origin: string, token: string, transport: typeof fetch = fetch): PosBillReader {
  const base = privateOrigin(origin);
  return {
    async bill(actor, billId) {
      const result = await getJson(transport, `${base}/internal/v1/pos/stores/${actor.storeId}/bills/${billId}`, ownerHeaders(token, actor));
      if (!result) return null;
      if (result.status === 404) return 'missing';
      return parsePosBill(result.body);
    },
  };
}

const integerString = (value: unknown) => typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : null;

/**
 * HTTP sources over the owners' store routes. Each call carries a dedicated marketing workload credential plus the
 * acting owner, so the owning service re-checks store membership and its own row-level scope.
 */
export function createHttpCouponSources(config: {
  customerUrl: string; customerToken: string; inventoryUrl: string; inventoryToken: string;
}, transport: typeof fetch = fetch): CouponSources {
  const customer = privateOrigin(config.customerUrl);
  const inventory = privateOrigin(config.inventoryUrl);
  const headers = ownerHeaders;
  const recipient = (row: unknown): Recipient | null => {
    if (!isRecord(row) || !isUuid(row.customerId) || !isRecord(row.consent)) return null;
    return { customerId: row.customerId.toLowerCase(),
      marketingAllowed: row.consent.marketingAllowed === true && row.consent.contactAllowed === true,
      visitCount: typeof row.visitCount === 'number' ? row.visitCount : 0,
      recentVisitCount: typeof row.recentVisitCount === 'number' ? row.recentVisitCount : 0,
      lastVisitAt: typeof row.lastVisitAt === 'string' ? row.lastVisitAt : null };
  };
  async function allMembers(actor: Actor) {
    const rows: Recipient[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const result = await getJson(transport, `${customer}/internal/v1/customer/stores/${actor.storeId}/customers?${query}`,
        headers(config.customerToken, actor));
      if (!result || result.status !== 200 || !isRecord(result.body) || !Array.isArray(result.body.items)) return null;
      for (const item of result.body.items) {
        const row = recipient(item);
        if (row) rows.push(row);
      }
      cursor = typeof result.body.nextCursor === 'string' ? result.body.nextCursor : null;
      if (!cursor) return rows;
    }
    return null;
  }
  return {
    async recipients(actor, customerIds) {
      const members = await allMembers(actor);
      if (!members) return null;
      const wanted = new Set(customerIds);
      return new Map(members.filter(row => wanted.has(row.customerId)).map(row => [row.customerId, row]));
    },
    regulars: allMembers,
    async expiryLot(actor, itemId, batchId) {
      const base = `${inventory}/internal/v1/inventory/stores/${actor.storeId}`;
      const item = await getJson(transport, `${base}/items/${itemId}`, headers(config.inventoryToken, actor));
      if (!item) return null;
      if (item.status === 404 || !isRecord(item.body)) return 'missing';
      const lots = await getJson(transport, `${base}/stock-batches?itemId=${itemId}&limit=200`, headers(config.inventoryToken, actor));
      if (!lots || lots.status !== 200 || !isRecord(lots.body) || !Array.isArray(lots.body.items)) return null;
      const open = lots.body.items.filter((lot): lot is Record<string, unknown> => isRecord(lot) && lot.discardedAt == null
        && typeof lot.expiresOn === 'string' && (integerString(lot.remainingQuantityBase) ?? 0) > 0
        && (batchId === null || lot.batchId === batchId));
      open.sort((a, b) => String(a.expiresOn).localeCompare(String(b.expiresOn)));
      const lot = open[0];
      if (!lot) return 'missing';
      return { itemId, batchId: isUuid(lot.batchId) ? lot.batchId.toLowerCase() : null, name: String(item.body.name ?? ''),
        expiresOn: String(lot.expiresOn), remainingBase: integerString(lot.remainingQuantityBase) ?? 0, unit: String(item.body.unit ?? '') };
    },
    async menuForItem(actor, itemId, menuId) {
      const base = `${inventory}/internal/v1/inventory/stores/${actor.storeId}`;
      const parse = (row: unknown): MenuBasis | null => {
        if (!isRecord(row) || !isUuid(row.menuId) || typeof row.price !== 'number' || typeof row.revision !== 'number') return null;
        const lines = Array.isArray(row.recipeLines) ? row.recipeLines.filter(isRecord) : [];
        return { menuId: row.menuId.toLowerCase(), name: String(row.name ?? ''), price: row.price,
          unitCost: typeof row.unitCost === 'number' ? row.unitCost : null, revision: row.revision,
          itemIds: lines.map(line => String(line.itemId).toLowerCase()) };
      };
      if (menuId) {
        const one = await getJson(transport, `${base}/menu/${menuId}`, headers(config.inventoryToken, actor));
        if (!one) return null;
        const row = one.status === 404 ? null : parse(one.body);
        return row && row.itemIds.includes(itemId) ? row : 'missing';
      }
      const menus: MenuBasis[] = [];
      let cursor: string | null = null;
      for (let page = 0; ; page += 1) {
        if (page === 10) return null;
        const query: string = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const list = await getJson(transport, `${base}/menu?${query}`, headers(config.inventoryToken, actor));
        if (!list || list.status !== 200 || !isRecord(list.body) || !Array.isArray(list.body.items)) return null;
        menus.push(...list.body.items.map(parse).filter((row): row is MenuBasis => !!row && row.itemIds.includes(itemId)));
        cursor = typeof list.body.nextCursor === 'string' ? list.body.nextCursor : null;
        if (!cursor) break;
      }
      // A retail item sold as itself has a single-line recipe; prefer it over drinks that merely use the item.
      return menus.find(row => row.itemIds.length === 1) ?? menus[0] ?? 'missing';
    },
  };
}

/* PN05 port: the structural subset of PN-A2 `createCouponPort` (backend/services/marketing/naver/pn05-coupons.ts). */
type Page<T> = { items: T[]; nextCursor: string | null };
type NaverCouponWrites = Pick<ReturnType<typeof createCouponPort>,
  'createPlaceCoupon' | 'deletePlaceCoupon' | 'setIssueUsage' | 'createOrderPromotion' | 'extendOrderPromotion' | 'endOrderPromotion'>;
export interface NaverCouponPort extends NaverCouponWrites {
  listPlaceCoupons(input?: { cursor?: string; signal?: AbortSignal }): Promise<Page<Record<string, unknown>>>;
  listCouponIssues(input: { couponRef: string; couponNumber?: string; cursor?: string; signal?: AbortSignal }): Promise<Page<Record<string, unknown>>>;
  listOrderPromotions(input?: { cursor?: string; signal?: AbortSignal }): Promise<Page<Record<string, unknown>>>;
  readMembership(signal?: AbortSignal): Promise<Record<string, unknown>>;
}
/** Resolve the store's port; `null` means PN05 is not bound for the store and the owner uses the official screen. */
export type NaverCouponPorts = (storeId: string) => NaverCouponPort | null;
