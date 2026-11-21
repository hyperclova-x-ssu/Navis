import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ClaimKind, PosClaim, PosOutcome, SaleLink } from './pos-client.ts';

type ClaimState = 'held' | 'committed' | 'released' | 'restored';
export type Claim = PosClaim & {
  actorId: string;
  state: ClaimState;
  posBound: boolean;
  settlementId: string | null;
  billId: string | null;
  orderId: string | null;
  releaseReason: 'aborted' | 'rejected' | null;
};
type Source = { version: number; status: string };
type Reservation = Source & { table_archived: boolean; first_order_id: string | null };
type Membership = Source & { eligible: boolean | null; uses_left: number };

const claimFields = `claim_id AS "claimId", command_key AS "commandKey", actor_id AS "actorId",
  COALESCE(reservation_id, membership_id) AS "sourceId", source_version AS "sourceVersion",
  CASE WHEN reservation_id IS NULL THEN 'membership_use' ELSE 'reservation_first_order' END AS kind,
  state, pos_bound AS "posBound", settlement_id AS "settlementId", bill_id AS "billId",
  order_id AS "orderId", release_reason AS "releaseReason"`;

export class ClaimError extends Error {
  readonly status: 400 | 404 | 409;
  readonly reason: string;

  constructor(status: 400 | 404 | 409, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

export async function withCustomerStore<T>(pool: Pool, storeId: string, action: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

async function lockRequest(db: PoolClient, storeId: string, namespace: string, key: string) {
  await db.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, $2::text, $3::text)::text, 0))
  `, [namespace, storeId, key]);
}

async function lockReservation(db: PoolClient, storeId: string, id: string) {
  const { rows: [row] } = await db.query<Reservation>(`
    SELECT version, status, table_archived, first_order_id
    FROM customer.reservation WHERE store_id = $1 AND reservation_id = $2 FOR UPDATE
  `, [storeId, id]);
  return row;
}

async function lockMembership(db: PoolClient, storeId: string, id: string, businessDate: string | null = null) {
  const { rows: [row] } = await db.query<Membership>(`
    SELECT version, status, uses_left, $3::date BETWEEN starts_on AND ends_on AS eligible
    FROM customer.membership WHERE store_id = $1 AND membership_id = $2 FOR UPDATE
  `, [storeId, id, businessDate]);
  return row;
}

export async function readClaim(db: PoolClient, storeId: string, claimId: string) {
  const { rows: [row] } = await db.query<Claim>(`
    SELECT ${claimFields} FROM customer.pos_claim WHERE store_id = $1 AND claim_id = $2
  `, [storeId, claimId]);
  return row;
}

export async function lockClaim(db: PoolClient, storeId: string, claimId: string) {
  const claim = await readClaim(db, storeId, claimId);
  if (!claim) return;
  // Acquisition, cancellation and finalization all lock the source before changing its claim.
  if (claim.kind === 'reservation_first_order') {
    await lockReservation(db, storeId, claim.sourceId);
  } else {
    await lockMembership(db, storeId, claim.sourceId);
  }
  return readClaim(db, storeId, claimId);
}

async function bookingClaimHeld(db: PoolClient, storeId: string, reservationId: string) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM customer.pos_claim WHERE store_id = $1 AND reservation_id = $2 AND state = 'held'
  `, [storeId, reservationId]);
  return Boolean(rowCount);
}

type RequestIdentity = { sourceId: string; sourceVersion: number; actorId: string; requestKey: string };

function assertSameSource(stored: Omit<RequestIdentity, 'requestKey'>, request: RequestIdentity) {
  if (stored.sourceId !== request.sourceId || stored.sourceVersion !== request.sourceVersion || stored.actorId !== request.actorId) {
    throw new ClaimError(409, 'IDEMPOTENCY_MISMATCH');
  }
}

function checkVersion(source: Source | undefined, version: number): asserts source is Source {
  if (!source) throw new ClaimError(404, 'SOURCE_NOT_FOUND');
  if (source.version !== version) throw new ClaimError(409, 'STALE_SOURCE_VERSION');
}

export async function reserveClaim(
  db: PoolClient, storeId: string, kind: ClaimKind, request: RequestIdentity, businessDate: string,
): Promise<Claim> {
  const { sourceId, sourceVersion, actorId, requestKey } = request;
  await lockRequest(db, storeId, 'customer:claim', requestKey);
  const { rows: [existing] } = await db.query<Claim>(`
    SELECT ${claimFields} FROM customer.pos_claim WHERE store_id = $1 AND request_key = $2
  `, [storeId, requestKey]);
  if (existing) {
    assertSameSource(existing, request);
    if (existing.kind !== kind) throw new ClaimError(409, 'IDEMPOTENCY_MISMATCH');
    return existing;
  }

  if (kind === 'reservation_first_order') {
    const reservation = await lockReservation(db, storeId, sourceId);
    checkVersion(reservation, sourceVersion);
    if (reservation.status !== 'confirmed' || reservation.table_archived || reservation.first_order_id) {
      throw new ClaimError(409, 'RESERVATION_UNAVAILABLE');
    }
    if (await bookingClaimHeld(db, storeId, sourceId)) throw new ClaimError(409, 'RESERVATION_CLAIM_PENDING');
  } else {
    const membership = await lockMembership(db, storeId, sourceId, businessDate);
    checkVersion(membership, sourceVersion);
    if (membership.status !== 'active' || !membership.eligible || !membership.uses_left) {
      throw new ClaimError(409, 'MEMBERSHIP_UNAVAILABLE');
    }
    await db.query('UPDATE customer.membership SET uses_left = uses_left - 1 WHERE store_id = $1 AND membership_id = $2',
      [storeId, sourceId]);
  }

  const { rows: [claim] } = await db.query<Claim>(`
    INSERT INTO customer.pos_claim (store_id, claim_id, request_key, command_key, actor_id, source_version,
      reservation_id, membership_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING ${claimFields}
  `, [storeId, randomUUID(), requestKey, `customer:${randomUUID()}`, actorId, sourceVersion,
    kind === 'reservation_first_order' ? sourceId : null, kind === 'membership_use' ? sourceId : null]);
  return claim;
}

