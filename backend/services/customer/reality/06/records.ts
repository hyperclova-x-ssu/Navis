import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withCustomerStore } from '../../claims.ts';
import { event } from '../05/wire.ts';
import { projectCalendarSource } from '../07/projection.ts';
import { conflict, integer, invalid, missing, uuid } from '../07/wire.ts';
import { affectedSources, day, fromUsageAt, maskPhone, naverPrefix, type ChangeKind, type LocalVisit,
  type OwnerScope, usageAt, type visitList } from './wire.ts';

export type Scope = { db: PoolClient; storeId: string; at: Date };
export type Context = Scope & OwnerScope;
export type Page = { limit: number; cursor: string | null; start: string | null; end: string | null };
const dateSql = "to_char(starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')";
const timeSql = "to_char(starts_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI')";
const currentStatus = "CASE WHEN first_order_id IS NULL THEN status ELSE 'completed' END";
const reservationFields = `r.reservation_id AS "reservationId", ${dateSql} AS date, ${timeSql} AS time, party_size AS "partySize",
  version AS revision, ${currentStatus} AS status, source, r.member_id AS "memberId", guest_name AS "guestName",
  guest_phone AS "guestPhone", request, table_id AS "tableId", preferred_table_id AS "preferredTableId",
  assignment_mode AS "assignmentMode", allocation_warning AS "allocationWarning", capacity_override AS "capacityOverride",
  confirmed_by AS "confirmedBy", to_char(proposed_time, 'HH24:MI') AS "proposedTime", first_order_id AS "firstOrderId"`;
const dateBounds = (column: 'starts_at' | 'changed_at', start: number, end: number) => `
  ($${start}::date IS NULL OR ${column} >= ($${start}::date::timestamp AT TIME ZONE 'Asia/Seoul'))
  AND ($${end}::date IS NULL OR ${column} < (($${end}::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))`;

export async function bookLock({ db, storeId }: Scope, readOnly = false) {
  const lock = readOnly ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await db.query(`SELECT ${lock}(hashtextextended('customer.booking:' || $1::text, 0))`, [storeId]);
}

export async function bookingRevision({ db, storeId }: Scope) {
  const { rows: [row] } = await db.query<{ revision: number }>(
    'SELECT revision FROM customer.booking_revision WHERE store_id = $1', [storeId]);
  return row?.revision ?? 0;
}

export async function bumpBookingRevision({ db, storeId }: Scope) {
  const { rows: [row] } = await db.query<{ revision: number }>(`
    INSERT INTO customer.booking_revision (store_id, revision) VALUES ($1, 1)
    ON CONFLICT (store_id) DO UPDATE SET revision = customer.booking_revision.revision + 1 RETURNING revision`, [storeId]);
  return row.revision;
}

export const retainsVisitPhone = (status: string) => ['confirmed', 'needs-check', 'proposed'].includes(status);

export async function clearVisitUndoPhones({ db, storeId }: Scope, reservationId: string) {
  await db.query(`UPDATE customer.booking_command SET inverse = jsonb_set(inverse, '{before,guestPhone}', 'null')
    WHERE store_id = $1 AND inverse #>> '{before,reservationId}' = $2
      AND inverse #>> '{before,guestPhone}' IS NOT NULL`, [storeId, reservationId]);
}

export function publicVisit({ guestPhone, firstOrderId: _firstOrder, preferredTableId: _preferred, ...visit }: LocalVisit, memberName?: string | null) {
  return {
    ...visit, kind: 'visit' as const, guestName: memberName ?? visit.guestName, phone: guestPhone && retainsVisitPhone(visit.status) ? maskPhone(guestPhone) : null,
    nameKey: visit.source === 'phone_ai' ? 'data.management.phoneBooking' : 'data.management.guest',
    requestKey: null, callId: visit.source === 'phone_ai' ? visit.reservationId : null, variant: null,
  };
}

