import type { PoolClient } from 'pg';
import { projectionRevision } from './projection.ts';
import { addDays, businessDay, daysBetween, GroupsError, invalid, isRecord, isUuid, limit, object, uuid,
  type Clock, type ReadScope } from './wire.ts';

export const groupIds = ['churn-risk', 'first-visit', 'regular'] as const;
export type GroupId = typeof groupIds[number];

/**
 * F-52 card rule (café numbers for every business type, PRD 2.4.10 기본값): a visit is one member's recognized POS
 * payment on one business day; first visit = 1 visit; regular = ≥ 4 visits in the last 28 days; may leave = more than
 * the usual cycle + 14 days since the last visit. Checked in that order, so the groups never overlap.
 */
export const groupRule = { businessType: 'cafe', regularVisits: 4, regularDays: 28, churnGapDays: 14,
  visitBasis: 'member-business-day', source: 'customer-consent+pos-recognized-sales' } as const;

export type GroupCustomer = {
  memberId: string; customerId: string; displayName: string | null; groupId: GroupId | null;
  visitCount: number; recentVisits: number; firstVisitOn: string; lastVisitOn: string; daysSinceLast: number;
  usualCycleDays: number | null; contactAllowed: boolean; marketingAllowed: boolean; selectable: boolean;
  blockedReason: 'NO_MARKETING_CONSENT' | null;
};

type MemberRow = { memberId: string; nameInitial: string | null; contactAllowed: boolean; marketingAllowed: boolean;
  visits: number; recent: number; firstVisitOn: string; lastVisitOn: string };

/** Every active member with at least one counted visit up to `day`, classified by the F-52 rule. */
export async function classifyMembers(db: PoolClient, storeId: string, day: string) {
  const { rows } = await db.query<MemberRow>(`
    WITH visit AS (
      SELECT DISTINCT s.member_id, s.business_date FROM marketing.r19_sale s
      WHERE s.store_id = $1 AND s.member_id IS NOT NULL AND s.business_date <= $2::date
        AND NOT EXISTS (SELECT 1 FROM marketing.r19_sale_correction c
          WHERE c.store_id = s.store_id AND c.settlement_id = s.settlement_id AND c.member_visit_voided)
    ), stats AS (
      SELECT member_id, count(*)::int AS visits, min(business_date) AS first_on, max(business_date) AS last_on,
        (count(*) FILTER (WHERE business_date > $2::date - $3::int))::int AS recent
      FROM visit GROUP BY member_id
    )
    SELECT m.member_id AS "memberId", m.name_initial AS "nameInitial", m.contact_allowed AS "contactAllowed",
      m.marketing_allowed AS "marketingAllowed", st.visits, st.recent,
      st.first_on::text AS "firstVisitOn", st.last_on::text AS "lastVisitOn"
    FROM stats st JOIN marketing.r19_member m ON m.store_id = $1 AND m.member_id = st.member_id
    WHERE m.active
  `, [storeId, day, groupRule.regularDays]);
  const { rows: [coverage] } = await db.query<{ active: number; pending: number }>(`
    SELECT (SELECT count(*)::int FROM marketing.r19_member WHERE store_id = $1 AND active) AS active,
      (SELECT count(DISTINCT s.member_id)::int FROM marketing.r19_sale s WHERE s.store_id = $1 AND s.member_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM marketing.r19_member m WHERE m.store_id = s.store_id AND m.member_id = s.member_id)) AS pending
  `, [storeId]);
  const customers = rows.map((row): GroupCustomer => {
    const usualCycleDays = row.visits >= 2 ? Math.round(daysBetween(row.firstVisitOn, row.lastVisitOn) / (row.visits - 1)) : null;
    const daysSinceLast = daysBetween(row.lastVisitOn, day);
    const groupId: GroupId | null = row.visits === 1 ? 'first-visit'
      : row.recent >= groupRule.regularVisits ? 'regular'
        : usualCycleDays !== null && daysSinceLast > usualCycleDays + groupRule.churnGapDays ? 'churn-risk' : null;
    const selectable = row.contactAllowed && row.marketingAllowed;
    return {
      memberId: row.memberId, customerId: row.memberId, displayName: row.nameInitial ? `${row.nameInitial}○○` : null, groupId,
      visitCount: row.visits, recentVisits: row.recent, firstVisitOn: row.firstVisitOn, lastVisitOn: row.lastVisitOn,
      daysSinceLast, usualCycleDays, contactAllowed: row.contactAllowed, marketingAllowed: row.marketingAllowed,
      selectable, blockedReason: selectable ? null : 'NO_MARKETING_CONSENT',
    };
  });
  return { customers, coverage: { activeMembers: coverage.active, visitedMembers: customers.length,
    ungroupedMembers: customers.filter(row => row.groupId === null).length, pendingMembers: coverage.pending } };
}

