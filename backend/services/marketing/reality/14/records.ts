import type { PoolClient } from 'pg';
import { benefitOf, type BenefitType, type Terms } from './benefit.ts';
import { addDays, choice, isoDate, missing, uuid, type StoreClock } from './wire.ts';

export type Scope = { db: PoolClient; storeId: string; actorId: string; now: Date; clock: StoreClock;
  timezone?: string; dayStart?: string };
export type Route = 'sms' | 'place_news' | 'blog' | 'clip';
export type Origin = 'slot' | 'expiry' | 'group' | 'manual';
export type CouponStatus = 'active' | 'paused' | 'ended';

export type CouponRow = {
  couponId: string; origin: Origin; name: string; benefitType: BenefitType; benefitValue: number; targetRef: string | null;
  validHours: Terms['validHours']; startsOn: string; endsOn: string; status: CouponStatus; originRef: Record<string, unknown>;
  basis: Record<string, unknown> | null; futureIssueCount: number | null; lotKey: string | null; businessDate: string;
  createdAt: Date; revision: number;
};
export type CodeRow = {
  codeId: string; couponId: string; code: string; route: Route; issueCount: number; activatedAt: Date | null;
  unpublishedAt: Date | null; issuedTerms: IssuedTerms | null; createdAt: Date; revision: number;
};
export type IssuedTerms = Pick<Terms, 'benefitType' | 'benefitValue' | 'targetRef' | 'endsOn'>;

export const couponColumns = `coupon_id AS "couponId", origin, name, benefit_type AS "benefitType", benefit_value AS "benefitValue",
  target_ref AS "targetRef", valid_hours AS "validHours", starts_on::text AS "startsOn", ends_on::text AS "endsOn", status,
  origin_ref AS "originRef", basis, future_issue_count AS "futureIssueCount", lot_key AS "lotKey",
  business_date::text AS "businessDate", created_at AS "createdAt", revision`;
export const codeColumns = `code_id AS "codeId", coupon_id AS "couponId", code, route, issue_count AS "issueCount",
  activated_at AS "activatedAt", unpublished_at AS "unpublishedAt", issued_terms AS "issuedTerms", created_at AS "createdAt", revision`;

/** Ending soon: running and ending within three days (AC-299). */
export const endingSoonDays = 3;
export const couponSources = ['slot-coupon', 'expiry-coupon', 'coupon-status', 'marketing-today', 'marketing-performance'] as const;

/** Effective status: an elapsed end date reads as ended even before a write records it. */
export const effectiveStatus = (row: Pick<CouponRow, 'status' | 'endsOn'>, today: string): CouponStatus =>
  row.status === 'ended' || row.endsOn < today ? 'ended' : row.status;

export async function lockCoupon(scope: Scope, couponId: string) {
  const { rows: [row] } = await scope.db.query<CouponRow>(`SELECT ${couponColumns} FROM marketing.coupon
    WHERE store_id = $1 AND coupon_id = $2 FOR UPDATE`, [scope.storeId, couponId]);
  if (!row) throw missing('COUPON_NOT_FOUND', 'couponId');
  return row;
}

export async function lockCode(scope: Scope, codeId: string) {
  const { rows: [row] } = await scope.db.query<CodeRow>(`SELECT ${codeColumns} FROM marketing.coupon_code
    WHERE store_id = $1 AND code_id = $2 FOR UPDATE`, [scope.storeId, codeId]);
  if (!row) throw missing('CODE_NOT_FOUND', 'codeId');
  return row;
}

export async function codesOf(scope: Scope, couponId: string) {
  const { rows } = await scope.db.query<CodeRow>(`SELECT ${codeColumns} FROM marketing.coupon_code
    WHERE store_id = $1 AND coupon_id = $2 ORDER BY activated_at IS NULL, created_at, code_id FOR UPDATE`, [scope.storeId, couponId]);
  return rows;
}

export async function bumpRevision(scope: Pick<Scope, 'db' | 'storeId'>, source: 'coupons' | 'redemptions' | 'naver') {
  const { rows: [row] } = await scope.db.query<{ revision: number }>(`
    INSERT INTO marketing.coupon_revision (store_id, source, revision) VALUES ($1, $2, 1)
    ON CONFLICT (store_id, source) DO UPDATE SET revision = marketing.coupon_revision.revision + 1
    RETURNING revision`, [scope.storeId, source]);
  return row.revision;
}

export async function sourceRevision(scope: Pick<Scope, 'db' | 'storeId'>, source: 'coupons' | 'redemptions' | 'naver') {
  const { rows: [row] } = await scope.db.query<{ revision: number }>(`SELECT revision FROM marketing.coupon_revision
    WHERE store_id = $1 AND source = $2`, [scope.storeId, source]);
  return row?.revision ?? 0;
}

