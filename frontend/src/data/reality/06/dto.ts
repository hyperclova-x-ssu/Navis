/**
 * REAL-PLAN F06 — wire types of the booking API (B06, customer service) and their projection into the existing
 * `reservation` / `reservationChange` / `callLog` tables. The widget, `selectReservations` and the Navis booking
 * domain keep reading those tables, so nothing downstream changes.
 *
 * Contract: `.evidence/real/B06-booking-dto.md` plus the B06 confirmation (msg_e6219ec25e39). Visit rows keep the existing
 * reservation fields; a NAVER row adds `sourceMetadata` and may have no party size (never invented); a pending AiCall
 * candidate has its own UUID and is shown as a waiting phone request until the owner presses [확정하기].
 */
import type { DataTables, Reservation, ReservationStatus } from '../../db/types';
import type { ReservationChange } from '../../db/management-types';

export interface NaverSourceMetadata {
  readonly kind: 'naver';
  readonly bookingNumber: string;
  readonly product: string;
  /** An Npay-linked booking cannot be changed here (409 `NPAY_LINKED_BOOKING`); only cancel guidance remains. */
  readonly npayLinked: boolean;
  /** The booking's payment amount in won as the owner view shows it (PN-FIX-2), when the projection carries it: an amount refund may not exceed it. Absent: no amount refund is offered. */
  readonly paymentAmount?: number;
}

/**
 * What the service says the owner may do with a NAVER booking (B06 `actions`). The widget draws only these; the service re-checks on the press.
 * `cancelRequiresRefund` is a confirmed or completed Npay booking (the provider takes refund terms with the cancel), and a NAVER cancel has no inverse (`cancelUndoable:false`).
 */
export interface BookingActions {
  readonly change: boolean;
  readonly confirm: boolean;
  readonly cancel: boolean;
  readonly cancelRequiresRefund: boolean;
  readonly cancelUndoable: boolean;
}

export interface ReservationDto {
  readonly reservationId: string;
  readonly date: string;
  readonly time: string;
  /** `null` for a NAVER booking that did not carry one: the table row holds 0 and the widget shows "—" (never a made-up party). */
  readonly partySize: number | null;
  readonly status: ReservationStatus;
  readonly source: 'phone_ai' | 'direct';
  readonly confirmedBy?: 'auto' | 'person' | null;
  readonly callId?: string | null;
  readonly proposedTime?: string | null;
  /** Raw, nullable: a member booking carries the member id instead. NAVER rows carry NAVER's masked name/number. */
  readonly guestName?: string | null;
  readonly phone?: string | null;
  readonly request?: string | null;
  readonly memberId?: string | null;
  readonly tableId?: string | null;
  readonly assignmentMode?: 'auto' | 'manual' | null;
  readonly allocationWarning?: string | null;
  readonly capacityOverride?: boolean;
  readonly revision: number;
  readonly sourceMetadata?: NaverSourceMetadata | null;
  /** Present on NAVER rows (B06); a local visit has none. */
  readonly actions?: BookingActions | null;
}

/** A booking request taken by the owner's smart-call number (AiCall). Nothing is confirmed until the owner presses the card. */
export interface SuggestionDto {
  readonly suggestionId: string;
  readonly callAt: string;
  readonly date: string;
  readonly time: string;
  readonly partySize: number;
  /** `null` when contact retention is off: the request is shown without a number. */
  readonly phoneMasked: string | null;
  readonly request?: string | null;
  /** `proposed`: the owner suggested another time (a local record, nothing is sent); the row shows 제안함 and no longer counts. */
  readonly status: 'pending' | 'proposed' | 'accepted' | 'declined';
  readonly proposedTime?: string | null;
  /** The reservation an accepted candidate became. */
  readonly reservationId: string | null;
  readonly revision: number;
}

/** SmartCall (PN08) daily aggregates, the only call data that exists: no recording, no summary, no per-call row, no number. */
export interface CallDayDto {
  readonly date: string;
  readonly totalCalls: number;
  readonly connectedCalls: number;
  readonly arsCalls: number;
  readonly missedCalls: number;
  readonly busyCalls: number;
  readonly averageDurationSeconds: number | null;
  readonly callsAtLeastTenSeconds: number;
}

export interface ChangeDto {
  readonly changeId: string;
  readonly reservationId: string;
  readonly at: string;
  readonly kind: ReservationChange['kind'];
}

/** PN02 general-type booking product: the name is all the provider gives (no interval, occupancy, prepayment or menu). */
export interface BookingProductDto {
  readonly name: string;
}

/** A POS table as the B02 service lists it. `tableId` is the service's UUID (kept for edits and claims); `layoutTableId` is the id the POS table map and the booking widget use. */
export interface PosTableDto {
  readonly tableId: string;
  readonly label: string;
  readonly seats?: number;
  readonly layoutTableId?: string | null;
  readonly state?: string;
}

