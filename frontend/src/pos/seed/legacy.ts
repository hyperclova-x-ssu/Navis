import fixture from './pos-day-2026-10-26.json';
import type { PosBill, PosBillAllocation, PosCatalog, PosDiscount, PosMethod, PosOptionGroup, PosOrder, PosRecipePart, PosState, PosUiState, PosUnitDimension } from '../../contracts/pos';
import { allocatePosAmount } from '../domain/money';
import { freezePos } from '../domain/common';

/** Baseline links/fallbacks remain available to the data adapter; checksum is never read. */
export const posSeedLinks = freezePos({ fallbacks: fixture.fallbacks, baselineBridge: fixture.baselineBridge, closingHistory: fixture.closingHistory });
const dimensions: Readonly<Record<string, PosUnitDimension>> = {
  'it-beans': 'g', 'it-milk': 'mL', 'it-cups': 'pcs', 'it-vanilla': 'mL', 'it-croissant': 'pcs', 'it-financier': 'pcs',
};
const preparation: Readonly<Record<string, number>> = {
  'm-americano': 3, 'm-latte': 4, 'm-vanilla': 4, 'm-croissant': 2,
  'm-financier': 1, 'm-beans200': 1, 'm-dripbag': 1,
};
const recipe = (parts: readonly { itemId: string; quantityBase: number }[]): readonly PosRecipePart[] => parts.map(p => {
  const unitDimension = dimensions[p.itemId];
  if (!unitDimension) throw new Error('INVALID_SEED_RECIPE');
  return { ...p, unitDimension };
});
export const createPosUi = (): PosUiState => ({ tab: 'order', approval: null, cartUndo: null });

