import type { PosOrder, PosReadSnapshot } from '../../contracts/pos';

export type OrderFilter = 'open' | 'done' | 'canceled' | 'all';
/** M1 read model. T-247/248 replaces this boundary with the shared status selector. */
export function selectOrderView(read: PosReadSnapshot, filter: OrderFilter) {
  const orders = read.scenario === 'empty' ? [] : read.pos.orders;
  const counts = {
    all: orders.length,
    open: orders.filter(order => order.preparation === 'accepted' || order.preparation === 'preparing').length,
    done: orders.filter(order => order.preparation === 'completed').length,
    canceled: orders.filter(order => order.preparation === 'canceled').length,
  };
  const rows = orders.filter(order => filter === 'all' || (filter === 'open' ? order.preparation === 'accepted' || order.preparation === 'preparing' : filter === 'done' ? order.preparation === 'completed' : order.preparation === 'canceled'));
  rows.sort((a, b) => filter === 'open' ? a.orderedAt.localeCompare(b.orderedAt) || a.seq - b.seq : filter === 'done' ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || b.orderNo - a.orderNo : b.orderNo - a.orderNo);
  return { counts, rows };
}
export function selectOrderDetail(read: PosReadSnapshot, order: PosOrder) {
  const gross = order.lines.reduce((sum, line) => sum + line.unitPriceAtOrder * line.qty, 0);
  const bill = read.pos.bills.find(bill => bill.billId === order.originBillId);
  const payments = read.pos.payments.filter(payment => payment.billId === order.originBillId);
  const discount = bill?.discounts.reduce((sum, value) => sum + value.amount, 0) ?? 0;
  const paymentStatus: 'paid' | 'partial' | 'canceled' | 'unpaid' = bill?.status === 'paid' ? 'paid' : bill?.status === 'partial' ? 'partial' : bill?.status === 'void' ? 'canceled' : 'unpaid';
  return { gross, discount, payable: gross - discount,
    paymentStatus,
    splits: payments.flatMap(payment => payment.splits),
  };
}
