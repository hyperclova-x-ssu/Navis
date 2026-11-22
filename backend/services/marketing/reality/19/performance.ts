import type { PoolClient } from 'pg';
import type { CouponCodeFact, CouponLedger, Period, RedemptionFact } from './ports.ts';
import { projectionRevision } from './projection.ts';
import { addDays, daysBetween, invalid, isRecord, money, object, optional, percent, validDate, type ReadScope } from './wire.ts';

const repeatWindowDays = 30;
const maxPeriodDays = 92;
export type PeriodKind = 'this-month' | 'last-month' | 'custom';

export function periodOf(query: unknown, day: string): Period & { kind: PeriodKind } {
  const input = object(query ?? {}, ['period', 'from', 'to']);
  if (input.from !== undefined || input.to !== undefined) {
    if (input.period !== undefined || !validDate(input.from) || !validDate(input.to)) invalid('INVALID_PERIOD', 'from');
    const { from, to } = input as { from: string; to: string };
    if (from > to || to > day) invalid('INVALID_PERIOD', 'to');
    if (daysBetween(from, to) + 1 > maxPeriodDays) invalid('PERIOD_TOO_LONG', 'to');
    return { from, to, kind: 'custom' };
  }
  const monthStart = `${day.slice(0, 7)}-01`;
  if (input.period === undefined || input.period === 'this-month') return { from: monthStart, to: day, kind: 'this-month' };
  if (input.period !== 'last-month') invalid('INVALID_PERIOD', 'period');
  const lastDay = addDays(monthStart, -1);
  return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay, kind: 'last-month' };
}

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Reject a malformed port result instead of computing from it. */
function checked(codes: CouponCodeFact[], redemptions: RedemptionFact[]) {
  const valid = Array.isArray(codes) && Array.isArray(redemptions)
    && codes.every(code => isRecord(code) && text(code.codeId) && text(code.couponId) && text(code.couponName)
      && text(code.route) && count(code.issued) && (code.activatedOn === null || validDate(code.activatedOn))
      && ['active', 'paused', 'ended'].includes(code.status))
    && redemptions.every(row => isRecord(row) && text(row.redemptionId) && text(row.codeId) && text(row.couponId)
      && text(row.settlementId) && (row.memberId === null || text(row.memberId)) && validDate(row.businessDate)
      && count(row.discount) && typeof row.reversed === 'boolean');
  if (!valid) throw new Error('Invalid coupon ledger facts');
  return { codes, redemptions };
}

type Payment = { settlementId: string; paid: string; cost: string | null };

async function payments(db: PoolClient, storeId: string, settlementIds: string[]) {
  const { rows } = await db.query<Payment>(`
    SELECT s.settlement_id AS "settlementId", (s.amount + coalesce(sum(c.amount_delta), 0))::text AS paid,
      CASE WHEN s.cost IS NULL OR s.incomplete_margin
          OR coalesce(bool_or(c.correction_id IS NOT NULL AND (c.incomplete_margin OR c.cost_delta IS NULL)), false)
        THEN NULL ELSE (s.cost + coalesce(sum(c.cost_delta), 0))::text END AS cost
    FROM marketing.r19_sale s
    LEFT JOIN marketing.r19_sale_correction c ON c.store_id = s.store_id AND c.settlement_id = s.settlement_id
    WHERE s.store_id = $1 AND s.settlement_id = ANY($2::uuid[])
    GROUP BY s.settlement_id, s.amount, s.cost, s.incomplete_margin
  `, [storeId, settlementIds]);
  return new Map(rows.map(row => [row.settlementId, { paid: money(row.paid)!, cost: money(row.cost) }]));
}

async function visitDays(db: PoolClient, storeId: string, memberIds: string[]) {
  const { rows } = await db.query<{ memberId: string; day: string }>(`
    SELECT DISTINCT s.member_id AS "memberId", s.business_date::text AS day FROM marketing.r19_sale s
    WHERE s.store_id = $1 AND s.member_id = ANY($2::uuid[])
      AND NOT EXISTS (SELECT 1 FROM marketing.r19_sale_correction c
        WHERE c.store_id = s.store_id AND c.settlement_id = s.settlement_id AND c.member_visit_voided)
  `, [storeId, memberIds]);
  const days = new Map<string, string[]>();
  for (const row of rows) days.set(row.memberId, [...days.get(row.memberId) ?? [], row.day]);
  return days;
}

