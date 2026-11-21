/**
 * The one explicit business clock of the mockup (D-248, ARCH16.6) and the one boundary rule built on it.
 *
 * Booking creation, visit completion / no-show, the 예약 availability "next slot", and the calendar's
 * "upcoming" entries all read this file. Before GD-1 the reservation and calendar code carried their own
 * 15:42 while the POS scenario clock is 15:45 (S3-208); 15:42 stays only where it is data (the last POS
 * payment's time, the stock "as of" label), never as "now".
 *
 * Leaf module: imports only the date constants, so derive/, commands/ and widgets can all use it.
 */
import { NOW_TIME, TODAY } from '../db/time';

export const BUSINESS_CLOCK = Object.freeze({ date: TODAY, time: NOW_TIME });

export type SlotPhase = 'past' | 'now' | 'future';

/** Where a slot sits against the clock. A slot at exactly the clock time is 'now': not yet past, not yet later. */
export function slotPhase(date: string, time: string | null | undefined): SlotPhase {
  if (date !== BUSINESS_CLOCK.date) return date < BUSINESS_CLOCK.date ? 'past' : 'future';
  if (time == null) return 'now';
  return time < BUSINESS_CLOCK.time ? 'past' : time === BUSINESS_CLOCK.time ? 'now' : 'future';
}

/** A slot has passed when it starts strictly before the clock (S3-208). */
export const slotHasPassed = (date: string, time: string | null | undefined): boolean => slotPhase(date, time) === 'past';
/** Strictly after the clock: the "next slot". */
export const slotIsLater = (date: string, time: string | null | undefined): boolean => slotPhase(date, time) === 'future';
/** The whole date is before the business date. */
export const dateIsPast = (date: string): boolean => date < BUSINESS_CLOCK.date;