export type BookingOrigin = 'local' | 'naver' | 'call';
export interface BookingMeta {
  readonly origin: BookingOrigin;
  readonly bookingNumber?: string;
  readonly product?: string;
  readonly npayLinked?: boolean;
  /** The payment amount the provider showed for an Npay booking, when it did (bounds an amount refund). */
  readonly paymentAmount?: number;
  /** False for a NAVER booking without a party size. */
  readonly partyKnown: boolean;
  /** The service's eligibility for this NAVER booking (absent: `naverRules` derives the same rule from the status and the Npay flag). */
  readonly actions?: BookingActions;
  /** The service revision: the sourceVersion of a first-order claim and the base of the next command. */
  readonly revision?: number;
  /** The POS table's service UUID (edits and claims) and its label (what the owner reads). */
  readonly tableUuid?: string;
  readonly tableLabel?: string;
  /** The row is a pending AiCall candidate (its id is the suggestion id). */
  readonly candidate?: { readonly callAt: string; readonly phoneMasked: string | null };
}

/** Scoped fields the booking domain adds beside the shared tables. Absent in fixture mode. */
export type SourceStatus = 'ready' | 'partial' | 'unavailable';
export interface RealBookingSnapshot {
  readonly meta: Readonly<Record<string, BookingMeta>>;
  /** The mixed booking list says whether the NAVER side was read completely; a partial or unavailable one is shown as such, never as "no bookings". */
  readonly sourceStatus: { readonly naver: SourceStatus };
  /** SmartCall daily aggregates of `callPeriod` (null when the read failed or has not run). */
  readonly calls: readonly CallDayDto[];
  readonly callPeriod: { readonly startDate: string; readonly endDate: string } | null;
  readonly callChannels: readonly string[];
  readonly products: readonly BookingProductDto[];
  /** The store's POS tables, for the label shown instead of a UUID. */
  readonly tables: readonly PosTableDto[];
  readonly asOf: string;
}

export const bookingKey = (id: string) => `booking:${id}`;

const isActions = (value: unknown): value is BookingActions => !!value && typeof value === 'object'
  && (['change', 'confirm', 'cancel', 'cancelRequiresRefund', 'cancelUndoable'] as const).every(name => typeof (value as Record<string, unknown>)[name] === 'boolean');

/** What the owner may do with a NAVER booking: the service's `actions`, else the same rule from the status and the Npay flag (a confirmed or completed Npay booking is refundable, so it can be cancelled). */
export interface NaverRules { readonly change: boolean; readonly confirm: boolean; readonly cancel: boolean; readonly requiresRefund: boolean; readonly undoable: boolean }
export function naverRules(meta: BookingMeta | undefined, status: ReservationStatus): NaverRules | null {
  if (meta?.origin !== 'naver') return null;
  if (meta.actions) return { change: meta.actions.change, confirm: meta.actions.confirm, cancel: meta.actions.cancel, requiresRefund: meta.actions.cancelRequiresRefund, undoable: meta.actions.cancelUndoable };
  const active = status === 'needs-check' || status === 'confirmed';
  const requiresRefund = (status === 'confirmed' || status === 'completed') && meta.npayLinked === true;
  return { change: active && meta.npayLinked !== true, confirm: status === 'needs-check', cancel: active || (status === 'completed' && requiresRefund), requiresRefund, undoable: false };
}
const text = (value: string | null | undefined) => value ? { raw: value } : undefined;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The POS table a booking points at, found by the service UUID (B06) or by the layout id (older rows). */
function tableOf(tables: readonly PosTableDto[], id: string | null | undefined): PosTableDto | undefined {
  return id ? tables.find(table => table.tableId === id || table.layoutTableId === id) : undefined;
}

/** The table fields of a row's meta: the UUID stays for commands and claims, the label is what the screens show. */
function tableMeta(table: PosTableDto | undefined, id: string | null | undefined) {
  const uuid = table?.tableId ?? (id && UUID.test(id) ? id : undefined);
  return { ...(uuid ? { tableUuid: uuid } : {}), ...(table?.label ? { tableLabel: table.label } : {}) };
}