/** Initial catalog helper. Production readData must adapt the live management catalog. */
export function createPosSeedCatalog(): PosCatalog {
  return freezePos({
    ingredients: Object.entries(dimensions).map(([itemId, unitDimension]) => ({ itemId, unitDimension })),
    items: fixture.menuCatalog.map(m => {
      const drink = ['m-americano', 'm-latte', 'm-vanilla'].includes(m.menuId);
      const retail = ['m-beans200', 'm-dripbag'].includes(m.menuId);
      const groups: PosOptionGroup[] = [];
      if (drink) {
        const groupId = `${m.menuId}:temperature`;
        groups.push({ groupId, menuId: m.menuId, name: '온도', required: true, options: ['hot', 'ice'].map(t => ({ optionId: `${groupId}:${t}`, groupId, name: t.toUpperCase(), extraPrice: 0, extraCost: 0, extraRecipe: [] })) });
        if (m.menuId !== 'm-americano') {
          const groupId = `${m.menuId}:size`;
          groups.push({ groupId, menuId: m.menuId, name: '사이즈', required: false, options: [{ optionId: `${groupId}:up`, groupId, name: '사이즈업', extraPrice: 500, extraCost: 350, extraRecipe: recipe([{ itemId: 'it-milk', quantityBase: 100 }]) }] });
        }
        const extraId = `${m.menuId}:extra`;
        groups.push({ groupId: extraId, menuId: m.menuId, name: '추가', required: false, options: [{ optionId: `${extraId}:shot`, groupId: extraId, name: '샷 추가', extraPrice: 500, extraCost: 300, extraRecipe: recipe([{ itemId: 'it-beans', quantityBase: 12 }]) }] });
      }
      return { menuId: m.menuId, name: m.name, category: drink ? 'drink' : retail ? 'retail' : 'dessert',
        kind: retail ? 'retail' as const : 'menu' as const,
        ...(retail ? { itemId: m.menuId === 'm-beans200' ? 'it-beans200' : 'it-dripbag' } : {}),
        price: m.unitPrice, prepMin: preparation[m.menuId] ?? 3, unitCost: m.unitCost, photoKey: null, saleStatus: 'selling' as const,
        shortageItems: ['m-latte', 'm-vanilla'].includes(m.menuId) ? ['it-milk'] : [], recipeBase: recipe(m.recipeBase), groups };
    }),
  });
}
export function createPosSeed(): PosState {
  const orders: PosOrder[] = fixture.orders.map(o => ({
    orderId: o.orderId, orderNo: o.orderNo, orderedAt: o.orderedAt, seq: o.orderNo,
    type: o.orderType === 'takeout' ? 'takeout' : 'dine_in', originBillId: o.billId, memo: o.memo,
    preparation: o.status === 'completed' ? 'completed' : o.status === 'preparing' ? 'preparing' : 'accepted',
    preparedAt: o.preparedAt, completedAt: o.completedAt, completedInRun: o.completedInRun,
    ...(o.reservationId ? { reservationId: o.reservationId } : {}),
    ...('partyId' in o && typeof o.partyId === 'string' ? { partyId: o.partyId } : {}),
    lines: o.lines.map(l => ({ orderLineId: l.lineId, menuId: l.menuId, nameAtOrder: l.nameAtSale, qty: l.qty,
      unitPriceAtOrder: l.unitPriceAtSale, request: l.request, canceledQty: 0,
      optionsAtOrder: l.options.map(p => ({ optionId: p.optionId, name: p.name, extraPrice: p.extraPriceAtSale, extraRecipe: recipe(p.extraRecipeBase) })) })),
  }));
  const billAllocations: PosBillAllocation[] = fixture.orders.flatMap(o => o.lines.map(l => ({ allocationId: `${o.billId}:${l.lineId}`, billId: o.billId, orderLineId: l.lineId, qty: l.qty })));
  const bills: PosBill[] = fixture.bills.map(b => {
    const order = fixture.orders.find(o => o.billId === b.billId)!;
    const discounts: PosDiscount[] = b.discounts.map((d, i) => ({ discountId: `${b.billId}:discount:${i + 1}`, billId: b.billId,
      source: d.kind === 'coupon' ? 'coupon' : d.kind === 'membership' ? 'membership' : 'direct',
      scope: d.scope === 'line' ? 'line' : 'bill', amount: d.amount,
      ...('percent' in d ? { percent: d.percent } : {}), ...('couponId' in d ? { couponId: d.couponId } : {}),
      ...('codeId' in d ? { codeId: d.codeId } : {}), ...('baselineIncluded' in d ? { baselineIncluded: d.baselineIncluded } : {}),
      ...('fallbackFrom' in d ? { fallbackFrom: d.fallbackFrom } : {}), ...('reason' in d ? { reason: d.reason } : {}),
    }));
    const remaining = Object.fromEntries(order.lines.map(l => [l.lineId, l.qty * l.unitPriceAtSale]));
    const allocations = discounts.map(d => {
      const amounts = allocatePosAmount(d.amount, order.lines.map(l => ({ id: l.lineId, amount: remaining[l.lineId] })));
      for (const l of order.lines) remaining[l.lineId] -= amounts[l.lineId];
      return { discountId: d.discountId, amounts };
    });
    return { billId: b.billId, originOrderNo: order.orderNo, tableId: order.tableId, status: 'paid',
      ...(b.memberId ? { memberId: b.memberId } : {}), ...(order.reservationId ? { reservationId: order.reservationId } : {}),
      settledAt: b.settledAt, recognizedAt: b.settledAt, discounts,
      settlementLines: order.lines.map(l => ({ allocationId: `${b.billId}:${l.lineId}`, menuId: l.menuId, qty: l.qty,
        basePriceAtSale: l.unitPriceAtSale - l.options.reduce((n, p) => n + p.extraPriceAtSale, 0),
        optionPriceAtSale: l.options.reduce((n, p) => n + p.extraPriceAtSale, 0),
        unitCostAtSale: l.unitCostAtSale, optionCostAtSale: 0, recognizedQty: l.qty,
        discountAllocations: allocations.map(a => ({ discountId: a.discountId, amount: a.amounts[l.lineId] })) })),
    };
  });
  const payments = fixture.payments.map(p => ({ paymentId: p.paymentId, billId: p.billId, at: p.at, seq: p.seq,
    transactionNo: p.transactionNo, approvalNo: p.approvalNo, amount: p.amount,
    splits: p.methodSplits.map(s => ({ method: s.method as PosMethod, amount: s.amount })), countedMethod: p.countedMethod as PosMethod,
    status: 'paid' as const, recognizedAt: p.at, seedIncluded: p.seedIncluded, fixedTag: p.fixedTag }));
  return freezePos({ businessDate: fixture.businessDate, revision: 0,
    seq: Math.max(0, ...fixture.payments.map(p => p.seq), ...fixture.refunds.map(p => p.seq)),
    cart: { cartId: 'cart:prepaid', revision: 0, type: 'dine_in', memo: '', lines: [], lock: null },
    orders, bills, billAllocations, payments,
    refunds: fixture.refunds.map(r => ({ refundId: r.refundId, paymentId: r.paymentId, billId: r.billId, at: r.at, seq: r.seq,
      amount: r.amount, methodAmounts: r.methodSplits.map(s => ({ method: s.method as PosMethod, amount: s.amount })),
      lineAmounts: r.lines, reason: r.reason, seedIncluded: r.seedIncluded })),
    cancellations: [], receipts: payments.map(p => ({ paymentId: p.paymentId, billId: p.billId })),
    cashReceipts: fixture.cashReceipts.map(r => ({ cashReceiptId: r.cashReceiptId, paymentId: r.paymentId,
      kind: r.kind === 'business' ? 'business' : 'income', maskedIdentifier: r.maskedIdentifier, cashAmount: r.amount,
      status: 'issued', issuedAt: r.at })),
    tableSessions: [], reservationPrompts: [], drawer: { ...fixture.cashDrawer, movements: [] }, commandLedger: [],
  });
}
