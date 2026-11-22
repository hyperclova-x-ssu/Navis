/**
 * REAL-PLAN F06-2 — the first order of a seated reservation (B06 seam, `.evidence/real/B06-booking-dto.md` "First postpaid order").
 *
 * From the explicit order press on a table whose reservation is in its window, the booking is CLAIMED first
 * (`POST /reservations/:id/first-order-claim {sourceVersion}`, its own idempotency key) and the claim's `commandKey` becomes the idempotency key of the
 * POS bill (`POST /pos/bills` with `reservationId`). POS records the order, the receipt and the link event in one transaction; the customer service completes
 * the visit from that event. Nothing here runs without the owner's press, and no provider is called.
 *
 * A claim the service refuses for good (the booking changed, left its window, is already claimed or linked) never blocks the order: the order is placed as an
 * ordinary table bill and the owner is told the booking was not linked. An unknown outcome (network, 5xx after send, a bind not yet confirmed) is NOT a
 * refusal: it throws with `outcomeUnknown`, and the same keys are resent on the next press, so a second claim or second bill is never made.
 */
import { PortError, type PortRequest } from '../00/port';
import { toPortError } from '../00/transport';

export interface FirstOrderReservation {
  readonly reservationId: string;
  /** The booking's service revision from the last read (`realBooking.meta[id].revision`). */
  readonly sourceVersion: number;
}

export type ClaimSend = <T>(request: Omit<PortRequest, 'idempotencyKey'>, key: string) => Promise<T>;

interface ClaimView { readonly claimId: string; readonly state: string; readonly commandKey?: string; readonly releaseReason?: string | null }
export type ClaimOutcome =
  | { readonly status: 'bound'; readonly claimId: string; readonly commandKey: string }
  | { readonly status: 'refused'; readonly reason: string };

/** A lost session or a store change ends the whole screen; it is never read as "this booking cannot be claimed". */
const SESSION_CODES = new Set(['UNAUTHENTICATED', 'STORE_FORBIDDEN', 'TOKEN_EXPIRED']);
const RECONCILE_ATTEMPTS = 3;

export const claimKey = (orderKey: string) => `claim:${orderKey}`;
const claimPath = (reservationId: string) => `/reservations/${encodeURIComponent(reservationId)}/first-order-claim`;

export async function claimFirstOrder(send: ClaimSend, reservation: FirstOrderReservation, orderKey: string, sleep: (ms: number) => Promise<void>): Promise<ClaimOutcome> {
  let view: ClaimView;
  try {
    view = await send<ClaimView>({ method: 'POST', path: claimPath(reservation.reservationId), body: { sourceVersion: reservation.sourceVersion } }, claimKey(orderKey));
  } catch (error) {
    const failed = toPortError(error, 'POST');
    if (failed.outcomeUnknown || SESSION_CODES.has(failed.code)) throw failed;
    return { status: 'refused', reason: failed.reason ?? failed.code };
  }
  for (let attempt = 0; ; attempt += 1) {
    if (view.state === 'released') return { status: 'refused', reason: view.releaseReason ?? 'RESERVATION_UNAVAILABLE' };
    // `committed`: a resend after POS already recorded this very order; the bill call below returns the stored receipt for the same key.
    if ((view.state === 'held' || view.state === 'committed') && view.commandKey) return { status: 'bound', claimId: view.claimId, commandKey: view.commandKey };
    // Held without a command key: the bind to POS is not confirmed yet. Ask the service to reconcile and look again; never place the order on a private key.
    if (attempt >= RECONCILE_ATTEMPTS || view.state !== 'held') throw new PortError(502, 'SERVICE_UNAVAILABLE', 'CLAIM_NOT_CONFIRMED', undefined, true);
    await sleep(300 * (attempt + 1));
    view = await send<ClaimView>({ method: 'POST', path: `/claims/${encodeURIComponent(view.claimId)}/reconcile`, body: {} }, `reconcile:${view.claimId}:${attempt}`);
  }
}

/** The bill was refused for good after the claim was held: let the booking go again (the service first checks that POS did not already commit the order). */
export async function abortClaim(send: ClaimSend, claimId: string): Promise<void> {
  try {
    await send({ method: 'POST', path: `/claims/${encodeURIComponent(claimId)}/abort`, body: {} }, `abort:${claimId}`);
  } catch {
    // The hold expires on its own; the order failure is what the owner is told.
  }
}

/** Dependent domains a linked first order changes: the booking list (the visit completes) and the calendar projection that reads it. */
export const FIRST_ORDER_DOMAINS = ['booking', 'staff'] as const;
export const BOOKING_SOURCES = ['voice-booking', 'reservations', 'calendar'] as const;