function visitRow(dto: ReservationDto, table: PosTableDto | undefined): Reservation {
  return {
    kind: 'visit', reservationId: dto.reservationId, date: dto.date, time: dto.time, partySize: dto.partySize ?? 0,
    nameKey: 'data.management.guest', requestKey: null, source: dto.source, status: dto.status,
    confirmedBy: dto.confirmedBy ?? null, callId: dto.callId ?? null, proposedTime: dto.proposedTime ?? null, variant: null,
    ...(dto.memberId ? { memberId: dto.memberId } : {}),
    ...(dto.guestName ? { guestName: { raw: dto.guestName } } : {}),
    ...(dto.phone ? { phone: { raw: dto.phone } } : {}),
    request: text(dto.request) ?? null,
    // The POS table map and the booking selects speak layout ids; the service UUID stays in `meta` for edits and claims.
    tableId: table?.layoutTableId ?? dto.tableId ?? null,
    ...(dto.assignmentMode ? { assignmentMode: dto.assignmentMode } : {}),
    ...(dto.allocationWarning ? { allocationWarning: dto.allocationWarning } : {}),
    ...(dto.capacityOverride ? { capacityOverride: true } : {}),
  };
}

function candidateRow(dto: SuggestionDto): Reservation {
  return {
    kind: 'visit', reservationId: dto.suggestionId, date: dto.date, time: dto.time, partySize: dto.partySize,
    nameKey: 'data.management.guest', requestKey: null, source: 'phone_ai', status: dto.status === 'proposed' ? 'proposed' : 'needs-check',
    confirmedBy: null, callId: null, proposedTime: dto.status === 'proposed' ? dto.proposedTime ?? null : null, variant: null,
    ...(dto.phoneMasked ? { phone: { raw: dto.phoneMasked } } : {}), request: text(dto.request) ?? null, tableId: null,
  };
}

export interface BookingPages {
  readonly reservations: readonly ReservationDto[];
  readonly suggestions: readonly SuggestionDto[];
  readonly calls: readonly CallDayDto[];
  readonly callPeriod?: { readonly startDate: string; readonly endDate: string } | null;
  readonly callChannels?: readonly string[];
  readonly changes: readonly ChangeDto[];
  readonly products: readonly BookingProductDto[];
  readonly tables?: readonly PosTableDto[];
  readonly asOf: string;
  readonly sourceStatus?: SourceStatus;
  /** Pickup rows other domains own; they stay in the `reservation` table untouched. */
  readonly pickups: DataTables['reservation'];
}

/** Rows for the tables, plus the resource revisions the commands send back as `expectedRevision`. */
export function projectBooking(pages: BookingPages): { readonly tables: Pick<DataTables, 'reservation' | 'reservationChange' | 'callLog' | 'realBooking'>; readonly revisions: Readonly<Record<string, number>> } {
  const revisions: Record<string, number> = {};
  const meta: Record<string, BookingMeta> = {};
  const visits = new Map<string, Reservation>();
  const tables = pages.tables ?? [];
  for (const dto of pages.reservations) {
    const table = tableOf(tables, dto.tableId);
    visits.set(dto.reservationId, visitRow(dto, table));
    revisions[bookingKey(dto.reservationId)] = dto.revision;
    const naver = dto.sourceMetadata?.kind === 'naver' ? dto.sourceMetadata : null;
    meta[dto.reservationId] = naver
      ? { origin: 'naver', bookingNumber: naver.bookingNumber, product: naver.product, npayLinked: naver.npayLinked,
        ...(Number.isSafeInteger(naver.paymentAmount) && naver.paymentAmount! >= 0 ? { paymentAmount: naver.paymentAmount } : {}), partyKnown: dto.partySize !== null, revision: dto.revision,
        ...(isActions(dto.actions) ? { actions: dto.actions } : {}) }
      : { origin: dto.source === 'phone_ai' ? 'call' : 'local', partyKnown: dto.partySize !== null, revision: dto.revision, ...tableMeta(table, dto.tableId) };
  }
  for (const dto of pages.suggestions) {
    if (!(dto.status === 'pending' || dto.status === 'proposed') || visits.has(dto.suggestionId)) continue;
    visits.set(dto.suggestionId, candidateRow(dto));
    revisions[bookingKey(dto.suggestionId)] = dto.revision;
    meta[dto.suggestionId] = { origin: 'call', partyKnown: true, revision: dto.revision, candidate: { callAt: dto.callAt, phoneMasked: dto.phoneMasked } };
  }
  return {
    tables: {
      reservation: [...visits.values(), ...pages.pickups],
      // Before/after bodies are not kept: they can hold names and numbers. The count and kind are all the briefing reads.
      reservationChange: pages.changes.map(change => ({ changeId: change.changeId, reservationId: change.reservationId, at: change.at, kind: change.kind, before: null, after: null })),
      // No call summary, recording or per-call row exists; the daily aggregates live in `realBooking.calls`.
      callLog: [],
      realBooking: { meta, sourceStatus: { naver: pages.sourceStatus ?? 'ready' }, calls: pages.calls, callPeriod: pages.callPeriod ?? null,
        callChannels: pages.callChannels ?? [], products: pages.products, tables, asOf: pages.asOf },
    },
    revisions,
  };
}
