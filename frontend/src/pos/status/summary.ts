import type { PosBill, PosCatalog, PosOrder, PosReadSnapshot, PosState } from '../../contracts/pos';
import { menuText, orderItems, selectOrderSummary as summarizeOrders } from '../../orders';
import { businessNow } from '../clock';
import { selectPosDayTotals } from '../domain/money';
import { orderInputs, orderRuntime } from './inputs';
import type { OrderPaymentStatus, OrderStatusRow, OrderSummaryOptions, PosOrderSummary } from './types';

function paymentStatus(pos: PosState, bills: readonly PosBill[]): OrderPaymentStatus {
  if (!bills.length) return 'unpaid';
  const ids = new Set(bills.map(bill => bill.billId));
  // Abandoned partial shares returned money before any sale was recognized.
  const payments = pos.payments.filter(payment => ids.has(payment.billId)
    && (payment.status !== 'canceled' || payment.recognizedAt !== null));
  const cancellations = pos.cancellations.filter(row => ids.has(row.billId));
  const activePaid = payments.filter(payment => payment.status === 'paid').reduce((sum, payment) => sum + payment.amount, 0);
  const activePaymentIds = new Set(payments.filter(payment => payment.status === 'paid').map(payment => payment.paymentId));
  const canceledAmount = cancellations.filter(row => activePaymentIds.has(row.paymentId)).reduce((sum, row) => sum + row.amount, 0);
  if (bills.every(bill => bill.status === 'void') || payments.length > 0 && payments.every(payment => payment.status === 'canceled')) return 'canceled';
  if (bills.some(bill => bill.status === 'partial') || bills.some(bill => bill.status === 'paid') && bills.some(bill => bill.status === 'open')) return 'partial';
  const refunded = pos.refunds.filter(row => ids.has(row.billId)).reduce((sum, row) => sum + row.amount, 0);
  if (refunded > 0) return refunded >= activePaid - canceledAmount ? 'refunded' : 'partially_refunded';
  if (canceledAmount > 0 || payments.some(payment => payment.status === 'canceled') || bills.some(bill => bill.status === 'void')) return 'partially_canceled';
  return bills.every(bill => bill.status === 'paid') ? 'paid' : 'unpaid';
}

function compute(read: PosReadSnapshot, options: OrderSummaryOptions): PosOrderSummary {
  const empty = read.scenario === 'empty';
  const orders = empty ? [] : read.pos.orders;
  const input = orderInputs(orders, read.data.catalog, options.businessNow ?? businessNow());
  const summary = summarizeOrders({ orders: orders.map(orderRuntime) }, input);
  const open = new Map(summary.openList.map(row => [row.id, row]));
  const done = new Map(summary.doneList.map(row => [row.id, row]));
  const records = new Map(input.records.map(record => [record.id, record]));
  const bills = new Map(read.pos.bills.map(bill => [bill.billId, bill]));
  const allocations = new Map<string, Set<string>>();
  for (const allocation of read.pos.billAllocations) if (allocation.qty > 0) {
    const ids = allocations.get(allocation.orderLineId) ?? new Set<string>();
    ids.add(allocation.billId); allocations.set(allocation.orderLineId, ids);
  }
  const byId = new Map<string, OrderStatusRow>(orders.map((order: PosOrder) => {
    const record = records.get(order.orderId)!;
    const displayRecord = { ...record, lines: order.lines.map(line => ({ menuId: line.menuId, menu: line.nameAtOrder, qty: line.qty, unitPrice: line.unitPriceAtOrder })) };
    const pending = open.get(order.orderId), completed = done.get(order.orderId);
    const ids = new Set(order.lines.flatMap(line => [...(allocations.get(line.orderLineId) ?? [])]));
    // Canceled allocations may have been removed; keep their original bill available for history.
    if (!ids.size) ids.add(order.originBillId);
    const linked = [...ids].map(id => bills.get(id)).filter((bill): bill is PosBill => !!bill);
    const row: OrderStatusRow = { ...order, id: order.orderId, no: order.orderNo,
      menuText: menuText(displayRecord), items: orderItems(displayRecord, input.catalog),
      amount: order.lines.reduce((sum, line) => sum + line.unitPriceAtOrder * line.qty, 0),
      paymentStatus: paymentStatus(read.pos, linked), billIds: linked.map(bill => bill.billId),
      tableIds: [...new Set(linked.filter(bill => bill.status !== 'void').flatMap(bill => bill.tableId ? [bill.tableId] : []))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      elapsedMin: pending?.elapsedMin ?? completed?.waitMin ?? 0, usualMin: pending?.usualMin ?? 0,
      waitMin: completed?.waitMin ?? null, isSlow: pending?.isSlow ?? false, isMissing: pending?.isMissing ?? false,
      canReopen: order.preparation === 'completed' && order.completedInRun,
    };
    return [order.orderId, row];
  }));
  const openList = summary.openList.map(row => byId.get(row.id)!);
  const doneList = summary.doneList.map(row => byId.get(row.id)!);
  const canceledList = [...byId.values()].filter(row => row.preparation === 'canceled').sort((a, b) => b.orderNo - a.orderNo);
  const rows = options.filter === 'done' ? doneList : options.filter === 'canceled' ? canceledList
    : options.filter === 'all' ? [...byId.values()].sort((a, b) => b.orderNo - a.orderNo) : openList;
  const totals = empty ? null : selectPosDayTotals(read.pos);
  return { ...summary, orderGross: totals?.gross ?? 0, netRevenue: totals?.revenue ?? 0, openList, doneList, canceledList, rows,
    counts: { open: openList.length, done: doneList.length, canceled: canceledList.length, all: orders.length } };
}

const cache = new WeakMap<PosState, WeakMap<PosCatalog, Map<string, PosOrderSummary>>>();
/** API-245: the screen, alerts, briefing and facts share this read model. */
export function selectOrderSummary(read: PosReadSnapshot, options: OrderSummaryOptions = {}): PosOrderSummary {
  let byCatalog = cache.get(read.pos);
  if (!byCatalog) { byCatalog = new WeakMap(); cache.set(read.pos, byCatalog); }
  let byOptions = byCatalog.get(read.data.catalog);
  if (!byOptions) { byOptions = new Map(); byCatalog.set(read.data.catalog, byOptions); }
  const key = JSON.stringify([read.scenario, options.filter ?? 'open', options.businessNow ?? businessNow()]);
  const hit = byOptions.get(key);
  if (hit) return hit;
  const summary = compute(read, options);
  byOptions.set(key, summary);
  return summary;
}
