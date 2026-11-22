import type { Pool, PoolClient } from 'pg';
import { PermanentStreamError, StreamConsumer, type RedisStreams, type StreamEnvelope } from '../../packages/streams/index.ts';
import { creditMembership, lockClaim, sameSale, settleClaim } from './claims.ts';
import { isRecord, isUuid, type SaleLink } from './pos-client.ts';
import { projectFunding } from './reality/05/passes.ts';
import { event as appendCustomerEvent } from './reality/05/wire.ts';
import { bookingPosProjectionHandlers } from './reality/06/projection.ts';
import { calendarPosProjectionHandlers } from './reality/07/projection.ts';

type Quantity = { allocationId: string; quantity: number };
const invalidEvent = () => new PermanentStreamError('INVALID_CUSTOMER_POS_EVENT');

function storeOf(event: StreamEnvelope) {
  if (!isUuid(event.storeId) || event.scopeKey !== event.storeId) throw invalidEvent();
  return event.storeId;
}

function saleOf(payload: Record<string, unknown>): SaleLink {
  const { settlementId, billId, orderId } = payload;
  if (!isUuid(settlementId) || !isUuid(billId) || !isUuid(orderId)) throw invalidEvent();
  return { settlementId, billId, orderId };
}

function quantities(input: unknown, min: number): Quantity[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw invalidEvent();
  const seen = new Set<string>();
  const rows = input.map((entry: unknown) => {
    if (!isRecord(entry) || !isUuid(entry.allocationId) || typeof entry.quantity !== 'number'
      || !Number.isInteger(entry.quantity) || entry.quantity < min || entry.quantity > 99
      || seen.has(entry.allocationId)) throw invalidEvent();
    seen.add(entry.allocationId);
    return { allocationId: entry.allocationId, quantity: entry.quantity };
  });
  return rows.sort((a, b) => a.allocationId.localeCompare(b.allocationId));
}

async function registerContributions(db: PoolClient, storeId: string, useId: string, contributions: Quantity[]) {
  const { rows } = await db.query<Quantity>(`
    SELECT allocation_id AS "allocationId", quantity FROM customer.membership_contribution
    WHERE store_id = $1 AND use_id = $2
  `, [storeId, useId]);
  if (rows.length) {
    const prior = new Map(rows.map(row => [row.allocationId, row.quantity]));
    if (prior.size !== contributions.length || contributions.some(row => prior.get(row.allocationId) !== row.quantity)) {
      throw new PermanentStreamError('MEMBERSHIP_CONTRIBUTIONS_MISMATCH');
    }
    return;
  }
  await db.query(`
    INSERT INTO customer.membership_contribution (store_id, use_id, allocation_id, quantity)
    SELECT $1, $2, line."allocationId", line.quantity
    FROM jsonb_to_recordset($3) AS line("allocationId" uuid, quantity int)
  `, [storeId, useId, JSON.stringify(contributions)]);
}

