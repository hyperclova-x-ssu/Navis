import { createHash } from 'node:crypto';
import type { Booking, BookingCancel, BookingFilters, BookingProduct } from '../../../../packages/naver/contracts/pn02/wire.ts';
import type { SmartCallSummary } from '../../../../packages/naver/contracts/pn08/wire.ts';
import { choice, conflict, date, integer, invalid, listing, object, storeTime, text, time, uuid } from '../07/wire.ts';

export const visitStatuses = ['needs-check', 'confirmed', 'proposed', 'canceled', 'completed', 'no-show'] as const;
export type VisitStatus = (typeof visitStatuses)[number];
export const transitionTypes = ['booking.confirm', 'booking.propose', 'booking.cancel', 'booking.markNoShow',
  'booking.markCompleted', 'booking.declineSuggestion'] as const;
export type Transition = (typeof transitionTypes)[number];
export const visitFields = ['memberId', 'guest', 'date', 'time', 'partySize', 'request', 'tableChoice'] as const;
export type Table = { tableId: string; number: number | null; label: string; seats: number; layoutTableId?: string | null };
export type TableMap = { enabled: boolean; tables: readonly Table[] };
export type ReadTables = (storeId: string, actorId: string) => Promise<TableMap>;
export type OwnerScope = { storeId: string; actorId: string };
export type NaverEffect = { kind: 'change'; usageAt: string } | { kind: 'confirm' }
  | ({ kind: 'cancel' } & BookingCancel);
export type BookingNaver = {
  bookings(ctx: OwnerScope, filters?: BookingFilters): Promise<readonly Booking[]>;
  booking(ctx: OwnerScope, ref: string): Promise<Booking | null>;
  bookingProducts(ctx: OwnerScope): Promise<readonly BookingProduct[]>;
  bookingCommand(ctx: OwnerScope, card: { key: string; extraConfirmed?: true }, ref: string, effect: NaverEffect):
    Promise<Booking>;
  smartCallSummary(ctx: OwnerScope, startDate: string, endDate: string): Promise<SmartCallSummary>;
};
export const seatWarnings = ['NO_MATCHING_TABLE', 'SEAT_LIMIT'] as const;
export type LocalVisit = {
  reservationId: string; date: string; time: string; partySize: number; revision: number; status: VisitStatus;
  source: 'direct' | 'phone_ai'; memberId: string | null; guestName: string | null; guestPhone: string | null;
  request: string | null; tableId: string | null; preferredTableId: string | null; assignmentMode: 'auto' | 'manual';
  allocationWarning: (typeof seatWarnings)[number] | null; capacityOverride: boolean; confirmedBy: 'auto' | 'person' | null;
  proposedTime: string | null; firstOrderId: string | null;
};
export type ChangeKind = 'created' | 'updated' | 'canceled' | 'status';
export const affectedSources = ['voice-booking', 'reservations', 'members', 'calendar', 'briefing', 'pos.tables'];

export class BookingUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function stableUuid(...values: string[]) {
  const digest = sha(values);
  return [digest.slice(0, 8), digest.slice(8, 12), '5' + digest.slice(13, 16), '8' + digest.slice(17, 20), digest.slice(20, 32)].join('-');
}

export const naverRefPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const naverPrefix = 'naver-';
export function reservationRef(value: unknown) {
  if (typeof value === 'string' && value.startsWith(naverPrefix) && naverRefPattern.test(value.slice(naverPrefix.length))) return value;
  return uuid(value, 'reservationId');
}

export const seoulZone = 'Asia/Seoul';
export const usageAt = (date: string, time: string) => `${date}T${time}:00+09:00`;
export const day = (at: Date) => storeTime(at, seoulZone).date;

export function fromUsageAt(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?([+-]\d{2}:\d{2}|Z)$/.test(value) ||
    !Number.isFinite(Date.parse(value))) throw invalid('usageAt');
  date(value.slice(0, 10), 'usageAt');
  time(value.slice(11, 16), 'usageAt');
  return storeTime(new Date(value), seoulZone);
}

export const maskPhone = (phone: string) => phone.slice(0, 3) + '-****-' + phone.slice(-4);

export function guestPhone(value: unknown) {
  if (typeof value !== 'string' || !/^\d{10,11}$/.test(value)) throw invalid('guest.phone', 'GUEST_INVALID');
  return value;
}

export function checkExtraConfirmation(value: unknown) {
  if (value !== true) throw conflict('CONFIRMATION_REQUIRED', 'confirmed');
}

export function listInput(query: unknown, fields: readonly string[] = []) {
  const input = object(query, ['limit', 'cursor', 'date', 'startDate', 'endDate', ...fields]);
  const singleDate = input.date === undefined ? undefined : date(input.date, 'date');
  if (singleDate && (input.startDate !== undefined || input.endDate !== undefined)) throw invalid('date', 'INVALID_DATE_RANGE');
  return { input, ...listing(singleDate ? { ...input, startDate: singleDate, endDate: singleDate } : input) };
}

export function visitList(query: unknown) {
  const { input, ...options } = listInput(query, ['source', 'status', 'q', 'memberId']);
  return {
    ...options,
    cursor: input.cursor === undefined ? null : reservationRef(input.cursor),
    source: input.source === undefined ? null : choice(input.source, ['local', 'naver'], 'source'),
    status: input.status === undefined ? null : choice(input.status, visitStatuses, 'status'),
    q: input.q === undefined ? null : text(input.q, 'q', 100) || null,
    memberId: input.memberId === undefined ? null : uuid(input.memberId, 'memberId'),
  };
}

export function parseTransition(raw: unknown) {
  const input = object(raw, ['type', 'time', 'expectedRevision', 'confirmed']);
  const type = choice(input.type, transitionTypes, 'type');
  if (type === 'booking.cancel' || type === 'booking.declineSuggestion') checkExtraConfirmation(input.confirmed);
  if (input.time !== undefined && type !== 'booking.propose') throw invalid('time');
  return { type, expectedRevision: integer(input.expectedRevision, 'expectedRevision', 1),
    ...(type === 'booking.propose' && { time: time(input.time, 'time', 'TIME_INVALID') }) };
}
