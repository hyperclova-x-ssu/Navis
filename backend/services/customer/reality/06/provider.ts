import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { NaverError } from '../../../account/naver/wire.ts';
import { bookingRefundRequired, validBookingRefund, type Booking, type BookingStatus } from '../../../../packages/naver/contracts/pn02/wire.ts';
import { checkRevision, conflict, date, invalid, missing, object, time } from '../07/wire.ts';
import { fingerprint, previousCommand, type Receipt } from './commands.ts';
import { bookLock, recordBookingChange, visitSummary, type Context } from './records.ts';
import { affectedSources, BookingUnavailable, fromUsageAt, naverPrefix, naverRefPattern, parseTransition, sha, stableUuid,
  usageAt, type BookingNaver, type NaverEffect, type OwnerScope, type VisitStatus, type visitList } from './wire.ts';

const localStatuses: Record<BookingStatus, VisitStatus> = {
  requested: 'needs-check', confirmed: 'confirmed', cancelled: 'canceled', completed: 'completed', 'no-show': 'no-show',
};
const providerStatus = (status: VisitStatus | null) =>
  (Object.keys(localStatuses) as BookingStatus[]).find(key => localStatuses[key] === status);

export function naverVisit(booking: Booking) {
  const { bookingNumber, product, npayLinked, paymentAmount } = booking;
  if (!naverRefPattern.test(bookingNumber)) throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
  const status = localStatuses[booking.status];
  const active = status === 'needs-check' || status === 'confirmed';
  const cancelRequiresRefund = bookingRefundRequired(booking);
  const cancel = active || (status === 'completed' && cancelRequiresRefund);
  const guestName = active && booking.maskedName?.includes('*') ? booking.maskedName : null;
  const phone = active && /^\d{2,4}-\*{2,4}-\d{2,4}$/.test(booking.maskedPhone ?? '') ? booking.maskedPhone! : null;
  const revision = parseInt(sha([bookingNumber, booking.usageAt, status, npayLinked, product, paymentAmount]).slice(0, 7), 16) + 1;
  return {
    kind: 'visit' as const, source: 'direct' as const, reservationId: naverPrefix + bookingNumber,
    ...fromUsageAt(booking.usageAt), status, partySize: null, revision, memberId: null, guestName, phone,
    nameKey: 'data.management.guest', request: null, requestKey: null, tableId: null, allocationWarning: null,
    assignmentMode: 'auto' as const, capacityOverride: false, confirmedBy: null, callId: null, proposedTime: null, variant: null,
    sourceMetadata: { kind: 'naver' as const, bookingNumber, product, npayLinked,
      ...(paymentAmount !== undefined && { paymentAmount }) },
    actions: { change: active && !npayLinked, confirm: status === 'needs-check', cancel,
      cancelRequiresRefund, cancelUndoable: false as const },
  };
}

export async function listNaver(naver: BookingNaver | undefined, scope: OwnerScope, filters: ReturnType<typeof visitList>) {
  if (filters.memberId || filters.status === 'proposed' || filters.source === 'local') return { items: [], status: 'ready' as const };
  if (!naver) return { items: [], status: 'unavailable' as const };
  const { start, end, status, q, cursor } = filters;
  const query = { date: start !== null && start === end ? start : undefined, status: providerStatus(status) };
  try {
    const matches = await naver.bookings(scope, query);
    const byName = q && !/^\d+$/.test(q) ? await naver.bookings(scope, { ...query, name: q }) : [];
    const matched = new Set(byName.map(booking => booking.bookingNumber));
    const unique = new Map([...matches, ...byName].map(booking => [booking.bookingNumber, booking]));
    const items = [...unique.values()].map(naverVisit).filter(row =>
      (!cursor || row.reservationId > cursor) && (!start || row.date >= start) && (!end || row.date <= end)
      && (!status || row.status === status) && (!q || matched.has(row.sourceMetadata.bookingNumber)
        || [row.sourceMetadata.bookingNumber, row.guestName].some(value => value?.toLowerCase().includes(q.toLowerCase()))
        || /^\d{1,4}$/.test(q) && row.phone?.endsWith(q)));
    return { items, status: matches.length >= 5_000 || byName.length >= 5_000 ? 'partial' as const : 'ready' as const };
  } catch {
    return { items: [], status: 'unavailable' as const };
  }
}

export async function providerRead<T>(naver: BookingNaver | undefined, read: (service: BookingNaver) => Promise<T>) {
  if (!naver) throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
  try {
    return await read(naver);
  } catch (error) {
    if (error instanceof NaverError && error.status === 404) throw missing('reservationId');
    throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
  }
}

