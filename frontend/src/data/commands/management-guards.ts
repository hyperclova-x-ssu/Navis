/**
 * GD-1 guards for the management and legacy handlers (NAVIS_AGENT_GAP_PLAN "Direct app defects").
 *
 * Every rule lives in the HANDLER, so the widget and the chatbot get the same typed refusal
 * (`code` + `reason` + `messageKey` + `details`, the shape of `member-guard.ts`). Rules read the
 * store state only: never a literal seed id or number, because the seed is replaced later (N-4).
 *
 * Two kinds of refusal:
 *  - hard: the input is wrong (past slot, same phone, same name where identity needs one);
 *  - ask: the input is plausible but looks like a repeat. The caller repeats the same command with
 *    `confirmDuplicate: true` once the owner insists (an intentional second record).
 */
import type { DataTables, DataText, Reservation } from '../db/types';
import { addDays, weekdayOf } from '../db/time';
import { STORE_HOURS, STORE_WEEKDAYS } from '../store-hours';
import { maskCustomer } from '../derive/members';
import { dataBundles } from '../messages';
import { resolveDataText } from '../text';
import type { DataErrorCode } from './types';
import type { HandlerResult } from './handlers';

type Refusal = Extract<HandlerResult, { ok: false }>;

/** A typed refusal; `reason` also picks the Korean message `data.management.error.<reason>`. */
export function refuse(code: DataErrorCode, reason: string, field?: string, details?: Readonly<Record<string, unknown>>): Refusal {
  return { ok: false, code, reason, messageKey: `data.management.error.${reason}`, ...(field ? { field } : {}), ...(details ? { details } : {}) };
}

/* The business clock and its one boundary live in business-clock.ts; re-exported for the handlers. */
export { BUSINESS_CLOCK, dateIsPast, slotHasPassed, slotIsLater, slotPhase } from './business-clock';
import { BUSINESS_CLOCK } from './business-clock';

/* ───────────── Names and phone numbers ───────────── */

const KO: Readonly<Record<string, string>> = Object.assign({}, ...dataBundles.map((bundle) => bundle.ko));
const koText = (key: string): string => KO[key] ?? key;

/** The text an owner sees for stored data: typed text as typed, keyed seed text in Korean. */
export const plainText = (text: DataText | null | undefined, fallbackKey?: string): string =>
  text ? resolveDataText(koText, text) : fallbackKey ? koText(fallbackKey) : '';

