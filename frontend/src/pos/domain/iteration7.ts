import type { PosReadSnapshot } from '../../contracts/pos';
import type { MoneyRead, MoneySource, SettlementAllocation } from '../../data/iteration7/accounting/types';
import { quoteSettlement } from '../../data/iteration7/accounting/settlement';
import { quoteMembershipUse } from '../../data/iteration7/memberships';
import { paymentBill, quotePaymentBill } from '../loyalty/selectors';
import { distributePosAmount } from './money';

/** Keeps catalog/stock validation in the existing POS quote; pass value belongs to M3 settlement. */
export function adaptPosSettlementSource(read: PosReadSnapshot, billId: string, now: string): MoneySource {
  const quote = quotePaymentBill(read, billId, now), bill = paymentBill(read, billId);
  const lines = quote.lines.map(l => {
    const row = quote.settlementLines.find(s => s.allocationId === l.lineId);
    const discountBySource = { direct: 0, coupon: 0, membership: 0 };
    for (const a of row?.discountAllocations ?? []) {
      const discount = quote.discounts.find(d => d.discountId === a.discountId);
      if (discount?.source === 'direct' || discount?.source === 'coupon') discountBySource[discount.source] += a.amount;
    }
    const item = read.data.catalog.items.find(m => m.menuId === l.menuId);
    const recipes = new Map<string, number>();
    for (const r of [...(item?.recipeBase ?? []), ...l.options.flatMap(o => o.extraRecipe)]) recipes.set(r.itemId, (recipes.get(r.itemId) ?? 0) + r.quantityBase);
    return { allocationId: l.lineId, orderLineId: read.pos.billAllocations.find(a => a.allocationId === l.lineId)?.orderLineId ?? l.lineId,
      menuId: l.menuId, name: l.name, prepared: read.pos.orders.some(o => o.lines.some(line => line.orderLineId === read.pos.billAllocations.find(a => a.allocationId === l.lineId)?.orderLineId) && o.preparation !== 'accepted'), category: item?.category, quantity: l.qty, unitPrice: l.unitPrice, unitCost: l.baseCost === null || l.optionCost === null ? null : l.baseCost + l.optionCost,
      discountBySource, recipe: [...recipes].map(([itemId, quantityBase]) => ({ itemId, quantityBase })) };
  });
  const amountDue = lines.reduce((n, l) => n + l.unitPrice * l.quantity - l.discountBySource.direct - l.discountBySource.coupon, 0);
  const parts = quote.parts.length ? quote.parts.map(p => ({ partId: p.partId, amount: 0, ...(p.lineQtyAllocations ? { allocationIds: p.lineQtyAllocations.map(a => a.allocationId) } : {}) })) : undefined;
  if (parts && bill?.splitPlan?.kind === 'items') {
    for (const l of lines) {
      const values = distributePosAmount(l.unitPrice * l.quantity - l.discountBySource.direct - l.discountBySource.coupon,
        quote.parts.map(p => ({ id: p.partId, amount: p.lineQtyAllocations?.find(a => a.allocationId === l.allocationId)?.qty ?? 0 })));
      for (const p of parts) p.amount += values[p.partId];
    }
  } else if (parts) {
    const each = Math.floor(amountDue / parts.length);
    for (let i = 0; i < parts.length; i++) parts[i].amount = each + (i === parts.length - 1 ? amountDue % parts.length : 0);
  }
  return { sourceRef: { kind: 'bill', id: billId }, purpose: 'sale', billId, cartId: bill?.cartId, memberId: quote.memberId ?? null, amountDue, fingerprint: quote.fingerprint,
    lines, orderIds: quote.orderIds, parts, canSubmit: quote.canSubmit,
    issues: quote.issues.map(i => ({ ok: false, code: 'VALIDATION', reason: i.reason, messageKey: i.messageKey, details: i.details })),
    wholeBillDiscount: bill?.discounts.some(d => d.scope === 'bill'), prepared: read.pos.orders.some(o => quote.orderIds.includes(o.orderId) && o.preparation !== 'accepted') };
}

/** Optional convenience for the controlled checkout port; it does not publish either store. */
export function quotePosSettlement(read: MoneyRead, posRead: PosReadSnapshot, input: { readonly billId: string; readonly partId?: string; readonly allocations: readonly SettlementAllocation[] }) {
  const source = adaptPosSettlementSource(posRead, input.billId, read.now), quote = quotePaymentBill(posRead, input.billId, read.now);
  const frozen = read.sources.find(s => s.billId === input.billId)?.membershipContributions;
  const adapted = { ...source, ...(frozen ? { membershipContributions: frozen } : {}) };
  const allocations = [...input.allocations];
  for (const d of quote.discounts.filter(d => d.source === 'membership' && d.membershipId)) {
    if (allocations.some(a => a.membershipId === d.membershipId)) continue;
    const lineId = d.allocationId ?? d.targetAllocationIds?.[0] ?? d.fixedAllocations?.[0]?.allocationId;
    const pass = read.state.memberships.find(m => m.membershipId === d.membershipId);
    if (!lineId || !pass) continue;
    const use = quoteMembershipUse(read, { membershipId: pass.membershipId, source: adapted, allocationId: lineId, quantity: 1, useId: d.useId });
    allocations.push({ kind: pass.kind === 'count' ? 'membership_count' : 'membership_period', amount: use.recognizedAmount,
      membershipId: pass.membershipId, billAllocationId: lineId, quantity: 1, useId: use.useId });
  }
  return quoteSettlement({ ...read, sources: [adapted, ...read.sources.filter(s => s.billId !== input.billId)] }, { target: { purpose: 'sale', billId: input.billId, ...(input.partId ? { partId: input.partId } : {}) }, allocations });
}