function plan(action: 'update' | 'transition', raw: unknown, visit: ReturnType<typeof naverVisit>, at: Date): NaverEffect {
  const { npayLinked: npay, paymentAmount } = visit.sourceMetadata;
  if (action === 'update') {
    const input = object(raw, ['patch', 'expectedRevision', 'confirmDuplicate']);
    checkRevision(input.expectedRevision, visit.revision);
    if (npay) throw conflict('NPAY_LINKED_BOOKING', 'reservationId');
    if (!visit.actions.change) throw conflict('BOOKING_TRANSITION', 'reservationId');
    const patch = object(input.patch, ['date', 'time']);
    if (!Object.keys(patch).length) throw invalid('patch');
    const requested = usageAt(patch.date === undefined ? visit.date : date(patch.date, 'date'),
      patch.time === undefined ? visit.time : time(patch.time, 'time'));
    if (Date.parse(requested) < at.getTime()) throw invalid('time', 'BOOKING_PAST');
    return { kind: 'change', usageAt: requested };
  }
  const { cancelReason, refund, ...transition } = object(raw, ['type', 'time', 'expectedRevision', 'confirmed', 'cancelReason', 'refund']);
  const input = parseTransition(transition);
  checkRevision(input.expectedRevision, visit.revision);
  if (input.type !== 'booking.cancel' && (cancelReason !== undefined || refund !== undefined)) throw invalid('cancelReason');
  if (input.type === 'booking.propose' && npay) throw conflict('NPAY_LINKED_BOOKING', 'reservationId');
  if (input.type === 'booking.confirm' && visit.actions.confirm) return { kind: 'confirm' };
  if (input.type === 'booking.cancel' && visit.actions.cancel) {
    if (typeof cancelReason !== 'string' || !cancelReason.trim() || cancelReason.includes('\0')) {
      throw invalid('cancelReason', 'CANCEL_REASON_REQUIRED');
    }
    const required = visit.actions.cancelRequiresRefund;
    if (refund === undefined) {
      if (required) throw invalid('refund', 'REFUND_REQUIRED');
      return { kind: 'cancel', cancelReason: cancelReason.trim() };
    }
    if (!required || !validBookingRefund(refund, paymentAmount)) throw invalid('refund', 'INVALID_REFUND_TERMS');
    return { kind: 'cancel', cancelReason: cancelReason.trim(), refund };
  }
  throw conflict('BOOKING_TRANSITION', 'reservationId');
}

type Pending = { before: ReturnType<typeof visitSummary>; effect: NaverEffect };
type ProviderCommand = OwnerScope & {
  pool: Pool; naver: BookingNaver; action: 'update' | 'transition'; id: string; key: string; raw: unknown; now: () => Date;
};

const pendingLifetimeMs = 5 * 60_000;
type Journal = { actor_id: string; key: string; receipt_id: string; provider_effect: Pending; provider_expires_at: Date };

function observedEffect(booking: Booking, effect: NaverEffect) {
  if (effect.kind === 'change') return Date.parse(booking.usageAt) === Date.parse(effect.usageAt);
  return booking.status === (effect.kind === 'confirm' ? 'confirmed' : 'cancelled');
}

