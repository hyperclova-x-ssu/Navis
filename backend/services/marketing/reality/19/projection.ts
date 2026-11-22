import type { PoolClient } from 'pg';
import { PermanentStreamError, type StreamHandler } from '../../../../packages/streams/index.ts';
import type { StreamEnvelope } from '../../../../packages/streams/envelope.ts';
import { isRecord, isUuid, validDate } from './wire.ts';

const invalid = () => new PermanentStreamError('INVALID_R19_EVENT');

function scope(event: StreamEnvelope) {
  const { storeId, scopeKey, payload } = event;
  if (!isUuid(storeId) || scopeKey !== storeId || !isRecord(payload)) throw invalid();
  return { storeId, payload };
}

const wholeWon = (value: unknown, sign: 1 | -1) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value * sign >= 0;

export async function bumpRevision(db: PoolClient, storeId: string, at: Date) {
  await db.query(`
    INSERT INTO marketing.r19_projection_state (store_id, revision, updated_at) VALUES ($1, 1, $2)
    ON CONFLICT (store_id) DO UPDATE SET revision = marketing.r19_projection_state.revision + 1, updated_at = EXCLUDED.updated_at
  `, [storeId, at]);
}

export async function projectionRevision(db: PoolClient, storeId: string) {
  const { rows: [row] } = await db.query<{ revision: string }>(
    'SELECT revision FROM marketing.r19_projection_state WHERE store_id = $1', [storeId]);
  return Number(row?.revision ?? 0);
}

/** Contact snapshots can supply a single Unicode letter. */
function initial(value: unknown) {
  return typeof value === 'string' && [...value].length === 1 && /^\p{L}$/u.test(value) ? value : null;
}

/** B05 contact-state facts: `customer.contact_state_changed.v1` and member changes that carry the same fields. */
const contactState: StreamHandler = async (db, event) => {
  const { storeId, payload } = scope(event);
  const { memberId, revision, active, contactAllowed, marketingAllowed } = payload;
  if (event.eventType === 'customer.member_changed.v1'
    && [active, contactAllowed, marketingAllowed].some(value => typeof value !== 'boolean')) return;
  if (!isUuid(memberId) || memberId !== event.aggregateId || typeof revision !== 'number' || !Number.isInteger(revision)
    || revision < 1 || typeof active !== 'boolean' || typeof contactAllowed !== 'boolean'
    || typeof marketingAllowed !== 'boolean' || (marketingAllowed && !contactAllowed)) throw invalid();
  const at = new Date(event.occurredAt);
  const { rowCount } = await db.query(`
    INSERT INTO marketing.r19_member (store_id, member_id, member_revision, active, contact_allowed, marketing_allowed,
      name_initial, event_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (store_id, member_id) DO UPDATE SET member_revision = EXCLUDED.member_revision, active = EXCLUDED.active,
      contact_allowed = EXCLUDED.contact_allowed, marketing_allowed = EXCLUDED.marketing_allowed,
      name_initial = EXCLUDED.name_initial,
      event_id = EXCLUDED.event_id, updated_at = EXCLUDED.updated_at
    WHERE marketing.r19_member.member_revision < EXCLUDED.member_revision
  `, [storeId, memberId, revision, active, contactAllowed, marketingAllowed,
    active && contactAllowed && marketingAllowed ? initial(payload.nameInitial) : null, event.eventId, at]);
  if (rowCount) await bumpRevision(db, storeId, at);
};

type SaleRow = { business_date: string; member_id: string | null; amount: string; cost: string | null; incomplete_margin: boolean };

const recognized: StreamHandler = async (db, event) => {
  const { storeId, payload } = scope(event);
  const { settlementId, businessDate, memberId, amount, cost, incompleteMarginCoverage } = payload;
  if (!isUuid(settlementId) || settlementId !== event.aggregateId || !validDate(businessDate)
    || (memberId !== undefined && !isUuid(memberId)) || !wholeWon(amount, 1) || (cost !== null && !wholeWon(cost, 1))
    || typeof incompleteMarginCoverage !== 'boolean') throw invalid();
  const at = new Date(event.occurredAt);
  const { rowCount } = await db.query(`
    INSERT INTO marketing.r19_sale (store_id, settlement_id, business_date, occurred_at, member_id, amount, cost,
      incomplete_margin, event_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (store_id, settlement_id) DO NOTHING
  `, [storeId, settlementId, businessDate, at, memberId ?? null, amount, cost, incompleteMarginCoverage, event.eventId]);
  if (rowCount) return bumpRevision(db, storeId, at);
  const { rows: [prior] } = await db.query<SaleRow>(`
    SELECT business_date::text, member_id, amount, cost, incomplete_margin FROM marketing.r19_sale
    WHERE store_id = $1 AND settlement_id = $2`, [storeId, settlementId]);
  if (prior.business_date !== businessDate || prior.member_id !== (memberId ?? null) || Number(prior.amount) !== amount
    || (prior.cost === null ? null : Number(prior.cost)) !== cost || prior.incomplete_margin !== incompleteMarginCoverage) {
    throw new PermanentStreamError('R19_SALE_MISMATCH');
  }
};

const corrected: StreamHandler = async (db, event) => {
  const { storeId, payload } = scope(event);
  const { correctionId, settlementId, businessDate, kind, amountDelta, costDelta, incompleteMarginCoverage, memberVisitVoided } = payload;
  if (!isUuid(correctionId) || correctionId !== event.aggregateId || !isUuid(settlementId) || !validDate(businessDate)
    || (kind !== 'cancel' && kind !== 'refund') || !wholeWon(amountDelta, -1) || (costDelta !== null && !wholeWon(costDelta, -1))
    || typeof incompleteMarginCoverage !== 'boolean'
    || (memberVisitVoided !== undefined && typeof memberVisitVoided !== 'boolean')) throw invalid();
  const at = new Date(event.occurredAt);
  const { rowCount } = await db.query(`
    INSERT INTO marketing.r19_sale_correction (store_id, correction_id, settlement_id, business_date, occurred_at, kind,
      amount_delta, cost_delta, incomplete_margin, member_visit_voided, event_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (store_id, correction_id) DO NOTHING
  `, [storeId, correctionId, settlementId, businessDate, at, kind, amountDelta, costDelta, incompleteMarginCoverage,
    memberVisitVoided === true, event.eventId]);
  if (rowCount) await bumpRevision(db, storeId, at);
};

/** Merge into the marketing service's single `customer` producer consumer (group `marketing`). */
export const groupCustomerHandlers = {
  'customer.contact_state_changed.v1': contactState,
  'customer.member_changed.v1': contactState,
} satisfies Record<string, StreamHandler>;

/** Merge into the marketing service's single `pos` producer consumer; B13 handles the same event types. */
export const performancePosHandlers = {
  'pos.sale_recognized.v1': recognized,
  'pos.sale_corrected.v1': corrected,
} satisfies Record<string, StreamHandler>;
