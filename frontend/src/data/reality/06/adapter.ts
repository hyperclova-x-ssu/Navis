/**
 * REAL-PLAN F06 — the `booking` domain on the F00 port: UI → api-gateway → customer service (B06) → its PostgreSQL DB.
 * Command names and arguments are the widget's and Navis' own (`booking.confirm`, `booking.cancel` …); only the
 * implementation moves from the store to HTTP. NAVER bookings and AiCall candidates are RECORDS the service holds; the
 * owner's card press is the only thing that confirms, changes or cancels one, and no provider is called from the browser.
 *
 * Money-like safety rules that stay in force: every booking write waits for its receipt (no optimistic preview, because the
 * table allocation and the duplicate/Npay refusals are the server's), cancel and decline carry `confirmed: true` (the widget
 * and the Navis card ask the extra question first), and a stale revision re-reads and asks the owner to press again.
 */
import { defineBinding, PortError, type CommandContext, type CommandOf, type CommandRequest, type DomainAdapter, type ListPage, type PortReads } from '../00';
import { BUSINESS_CLOCK } from '../../commands/business-clock';
import { addDays } from '../../db/time';
import { bookingKey, naverRules, projectBooking, type BookingProductDto, type CallDayDto, type ChangeDto, type PosTableDto, type ReservationDto, type SourceStatus, type SuggestionDto } from './dto';

export const reservationsPath = '/reservations';
export const suggestionsPath = '/reservation-suggestions';
export const callRecordsPath = '/call-records';
export const changesPath = '/reservation-changes';
export const productsPath = '/booking-products';
/** B02: the POS tables (service UUID, label, layout id): the label is what the owner reads, the UUID stays for edits and claims. */
export const tablesPath = '/pos/tables';
/** B06: `POST /booking/receipts/:id/undo` — local create, change, status change and cancel. Provider-side transitions and candidate acceptance have no undo. */
const receiptBase = '/booking';
const PAGE = 200;
/** The POS service lists at most 50 rows a page (`INVALID_LIMIT` above it); `reads.all` follows the cursor. */
const POS_PAGE = 50;
/** Visit rows are read for a bounded window around the business day; the widget steps day by day inside it. */
export const WINDOW = { back: 30, forward: 90 } as const;
const CALL_DAYS = 7;

const item = (id: string) => `${reservationsPath}/${encodeURIComponent(id)}`;
const transitions = (id: string) => `${item(id)}/transitions`;

function expected(context: CommandContext, id: string): number {
  const value = context.revision(bookingKey(id));
  if (value === undefined) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
  return value;
}
const without = (command: object, drop: readonly string[]) =>
  Object.fromEntries(Object.entries(command).filter(([name, value]) => value !== undefined && !drop.includes(name)));
const META = ['type', 'idempotencyKey', 'baseRevision', 'reservationId'] as const;

const SESSION_CODES = new Set(['UNAUTHENTICATED', 'STORE_FORBIDDEN', 'TOKEN_EXPIRED']);
/** A side read (calls, products, change log) may fail without hiding the bookings; a lost session may not. */
interface SidePage<T> { readonly items: readonly T[]; readonly asOf: string; readonly sourceRevision: number; readonly complete: boolean }
async function optional<T, E extends object = Record<never, never>>(read: () => Promise<SidePage<T> & E>, extra?: E): Promise<SidePage<T> & E> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PortError && SESSION_CODES.has(error.code)) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { items: [] as readonly T[], asOf: '', sourceRevision: 0, complete: false, ...extra } as SidePage<T> & E;
  }
}

/** `GET /call-records`: audited SmartCall daily aggregates with their period and channel names (one page: a period spans at most 31 days). */
async function callDays(reads: PortReads, query: Record<string, string | number>, signal: AbortSignal) {
  const page = await reads.page<CallDayDto>({ resource: 'call-records', path: callRecordsPath, query: { ...query, limit: PAGE } }, { signal });
  const body = page as ListPage<CallDayDto> & { period?: { startDate?: string; endDate?: string }; channels?: readonly string[] };
  const period = body.period?.startDate && body.period.endDate ? { startDate: body.period.startDate, endDate: body.period.endDate } : null;
  return { items: page.items, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: page.nextCursor === null, period, channels: body.channels ?? [] };
}