type Usage = { codeId: string; used: number; held: number; discountSum: number };
type Counts = { couponId: string; targets: number; reminders: number; messages: number };

function codeView(code: CodeRow, coupon: CouponRow, usage: Usage | undefined, today: string) {
  const status = effectiveStatus(coupon, today);
  const used = usage?.used ?? 0;
  return {
    codeId: code.codeId, code: code.code, route: code.route, issueCount: code.issueCount,
    activated: code.activatedAt !== null, activatedAt: code.activatedAt?.toISOString() ?? null,
    unpublished: code.unpublishedAt !== null, unpublishedAt: code.unpublishedAt?.toISOString() ?? null,
    issuedTerms: code.issuedTerms, used, held: usage?.held ?? 0, discountSum: usage?.discountSum ?? 0,
    remaining: Math.max(0, code.issueCount - used - (usage?.held ?? 0)),
    // Attestation is possible only for an unposted public code of a running coupon (coupon.markPosted).
    eligible: code.route !== 'sms' && status === 'active' && code.activatedAt === null,
    revision: code.revision,
  };
}

export function couponView(coupon: CouponRow, codes: readonly CodeRow[], usage: ReadonlyMap<string, Usage>, counts: Counts | undefined, today: string) {
  const status = effectiveStatus(coupon, today);
  const daysLeft = Math.round((Date.parse(coupon.endsOn) - Date.parse(today)) / 86_400_000);
  const views = codes.map(code => codeView(code, coupon, usage.get(code.codeId), today));
  const live = views.filter(code => code.activated);
  const endingSoon = status === 'active' && daysLeft <= endingSoonDays;
  return {
    couponId: coupon.couponId, origin: coupon.origin, name: coupon.name,
    benefitType: coupon.benefitType, benefitValue: coupon.benefitValue, benefit: benefitOf(coupon.benefitType, coupon.benefitValue),
    targetRef: coupon.targetRef, validHours: coupon.validHours, startsOn: coupon.startsOn, endsOn: coupon.endsOn,
    status, storedStatus: coupon.status, daysLeft, endingSoon, originRef: coupon.originRef, basis: coupon.basis,
    futureIssueCount: coupon.futureIssueCount, businessDate: coupon.businessDate, createdAt: coupon.createdAt.toISOString(),
    issued: live.reduce((sum, code) => sum + code.issueCount, 0),
    used: views.reduce((sum, code) => sum + code.used, 0),
    discountSum: views.reduce((sum, code) => sum + code.discountSum, 0),
    reminderTargets: counts?.targets ?? 0, remindersQueued: counts?.reminders ?? 0, messagesQueued: counts?.messages ?? 0,
    canPause: status === 'active', canResume: status === 'paused', canExtend: status !== 'ended', canEnd: status !== 'ended',
    canNotify: endingSoon && (counts?.targets ?? 0) > 0,
    codes: views, revision: coupon.revision,
  };
}
export type CouponView = ReturnType<typeof couponView>;

const statusFilters = ['active', 'paused', 'ended', 'running', 'all'] as const;
const originFilters = ['slot', 'expiry', 'group', 'manual'] as const;