/** May-leave customers come oldest last visit first; the others newest first. Ties break by member ID. */
function order(groupId: GroupId) {
  const sign = groupId === 'churn-risk' ? 1 : -1;
  return (a: GroupCustomer, b: GroupCustomer) =>
    sign * a.lastVisitOn.localeCompare(b.lastVisitOn) || a.memberId.localeCompare(b.memberId);
}

function members(customers: GroupCustomer[], groupId: GroupId) {
  return customers.filter(row => row.groupId === groupId).sort(order(groupId));
}

export function groupId(value: unknown): GroupId {
  if (!groupIds.some(id => id === value)) invalid('INVALID_GROUP', 'groupId');
  return value as GroupId;
}

export async function readGroups(scope: ReadScope) {
  const { db, storeId, day, at } = scope;
  const { customers, coverage } = await classifyMembers(db, storeId, day);
  const sourceRevision = await projectionRevision(db, storeId);
  const lists = Object.fromEntries(groupIds.map(id => [id, members(customers, id)])) as Record<GroupId, GroupCustomer[]>;
  const churn = lists['churn-risk'];
  const recipientIds = churn.filter(row => row.selectable).map(row => row.memberId);
  return {
    asOf: at.toISOString(), sourceRevision, businessDate: day, state: customers.length ? 'ready' : 'empty', rule: groupRule,
    counts: Object.fromEntries(groupIds.map(id => [id, lists[id].length])) as Record<GroupId, number>,
    preview: Object.fromEntries(groupIds.map(id => [id, lists[id].slice(0, 3)])) as Record<GroupId, GroupCustomer[]>,
    reachOut: { groupId: 'churn-risk', recipientIds, blockedIds: churn.filter(row => !row.selectable).map(row => row.memberId),
      count: recipientIds.length },
    coverage,
  };
}

function cursorOf(value: unknown) {
  if (value === undefined) return null;
  const match = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})_([0-9a-f-]{36})$/.exec(value) : null;
  if (!match || !isUuid(match[2])) invalid('INVALID_CURSOR', 'cursor');
  return { lastVisitOn: match[1], memberId: match[2] };
}

export async function readGroupCustomers(scope: ReadScope, id: GroupId, query: unknown) {
  const input = object(query ?? {}, ['cursor', 'limit']);
  const take = limit(input.limit);
  const cursor = cursorOf(input.cursor);
  const { db, storeId, day, at } = scope;
  const { customers } = await classifyMembers(db, storeId, day);
  const sorted = members(customers, id);
  const compare = order(id);
  const rest = cursor ? sorted.filter(row => compare(row, { ...row, ...cursor }) > 0) : sorted;
  const items = rest.slice(0, take);
  const last = items[items.length - 1];
  return { groupId: id, count: sorted.length, items, nextCursor: rest.length > take ? `${last.lastVisitOn}_${last.memberId}` : null,
    asOf: at.toISOString(), sourceRevision: await projectionRevision(db, storeId), businessDate: day };
}

type Blocked = { memberId: string; reason: 'NOT_IN_GROUP' | 'NO_MARKETING_CONSENT' };

