import { expect, it, vi } from 'vitest';
import * as menuFacts from './menu-facts.ts';

const scope = { storeId: 'store', actorId: 'owner' };
const menu = { name: '보늬밤 라떼', saleStatus: 'selling', price: 4900 };

it('uses the current unique selling menu as the price source and omits ambiguous or unavailable prices', async () => {
  const fake = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ items: [menu], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ items: [menu, { ...menu, price: 6000 }], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ items: [{ ...menu, saleStatus: 'sold_out' }], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ items: [menu], nextCursor: 'other-page' }));
  const read = menuFacts.createPromoMenuPriceRead('http://inventory:3000', 'fixture-token', fake);
  expect(await read(scope, menu.name)).toBe(4900);
  expect(await read(scope, menu.name)).toBeNull();
  expect(await read(scope, menu.name)).toBeNull();
  expect(await read(scope, menu.name)).toBeNull();
  expect(String(fake.mock.calls[0][0])).toBe('http://inventory:3000/internal/v1/inventory/stores/store/menu?limit=100');
  expect(new Headers(fake.mock.calls[0][1]?.headers).get('x-navis-user-id')).toBe('owner');
});