export async function cancelReservation(db: PoolClient, storeId: string, request: RequestIdentity) {
  const { sourceId, sourceVersion, actorId, requestKey } = request;
  const receipt = { reservationId: sourceId, status: 'canceled', version: sourceVersion + 1 };
  await lockRequest(db, storeId, 'customer:cancel', requestKey);
  const { rows: [existing] } = await db.query<Omit<RequestIdentity, 'requestKey'>>(`
    SELECT reservation_id AS "sourceId", source_version AS "sourceVersion", actor_id AS "actorId"
    FROM customer.reservation_cancel_command WHERE store_id = $1 AND request_key = $2
  `, [storeId, requestKey]);
  if (existing) {
    assertSameSource(existing, request);
    return receipt;
  }

  const reservation = await lockReservation(db, storeId, sourceId);
  checkVersion(reservation, sourceVersion);
  if (reservation.status !== 'confirmed' || reservation.first_order_id) throw new ClaimError(409, 'RESERVATION_UNAVAILABLE');
  if (await bookingClaimHeld(db, storeId, sourceId)) throw new ClaimError(409, 'RESERVATION_CLAIM_PENDING');

  await db.query(`
    UPDATE customer.reservation SET status = 'canceled', version = version + 1
    WHERE store_id = $1 AND reservation_id = $2
  `, [storeId, sourceId]);
  await db.query(`
    INSERT INTO customer.reservation_cancel_command (store_id, request_key, reservation_id, source_version, actor_id)
    VALUES ($1, $2, $3, $4, $5)
  `, [storeId, requestKey, sourceId, sourceVersion, actorId]);
  return receipt;
}

export async function creditMembership(db: PoolClient, storeId: string, membershipId: string) {
  await db.query('UPDATE customer.membership SET uses_left = uses_left + 1 WHERE store_id = $1 AND membership_id = $2',
    [storeId, membershipId]);
}

export function sameSale(claim: Claim, sale: SaleLink) {
  return claim.settlementId === sale.settlementId && claim.billId === sale.billId && claim.orderId === sale.orderId;
}

/** Apply a terminal outcome while holding the source lock. Stream effects call the same transition. */
export async function settleClaim(db: PoolClient, storeId: string, claim: Claim, outcome: PosOutcome | null): Promise<Claim> {
  if (claim.state !== 'held') return claim;
  if (outcome?.status === 'committed') {
    const { billId, orderId, settlementId } = outcome.sale;
    if (claim.kind === 'reservation_first_order') {
      const { rowCount } = await db.query(`
        UPDATE customer.reservation SET first_bill_id = $3, first_order_id = $4, version = version + 1
        WHERE store_id = $1 AND reservation_id = $2 AND status = 'confirmed' AND NOT table_archived
          AND first_order_id IS NULL AND version = $5
      `, [storeId, claim.sourceId, billId, orderId, claim.sourceVersion]);
      if (rowCount !== 1) throw new Error('Reservation changed while a POS claim was held');
    }
    await db.query(`
      UPDATE customer.pos_claim SET state = 'committed', pos_bound = true, settlement_id = $3, bill_id = $4, order_id = $5
      WHERE store_id = $1 AND claim_id = $2
    `, [storeId, claim.claimId, settlementId, billId, orderId]);
    return { ...claim, ...outcome.sale, state: 'committed', posBound: true };
  }

  if (outcome?.status === 'aborted' || outcome?.status === 'rejected') {
    if (claim.kind === 'membership_use') await creditMembership(db, storeId, claim.sourceId);
    await db.query(`
      UPDATE customer.pos_claim SET state = 'released', pos_bound = true, release_reason = $3
      WHERE store_id = $1 AND claim_id = $2
    `, [storeId, claim.claimId, outcome.status]);
    return { ...claim, state: 'released', posBound: true, releaseReason: outcome.status };
  }

  if (!claim.posBound) {
    await db.query('UPDATE customer.pos_claim SET pos_bound = true WHERE store_id = $1 AND claim_id = $2',
      [storeId, claim.claimId]);
  }
  return { ...claim, posBound: true };
}
