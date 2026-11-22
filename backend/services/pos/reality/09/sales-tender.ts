import { money, type FinanceTx } from './input.ts';

export function emptySalesByMethod() {
  return { cash: 0, card: 0, easy_pay: 0, charge: 0, receivable: 0, mixed: 0 };
}

type Method = keyof ReturnType<typeof emptySalesByMethod>;
type Row = { day: string | null; method: Method; amount: string };

export async function readSalesByMethod(tx: FinanceTx, from: string, to: string) {
  // A correction can have several recognition lines. Resolve tender once per
  // menu settlement effect on its recognition day. Custom pickup has its own sales source.
  const { rows } = await tx.db.query<Row>(`
    WITH effects AS (
      SELECT settlement_id, business_date, correction_id, 1 AS direction
      FROM pos.sales_recognition
      WHERE store_id = $1 AND business_date BETWEEN $2 AND $3
      GROUP BY settlement_id, business_date, correction_id
    ), settlements AS (
      SELECT DISTINCT settlement_id FROM effects WHERE settlement_id IS NOT NULL
    ), original AS (
      SELECT p.settlement_id, split->>'method' AS method, (split->>'amount')::bigint AS amount
      FROM settlements s JOIN pos.payment p ON p.store_id = $1 AND p.settlement_id = s.settlement_id
      CROSS JOIN LATERAL jsonb_array_elements(p.splits) split
      UNION ALL
      SELECT a.settlement_id, a.account, CASE a.kind WHEN 'use' THEN -a.amount ELSE a.amount END
      FROM settlements s JOIN pos.member_account_entry a ON a.store_id = $1 AND a.settlement_id = s.settlement_id
      WHERE a.kind IN ('use', 'sale')
    ), mixed AS (
      SELECT settlement_id FROM original WHERE amount > 0
      GROUP BY settlement_id HAVING count(DISTINCT method) > 1
    ), components AS (
      SELECT e.business_date, e.settlement_id, o.method, o.amount * e.direction AS amount
      FROM effects e JOIN original o USING (settlement_id) WHERE e.correction_id IS NULL
      UNION ALL
      SELECT e.business_date, e.settlement_id, split->>'method', -(split->>'amount')::bigint
      FROM effects e JOIN pos.payment_correction c ON c.store_id = $1 AND c.correction_id = e.correction_id
      CROSS JOIN LATERAL jsonb_array_elements(c.methods) split
      UNION ALL
      SELECT e.business_date, e.settlement_id, a.account, CASE a.account WHEN 'charge' THEN -a.amount ELSE a.amount END
      FROM effects e JOIN pos.member_account_entry a ON a.store_id = $1 AND a.correction_id = e.correction_id
      WHERE a.kind = 'reversal' AND a.settlement_id = e.settlement_id
    ), subtotals AS (
      SELECT business_date, method, amount FROM components
      UNION ALL
      SELECT business_date, 'mixed', amount FROM components JOIN mixed USING (settlement_id)
    )
    SELECT business_date::text AS day, method, sum(amount) AS amount FROM subtotals
    GROUP BY GROUPING SETS ((method), (business_date, method))
  `, [tx.storeId, from, to]);
  return rows.map(row => ({ ...row, amount: money(row.amount) }));
}
