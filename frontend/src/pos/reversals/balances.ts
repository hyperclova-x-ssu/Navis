import type { PosState } from '../../contracts/pos';
import { allocatePosAmount } from '../domain/money';
import { canceledSettlement, paymentSettlementShares } from '../domain/settlement';

export function selectPaymentRemaining(pos: PosState, paymentId: string) {
  const payment = pos.payments.find(p => p.paymentId === paymentId);
  if (!payment) return null;
  const corrections = [...pos.cancellations, ...pos.refunds].filter(c => c.paymentId === paymentId);
  const methods = payment.splits.map(s => ({ method: s.method, amount: s.amount - corrections.reduce((n, c) => n + c.methodAmounts.filter(m => m.method === s.method).reduce((n, m) => n + m.amount, 0), 0) }));
  return { paymentId, remaining: methods.reduce((n, s) => n + s.amount, 0), methods };
}

/** Refund amounts use each original payment's line balance, including every earlier amount-only refund. */
export function paymentLineBalances(pos: PosState, paymentId: string) {
  const payment = pos.payments.find(p => p.paymentId === paymentId), bill = pos.bills.find(b => b.billId === payment?.billId);
  if (!bill || !payment) return [];
  const rows = paymentSettlementShares(pos, bill).filter(s => s.paymentId === paymentId).map(s => {
    const canceled = canceledSettlement(pos, bill.billId, s.allocationId, paymentId);
    return { ...s, qty: s.qty - canceled.qty, gross: s.gross - canceled.gross, discount: s.discount - canceled.discount,
      net: s.net - canceled.gross + canceled.discount, refundedQty: 0,
      discountAllocations: s.discountAllocations.map(d => ({ ...d, amount: d.amount - (canceled.discountAllocations.find(a => a.discountId === d.discountId)?.amount ?? 0) })) };
  });
  for (const refund of pos.refunds.filter(r => r.paymentId === paymentId).sort((a, b) => a.seq - b.seq)) {
    const amounts = refund.lineAmounts.length ? Object.fromEntries(refund.lineAmounts.map(l => [l.orderLineId, l.amount]))
      : allocatePosAmount(refund.amount, rows.map(l => ({ id: l.orderLineId, amount: l.net })));
    for (const row of rows) { row.net -= amounts[row.orderLineId] ?? 0; row.refundedQty += refund.lineAmounts.find(l => l.orderLineId === row.orderLineId)?.qty ?? 0; }
  }
  return rows;
}