export async function readCoupons(scope: Scope, filter: { status?: unknown; origin?: unknown; couponId?: string; lotKey?: unknown;
  businessDate?: unknown; cursor: string | null; limit: number }) {
  const today = scope.clock.businessDate;
  const status = filter.status === undefined ? 'all' : choice(filter.status, statusFilters, 'status');
  const origin = filter.origin === undefined ? null : choice(filter.origin, originFilters, 'origin');
  const lotKey = filter.lotKey === undefined ? null : uuid(filter.lotKey, 'lotKey');
  const day = filter.businessDate === undefined ? null : isoDate(filter.businessDate, 'businessDate');
  const { rows } = await scope.db.query<CouponRow>(`
    SELECT ${couponColumns} FROM marketing.coupon c
    WHERE store_id = $1 AND ($2::uuid IS NULL OR coupon_id = $2)
      AND ($3::text IS NULL OR origin = $3)
      AND ($4::text IS NULL OR lot_key = $4)
      AND ($5::date IS NULL OR business_date = $5)
      AND CASE $6::text
        WHEN 'active' THEN status = 'active' AND ends_on >= $7::date
        WHEN 'paused' THEN status = 'paused' AND ends_on >= $7::date
        WHEN 'running' THEN status IN ('active', 'paused') AND ends_on >= $7::date
        WHEN 'ended' THEN status = 'ended' OR ends_on < $7::date
        ELSE true END
      AND ($8::uuid IS NULL OR (ends_on, coupon_id) > (SELECT ends_on, coupon_id FROM marketing.coupon
        WHERE store_id = $1 AND coupon_id = $8))
    ORDER BY ends_on, coupon_id LIMIT $9`,
  [scope.storeId, filter.couponId ?? null, origin, lotKey, day, status, today, filter.cursor, filter.limit + 1]);
  const page = rows.slice(0, filter.limit);
  const ids = page.map(row => row.couponId);
  // One checked-out client per transaction: run the three batched reads in sequence.
  const { rows: codes } = await scope.db.query<CodeRow>(`SELECT ${codeColumns} FROM marketing.coupon_code
    WHERE store_id = $1 AND coupon_id = ANY($2::uuid[]) ORDER BY activated_at IS NULL, created_at, code_id`, [scope.storeId, ids]);
  const { rows: usage } = await scope.db.query<Usage>(`SELECT code_id AS "codeId", count(*) FILTER (WHERE state = 'committed')::int AS used,
      count(*) FILTER (WHERE state = 'held')::int AS held,
      coalesce(sum(discount) FILTER (WHERE state = 'committed'), 0)::int AS "discountSum"
    FROM marketing.coupon_redemption WHERE store_id = $1 AND coupon_id = ANY($2::uuid[]) GROUP BY code_id`, [scope.storeId, ids]);
  const { rows: counts } = await scope.db.query<Counts>(`SELECT c.coupon_id AS "couponId",
      (SELECT count(DISTINCT t.customer_id) FROM marketing.coupon_target t WHERE t.store_id = c.store_id AND t.coupon_id = c.coupon_id)::int AS targets,
      (SELECT count(*) FROM marketing.coupon_reminder r WHERE r.store_id = c.store_id AND r.coupon_id = c.coupon_id)::int AS reminders,
      (SELECT count(*) FROM marketing.coupon_message m WHERE m.store_id = c.store_id AND m.coupon_id = c.coupon_id)::int AS messages
    FROM marketing.coupon c WHERE c.store_id = $1 AND c.coupon_id = ANY($2::uuid[])`, [scope.storeId, ids]);
  const usageMap = new Map(usage.map(row => [row.codeId, row]));
  const countMap = new Map(counts.map(row => [row.couponId, row]));
  const items = page.map(coupon => couponView(coupon, codes.filter(code => code.couponId === coupon.couponId), usageMap,
    countMap.get(coupon.couponId), today));
  return { items, nextCursor: rows.length > filter.limit ? page[page.length - 1].couponId : null };
}

export async function readCoupon(scope: Scope, couponId: string) {
  const { items: [item] } = await readCoupons(scope, { couponId, status: 'all', cursor: null, limit: 1 });
  if (!item) throw missing('COUPON_NOT_FOUND', 'couponId');
  return item;
}

export async function findCodeByText(scope: Scope, code: string) {
  const { rows: [row] } = await scope.db.query<CodeRow>(`SELECT ${codeColumns} FROM marketing.coupon_code
    WHERE store_id = $1 AND code = $2`, [scope.storeId, code]);
  return row;
}

/** Summary used by marketing-today and performance: issued, verified uses and discount by period (business date of use). */
export async function readUsage(scope: Scope, from: string, to: string) {
  const { rows: [row] } = await scope.db.query<{ uses: number; reversed: number; discount: number; held: number }>(`
    SELECT count(*) FILTER (WHERE state = 'committed')::int AS uses, count(*) FILTER (WHERE state = 'reversed')::int AS reversed,
      coalesce(sum(discount) FILTER (WHERE state = 'committed'), 0)::int AS discount, count(*) FILTER (WHERE state = 'held')::int AS held
    FROM marketing.coupon_redemption WHERE store_id = $1 AND business_date BETWEEN $2 AND $3`, [scope.storeId, from, to]);
  const { rows: [issued] } = await scope.db.query<{ issued: number; codes: number }>(`
    SELECT coalesce(sum(issue_count), 0)::int AS issued, count(*)::int AS codes FROM marketing.coupon_code
    WHERE store_id = $1 AND activated_at IS NOT NULL
      AND (activated_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $2 AND $3`, [scope.storeId, from, to]);
  return { from, to, issued: issued.issued, activatedCodes: issued.codes, used: row.uses, reversed: row.reversed,
    held: row.held, discount: row.discount };
}

export const slotCouponEnds = (businessDate: string) => addDays(businessDate, 13);
