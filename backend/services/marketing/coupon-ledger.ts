import { effectiveStatus } from './reality/14/records.ts';
import type { CouponCodeFact, CouponLedger, RedemptionFact } from './reality/19/ports.ts';

export const couponLedger: CouponLedger = {
  async codes(db, storeId, period, { day, clock }) {
    const { rows } = await db.query<CouponCodeFact & { endsOn: string }>(`
      SELECT code.code_id AS "codeId", c.coupon_id AS "couponId", c.name AS "couponName",
        code.route, code.issue_count AS issued, activation.day::text AS "activatedOn",
        c.status, c.ends_on::text AS "endsOn"
      FROM marketing.coupon_code code
      JOIN marketing.coupon c USING (store_id, coupon_id)
      CROSS JOIN LATERAL (SELECT ((code.activated_at AT TIME ZONE $4) - ($5::time - time '00:00'))::date AS day) activation
      WHERE code.store_id = $1 AND activation.day BETWEEN $2::date AND $3::date
      ORDER BY activation.day, code.code_id`, [storeId, period.from, period.to, clock.timezone, clock.dayStart]);
    return rows.map(({ endsOn, ...row }) => ({ ...row, status: effectiveStatus({ status: row.status, endsOn }, day) }));
  },
  async redemptions(db, storeId, codeIds, until) {
    const { rows } = await db.query<RedemptionFact>(`
      SELECT redemption_id AS "redemptionId", code_id AS "codeId", coupon_id AS "couponId",
        settlement_id AS "settlementId", customer_id AS "memberId", business_date::text AS "businessDate",
        discount, state = 'reversed' AS reversed
      FROM marketing.coupon_redemption
      WHERE store_id = $1 AND code_id = ANY($2::uuid[]) AND business_date <= $3::date
        AND state IN ('committed', 'reversed')
      ORDER BY business_date, redemption_id`, [storeId, codeIds, until]);
    return rows;
  },
};
