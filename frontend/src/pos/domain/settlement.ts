import type { PosBill, PosDiscountAllocation, PosState } from '../../contracts/pos';
import { allocatePosAmount, distributePosAmount } from './money';

/** Original shares include canceled payments. Corrections must never redistribute another share. */
export function paymentSettlementShares(pos: PosState, bill: PosBill) {
  const payments = pos.payments.filter(p => p.billId === bill.billId && p.recognizedAt);
  // Zero-won bills recognize sales, cost and usage without creating a payment share.
  if (payments.length === 0) return [];
  const weights = payments.map(p => ({ id: p.paymentId, amount: p.amount }));
  const remaining = new Map(bill.settlementLines.map(l => [l.allocationId, (l.basePriceAtSale + l.optionPriceAtSale) * l.recognizedQty - l.discountAllocations.reduce((n, d) => n + d.amount, 0)]));
  const nets = new Map<string, Readonly<Record<string, number>>>();
  for (const payment of payments) {
    const part = bill.splitPlan?.parts.find(p => p.partId === payment.partId);
    const net = part?.lineQtyAllocations ? Object.fromEntries(bill.settlementLines.map(line => {
      const partWeights = bill.splitPlan!.parts.map(p => ({ id: p.partId, amount: p.lineQtyAllocations?.find(a => a.allocationId === line.allocationId)?.qty ?? 0 }));
      const amount = (line.basePriceAtSale + line.optionPriceAtSale) * line.recognizedQty - line.discountAllocations.reduce((n, d) => n + d.amount, 0);
      return [line.allocationId, distributePosAmount(amount, partWeights)[part.partId]];
    })) : allocatePosAmount(payment.amount, [...remaining].map(([id, amount]) => ({ id, amount })));
    nets.set(payment.paymentId, net);
    for (const [id, amount] of Object.entries(net)) remaining.set(id, remaining.get(id)! - amount);
  }
  return bill.settlementLines.flatMap(line => {
    const netWeights = payments.map(p => ({ id: p.paymentId, amount: nets.get(p.paymentId)![line.allocationId] ?? 0 }));
    const allocationWeights = netWeights.some(w => w.amount) ? netWeights : weights;
    const quantities = distributePosAmount(line.recognizedQty, allocationWeights);
    const discounts = line.discountAllocations.map(d => ({ discountId: d.discountId, amounts: distributePosAmount(d.amount, allocationWeights) }));
    const orderLineId = pos.billAllocations.find(a => a.allocationId === line.allocationId)!.orderLineId;
    return payments.map(payment => {
      const part = bill.splitPlan?.parts.find(p => p.partId === payment.partId);
      const qty = part?.lineQtyAllocations?.find(a => a.allocationId === line.allocationId)?.qty ?? (part?.lineQtyAllocations ? 0 : quantities[payment.paymentId]);
      const discountAllocations = discounts.map(d => ({ discountId: d.discountId, amount: d.amounts[payment.paymentId] }));
      const discount = discountAllocations.reduce((n, d) => n + d.amount, 0), net = nets.get(payment.paymentId)![line.allocationId];
      return { paymentId: payment.paymentId, allocationId: line.allocationId, orderLineId, menuId: line.menuId, qty, gross: net + discount, discount, net,
        discountAllocations, unitPrice: line.basePriceAtSale + line.optionPriceAtSale,
        unitCost: line.unitCostAtSale === null || line.optionCostAtSale === null ? null : line.unitCostAtSale + line.optionCostAtSale };
    });
  });
}

export function canceledSettlement(pos: PosState, billId: string, allocationId: string, paymentId?: string) {
  const orderLineId = pos.billAllocations.find(a => a.allocationId === allocationId)?.orderLineId;
  const rows = pos.cancellations.filter(c => c.billId === billId && (!paymentId || c.paymentId === paymentId)).flatMap(c => c.allocations)
    .filter(a => a.allocationId ? a.allocationId === allocationId : a.lineId === orderLineId);
  const discounts = new Map<string, number>();
  for (const row of rows) for (const d of row.discountAllocations ?? []) discounts.set(d.discountId, (discounts.get(d.discountId) ?? 0) + d.amount);
  return { qty: rows.reduce((n, r) => n + r.qty, 0), gross: rows.reduce((n, r) => n + r.gross, 0), discount: rows.reduce((n, r) => n + r.discount, 0),
    cost: rows.reduce((n, r) => n + (r.cost ?? 0), 0), discountAllocations: [...discounts].map(([discountId, amount]): PosDiscountAllocation => ({ discountId, amount })) };
}