/** Identity form of a name: width/compat forms folded, spaces and light punctuation dropped, case folded. */
export const normalizeName = (value: string): string => value.normalize('NFKC').replace(/[\s·・.,'"\-_()[\]{}]+/g, '').toLowerCase();
export const digitsOf = (value: string): string => value.replace(/\D/g, '');

/** Seed rows hold masked names ("윤○○"); typed names hold the real letters. A mask matches by its visible letters. */
export function sameName(a: string, b: string): boolean {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const hidden = (s: string) => s.includes('○');
  if (!hidden(x) && !hidden(y) || [...x].length !== [...y].length) return false;
  return [...x].every((ch, i) => ch === '○' || [...y][i] === '○' || ch === [...y][i]);
}

/** Another live name in `rows` that normalizes to the same name, ignoring the row being edited. */
export function findSameName<T>(rows: readonly T[], nameOf: (row: T) => string, name: string, isSelf?: (row: T) => boolean): T | undefined {
  const wanted = normalizeName(name);
  return wanted ? rows.find((row) => !isSelf?.(row) && normalizeName(nameOf(row)) === wanted) : undefined;
}

export const nameExists = (existingId: string, field = 'name') => refuse('CONFLICT', 'NAME_EXISTS', field, { existingId });

/* ───────────── (1) Members: one live customer per phone number ───────────── */

export interface PhoneMatch { readonly memberId: string | null; readonly customerId: string; readonly name: string; readonly phone: string }

export function normalizeMemberPhone(phone: string): string {
  const formatted = phone.normalize('NFKC').trim();
  const digits = digitsOf(formatted);
  const domestic = /^\+82/u.test(formatted) ? /^82([1-9]\d{8,9})$/u.exec(digits) : null;
  return domestic ? `0${domestic[1]}` : digits;
}

/** Live, normal (not sample-state) customer holding the number; archived customers do not count. */
export function findPhoneMatch(t: DataTables, phone: string, exceptCustomerId?: string): PhoneMatch | null {
  const digits = normalizeMemberPhone(phone);
  if (!/^\d{10,11}$/u.test(digits)) return null;
  const hit = t.marketing.mktCustomer.find((c) => !c.deletedAt && c.variant === null && c.customerId !== exceptCustomerId && !!c.phone && normalizeMemberPhone(c.phone) === digits);
  if (!hit) return null;
  const masked = maskCustomer({ ...hit, phone: digits });
  return { memberId: t.memberProfile.find((p) => p.customerId === hit.customerId)?.memberId ?? null, customerId: hit.customerId, name: typeof masked.name === 'string' ? masked.name : plainText(masked.name), phone: masked.phone };
}

export const phoneExists = (match: PhoneMatch) => refuse('CONFLICT', 'MEMBER_PHONE_EXISTS', 'phone', { memberId: match.memberId, name: match.name, phone: match.phone });

/* ───────────── (2) Tax payments ───────────── */

export interface TaxRow { readonly taxPaymentId: string; readonly type: DataText; readonly amount: number; readonly dueOn: string; readonly status: 'paid' | 'unpaid' }

/** The same obligation: same normalized type, amount and due date. A different amount or date is a distinct entry. */
export function findTaxDuplicate(rows: readonly TaxRow[], entry: { readonly type: string; readonly amount: number; readonly dueOn: string }, exceptId?: string): TaxRow | undefined {
  const type = normalizeName(entry.type);
  return rows.find((r) => r.taxPaymentId !== exceptId && normalizeName(plainText(r.type)) === type && r.amount === entry.amount && r.dueOn === entry.dueOn);
}

type TaxDue = { readonly taxPaymentId: string; readonly dueOn: string; readonly amount: number; readonly status: 'paid' | 'unpaid' };
/** Due order: earliest date first; ties by amount, then id, so the order never depends on table order. */
export const compareTaxDue = (a: TaxDue, b: TaxDue): number => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) || a.amount - b.amount || (a.taxPaymentId < b.taxPaymentId ? -1 : a.taxPaymentId > b.taxPaymentId ? 1 : 0);
/** The next payment to make: the first unpaid row in due order (S2-040). */
export function selectNextTaxPayment<T extends TaxDue>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) if (row.status === 'unpaid' && (!best || compareTaxDue(row, best) < 0)) best = row;
  return best;
}

/* ───────────── (3) CCTV: only today's business hours ───────────── */

/** Whole hours the demo store is open on `date`, from the one hours table (`store-hours.ts`). */
function hoursOnDate(date: string): { readonly open: number; readonly close: number } {
  const [open, close] = STORE_HOURS[STORE_WEEKDAYS[weekdayOf(date) - 1]];
  const hourOf = (time: string, roundUp: boolean) => Number(time.slice(0, 2)) + (roundUp && Number(time.slice(3)) > 0 ? 1 : 0);
  return { open: hourOf(open, false), close: hourOf(close, true) };
}

/** Is hour-of-day `hour` inside the business day `date`? (closing 22:00 → last hour 21, 21:30 → 21.) */
export function hourIsBusinessHour(date: string, hour: number): boolean {
  const range = hoursOnDate(date);
  return Number.isInteger(hour) && hour >= range.open && hour < range.close;
}

// N19 CCTV review projection and direct widget command use the same target check.
export function selectCctvReviewTarget(tables: Pick<DataTables, 'cctvHourly'>, date: string, hour: number):
  { readonly row: DataTables['cctvHourly'][number] } | { readonly reason: 'outside_hours' | 'missing' | 'unobserved' } {
  if (date !== BUSINESS_CLOCK.date || !hourIsBusinessHour(date, hour)) return { reason: 'outside_hours' };
  const row = tables.cctvHourly.find(entry => entry.businessDate === date && entry.hour === hour);
  if (!row) return { reason: 'missing' };
  return row.entries === null || row.status === 'none' ? { reason: 'unobserved' } : { row };
}
// End N19 CCTV review.