const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function couponOutcome({ db, storeId, day, clock }: ReadScope, ledger: CouponLedger, period: Period) {
  const codes = await ledger.codes(db, storeId, period, { day, clock });
  const ids = new Set(codes.map(code => code.codeId));
  const rows = ids.size ? await ledger.redemptions(db, storeId, [...ids], period.to) : [];
  checked(codes, rows);
  const live = rows.filter(row => !row.reversed && ids.has(row.codeId) && row.businessDate <= period.to);
  const settlementIds = [...new Set(live.map(row => row.settlementId))].filter(id => uuidLike.test(id));
  const paid = await payments(db, storeId, settlementIds);
  const found = settlementIds.filter(id => paid.has(id));
  const known = found.map(id => paid.get(id)!);
  const unknownCost = known.some(row => row.cost === null);
  const paidAmount = known.reduce((sum, row) => sum + row.paid, 0);
  const knownCost = known.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const cost = unknownCost ? null : knownCost;
  const pendingSettlements = settlementIds.length - found.length;

  const memberRows = live.filter(row => row.memberId !== null);
  const visits = await visitDays(db, storeId, [...new Set(memberRows.map(row => row.memberId!))].filter(id => uuidLike.test(id)));
  const maturedBy = addDays(day, -repeatWindowDays);
  const matured = memberRows.filter(row => row.businessDate <= maturedBy);
  const returned = matured.filter(row => (visits.get(row.memberId!) ?? [])
    .some(visit => visit > row.businessDate && visit <= addDays(row.businessDate, repeatWindowDays))).length;

  const tally = <K extends string>(key: (code: CouponCodeFact) => K) => {
    const out = new Map<K, { issued: number; used: number; codes: CouponCodeFact[] }>();
    for (const code of codes) {
      const entry = out.get(key(code)) ?? { issued: 0, used: 0, codes: [] };
      entry.issued += code.issued;
      entry.used += live.filter(row => row.codeId === code.codeId).length;
      entry.codes.push(code);
      out.set(key(code), entry);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  const paidOf = (codeIds: Set<string>) => [...new Set(live.filter(row => codeIds.has(row.codeId)).map(row => row.settlementId))]
    .reduce((sum, id) => sum + (paid.get(id)?.paid ?? 0), 0);
  const issued = codes.reduce((sum, code) => sum + code.issued, 0);
  return {
    issued, used: live.length, rate: percent(live.length, issued),
    payment: { paidAmount, discount: live.reduce((sum, row) => sum + row.discount, 0), cost, knownCost,
      profit: cost === null || pendingSettlements ? null : paidAmount - cost, costIncomplete: unknownCost,
      settlements: settlementIds.length, pendingSettlements },
    repeat: { windowDays: repeatWindowDays, matured: matured.length, returned, immature: memberRows.length - matured.length,
      unlinked: live.length - memberRows.length, rate: percent(returned, matured.length) },
    routes: tally(code => code.route).map(([route, entry]) => ({ route, issued: entry.issued, used: entry.used,
      rate: percent(entry.used, entry.issued), lines: entry.codes.map(code => ({ codeId: code.codeId, couponId: code.couponId,
        name: code.couponName, status: code.status, issued: code.issued, used: live.filter(row => row.codeId === code.codeId).length })) })),
    byCoupon: tally(code => code.couponId).map(([couponId, entry]) => ({ couponId, name: entry.codes[0].couponName,
      status: entry.codes[0].status, issued: entry.issued, used: entry.used, rate: percent(entry.used, entry.issued),
      paidAmount: paidOf(new Set(entry.codes.map(code => code.codeId))) })),
  };
}

export async function readPerformance(scope: ReadScope, query: unknown, ledger: CouponLedger | undefined) {
  const { db, storeId, day, at } = scope;
  const period = periodOf(query, day);
  const sourceRevision = await projectionRevision(db, storeId);
  const current = ledger ? await optional(db, () => couponOutcome(scope, ledger, period)) : { ok: false as const };
  const coupons = current.ok ? current.value : null;
  let comparison = null;
  if (coupons && ledger && period.kind === 'this-month') {
    const previous = periodOf({ period: 'last-month' }, day);
    const result = await optional(db, () => couponOutcome(scope, ledger, previous));
    if (result.ok) comparison = { period: previous, issued: result.value.issued, used: result.value.used, rate: result.value.rate };
  }
  const rateDelta = coupons?.rate != null && comparison?.rate != null
    ? Math.round((coupons.rate - comparison.rate) * 10) / 10 : null;
  return {
    asOf: at.toISOString(), sourceRevision, businessDate: day, period,
    state: !coupons ? 'partial' : coupons.issued === 0 && coupons.used === 0 ? 'empty' : 'ready',
    missing: coupons ? [] : ['coupons'], coupons, comparison, rateDelta,
    basis: { rate: 'used-of-issued-same-codes', payment: 'pos-recognized-net-of-discount-and-corrections',
      profit: 'payment-minus-sale-time-cost', repeat: 'member-visit-within-30-days-after-matured-use' },
  };
}
