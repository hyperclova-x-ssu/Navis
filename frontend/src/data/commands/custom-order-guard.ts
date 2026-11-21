import { failure, fingerprint } from '../iteration7/custom-orders/shared';
import { customPaymentView } from '../iteration7/custom-orders/selectors';
import type { CustomOrder, CustomOrderRead, CustomOrderTables, CustomReceipt } from '../iteration7/custom-orders/types';
import { normalizeMemberPhone, normalizeName } from './management-guards';

function sameCustomer(order: CustomOrder, receipt: CustomReceipt): boolean {
  if (order.memberId !== null || receipt.memberId !== null) return order.memberId === receipt.memberId;
  if (!order.guest || !receipt.guest) return false;
  const phone = normalizeMemberPhone(receipt.guest.phone);
  return /^\d{10,11}$/u.test(phone) && normalizeMemberPhone(order.guest.phone) === phone
    && normalizeName(order.guest.name) === normalizeName(receipt.guest.name);
}

/** Distinct pickups, custom instructions and options can be intentional repeat orders. */
export function findDuplicateCustomOrder(
  orders: CustomOrderTables['customOrder'], receipt: CustomReceipt, templateId: string, exceptOrderId?: string,
): CustomOrder | undefined {
  return orders.find(order => order.customOrderId !== exceptOrderId && !['canceled', 'received_by_customer'].includes(order.stage)
    && order.templateId === templateId && order.desiredPickupAt === receipt.desiredPickupAt && order.quantity === receipt.quantity
    && normalizeName(order.productLabel) === normalizeName(receipt.productLabel) && sameCustomer(order, receipt)
    && fingerprint(order.answers) === fingerprint(receipt.answers)
    && fingerprint(order.options) === fingerprint(receipt.options) && order.request.trim() === receipt.request.trim()
    && fingerprint(order.referencePhotoKeys) === fingerprint(receipt.referencePhotoKeys));
}

export function pickupLinkConflicts(rows: CustomOrderTables['reservation'], orderId: string, reservationId: string): boolean {
  return rows.filter(row => row.kind === 'pickup' && row.customOrderId === orderId).length > 1
    || rows.some(row => row.reservationId === reservationId && (row.kind !== 'pickup' || row.customOrderId !== orderId));
}

// D-326 guards the additional chat entry to the widget's existing pickup planner.
export function checkReversiblePickup(read: CustomOrderRead, orderId: string) {
  const order = read.tables.customOrder.find(row => row.customOrderId === orderId);
  if (!order) return failure('NOT_FOUND', 'customOrderId', 'NOT_FOUND');
  const payment = customPaymentView(read, order);
  if (order.paymentTiming !== 'advance' || payment.status !== 'paid' || payment.amountSettled !== order.quoteAmount) {
    return failure('PAYMENT_REQUIRED', 'customOrderId');
  }
}
// End D-326.