/* ───────────── (4) Bookings ───────────── */

/** Who a visit belongs to: the linked member, or the typed (or seeded, masked) guest name and number. */
function visitIdentity(t: DataTables, r: Pick<Reservation, 'memberId' | 'guestName' | 'nameKey' | 'phone'>): { readonly memberId: string | null; readonly name: string; readonly phone: string } {
  const member = r.memberId ? t.memberProfile.find((m) => m.memberId === r.memberId) : undefined;
  const customer = member ? t.marketing.mktCustomer.find((c) => c.customerId === member.customerId) : undefined;
  const name = customer ? (typeof maskCustomer(customer).name === 'string' ? String(maskCustomer(customer).name) : plainText(r.guestName, r.nameKey)) : plainText(r.guestName, r.nameKey);
  return { memberId: r.memberId ?? null, name, phone: r.phone && 'raw' in r.phone ? digitsOf(r.phone.raw) : '' };
}

export interface BookingIdentity { readonly memberId?: string; readonly guest?: { readonly name: string; readonly phone?: string } }

/** A live visit with the same person, date, time and party size: the "비슷한 예약". */
export function findBookingDuplicate(t: DataTables, entry: BookingIdentity & { readonly date: string; readonly time: string; readonly partySize: number }, exceptReservationId?: string): Reservation | undefined {
  const guestName = entry.guest?.name ?? '';
  const guestPhone = digitsOf(entry.guest?.phone ?? '');
  return t.reservation.filter((r): r is Reservation => r.kind !== 'pickup').find((r) => {
    if (r.reservationId === exceptReservationId || r.variant || r.status === 'canceled' || r.date !== entry.date || r.time !== entry.time || r.partySize !== entry.partySize) return false;
    const who = visitIdentity(t, r);
    if (entry.memberId) return who.memberId === entry.memberId;
    if (who.memberId) return false;
    // Two different numbers are two different people with the same name.
    if (guestPhone && who.phone && guestPhone !== who.phone) return false;
    return sameName(guestName, who.name);
  });
}

/** Allocation preview for the 예약 form: what `booking.create` would decide, before the owner confirms. */
export { allocateReservation as previewAllocation } from '../derive/reservations';

/* ───────────── (6) Orders, expenses ───────────── */

// D-326: ledger edits use the latest normal closing, never the sample scenario.
export function isExpenseDayClosed(tables: Pick<DataTables, 'dayClosing'>, date: string): boolean {
  return tables.dayClosing.filter(row => row.businessDate === date && row.scenario === 'normal').at(-1)?.status === 'closed';
}
// End D-326.

export const askAgain = (reason: string, field: string, details?: Readonly<Record<string, unknown>>) => refuse('CONFLICT', reason, field, details);

/** Same category, amount, supplier and memo on the same day, or the same monthly rent twice in one month (memo aside). */
export function findExpenseDuplicate(rows: DataTables['expense'], entry: { readonly date: string; readonly category: string; readonly amount: number; readonly supplierId: string | null; readonly memo: string }): DataTables['expense'][number] | undefined {
  const memo = normalizeName(entry.memo);
  return rows.find((e) => e.category === entry.category && e.amount === entry.amount && (e.supplierId ?? null) === entry.supplierId
    && (e.businessDate === entry.date && normalizeName(plainText(e.memo)) === memo || entry.category === 'rent' && e.businessDate.slice(0, 7) === entry.date.slice(0, 7)));
}

/** An open order for the same supplier and item, quantity and due date: probably the same order sent twice. */
export function findOrderDuplicate(t: DataTables, entry: { readonly supplierId: string; readonly itemId: string; readonly qty: number; readonly dueDate: string }): DataTables['purchaseOrder'][number] | undefined {
  return t.purchaseOrder.find((po) => po.supplierId === entry.supplierId && (po.status === 'scheduled' || po.status === 'partial') && po.dueDate === entry.dueDate
    && t.purchaseOrderLine.some((l) => l.poId === po.poId && l.itemId === entry.itemId && l.qtyOrdered === entry.qty));
}

/** Business date + n days, for date rules that must not hard-code a calendar date. */
export const businessDay = (offset = 0): string => addDays(BUSINESS_CLOCK.date, offset);