type TransitionType = 'booking.confirm' | 'booking.propose' | 'booking.cancel' | 'booking.markNoShow' | 'booking.markCompleted' | 'booking.declineSuggestion';
/** The mixed list (B06) also says whether the NAVER side could be read; follow the cursor like `reads.all`, keeping that one field of the first page. */
async function bookings(reads: PortReads, query: Record<string, string | number>, signal: AbortSignal) {
  const items: ReservationDto[] = [];
  let cursor: string | undefined, pages = 0, naver: SourceStatus = 'ready', last: ListPage<ReservationDto> | undefined;
  for (;;) {
    const page = await reads.page<ReservationDto>({ resource: 'reservations', path: reservationsPath, query: { ...query, limit: PAGE } }, { cursor, signal });
    if (pages === 0) naver = (page as { sourceStatus?: { naver?: SourceStatus } }).sourceStatus?.naver ?? 'ready';
    items.push(...page.items);
    last = page;
    pages += 1;
    if (page.nextCursor === null || pages >= 20) break;
    cursor = page.nextCursor;
  }
  return { items, asOf: last.asOf, sourceRevision: last.sourceRevision, complete: last.nextCursor === null, naver };
}

const invalid = (reason: string, field: string) => new PortError(400, 'VALIDATION', reason, field);

/**
 * NAVER cancel terms (D-347 PN02, owner help 18720 and 19427): the owner's own reason (shown to the customer) is required; refund terms are required when the service
 * says the cancel needs them (`actions.cancelRequiresRefund`: a CONFIRMED or COMPLETED Npay-linked booking, because Npay applied means it was paid) and never sent otherwise.
 * An amount refund needs the booking's payment amount and may not exceed it. A local booking sends neither. The service re-checks all of it on the press.
 */
export function cancelTerms(command: { readonly reservationId: string; readonly cancelReason?: string; readonly refund?: CancelRefund }, context: CommandContext): object {
  const meta = context.snapshot.tables.realBooking?.meta[command.reservationId];
  if (meta?.origin !== 'naver') return {};
  const reason = command.cancelReason?.trim() ?? '';
  if (!reason) throw invalid('CANCEL_REASON_REQUIRED', 'cancelReason');
  const status = context.snapshot.tables.reservation.find(row => row.reservationId === command.reservationId)?.status ?? 'needs-check';
  const refundDue = naverRules(meta, status)?.requiresRefund === true;
  const { refund } = command;
  if (!refundDue) {
    if (refund) throw invalid('REFUND_NOT_APPLICABLE', 'refund');
    return { cancelReason: reason };
  }
  if (!refund) throw invalid('REFUND_TERMS_REQUIRED', 'refund');
  const valid = refund.type === 'full' ? Object.keys(refund).length === 1
    : refund.type === 'rate' ? Number.isFinite(refund.value) && refund.value >= 0 && refund.value <= 100
    : refund.type === 'amount' && meta.paymentAmount !== undefined && Number.isSafeInteger(refund.value) && refund.value >= 0 && refund.value <= meta.paymentAmount;
  if (!valid) throw invalid('INVALID_REFUND_TERMS', 'refund');
  return { cancelReason: reason, refund: refund.type === 'full' ? { type: 'full' } : { type: refund.type, value: refund.value } };
}
export type CancelRefund = { readonly type: 'full' } | { readonly type: 'rate' | 'amount'; readonly value: number };

function transition<T extends TransitionType>(type: T, extra: (command: CommandOf<T>, context: CommandContext) => object = () => ({})) {
  return defineBinding({
    type, receiptBase,
    request: (command: CommandOf<T>, context: CommandContext): CommandRequest => {
      const { reservationId } = command as unknown as { reservationId: string };
      return { method: 'POST', path: transitions(reservationId), body: { type, ...extra(command, context) }, expectedRevision: expected(context, reservationId) };
    },
  });
}

