import type { PosMethod, PosOrder, PosState } from '../../contracts/pos';
import { selectPosDayTotals } from '../../pos/domain/money';
import { canceledSettlement } from '../../pos/domain/settlement';
import { fixtureOccurred } from './fixture-dates';
import type { seedToday } from './generated/today';

const visible = (at: string | null | undefined): at is string => Boolean(at && fixtureOccurred(at));

/** The generated café seed allocates lines when their bill settles. */
export function cafePosAsOf(pos: PosState): PosState {
  const elapsedOrders = pos.orders.filter(order => visible(order.orderedAt));
  const orderIds = new Set(elapsedOrders.map(order => order.orderId));
  const billIds = new Set(elapsedOrders.map(order => order.originBillId));
  const elapsedPayments = pos.payments.filter(row => billIds.has(row.billId) && visible(row.at));
  const paymentIds = new Set(elapsedPayments.map(row => row.paymentId));
  const refunds = pos.refunds.filter(row => paymentIds.has(row.paymentId) && visible(row.at));
  const cancellations = pos.cancellations.filter(row => paymentIds.has(row.paymentId) && visible(row.at));
  const canceledPayments = new Set(cancellations.map(row => row.paymentId));
  const canceledBills = new Set(cancellations.map(row => row.billId));
  const canceledQty = new Map<string, number>();
  for (const correction of cancellations) for (const line of correction.allocations) {
    canceledQty.set(line.lineId, (canceledQty.get(line.lineId) ?? 0) + line.qty);
  }
  const payments = elapsedPayments.map(row => ({
    ...row, status: canceledPayments.has(row.paymentId) ? 'canceled' as const : 'paid' as const,
    recognizedAt: visible(row.recognizedAt) ? row.recognizedAt : null,
  }));
  const partiallyPaidBills = new Set(payments.map(row => row.billId));
  const bills = pos.bills.filter(row => billIds.has(row.billId)).map(row => {
    if (visible(row.recognizedAt)) return row;
    // Omit the two fields so an open bill has the same shape as the generated open bill.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { recognizedAt: _recognized, settledAt: _settled, ...rest } = row;
    return { ...rest, status: partiallyPaidBills.has(row.billId) ? 'partial' as const : 'open' as const, discounts: [], settlementLines: [] };
  });
  const settledBills = new Set(bills.filter(row => row.recognizedAt).map(row => row.billId));
  const orders = elapsedOrders.map((row): PosOrder => {
    const preparedAt = visible(row.preparedAt) ? row.preparedAt : null;
    const completedAt = visible(row.completedAt) ? row.completedAt : null;
    const preparation = canceledBills.has(row.originBillId) ? 'canceled' : completedAt ? 'completed' : preparedAt ? 'preparing' : 'accepted';
    return { ...row, preparedAt, completedAt, preparation, lines: row.lines.map(line => ({ ...line, canceledQty: canceledQty.get(line.orderLineId) ?? 0 })) };
  });
  const seq = Math.max(0, ...[...orders, ...payments, ...refunds, ...cancellations].map(row => row.seq));
  return {
    ...pos, seq, orders, bills, payments, refunds, cancellations,
    billAllocations: pos.billAllocations.filter(row => settledBills.has(row.billId)),
    receipts: pos.receipts.filter(row => paymentIds.has(row.paymentId)),
    cashReceipts: pos.cashReceipts.filter(row => paymentIds.has(row.paymentId) && visible(row.issuedAt)),
    reservationPrompts: pos.reservationPrompts.filter(row => orderIds.has(row.firstOrderId)),
  };
}

type MenuAmounts = [qty: number, gross: number, discount: number, refund: number, cost: number];
type CouponAmounts = [count: number, discount: number, net: number, cost: number];
type MethodAmounts = Record<PosMethod, number>;

function returnedByMethod(rows: PosState['refunds'] | PosState['cancellations']): MethodAmounts {
  const amounts = { card: 0, easy_pay: 0, cash: 0 };
  for (const row of rows) for (const part of row.methodAmounts) amounts[part.method] += part.amount;
  return amounts;
}

/** Seed readers that run before POS is attached need the same elapsed sales and order counts. */
export function cafeRollupAsOf(pos: PosState, expenses: number): typeof seedToday.rollup {
  const totals = selectPosDayTotals(pos);
  const hourly = Array<number>(24).fill(0);
  for (const order of pos.orders) hourly[Number(order.orderedAt.slice(11, 13))]++;

  const menu = new Map<string, MenuAmounts>();
  const coupons = new Map<string, CouponAmounts>();
  const orderLineByAllocation = new Map(pos.billAllocations.map(row => [row.allocationId, row.orderLineId]));
  const refundByLine = new Map<string, number>();
  for (const refund of pos.refunds) for (const line of refund.lineAmounts) {
    refundByLine.set(line.orderLineId, (refundByLine.get(line.orderLineId) ?? 0) + line.amount);
  }
  let cost = 0;
  for (const bill of pos.bills) {
    let billDiscount = 0, billNet = 0, billCost = 0;
    for (const line of bill.settlementLines) {
      const canceled = canceledSettlement(pos, bill.billId, line.allocationId);
      const qty = line.recognizedQty - canceled.qty;
      const gross = (line.basePriceAtSale + line.optionPriceAtSale) * line.recognizedQty - canceled.gross;
      const discount = line.discountAllocations.reduce((sum, share) => sum + share.amount, 0) - canceled.discount;
      const refund = refundByLine.get(orderLineByAllocation.get(line.allocationId) ?? '') ?? 0;
      const lineCost = ((line.unitCostAtSale ?? 0) + (line.optionCostAtSale ?? 0)) * line.recognizedQty - canceled.cost;
      const amounts = menu.get(line.menuId) ?? [0, 0, 0, 0, 0];
      menu.set(line.menuId, [amounts[0] + qty, amounts[1] + gross, amounts[2] + discount, amounts[3] + refund, amounts[4] + lineCost]);
      billDiscount += discount;
      billNet += gross - discount - refund;
      billCost += lineCost;
    }
    cost += billCost;
    if (pos.cancellations.some(row => row.billId === bill.billId)) continue;
    for (const { codeId } of bill.discounts) if (codeId) {
      const [count, discount, net, cost] = coupons.get(codeId) ?? [0, 0, 0, 0];
      coupons.set(codeId, [count + 1, discount + billDiscount, net + billNet, cost + billCost]);
    }
  }
  return {
    date: pos.businessDate, orders: pos.orders.length, hourly,
    gross: totals.gross, discount: totals.discount, refund: totals.refund, canceled: totals.canceled, cost, net: totals.revenue, expenses,
    byMethod: totals.byMethod, methodCounts: totals.methodCounts, discountBySource: totals.discountBySource,
    paymentCount: pos.payments.length, refundCount: pos.refunds.length, cancelCount: pos.cancellations.length,
    refundByMethod: returnedByMethod(pos.refunds), cancelByMethod: returnedByMethod(pos.cancellations),
    menu: [...menu].sort().map(([menuId, amounts]) => [menuId, ...amounts]),
    coupons: [...coupons].sort().map(([codeId, amounts]) => [codeId, ...amounts]),
    expectedDrawer: pos.drawer.opening + totals.byMethod.cash,
  };
}