async function recognize(db: PoolClient, event: StreamEnvelope) {
  const storeId = storeOf(event);
  const payload = event.payload;
  if (!isRecord(payload)) throw invalidEvent();
  if (payload.memberId !== undefined) {
    const { memberId } = payload;
    const { settlementId } = saleOf(payload);
    if (!isUuid(memberId) || event.aggregateId !== settlementId) throw invalidEvent();
    const at = new Date(event.occurredAt);
    const { rowCount } = await db.query(`INSERT INTO customer.member_visit (store_id,settlement_id,member_id,visited_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT (store_id,settlement_id) DO NOTHING`, [storeId, settlementId, memberId, at]);
    if (rowCount) await appendCustomerEvent({ db, storeId, at, actorId: '', day: '' }, 'customer.visit_changed.v1', memberId,
      { memberId, settlementId, operation: 'recorded' });
  }
  if (payload.claimId === undefined) return;
  if (!isUuid(payload.claimId)) throw invalidEvent();
  const sale = saleOf(payload);
  if (event.aggregateId !== sale.settlementId) throw invalidEvent();

  const claim = await lockClaim(db, storeId, payload.claimId);
  if (!claim) throw new PermanentStreamError('CUSTOMER_CLAIM_NOT_FOUND');
  if (claim.state === 'released' || (claim.state !== 'held' && !sameSale(claim, sale))) {
    throw new PermanentStreamError('CUSTOMER_POS_OUTCOME_MISMATCH');
  }
  await settleClaim(db, storeId, claim, { status: 'committed', sale });
  if (claim.kind !== 'membership_use') return;

  const original = quantities(payload.lines, 1);
  const covered = payload.membershipContributions === undefined ? original : quantities(payload.membershipContributions, 1);
  const sold = new Map(original.map(row => [row.allocationId, row.quantity]));
  // Operating member sales use full corrections. Fixture sales support partial returns and require whole allocations.
  if (covered.some(row => claim.operating ? row.quantity > (sold.get(row.allocationId) ?? 0) : sold.get(row.allocationId) !== row.quantity)) {
    throw new PermanentStreamError('UNSUPPORTED_MEMBERSHIP_CONTRIBUTION');
  }
  await registerContributions(db, storeId, claim.claimId, covered);
  await db.query('UPDATE customer.pos_claim SET used_at=COALESCE(used_at,$3) WHERE store_id=$1 AND claim_id=$2',
    [storeId, claim.claimId, event.occurredAt]);
  if (payload.memberId !== undefined && claim.state === 'held') {
    const { rows: [membership] } = await db.query<{ version: number }>(`UPDATE customer.membership SET version=version+1
      WHERE store_id=$1 AND membership_id=$2 RETURNING version`, [storeId, claim.sourceId]);
    await appendCustomerEvent({ db, storeId, at: new Date(event.occurredAt), actorId: '', day: '' }, 'customer.member_changed.v1',
      payload.memberId as string, { memberId: payload.memberId, membershipId: claim.sourceId, revision: membership.version });
  }
}

async function recordCorrection(db: PoolClient, storeId: string, correctionId: string, eventId: string,
  useId: string, effect: object) {
  const encoded = JSON.stringify(effect);
  const result = await db.query(`
    INSERT INTO customer.membership_correction (store_id, correction_id, event_id, use_id, effect)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (store_id, correction_id) DO NOTHING
  `, [storeId, correctionId, eventId, useId, encoded]);
  if (result.rowCount) return true;

  const duplicate = await db.query(`
    SELECT 1 FROM customer.membership_correction
    WHERE store_id = $1 AND correction_id = $2 AND use_id = $3 AND effect = $4::jsonb
  `, [storeId, correctionId, useId, encoded]);
  if (!duplicate.rowCount) throw new PermanentStreamError('MEMBERSHIP_CORRECTION_MISMATCH');
  return false;
}

