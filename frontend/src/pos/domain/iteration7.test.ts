import { expect, it } from 'vitest';
import type { PosReadSnapshot } from '../../contracts/pos';
import { createPosSeed, createPosSeedCatalog, createPosUi } from '../seed';
import { getPaymentBillId, paymentBill } from '../loyalty/selectors';
import { quotePaymentBill } from '../loyalty/selectors';
import { buildSplitPlan } from '../loyalty/splits';
import * as domain from './index';
import { read as moneyRead, terms, withPass } from '../../data/iteration7/accounting/test-fixtures';
import { POS_NOW } from '../clock';

const americano = createPosSeedCatalog().items.find(menu => menu.menuId === 'm-americano')!;
const americanoOptions = (temperature: 'HOT' | 'ICE') =>
  americano.groups.flatMap(group => group.options.filter(option => [temperature, '레귤러'].includes(option.name)).map(option => option.optionId));


function posRead(): PosReadSnapshot {
  const pos = createPosSeed(), catalog = createPosSeedCatalog();
  const read: PosReadSnapshot = { runId: 'run', runRevision: 0, posRevision: 0, dataRevision: 0, scenario: 'normal', posUi: createPosUi(),
    settings: { businessType: 'cafe', paymentStyle: 'prepaid', tableLayout: null, revision: 0 },
    pos: { ...pos, cart: { ...pos.cart, lock: null, lines: [{ lineId: 'cart-line', menuId: 'm-americano', selectedOptionIds: americanoOptions('ICE'), qty: 1, request: '' }] } },
    data: { revision: 0, catalog, dayClosed: false, closingGeneration: 0 } };
  return read;
}
it('adapts the live POS quote with real menu quantities, stock recipes and only non-membership discounts', () => {
  const read = posRead(), source = domain.adaptPosSettlementSource(read, getPaymentBillId(read), POS_NOW);
  expect(source).toMatchObject({ purpose: 'sale', amountDue: 3000, canSubmit: true, lines: [{ menuId: 'm-americano', quantity: 1, unitPrice: 3000, category: 'drink', discountBySource: { direct: 0, coupon: 0, membership: 0 } }] });
  expect(source.lines[0].recipe).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: 'i-bean-house', quantityBase: 18 })]));
});
it('converts the selected legacy count benefit into 4000 value and 500 discount in the shared quote', () => {
  // This legacy count contract requires a retail price above the 4,000 won pass value.
  const base = posRead();
  const read = { ...base, data: { ...base.data, catalog: { ...base.data.catalog, items: base.data.catalog.items.map(menu => menu === americano ? { ...menu, price: 4500 } : menu) } } };
  const billId = getPaymentBillId(read), bill = paymentBill(read, billId)!;
  const linked = { ...read, pos: { ...read.pos, bills: [...read.pos.bills, { ...bill, memberId: 'M-0001', discounts: [{ discountId: 'pass-discount', billId, source: 'membership' as const, scope: 'line' as const, amount: 4500, allocationId: 'cart-line', membershipId: 'pass', useId: 'original-use' }] }] },
    data: { ...read.data, loyalty: { members: [{ memberId: 'M-0001', customerId: 'customer', name: 'Member', phone: '010-****-0001', grade: 'regular' as const, recentVisits: 1 }], coupons: [],
      passes: [{ membershipId: 'pass', memberId: 'M-0001', nameKey: 'pass', kind: 'americano' as const, startsOn: '2026-10-01', endsOn: '2026-12-29', active: true, usesLeft: 10, dailyLimit: null, usedToday: 0 }] } } };
  const quote = domain.quotePosSettlement(withPass(moneyRead(), terms()), linked, { billId, allocations: [] });
  expect(quote).toMatchObject({ amountDue: 4000, remaining: 0, realMethodSplits: [], canSubmit: true, discounts: [{ amount: 500 }], allocations: [{ kind: 'membership_count', amount: 4000 }] });
});
it('preserves unequal item-split quantities when adapting the source parts', () => {
  const r = posRead(), read = { ...r, pos: { ...r.pos, cart: { ...r.pos.cart, lines: r.pos.cart.lines.map(l => ({ ...l, qty: 3 })) } } };
  const billId = getPaymentBillId(read), quote = quotePaymentBill(read, billId, POS_NOW);
  const p = buildSplitPlan(quote, { kind: 'items', parts: [{ lineQtyAllocations: [{ allocationId: 'cart-line', qty: 1 }] }, { lineQtyAllocations: [{ allocationId: 'cart-line', qty: 2 }] }] });
  if (!p.ok) throw new Error(p.reason);
  const bill = { ...paymentBill(read, billId)!, splitPlan: p.plan };
  const linked = { ...read, pos: { ...read.pos, bills: [...read.pos.bills, bill] } };
  expect(domain.adaptPosSettlementSource(linked, billId, POS_NOW).parts?.map(s => s.amount)).toEqual([3000, 6000]);
});
