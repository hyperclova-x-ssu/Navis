import { isDeepStrictEqual } from 'node:util';
import { PermanentStreamError, type StreamHandler } from '../../../../packages/streams/index.ts';
import { lockClaim, settleClaim } from '../../claims.ts';
import { isRecord, isUuid } from '../../pos-client.ts';
import { choice, date, integer, object, ScheduleError, time, uuid } from '../07/wire.ts';
import { bumpBookingRevision, type Page, type Scope } from './records.ts';

type Pickup = {
  kind: 'pickup'; reservationId: string; customOrderId: string; date: string; time: string;
  status: 'confirmed' | 'completed' | 'canceled'; updatedAt: string;
};

function parsePickup(value: unknown, orderId: string): Pickup | null {
  if (value === null) return null;
  const input = object(value, ['kind', 'reservationId', 'customOrderId', 'date', 'time', 'status', 'updatedAt']);
  if (input.kind !== 'pickup' || input.customOrderId !== orderId || typeof input.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(input.updatedAt))) throw new PermanentStreamError('INVALID_PICKUP_PROJECTION');
  return { kind: 'pickup', customOrderId: orderId, reservationId: uuid(input.reservationId, 'reservationId'),
    date: date(input.date, 'date'), time: time(input.time, 'time'), updatedAt: new Date(input.updatedAt).toISOString(),
    status: choice(input.status, ['confirmed', 'completed', 'canceled'], 'status') };
}

const pickupChanged: StreamHandler = async (db, envelope) => {
  const { storeId, aggregateId, scopeKey, payload } = envelope;
  if (!isUuid(storeId) || storeId !== scopeKey || !isUuid(aggregateId) || !isRecord(payload)) {
    throw new PermanentStreamError('INVALID_PICKUP_PROJECTION');
  }
  if (!('pickupProjection' in payload)) return;
  let pickup: Pickup | null, revision: number;
  try {
    pickup = parsePickup(payload.pickupProjection, aggregateId);
    revision = integer(payload.revision, 'revision', 1);
  } catch (error) {
    if (error instanceof ScheduleError) throw new PermanentStreamError('INVALID_PICKUP_PROJECTION');
    throw error;
  }
  const result = await db.query(`
    INSERT INTO customer.booking_pickup (store_id, custom_order_id, revision, pickup, date) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (store_id, custom_order_id) DO UPDATE SET revision = EXCLUDED.revision,
      pickup = EXCLUDED.pickup, date = EXCLUDED.date WHERE booking_pickup.revision < EXCLUDED.revision`,
  [storeId, aggregateId, revision, pickup, pickup?.date ?? null]);
  if (result.rowCount) {
    await bumpBookingRevision({ db, storeId, at: new Date(envelope.occurredAt) });
    return;
  }
  const { rows: [current] } = await db.query<{ revision: number; pickup: Pickup | null }>(
    'SELECT revision, pickup FROM customer.booking_pickup WHERE store_id = $1 AND custom_order_id = $2', [storeId, aggregateId]);
  if (current?.revision === revision && !isDeepStrictEqual(current.pickup, pickup)) {
    throw new PermanentStreamError('PICKUP_PROJECTION_REVISION_CONFLICT');
  }
};

const reservationOrderLinked: StreamHandler = async (db, envelope) => {
  const { storeId, scopeKey, aggregateId, payload, occurredAt } = envelope;
  const { claimId, reservationId, sourceVersion, billId, orderId, tableId } = payload;
  const at = new Date(occurredAt);
  if (!isUuid(storeId) || storeId !== scopeKey || !isUuid(claimId) || !isUuid(reservationId) || reservationId !== aggregateId
    || typeof sourceVersion !== 'number' || !Number.isInteger(sourceVersion) || sourceVersion < 1
    || !isUuid(billId) || !isUuid(orderId) || (tableId !== null && !isUuid(tableId)) || !Number.isFinite(at.getTime())) {
    throw new PermanentStreamError('INVALID_RESERVATION_ORDER_LINK');
  }
  const claim = await lockClaim(db, storeId, claimId);
  if (!claim || !claim.reservationBinding || claim.kind !== 'reservation_first_order' || claim.sourceId !== reservationId
    || claim.sourceVersion !== sourceVersion || claim.reservationBinding.tableId !== tableId
    || (claim.state !== 'held' && (claim.state !== 'committed' || claim.billId !== billId || claim.orderId !== orderId))) {
    throw new PermanentStreamError('RESERVATION_ORDER_LINK_MISMATCH');
  }
  await settleClaim(db, storeId, claim, { status: 'linked', order: { billId, orderId, tableId } }, at);
};

export const bookingPosProjectionHandlers = {
  'pos.custom_pickup_changed.v1': pickupChanged,
  'pos.reservation_order_linked.v1': reservationOrderLinked,
};

export async function listPickups({ db, storeId }: Scope, { limit, cursor, start, end }: Page) {
  const { rows } = await db.query<{ pickup: Pickup; revision: number }>(`
    SELECT pickup, revision FROM customer.booking_pickup
    WHERE store_id = $1 AND date IS NOT NULL AND ($2::uuid IS NULL OR custom_order_id > $2)
      AND ($3::date IS NULL OR date >= $3) AND ($4::date IS NULL OR date <= $4)
    ORDER BY custom_order_id LIMIT $5`, [storeId, cursor, start, end, limit + 1]);
  return rows.map(({ pickup, revision }) => ({ ...pickup, revision }));
}