export async function readLocalVisit({ db, storeId }: Scope, id: string, lock = false) {
  const { rows: [row] } = await db.query<LocalVisit & { memberName: string | null }>(`
    SELECT ${reservationFields}, m.name AS "memberName" FROM customer.reservation r
    LEFT JOIN customer.member m ON (m.store_id, m.member_id) = (r.store_id, r.member_id) AND m.archived_at IS NULL
    WHERE r.store_id = $1 AND r.reservation_id = $2 AND starts_at IS NOT NULL ${lock ? 'FOR UPDATE OF r' : ''}`, [storeId, id]);
  return row ?? null;
}

export async function readLocalVisits({ db, storeId }: Scope, { limit, cursor, start, end, status, memberId, q }: ReturnType<typeof visitList>) {
  if (cursor?.startsWith(naverPrefix)) return [];
  const { rows } = await db.query<LocalVisit & { memberName: string | null }>(`
    SELECT ${reservationFields}, m.name AS "memberName" FROM customer.reservation r
    LEFT JOIN customer.member m ON (m.store_id, m.member_id) = (r.store_id, r.member_id) AND m.archived_at IS NULL
    WHERE r.store_id = $1 AND starts_at IS NOT NULL AND ($2::uuid IS NULL OR r.reservation_id > $2)
      AND ${dateBounds('starts_at', 3, 4)}
      AND ($5::text IS NULL OR (${currentStatus}) = $5)
      AND ($6::uuid IS NULL OR r.member_id = $6)
      AND ($7::text IS NULL OR strpos(lower(COALESCE(r.guest_name, m.name, '')), lower($7)) > 0
        OR ((${currentStatus}) IN ('confirmed', 'needs-check', 'proposed')
          AND $7 ~ '^[0-9]{1,4}$' AND right(COALESCE(r.guest_phone, m.phone), length($7)) = $7))
    ORDER BY r.reservation_id LIMIT $8`, [storeId, cursor, start, end, status, memberId, q, limit + 1]);
  return rows.map(({ memberName, ...row }) => publicVisit(row, memberName));
}

export async function assertMember({ db, storeId }: Scope, memberId: string) {
  const result = await db.query('SELECT 1 FROM customer.member WHERE store_id = $1 AND member_id = $2 AND archived_at IS NULL FOR SHARE',
    [storeId, memberId]);
  if (!result.rowCount) throw missing('memberId');
}

export async function assertNoFirstOrder({ db, storeId }: Scope, visit: LocalVisit) {
  if (visit.firstOrderId) throw conflict('RESERVATION_ORDER_LINKED', 'reservationId');
  const result = await db.query(`
    SELECT 1 FROM customer.pos_claim WHERE store_id = $1 AND reservation_id = $2 AND state = 'held'`, [storeId, visit.reservationId]);
  if (result.rowCount) throw conflict('RESERVATION_CLAIM_PENDING', 'reservationId');
}

export async function assertDistinct({ db, storeId }: Scope, row: LocalVisit) {
  if (!row.guestName && !row.memberId) return;
  const { rows: [duplicate] } = await db.query<{ reservationId: string }>(`
    SELECT reservation_id AS "reservationId" FROM customer.reservation
    WHERE store_id = $1 AND starts_at = $2 AND party_size = $3 AND reservation_id <> $4
      AND status <> 'canceled' AND (($5::uuid IS NOT NULL AND member_id = $5) OR
        ($5::uuid IS NULL AND member_id IS NULL AND lower(normalize(guest_name, NFC)) = lower(normalize($6::text, NFC))
          AND (guest_phone IS NULL OR $7::text IS NULL OR guest_phone = $7))) LIMIT 1`,
  [storeId, usageAt(row.date, row.time), row.partySize, row.reservationId, row.memberId, row.guestName, row.guestPhone]);
  if (duplicate) throw conflict('BOOKING_DUPLICATE', 'time', { ...duplicate, date: row.date, time: row.time, partySize: row.partySize });
}