export async function runProviderCommand({ pool, naver, action, id, key, raw, storeId, actorId, now }: ProviderCommand) {
  const ref = id.slice(naverPrefix.length);
  const hash = fingerprint(action, id, raw);
  const scope = { storeId, actorId };
  // Serialize only this provider booking across processes. Commit the journal
  // before sending and keep the provider calls outside database transactions.
  const db = await pool.connect();
  const lock = JSON.stringify(['booking-provider', storeId, ref]);
  let locked = false;
  let discard = true;
  const inScope = async <T>(handle: (ctx: Context) => Promise<T>) => {
    await db.query('BEGIN');
    try {
      await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
      const result = await handle({ db, ...scope, at: now() });
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    }
  };

  async function readBooking(outcomeUnknown: boolean) {
    try {
      const booking = await providerRead(naver, service => service.booking(scope, ref));
      if (!booking) throw missing('reservationId');
      if (naverVisit(booking).reservationId !== id) throw new BookingUnavailable('BOOKING_PROVIDER_UNAVAILABLE');
      return booking;
    } catch (error) {
      if (outcomeUnknown) throw new BookingUnavailable('BOOKING_PROVIDER_OUTCOME_UNKNOWN');
      throw error;
    }
  }

  const remove = (entry: Journal) => inScope(ctx => ctx.db.query(
    'DELETE FROM customer.booking_command WHERE store_id = $1 AND receipt_id = $2 AND receipt IS NULL',
    [storeId, entry.receipt_id]));

  const expire = (entry: Journal) => inScope(ctx => ctx.db.query(`
    UPDATE customer.booking_command SET provider_ref = NULL, provider_effect = NULL, provider_expired_at = $3
    WHERE store_id = $1 AND receipt_id = $2 AND receipt IS NULL`, [storeId, entry.receipt_id, ctx.at]));

  const settle = (entry: Journal, booking: Booking) => inScope(async ctx => {
    await bookLock(ctx);
    const { effect, before } = entry.provider_effect;
    const after = visitSummary(naverVisit(booking));
    const changed = before.revision !== after.revision;
    const receipt: Receipt = { resourceId: id, reservationId: id, revision: after.revision, receiptId: entry.receipt_id,
      status: after.status, changed, affectedSources: changed ? affectedSources : [],
      ...(effect.kind === 'cancel' && { undoable: false as const }) };
    if (changed) {
      const kind = effect.kind === 'change' ? 'updated' : effect.kind === 'cancel' ? 'canceled' : 'status';
      await recordBookingChange(ctx, before, after, kind, stableUuid(storeId, 'naver-booking', ref));
    }
    await ctx.db.query(`UPDATE customer.booking_command SET receipt = $3, provider_ref = NULL, provider_effect = NULL
      WHERE store_id = $1 AND receipt_id = $2`, [storeId, entry.receipt_id, receipt]);
    return receipt;
  });

  try {
    const result = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock]);
    locked = result.rows[0].locked;
    discard = false;
    if (!locked) throw conflict('BOOKING_PROVIDER_PENDING', 'reservationId');

    const { previous, pending } = await inScope(async ctx => {
      const previous = await previousCommand(ctx, key, hash);
      const { rows: [pending] } = await db.query<Journal>(`
        SELECT actor_id, key, receipt_id, provider_effect, provider_expires_at
        FROM customer.booking_command WHERE store_id = $1 AND provider_ref = $2 AND receipt IS NULL`, [storeId, ref]);
      return { previous, pending };
    });
    if (previous?.receipt) return previous.receipt;
    const booking = await readBooking(Boolean(pending));
    let entry: Journal | undefined = pending;
    if (entry) {
      const sameCommand = entry.actor_id === actorId && entry.key === key;
      if (observedEffect(booking, entry.provider_effect.effect)) {
        const receipt = await settle(entry, booking);
        if (sameCommand) return receipt;
        entry = undefined;
      } else if (naverVisit(booking).revision !== entry.provider_effect.before.revision ||
        (!sameCommand && entry.provider_expires_at.getTime() <= now().getTime())) {
        await expire(entry);
        if (sameCommand) throw conflict('BOOKING_PROVIDER_RETRY', 'reservationId');
        entry = undefined;
      } else if (!sameCommand) {
        throw conflict('BOOKING_PROVIDER_PENDING', 'reservationId');
      }
    }

    if (!entry) {
      const visit = naverVisit(booking);
      const at = now();
      const next: Journal = { actor_id: actorId, key, receipt_id: randomUUID(),
        provider_effect: { before: visitSummary(visit), effect: plan(action, raw, visit, at) },
        provider_expires_at: new Date(at.getTime() + pendingLifetimeMs) };
      await inScope(async ctx => {
        await bookLock(ctx);
        const { rowCount } = await db.query(`
          INSERT INTO customer.booking_command (store_id, actor_id, key, fingerprint, receipt_id, provider_ref, provider_effect, provider_expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [storeId, actorId, key, hash, next.receipt_id, ref, next.provider_effect, next.provider_expires_at]);
        if (!rowCount) throw conflict('IDEMPOTENCY_MISMATCH');
      });
      entry = next;
    }

    const { effect } = entry.provider_effect;
    let response: Booking;
    try {
      response = await naver.bookingCommand(scope, {
        key: 'booking:' + entry.receipt_id, ...(effect.kind === 'cancel' && { extraConfirmed: true }),
      }, ref, effect);
    } catch (error) {
      // A missing read-back or transport failure can follow a successful write.
      if (!(error instanceof NaverError) || ![400, 403, 409].includes(error.status)) {
        throw new BookingUnavailable('BOOKING_PROVIDER_OUTCOME_UNKNOWN');
      }
      await remove(entry);
      throw conflict(error.code === 'NPAY_LINKED_BOOKING' ? error.code : 'BOOKING_PROVIDER_REFUSED', 'reservationId');
    }
    if (response.bookingNumber !== ref || !observedEffect(response, effect)) {
      throw new BookingUnavailable('BOOKING_PROVIDER_OUTCOME_UNKNOWN');
    }
    return await settle(entry, response);
  } finally {
    try {
      if (locked && !discard) await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    } catch {
      discard = true;
    } finally {
      db.release(discard);
    }
  }
}
