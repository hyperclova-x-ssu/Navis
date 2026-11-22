import { date, timezone, type FinanceTx } from '../09/input.ts';
import { recognizedMenuRows } from '../09/finance.ts';
import { object, PosError } from '../../wire.ts';

type ByHour = { businessDate: string; hour: number };
export type CouponSales = {
  businessDate: string;
  asOf: string;
  hours: (ByHour & { count: number })[];
  visits: (ByHour & { memberId: string })[];
  menuFrequency: { menuId: string; count: number }[];
  soldToday: { menuId: string; quantity: number }[];
};

export async function readCouponSales(tx: FinanceTx, query: unknown): Promise<CouponSales> {
  const { businessDate: value, view } = object(query, ['businessDate', 'view']);
  const businessDate = date(value);
  if (view !== undefined && view !== 'today') throw new PosError(400, 'INVALID_REQUEST');

  // Quiet hours count each positive net settlement once. A visit is removed on a full cancellation.
  // Sold quantities follow the recognition date and cancellation deltas used by margin.
  const { rows: [totals] } = await tx.db.query<Omit<CouponSales, 'businessDate' | 'asOf'>>(`
    WITH historical AS (
      SELECT b.store_id, b.business_date, s.settlement_id, p.payment_id, m.member_id,
        extract(hour FROM s.at AT TIME ZONE $4)::int AS hour,
        s.amount - corrections.returned AS remaining, corrections.last_kind
      FROM pos.bill b
      JOIN pos.settlement s USING (store_id, bill_id)
      LEFT JOIN pos.payment p USING (store_id, settlement_id)
      LEFT JOIN pos.member_sale m USING (store_id, settlement_id)
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(coalesce(c.member_sale_amount, c.amount)), 0) AS returned,
          (array_agg(c.kind ORDER BY c.seq DESC))[1] AS last_kind
        FROM pos.payment_correction c WHERE c.store_id = b.store_id
          AND (c.payment_id = p.payment_id OR c.member_sale_settlement_id = s.settlement_id)
      ) corrections
      WHERE b.store_id = $1 AND b.status = 'paid' AND b.recognized_at IS NOT NULL AND s.purpose = 'sale'
        AND NOT $5::boolean AND b.business_date >= $2::date - 28 AND b.business_date < $2::date
    ), hours AS (
      SELECT business_date::text AS "businessDate", hour, count(*)::int AS count
      FROM historical WHERE remaining > 0 GROUP BY business_date, hour
    ), visits AS (
      SELECT DISTINCT business_date::text AS "businessDate", hour, member_id AS "memberId"
      FROM historical WHERE member_id IS NOT NULL AND (remaining > 0 OR last_kind IS DISTINCT FROM 'cancel')
    ), menu_frequency AS (
      SELECT l.snapshot->>'menuId' AS "menuId", count(*)::int AS count
      FROM historical h JOIN pos.settlement_line l USING (store_id, settlement_id)
      WHERE h.remaining > 0 GROUP BY l.snapshot->>'menuId'
    ), recognized AS (${recognizedMenuRows}), quantities AS (
      SELECT menu_id AS "menuId", sum(quantity)::int AS quantity
      FROM recognized GROUP BY menu_id HAVING sum(quantity) > 0
    )
    SELECT (SELECT coalesce(jsonb_agg(hours ORDER BY "businessDate", hour), '[]') FROM hours) AS hours,
      (SELECT coalesce(jsonb_agg(visits ORDER BY "businessDate", hour, "memberId"), '[]') FROM visits) AS visits,
      (SELECT coalesce(jsonb_agg(menu_frequency ORDER BY "menuId"), '[]') FROM menu_frequency) AS "menuFrequency",
      (SELECT coalesce(jsonb_agg(quantities ORDER BY "menuId"), '[]') FROM quantities) AS "soldToday"
  `, [tx.storeId, businessDate, businessDate, timezone(tx), view === 'today']);
  return { businessDate, asOf: tx.at.toISOString(), ...totals };
}