export async function concurrentVisits({ db, storeId }: Scope, row: LocalVisit, enabled: boolean) {
  const at = usageAt(row.date, row.time);
  const { rows } = await db.query<{ tableId: string | null; partySize: number }>(`
    SELECT table_id AS "tableId", party_size AS "partySize" FROM customer.reservation
    WHERE store_id = $1 AND status = 'confirmed' AND reservation_id <> $2 AND first_order_id IS NULL
      AND ${enabled ? "starts_at > $3::timestamptz - interval '120 minutes' AND starts_at < $3::timestamptz + interval '120 minutes'" : 'starts_at = $3'}`,
  [storeId, row.reservationId, at]);
  return rows;
}

export async function storeVisit({ db, storeId }: Scope, before: LocalVisit | null, row: LocalVisit) {
  const fields = [row.revision, row.status, usageAt(row.date, row.time), row.partySize, row.source, row.memberId, row.guestName, row.guestPhone,
    row.request, row.tableId, row.preferredTableId, row.assignmentMode, row.allocationWarning, row.capacityOverride, row.confirmedBy, row.proposedTime];
  if (!before) {
    await db.query(`INSERT INTO customer.reservation (store_id, reservation_id, version, status, starts_at, party_size, source, member_id,
      guest_name, guest_phone, request, table_id, preferred_table_id, assignment_mode, allocation_warning, capacity_override, confirmed_by, proposed_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [storeId, row.reservationId, ...fields]);
    return;
  }
  await db.query(`UPDATE customer.reservation SET version = $3, status = $4, starts_at = $5, party_size = $6, source = $7, member_id = $8,
    guest_name = $9, guest_phone = $10, request = $11, table_id = $12, preferred_table_id = $13, assignment_mode = $14,
    allocation_warning = $15, capacity_override = $16, confirmed_by = $17, proposed_time = $18, table_archived = false
    WHERE store_id = $1 AND reservation_id = $2`, [storeId, row.reservationId, ...fields]);
}

type Summary = { reservationId: string; date: string; time: string; partySize: number | null; status: string; revision: number; tableId: string | null };
export function visitSummary({ reservationId, date, time, partySize, status, revision, tableId }: Summary): Summary {
  return { reservationId, date, time, partySize, status, revision, tableId };
}

export async function recordBookingChange(ctx: Context, before: Summary | null, after: Summary, kind: ChangeKind, aggregateId = after.reservationId) {
  const { db, storeId, at } = ctx;
  const changeId = randomUUID();
  const calendarProjection = { source: 'reservation', sourceId: aggregateId, revision: after.revision,
    entry: after.status === 'confirmed' ? { date: after.date, time: after.time } : null };
  if (aggregateId === after.reservationId) await projectCalendarSource(db, storeId, 'customer', calendarProjection);
  const sourceRevision = await bumpBookingRevision(ctx);
  await db.query(`
    INSERT INTO customer.booking_change (store_id, change_id, reservation_id, changed_at, kind, before_summary, after_summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [storeId, changeId, after.reservationId, at, kind, before, after]);
  await event({ ...ctx, day: day(at) }, 'customer.reservation_changed.v1', aggregateId,
    { changeId, revision: after.revision, sourceRevision, status: after.status, kind,
      date: after.date, time: after.time, partySize: after.partySize, tableId: after.tableId, affectedSources,
      ...(aggregateId === after.reservationId && { calendarProjection }) });
}

export async function projectFirstOrderBooking(db: PoolClient, storeId: string, reservationId: string, at: Date, actorId: string) {
  const ctx = { db, storeId, at, actorId };
  const visit = await readLocalVisit(ctx, reservationId);
  if (visit?.firstOrderId) {
    await db.query('UPDATE customer.reservation SET guest_phone = NULL WHERE store_id = $1 AND reservation_id = $2 AND guest_phone IS NOT NULL',
      [storeId, reservationId]);
    await clearVisitUndoPhones(ctx, reservationId);
    const after = visitSummary(visit);
    await recordBookingChange(ctx, { ...after, status: 'confirmed', revision: after.revision - 1 }, after, 'status');
  }
}

export async function listChanges({ db, storeId }: Scope, { limit, cursor, start, end }: Page, reservationId: string | null) {
  const { rows } = await db.query<{ changeId: string; at: Date }>(`
    SELECT change_id AS "changeId", reservation_id AS "reservationId", changed_at AS at, kind,
      before_summary AS before, after_summary AS after FROM customer.booking_change
    WHERE store_id = $1 AND ($2::uuid IS NULL OR change_id > $2) AND ${dateBounds('changed_at', 3, 4)}
      AND ($5::text IS NULL OR reservation_id = $5) ORDER BY change_id LIMIT $6`, [storeId, cursor, start, end, reservationId, limit + 1]);
  return rows;
}

type Candidate = { suggestionId: string; callAt: Date; date: string; time: string; partySize: number; phoneMasked: string | null;
  status: 'pending' | 'proposed' | 'accepted' | 'declined'; revision: number; reservationId: string | null; proposedTime: string | null };
const candidateFields = `candidate_id AS "suggestionId", received_at AS "callAt", ${dateSql} AS date, ${timeSql} AS time,
  party_size AS "partySize", phone_masked AS "phoneMasked", status, revision, reservation_id AS "reservationId",
  to_char(proposed_time, 'HH24:MI') AS "proposedTime"`;

export async function listCandidates({ db, storeId }: Scope, { limit, cursor, start, end }: Page, status: Candidate['status'] | null) {
  const { rows } = await db.query<Candidate>(`
    SELECT ${candidateFields} FROM customer.booking_candidate
    WHERE store_id = $1 AND ($2::uuid IS NULL OR candidate_id > $2) AND ${dateBounds('starts_at', 3, 4)}
      AND ($5::text IS NULL OR status = $5)
    ORDER BY candidate_id LIMIT $6`, [storeId, cursor, start, end, status, limit + 1]);
  return rows;
}

export async function readCandidate({ db, storeId }: Scope, id: string) {
  const { rows: [row] } = await db.query<Candidate>(`SELECT ${candidateFields} FROM customer.booking_candidate
    WHERE store_id = $1 AND candidate_id = $2 FOR UPDATE`, [storeId, id]);
  return row ?? null;
}

export async function transitionCandidate({ db, storeId }: Scope, row: Candidate, status: Candidate['status'], proposedTime: string | null = null) {
  await db.query(`UPDATE customer.booking_candidate SET status = $3, revision = revision + 1, reservation_id = $4,
    phone_masked = CASE WHEN $3 IN ('accepted', 'declined') THEN NULL ELSE phone_masked END, proposed_time = $5
    WHERE store_id = $1 AND candidate_id = $2`,
  [storeId, row.suggestionId, status, status === 'accepted' ? row.suggestionId : null, proposedTime]);
}

export type CandidateIntake = { storeId: string; dedupeKey: string; usageAt: string; partySize: number; contact?: string };
export async function upsertBookingCandidate(pool: Pool, input: CandidateIntake, at = new Date()) {
  const storeId = uuid(input.storeId, 'storeId');
  if (!/^[a-f0-9]{64}$/.test(input.dedupeKey)) throw invalid('dedupeKey');
  const local = fromUsageAt(input.usageAt);
  const party = integer(input.partySize, 'partySize', 1, 1000);
  if (input.contact !== undefined && !/^\d{9,11}$/.test(input.contact)) throw invalid('contact');
  const phone = input.contact === undefined ? null : maskPhone(input.contact);
  await withCustomerStore(pool, storeId, async db => {
    const ctx = { db, storeId, at };
    await bookLock(ctx);
    const result = await db.query(`
      INSERT INTO customer.booking_candidate (store_id, candidate_id, dedupe_key, received_at, starts_at, party_size, phone_masked)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (store_id, dedupe_key) DO NOTHING`,
    [storeId, randomUUID(), input.dedupeKey, at, usageAt(local.date, local.time), party, phone]);
    if (result.rowCount) await bumpBookingRevision(ctx);
  });
}
