import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createHttpCouponSources, createPosBillReader } from './clients.ts';

const store = randomUUID();
const actor = { storeId: store, actorId: randomUUID(), timezone: 'Asia/Seoul', dayStart: '05:00:00' };

function transport(routes: Record<string, unknown>, calls: { url: string; headers: Record<string, string> }[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const path = new URL(url).pathname + new URL(url).search;
    const body = routes[path];
    return body === undefined ? new Response('{}', { status: 404 }) : Response.json(body);
  }) as typeof fetch;
}

it('reads consent, lots and menus as the acting owner with the store clock, paging through members and menus', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const member = (id: string, marketingAllowed: boolean) => ({ customerId: id, consent: { contactAllowed: true, marketingAllowed },
    visitCount: 3, recentVisitCount: 2, lastVisitAt: null });
  const [a, b] = [randomUUID(), randomUUID()];
  const item = randomUUID();
  const [drink, retail] = [randomUUID(), randomUUID()];
  const root = `/internal/v1/customer/stores/${store}`;
  const inv = `/internal/v1/inventory/stores/${store}`;
  const sources = createHttpCouponSources({ customerUrl: 'http://customer:3000', customerToken: 'c-token',
    inventoryUrl: 'http://inventory:3000', inventoryToken: 'i-token' }, transport({
    [`${root}/customers?limit=200`]: { items: [member(a, true)], nextCursor: a },
    [`${root}/customers?limit=200&cursor=${a}`]: { items: [member(b, false)], nextCursor: null },
    [`${inv}/items/${item}`]: { itemId: item, name: '크루아상', unit: 'pcs' },
    [`${inv}/stock-batches?itemId=${item}&limit=200`]: { items: [
      { batchId: randomUUID(), remainingQuantityBase: '0', expiresOn: '2026-11-17', discardedAt: null },
      { batchId: 'later', remainingQuantityBase: '4', expiresOn: '2026-11-18', discardedAt: null },
      { batchId: 'today', remainingQuantityBase: '6', expiresOn: '2026-11-17', discardedAt: null },
    ] },
    [`${inv}/menu?limit=100`]: { items: [{ menuId: drink, name: '라떼', price: 4500, unitCost: 900, revision: 1,
      recipeLines: [{ itemId: item }, { itemId: randomUUID() }] }], nextCursor: drink },
    [`${inv}/menu?limit=100&cursor=${drink}`]: { items: [{ menuId: retail, name: '크루아상', price: 3500, unitCost: 1200, revision: 2,
      recipeLines: [{ itemId: item }] }], nextCursor: null },
  }, calls));
  const found = await sources.recipients(actor, [a, b, randomUUID()]);
  expect([...found!.values()].map(row => [row.customerId, row.marketingAllowed])).toEqual([[a, true], [b, false]]);
  expect(await sources.expiryLot(actor, item, null)).toMatchObject({ batchId: null, expiresOn: '2026-11-17', remainingBase: 6, unit: 'pcs' });
  expect(await sources.menuForItem(actor, item, null)).toMatchObject({ menuId: retail, price: 3500, unitCost: 1200 });
  expect(await sources.expiryLot(actor, randomUUID(), null)).toBe('missing');
  expect(calls[0].headers).toEqual({ authorization: 'Bearer c-token', 'x-navis-store-id': store, 'x-navis-user-id': actor.actorId,
    'x-navis-store-role': 'owner', 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00:00' });
});

it('parses the POS bill and closes on an unreachable POS', async () => {
  const billId = randomUUID();
  const settlementId = randomUUID();
  const orderId = randomUUID();
  const reader = createPosBillReader('http://pos:3000', 'p-token', transport({
    [`/internal/v1/pos/stores/${store}/bills/${billId}`]: { billId, status: 'paid', settlementId, orderIds: [orderId], quote: { discount: 1400,
      lines: [{ allocationId: 'a1', menuId: 'M', gross: 3500, basePrice: 3500, options: [{ optionId: 'o', extraPrice: 500, extraCost: 1 }] }] } },
  }, []));
  expect(await reader.bill(actor, billId)).toEqual({ billId, status: 'paid', discount: 1400, settlementId, orderId,
    lines: [{ lineId: 'a1', menuId: 'm', gross: 3500, basePrice: 3500, options: [{ optionId: 'o', extraPrice: 500 }] }] });
  expect(await reader.bill(actor, randomUUID())).toBe('missing');
  const down = createPosBillReader('http://pos:3000', 'p-token', (async () => { throw new Error('down'); }) as typeof fetch);
  expect(await down.bill(actor, billId)).toBeNull();
  expect(() => createPosBillReader('http://user:pw@pos:3000', 't')).toThrow();
});
