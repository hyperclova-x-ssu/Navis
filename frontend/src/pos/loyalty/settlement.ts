import type { PosApprovalInput, PosBill, PosCommandMeta, PosLoyaltyQuote, PosOrder, PosPayment, PosReadSnapshot, PosUiState } from '../../contracts/pos';
import { makePlan } from '../domain/common';
import { nextOrderNumber } from '../tables/commands';

export function settlePaymentBill(read: PosReadSnapshot, bill: PosBill, quote: PosLoyaltyQuote, now: string,
  meta: PosCommandMeta, type: string, payload: unknown, payment?: PosPayment, nextUi: PosUiState = read.posUi) {
  const payments = [...read.pos.payments, ...(payment ? [payment] : [])];
  const received = payments.filter(p => p.billId === bill.billId && p.status === 'paid').reduce((n, p) => n + p.amount, 0);
  const settled = received === quote.payable;
  let orders = read.pos.orders, allocations = read.pos.billAllocations;
  let orderIds = quote.orderIds, settlementLines = quote.settlementLines, nextBill = bill;
  if (settled && bill.cartId) {
    const orderNo = nextOrderNumber(read.pos), orderId = `O-${String(orderNo).padStart(3, '0')}`;
    const lineIds = new Map(quote.lines.map((l, i) => [l.lineId, `${bill.billId}:${orderId}:L-${i + 1}`]));
    const order: PosOrder = { orderId, orderNo, originBillId: bill.billId, orderedAt: now, seq: read.pos.seq + 1, type: read.pos.cart.type,
      memo: read.pos.cart.memo, preparation: 'accepted', preparedAt: null, completedAt: null, completedInRun: false,
      lines: quote.lines.map((l, i) => ({ orderLineId: `${orderId}:L-${i + 1}`, menuId: l.menuId, nameAtOrder: l.name, qty: l.qty, unitPriceAtOrder: l.unitPrice,
        optionsAtOrder: l.options.map(o => ({ optionId: o.optionId, name: o.name, extraPrice: o.extraPrice, extraRecipe: o.extraRecipe })), request: l.request, canceledQty: 0 })) };
    orders = [...orders, order]; orderIds = [orderId];
    allocations = [...allocations, ...order.lines.map((l, i) => ({ billId: bill.billId, allocationId: lineIds.get(quote.lines[i].lineId)!, orderLineId: l.orderLineId, qty: l.qty }))];
    settlementLines = quote.settlementLines.map(l => ({ ...l, allocationId: lineIds.get(l.allocationId)! }));
    nextBill = { ...bill, originOrderNo: orderNo, discounts: quote.discounts.map(d => ({ ...d,
      ...(d.allocationId ? { allocationId: lineIds.get(d.allocationId)! } : {}), ...(d.targetAllocationIds ? { targetAllocationIds: d.targetAllocationIds.map(id => lineIds.get(id)!) } : {}) })),
      ...(bill.splitPlan ? { splitPlan: { ...bill.splitPlan, settlementLines, lines: quote.lines.map(l => ({ ...l, lineId: lineIds.get(l.lineId)! })),
        parts: bill.splitPlan.parts.map(p => ({ ...p, ...(p.lineQtyAllocations ? { lineQtyAllocations: p.lineQtyAllocations.map(a => ({ ...a, allocationId: lineIds.get(a.allocationId)! })) } : {}) })) } } : {}) };
  }
  const parts = nextBill.splitPlan?.parts.map(p => payment?.partId === p.partId ? { ...p, status: 'paid' as const } : p);
  nextBill = { ...nextBill, status: settled ? 'paid' : 'partial', discounts: settled && bill.cartId ? nextBill.discounts : quote.discounts,
    settlementLines: settled ? settlementLines : [], ...(settled ? { settledAt: now, recognizedAt: now } : {}),
    ...(nextBill.splitPlan ? { splitPlan: { ...nextBill.splitPlan, parts: parts! } } : {}) };
  const cart = bill.cartId ? settled ? { cartId: read.pos.cart.cartId, revision: read.pos.cart.revision + 1, type: read.pos.cart.type, memo: '', lines: [], lock: null }
    : { ...read.pos.cart, lock: bill.billId, revision: read.pos.cart.revision + 1 } : read.pos.cart;
  const nextPos = { ...read.pos, revision: read.posRevision + 1, seq: read.pos.seq + 1, cart, orders, billAllocations: allocations,
    bills: [...read.pos.bills.filter(b => b.billId !== bill.billId), nextBill],
    payments: settled ? payments.map(p => p.billId === bill.billId && p.status === 'paid' ? { ...p, recognizedAt: now } : p) : payments,
    receipts: payment ? [...read.pos.receipts, { paymentId: payment.paymentId, billId: bill.billId }] : read.pos.receipts,
    tableSessions: settled && bill.tableId ? [...read.pos.tableSessions.filter(s => s.tableId !== bill.tableId), { tableId: bill.tableId, billId: bill.billId, cleaning: true }] : read.pos.tableSessions };
  return makePlan(read, nextPos, { ...nextUi, cartUndo: null, tablesUndo: null },
    { ...(payment ? { paymentId: payment.paymentId } : {}), billId: bill.billId, orderIds, remaining: quote.payable - received, settled }, meta, type, payload);
}
export const approvalPayload = (input: PosApprovalInput) => {
  const { meta: _meta, ...payload } = input;
  return payload;
};