function partition(customers: GroupCustomer[], ids: string[]) {
  const byId = new Map(customers.map(row => [row.memberId, row]));
  const eligibleIds: string[] = [];
  const blocked: Blocked[] = [];
  for (const memberId of ids) {
    const row = byId.get(memberId);
    if (row?.groupId !== 'churn-risk') blocked.push({ memberId, reason: 'NOT_IN_GROUP' });
    else if (!row.selectable) blocked.push({ memberId, reason: 'NO_MARKETING_CONSENT' });
    else eligibleIds.push(memberId);
  }
  return { eligibleIds, blocked };
}

function recipients(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) invalid('INVALID_RECIPIENTS', 'recipientIds');
  return [...new Set(value.map(id => uuid(id, 'recipientIds', 'INVALID_RECIPIENTS')))];
}

/** Read-only preview for the reach-out card (Navis `coupon.sendReachOut`); the send itself belongs to B14/R2. */
export async function checkReachOut(scope: ReadScope, id: GroupId, body: unknown) {
  if (id !== 'churn-risk') invalid('REACH_OUT_GROUP_UNSUPPORTED', 'groupId');
  const input = object(body, ['recipientIds', 'expectedSourceRevision']);
  const ids = recipients(input.recipientIds);
  const expected = input.expectedSourceRevision;
  if (expected !== undefined && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)) {
    invalid('INVALID_REQUEST', 'expectedSourceRevision');
  }
  const { db, storeId, day, at } = scope;
  const sourceRevision = await projectionRevision(db, storeId);
  if (expected !== undefined && expected !== sourceRevision) {
    throw new GroupsError(409, 'STALE_REVISION', 'expectedSourceRevision', { sourceRevision });
  }
  const { customers } = await classifyMembers(db, storeId, day);
  return { groupId: id, ...partition(customers, ids), sourceRevision, asOf: at.toISOString() };
}

const seoul: Clock = { timezone: 'Asia/Seoul', dayStart: '05:00' };

/**
 * Commit-time recheck for the issuing command (B14 reach-out issuance) inside its own store-scoped transaction.
 * Returns the deduplicated eligible IDs or throws 409 RECIPIENT_NOT_ELIGIBLE with the blocked list.
 */
export async function assertReachOutRecipients(db: PoolClient, storeId: string, recipientIds: unknown, at: Date, clock = seoul) {
  const ids = recipients(recipientIds);
  const { customers } = await classifyMembers(db, storeId, businessDay(at, clock));
  const { eligibleIds, blocked } = partition(customers, ids);
  if (blocked.length) throw new GroupsError(409, 'RECIPIENT_NOT_ELIGIBLE', 'recipientIds', { blocked });
  return eligibleIds;
}

/** Consented regulars who came at least twice on this weekday and hour range in the last four weeks (slot coupons). */
export async function slotRegulars(db: PoolClient, storeId: string, input: { day: string; weekday: number;
  startHour: number; endHour: number; timezone?: string }) {
  if (!isRecord(input) || !Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6
    || !Number.isInteger(input.startHour) || !Number.isInteger(input.endHour) || input.startHour < 0
    || input.endHour > 24 || input.startHour >= input.endHour) invalid('INVALID_SLOT');
  const { rows } = await db.query<{ memberId: string }>(`
    SELECT s.member_id AS "memberId" FROM marketing.r19_sale s
    JOIN marketing.r19_member m ON m.store_id = s.store_id AND m.member_id = s.member_id
    WHERE s.store_id = $1 AND m.active AND m.contact_allowed AND m.marketing_allowed
      AND s.business_date BETWEEN $2::date AND $3::date AND extract(dow FROM s.business_date) = $4
      AND extract(hour FROM s.occurred_at AT TIME ZONE $7) >= $5 AND extract(hour FROM s.occurred_at AT TIME ZONE $7) < $6
      AND NOT EXISTS (SELECT 1 FROM marketing.r19_sale_correction c
        WHERE c.store_id = s.store_id AND c.settlement_id = s.settlement_id AND c.member_visit_voided)
    GROUP BY s.member_id HAVING count(DISTINCT s.business_date) >= 2 ORDER BY s.member_id
  `, [storeId, addDays(input.day, -(groupRule.regularDays - 1)), input.day, input.weekday, input.startHour, input.endHour,
    input.timezone ?? 'Asia/Seoul']);
  return rows.map(row => row.memberId);
}
