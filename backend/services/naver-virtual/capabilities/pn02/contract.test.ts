import { expect, it } from 'vitest';
import { bookingRefundRequired, validBookingRefund } from '../../../../packages/naver/contracts/pn02/wire.ts';
import { bookingStatusAfter, bookingCanChange, orderStatusAfter, parseUsageAt } from './rules.ts';

const now = new Date('2026-11-17T06:45:00Z');
const upcoming = '2026-11-18T09:00:00+09:00';

it('keeps reservation terminal states and Npay change refusal even when a time is otherwise eligible', () => {
  expect(bookingStatusAfter('requested', 'confirm')).toBe('confirmed');
  expect(bookingStatusAfter('confirmed', 'confirm')).toBeNull();
  expect(bookingStatusAfter('confirmed', 'cancel')).toBe('cancelled');
  for (const state of ['cancelled', 'completed', 'no-show'] as const) {
    expect(bookingStatusAfter(state, 'cancel')).toBeNull();
    expect(bookingCanChange(state, false, upcoming, now)).toBe(false);
  }
  expect(bookingCanChange('confirmed', true, upcoming, now)).toBe(false);
  expect(bookingCanChange('requested', false, upcoming, now)).toBe(true);
  expect(bookingCanChange('confirmed', false, upcoming, now)).toBe(true);
  expect(bookingCanChange('confirmed', false, '2026-11-17T15:44:00+09:00', now)).toBe(false);
  expect(parseUsageAt('2026-02-30T09:00:00+09:00')).toBeNull();
});

it('enforces pickup after preparation and disallows reversals', () => {
  expect(orderStatusAfter('received', 'pickup')).toBeNull();
  expect(orderStatusAfter('received', 'prepare')).toBe('preparing');
  expect(orderStatusAfter('preparing', 'pickup')).toBe('picked-up');
  expect(orderStatusAfter('picked-up', 'prepare')).toBeNull();
  expect(orderStatusAfter('picked-up', 'pickup')).toBeNull();
});

it('requires refund terms exactly for confirmed or completed Npay bookings and caps amounts at the payment', () => {
  expect(bookingRefundRequired({ status: 'confirmed', npayLinked: true })).toBe(true);
  expect(bookingRefundRequired({ status: 'confirmed', npayLinked: false })).toBe(false);
  expect(bookingRefundRequired({ status: 'requested', npayLinked: true })).toBe(false);
  expect(bookingStatusAfter('completed', 'cancel', true)).toBe('cancelled');
  expect(bookingStatusAfter('completed', 'cancel', false)).toBeNull();
  expect(bookingStatusAfter('completed', 'confirm', true)).toBeNull();
  expect(bookingStatusAfter('cancelled', 'cancel', true)).toBeNull();
  expect(bookingRefundRequired({ status: 'completed', npayLinked: true })).toBe(true);
  expect(bookingRefundRequired({ status: 'completed', npayLinked: false })).toBe(false);
  expect(validBookingRefund({ type: 'full' }, 4500)).toBe(true);
  expect(validBookingRefund({ type: 'rate', value: 0 }, 4500)).toBe(true);
  expect(validBookingRefund({ type: 'rate', value: 100 }, 4500)).toBe(true);
  expect(validBookingRefund({ type: 'rate', value: 101 }, 4500)).toBe(false);
  expect(validBookingRefund({ type: 'amount', value: 4500 }, 4500)).toBe(true);
  expect(validBookingRefund({ type: 'amount', value: 4501 }, 4500)).toBe(false);
  expect(validBookingRefund({ type: 'amount', value: 0.5 }, 4500)).toBe(false);
});