export const bookingAdapter: DomainAdapter = {
  domain: 'booking',
  sources: ['booking', 'voice-booking', 'reservations', 'pos.tables'],
  tables: ['reservation', 'reservationChange', 'callLog', 'realBooking'],
  clear() { return { realBooking: undefined }; },
  errorKeys: {
    BOOKING_DUPLICATE: 'data.management.error.BOOKING_DUPLICATE', BOOKING_PAST: 'data.management.error.BOOKING_PAST',
    BOOKING_TRANSITION: 'data.management.error.BOOKING_TRANSITION', GUEST_OR_MEMBER: 'data.management.error.GUEST_OR_MEMBER',
    GUEST_INVALID: 'data.management.error.GUEST_INVALID', DATE_INVALID: 'data.management.error.DATE_INVALID',
    TIME_INVALID: 'data.management.error.TIME_INVALID', PARTY_INVALID: 'data.management.error.PARTY_INVALID',
    TABLE_INVALID: 'data.management.error.TABLE_INVALID', NOT_YET_TIME: 'data.error.notYetTime',
    // No shared message exists for an Npay-linked booking; the widget shows its own sentence, a Navis card the generic status refusal.
    NPAY_LINKED_BOOKING: 'data.management.error.BOOKING_TRANSITION',
    CONFIRMATION_REQUIRED: 'data.management.error.BOOKING_TRANSITION',
    // NAVER cancel terms and provider refusals: the widget words them itself; a Navis card gets the generic status refusal.
    CANCEL_REASON_REQUIRED: 'data.management.error.BOOKING_TRANSITION', REFUND_TERMS_REQUIRED: 'data.management.error.BOOKING_TRANSITION',
    REFUND_NOT_APPLICABLE: 'data.management.error.BOOKING_TRANSITION', INVALID_REFUND_TERMS: 'data.management.error.BOOKING_TRANSITION',
    // B06 says the same thing with its own codes when the browser's copy of the booking was behind the service.
    REFUND_REQUIRED: 'data.management.error.BOOKING_TRANSITION',
    BOOKING_PROVIDER_REFUSED: 'data.management.error.BOOKING_TRANSITION',
    STALE_REVISION: 'data.real.error.STALE_REVISION',
  },
  async load({ reads, snapshot, signal }) {
    const today = BUSINESS_CLOCK.date;
    const window = { startDate: addDays(today, -WINDOW.back), endDate: addDays(today, WINDOW.forward) };
    const week = { startDate: addDays(today, -CALL_DAYS), endDate: addDays(today, 1) };
    const list = <T>(resource: string, path: string, query: Record<string, string | number> = {}) =>
      reads.all<T>({ resource, path, query: { limit: PAGE, ...query } }, { signal });
    const [reservations, suggestions, calls, changes, products, tables] = await Promise.all([
      bookings(reads, window, signal),
      list<SuggestionDto>('reservation-suggestions', suggestionsPath),
      optional(() => callDays(reads, week, signal), { period: null as { startDate: string; endDate: string } | null, channels: [] as readonly string[] }),
      optional(() => list<ChangeDto>('reservation-changes', changesPath, week)),
      optional(() => list<BookingProductDto>('booking-products', productsPath)),
      optional(() => list<PosTableDto>('pos.tables', tablesPath, { limit: POS_PAGE })),
    ]);
    // Custom-order pickups belong to the POS service (B08): the F08 rows win when that domain is HTTP, otherwise the rows stay as they are.
    const pickups = snapshot.tables.realCustom ? snapshot.tables.realCustom.pickups : snapshot.tables.reservation.filter(row => row.kind === 'pickup');
    const asOf = [reservations.asOf, suggestions.asOf].sort().at(-1)!;
    const projected = projectBooking({ reservations: reservations.items, suggestions: suggestions.items, calls: calls.items, callPeriod: calls.period, callChannels: calls.channels,
      changes: changes.items, products: products.items, tables: tables.items, asOf, sourceStatus: reservations.naver, pickups });
    return { tables: projected.tables, revisions: projected.revisions, asOf, sourceRevision: Math.max(reservations.sourceRevision, suggestions.sourceRevision),
      complete: reservations.naver === 'ready' && [reservations, suggestions, calls, changes, products, tables].every(page => page.complete) };
  },
  commands: [
    // `idempotencyKey` is the Idempotency-Key header; the server reads the rest of BookingInput from the body.
    defineBinding({ type: 'booking.create', receiptBase, noticeKey: 'data.management.notice.bookingAdded',
      request: command => ({ method: 'POST', path: reservationsPath, body: without(command, META) }) }),
    defineBinding({ type: 'booking.update', receiptBase, noticeKey: 'data.management.notice.bookingEdited',
      request: ({ reservationId, patch, confirmDuplicate }, context) => ({ method: 'PATCH', path: item(reservationId),
        body: { patch, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, expectedRevision: expected(context, reservationId) }) }),
    transition('booking.confirm'),
    transition('booking.propose', ({ time }) => ({ time })),
    transition('booking.cancel', (command, context) => ({ confirmed: true, ...cancelTerms(command, context) })),
    transition('booking.markNoShow'),
    transition('booking.markCompleted'),
    transition('booking.declineSuggestion', () => ({ confirmed: true })),
  ],
};
