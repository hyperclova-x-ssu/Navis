// Partner-assumed projections. Lookup and states: https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS
// General restaurant booking and orders: https://help.naver.com/service/11712/contents/17285?lang=ko
// Order progression: https://new.smartplace.naver.com/introduction/solution-market/payNPos
export const partnerPath = '/partner-assumed/v1';
export const bookingStatuses = ['requested', 'confirmed', 'cancelled', 'completed', 'no-show'] as const;
export type BookingStatus = typeof bookingStatuses[number];
export interface Booking {
  bookingNumber: string;
  product: string;
  usageAt: string;
  maskedName?: string;
  maskedPhone?: string;
  status: BookingStatus;
  npayLinked: boolean;
  /** Won, as shown under 결제/환불정보 (18720 step 8). Omitted for non-Npay bookings. */
  paymentAmount?: number;
}
export interface BookingFilters { bookingNumber?: string; name?: string; phone?: string; date?: string; status?: BookingStatus }
// Partner-assumed cancellation requires a reason and refund terms for confirmed or completed Npay bookings.
// Confirmed: NAVER help 18720. Completed via Npay Center: https://help.naver.com/service/11712/bookmark/19427?osType=COMMONOS
// For completed bookings, actual Npay Center refunds depend on settlement and partial-cancellation eligibility.
// The virtual server uses the same full, rate, and amount inputs for both statuses.
export type BookingRefund = { type: 'full' } | { type: 'rate' | 'amount'; value: number };
export interface BookingCancel { cancelReason: string; refund?: BookingRefund }
export function bookingRefundRequired(booking: Pick<Booking, 'status' | 'npayLinked'>): boolean {
  return booking.npayLinked && (booking.status === 'confirmed' || booking.status === 'completed');
}

export function validBookingRefund(raw: unknown, paymentAmount?: number): raw is BookingRefund {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const { type, value } = raw as Record<string, unknown>;
  if (type === 'full') return Object.keys(raw).length === 1;
  if (Object.keys(raw).length !== 2 || typeof value !== 'number' || value < 0) return false;
  if (type === 'rate') return value <= 100;
  return type === 'amount' && Number.isSafeInteger(value) && paymentAmount !== undefined && value <= paymentAmount;
}

export interface BookingChange { usageAt: string }
export type OrderStatus = 'received' | 'preparing' | 'picked-up';
export interface Order {
  orderNumber: string;
  preparationMinutes: number | null;
  status: OrderStatus;
}
export interface BookingProduct {
  name: string;
}
