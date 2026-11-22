import { calendarDate } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { bookingRefundRequired, type BookingStatus, type OrderStatus } from '../../../../packages/naver/contracts/pn02/wire.ts';

export function parseUsageAt(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::00)?\+09:00$/.test(value)
      || !calendarDate(value.slice(0, 10))) return null;
  return new Date(value);
}

// https://help.naver.com/service/30026/contents/20630?lang=ko&osType=COMMONOS
// https://help.naver.com/service/30026/contents/20659?lang=ko&osType=COMMONOS
export function bookingStatusAfter(state: BookingStatus, action: 'confirm' | 'cancel', npayLinked = false): BookingStatus | null {
  if (state === 'requested') return action === 'confirm' ? 'confirmed' : 'cancelled';
  const cancellable = state === 'confirmed' || bookingRefundRequired({ status: state, npayLinked });
  return cancellable && action === 'cancel' ? 'cancelled' : null;
}

// https://help.naver.com/service/11712/contents/7581?lang=ko
export function bookingCanChange(state: BookingStatus, npayLinked: boolean, usageAt: string, now: Date) {
  const usage = parseUsageAt(usageAt);
  return (state === 'requested' || state === 'confirmed') && !npayLinked && usage !== null && usage > now;
}

// https://new.smartplace.naver.com/introduction/solution-market/payNPos
export function orderStatusAfter(state: OrderStatus, action: 'prepare' | 'pickup'): OrderStatus | null {
  if (state === 'received' && action === 'prepare') return 'preparing';
  if (state === 'preparing' && action === 'pickup') return 'picked-up';
  return null;
}