async function correct(db: PoolClient, event: StreamEnvelope) {
  const storeId = storeOf(event);
  const payload = event.payload;
  if (!isRecord(payload) || !isUuid(payload.settlementId)) throw invalidEvent();
  if (payload.memberVisitVoided === true) {
    const at = new Date(event.occurredAt);
    const { rows: [visit] } = await db.query<{ member_id: string }>(`UPDATE customer.member_visit SET reversed_at=$3
      WHERE store_id=$1 AND settlement_id=$2 AND reversed_at IS NULL RETURNING member_id`, [storeId, payload.settlementId, at]);
    if (visit) await appendCustomerEvent({ db, storeId, at, actorId: '', day: '' }, 'customer.visit_changed.v1', visit.member_id,
      { memberId: visit.member_id, settlementId: payload.settlementId, operation: 'reversed' });
  }
  const { rows: [match] } = await db.query<{ claim_id: string }>(`
    SELECT claim_id FROM customer.pos_claim
    WHERE store_id = $1 AND settlement_id = $2 AND membership_id IS NOT NULL
  `, [storeId, payload.settlementId]);
  if (!match) return;

  const claim = await lockClaim(db, storeId, match.claim_id);
  const { correctionId, kind, target, usageEffect } = payload;
  if (!claim || !sameSale(claim, saleOf(payload)) || !isUuid(correctionId) || correctionId !== event.aggregateId
    || target !== 'recognized_sale'
    || !((kind === 'cancel' && usageEffect === 'restore') || (kind === 'refund' && usageEffect === 'keep'))) {
    throw invalidEvent();
  }
  const lines = quantities(payload.lines, kind === 'cancel' ? 1 : 0);
  const restoreMember = claim.operating && payload.memberUseRestored === true && isUuid(payload.memberId);
  const effect = { kind, lines, ...(restoreMember && { restoreMember }) };
  if (!(await recordCorrection(db, storeId, correctionId, event.eventId, claim.claimId, effect))) return;
  if (kind === 'refund' && !restoreMember) return;

  const { rows } = await db.query<Quantity & { returned: number }>(`
    SELECT allocation_id AS "allocationId", quantity, returned FROM customer.membership_contribution
    WHERE store_id = $1 AND use_id = $2
  `, [storeId, claim.claimId]);
  if (!rows.length) throw new PermanentStreamError('MEMBERSHIP_CONTRIBUTIONS_MISSING');

  const byAllocation = new Map(lines.map(row => [row.allocationId, row.quantity]));
  const updated = rows.map(row => ({ ...row, returned: restoreMember ? row.quantity : row.returned + (byAllocation.get(row.allocationId) ?? 0) }));
  if (updated.some(row => row.returned > row.quantity)) throw new PermanentStreamError('MEMBERSHIP_OVER_REVERSAL');
  await db.query(`
    UPDATE customer.membership_contribution SET returned = line.returned
    FROM jsonb_to_recordset($3) AS line("allocationId" uuid, returned int)
    WHERE store_id = $1 AND use_id = $2 AND allocation_id = line."allocationId"
  `, [storeId, claim.claimId, JSON.stringify(updated)]);

  if (claim.state !== 'committed' || updated.some(row => row.returned < row.quantity)) return;
  await creditMembership(db, storeId, claim.sourceId);
  await db.query(`
    UPDATE customer.pos_claim SET state = 'restored', restored_at = $3 WHERE store_id = $1 AND claim_id = $2
  `, [storeId, claim.claimId, event.occurredAt]);
  if (restoreMember && isUuid(payload.memberId)) {
    const { rows: [membership] } = await db.query<{ version: number }>(`UPDATE customer.membership SET version=version+1
      WHERE store_id=$1 AND membership_id=$2 AND member_id=$3 RETURNING version`, [storeId, claim.sourceId, payload.memberId]);
    if (!membership) throw invalidEvent();
    await appendCustomerEvent({ db, storeId, at: new Date(event.occurredAt), actorId: '', day: '' }, 'customer.member_changed.v1',
      payload.memberId, { memberId: payload.memberId, membershipId: claim.sourceId, revision: membership.version });
  }
}

type ConsumerOptions = Partial<Pick<ConstructorParameters<typeof StreamConsumer>[0], 'reclaimIdleMs' | 'afterCommit'>>;

export function createCustomerConsumer(database: Pool, redis: RedisStreams, name: string, options: ConsumerOptions = {}) {
  return new StreamConsumer({
    ...options,
    database, redis, name, service: 'customer', producer: 'pos', group: 'customer',
    handlers: { ...calendarPosProjectionHandlers, ...bookingPosProjectionHandlers,
      async 'pos.custom_pickup_changed.v1'(db, envelope) {
        await calendarPosProjectionHandlers['pos.custom_pickup_changed.v1'](db, envelope);
        await bookingPosProjectionHandlers['pos.custom_pickup_changed.v1'](db, envelope);
      },
      'pos.sale_recognized.v1': recognize, 'pos.sale_corrected.v1': correct,
      'pos.member_funding_recorded.v1': projectFunding },
  });
}
