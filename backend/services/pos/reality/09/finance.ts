import { page } from '../02/reads.ts';
import { type MethodSplit, methods } from '../../wire.ts';
import { emptySalesByMethod, readSalesByMethod } from "./sales-tender.ts";
import { money, period, revision, timezone, type FinanceTx } from './input.ts';

const purposes = ['sale', 'charge_topup', 'receivable_collection', 'membership_sale', 'custom_order'] as const;
type Purpose = typeof purposes[number];

// Tender belongs to the payment's settlement. A return belongs to its own
// business day and retains the original payment and purpose for reconciliation.
const depositRows = `
  SELECT p.payment_id AS id, p.payment_id, NULL::uuid AS correction_id, p.settlement_id, s.purpose,
    coalesce(b.business_date, f.business_date, d.business_date) AS business_date,
    coalesce(t.occurred_at, p.at) AS at, 'payment' AS kind, p.splits, p.amount, p.transaction_no
  FROM pos.payment p
  JOIN pos.settlement s USING (store_id, settlement_id)
  LEFT JOIN pos.bill b USING (store_id, bill_id)
  LEFT JOIN pos.member_funding f USING (store_id, settlement_id)
  LEFT JOIN pos.business_day d ON s.purpose = 'custom_order' AND d.store_id = p.store_id
    AND d.starts_at <= p.at AND d.ends_at > p.at
  LEFT JOIN pos.terminal_record t ON t.store_id = p.store_id AND t.payment_id = p.payment_id AND t.correction_id IS NULL
  WHERE p.store_id = $1
  UNION ALL
  SELECT c.correction_id, p.payment_id, c.correction_id, p.settlement_id, s.purpose, c.business_date,
    coalesce(t.occurred_at, c.at), c.kind, c.methods, c.amount, p.transaction_no
  FROM pos.payment_correction c
  JOIN pos.payment p USING (store_id, payment_id)
  JOIN pos.settlement s USING (store_id, settlement_id)
  LEFT JOIN pos.terminal_record t ON t.store_id = c.store_id AND t.correction_id = c.correction_id
  WHERE c.store_id = $1 AND c.business_date BETWEEN $2 AND $3 AND c.amount > 0
`;

// Corrections already carry the signed cost delta. Prepared-goods refunds
// therefore keep original cost. Keep unknown sale-time cost as NULL.
export const recognizedMenuRows = `
  SELECT r.recognition_id, r.settlement_id, l.order_id AS source_id, r.business_date, r.at, r.amount, r.cost,
    r.correction_id IS NULL AS original,
    CASE WHEN r.correction_id IS NULL THEN (s.snapshot->>'gross')::bigint ELSE 0 END AS gross,
    CASE WHEN r.correction_id IS NULL THEN (s.snapshot->>'discount')::bigint ELSE 0 END AS discount,
    CASE WHEN r.correction_id IS NULL THEN (s.snapshot->>'qty')::integer
      WHEN c.kind = 'cancel' THEN -coalesce((a.effect->>'qty')::integer, 0) ELSE 0 END AS quantity,
    s.snapshot->>'menuId' AS menu_id, s.snapshot->>'name' AS name, s.snapshot->>'recipeVersion' AS recipe_version,
    (s.snapshot->>'basePrice')::bigint + (s.snapshot->>'optionPrice')::bigint AS unit_price,
    (s.snapshot->>'baseCost')::bigint + (s.snapshot->>'optionCost')::bigint AS unit_cost,
    s.snapshot->'options' AS options, 'menu' AS kind
  FROM pos.sales_recognition r
  JOIN pos.settlement_line s USING (store_id, settlement_id, allocation_id)
  JOIN pos.bill_allocation b USING (store_id, allocation_id)
  JOIN pos.order_line l USING (store_id, order_line_id)
  LEFT JOIN pos.payment_correction c USING (store_id, correction_id)
  LEFT JOIN LATERAL (
    SELECT effect FROM jsonb_array_elements(c.allocations) effect
    WHERE effect->>'allocationId' = r.allocation_id::text LIMIT 1
  ) a ON c.kind = 'cancel'
  WHERE r.store_id = $1 AND r.business_date BETWEEN $2 AND $3
`;

const salesRows = `
  ${recognizedMenuRows}
  UNION ALL
  SELECT recognition_id, settlement_id, custom_order_id, business_date, at, amount, NULL, true,
    amount, 0, 1, NULL, name, NULL, amount, NULL, '[]'::jsonb, 'custom-pickup'
  FROM pos.custom_pickup_recognition
  WHERE store_id = $1 AND business_date BETWEEN $2 AND $3
  UNION ALL
  SELECT a.adjustment_id, r.settlement_id, a.custom_order_id, a.business_date, a.at, a.amount, NULL, a.kind <> 'refund',
    CASE WHEN a.kind <> 'refund' THEN a.amount ELSE 0 END, 0,
    CASE a.kind WHEN 'receive' THEN 1 WHEN 'undo' THEN -1 ELSE 0 END,
    NULL, r.name, NULL, r.amount, NULL, '[]'::jsonb, 'custom-pickup'
  FROM pos.custom_pickup_adjustment a JOIN pos.custom_pickup_recognition r USING (store_id, custom_order_id)
  WHERE a.store_id = $1 AND a.business_date BETWEEN $2 AND $3
`;

function depositTotals() {
  return {
    gross: 0, returned: 0, total: 0,
    byMethod: { cash: 0, card: 0, easy_pay: 0 },
    byMethodGross: { cash: 0, card: 0, easy_pay: 0 },
    byMethodReturned: { cash: 0, card: 0, easy_pay: 0 },
    byPurpose: { sale: 0, charge_topup: 0, receivable_collection: 0, membership_sale: 0, custom_order: 0 },
  };
}

function emptyTotals() {
  return {
    sales: { gross: 0, discount: 0, refund: 0, total: 0, bySource: { menu: 0, customPickup: 0 }, byMethod: emptySalesByMethod() }, deposits: depositTotals(),
    expenses: 0, cost: 0 as number | null, knownCost: 0, unknownCostSales: 0, unknownCostCount: 0,
    profit: 0, contribution: 0 as number | null, orderCount: 0, realPaymentCount: 0,
    settlementActivity: { chargeUsed: 0, receivableCreated: 0, receivableCollected: 0,
      chargeReversal: 0, receivableReversal: 0 },
  };
}

export type FinanceTotals = ReturnType<typeof emptyTotals>;
type SalesRow = { day: string | null; hour: number | null; gross: string; discount: string; refund: string; menu: string; customPickup: string;
  sales: string; knownCost: string; unknownCostSales: string; unknownCostCount: string; orders: string };
type DepositTotal = { day: string | null; purpose: Purpose; method: typeof methods[number];
  gross: string; returned: string; paymentCount: string };
type SumRow = { day: string | null; amount: string };
type AccountRow = SumRow & { account: 'charge' | 'receivable'; kind: 'use' | 'sale' | 'collection' | 'reversal' };

function setSales(total: FinanceTotals, row: SalesRow) {
  total.sales = { gross: money(row.gross), discount: money(row.discount), refund: money(row.refund), total: money(row.sales),
    bySource: { menu: money(row.menu), customPickup: money(row.customPickup) }, byMethod: total.sales.byMethod };
  total.knownCost = money(row.knownCost);
  total.unknownCostSales = money(row.unknownCostSales);
  total.unknownCostCount = money(row.unknownCostCount);
  total.cost = total.unknownCostCount || total.unknownCostSales ? null : total.knownCost;
  total.contribution = total.cost === null ? null : money(BigInt(total.sales.total) - BigInt(total.cost));
  total.orderCount = money(row.orders);
}

function addDeposit(total: FinanceTotals, row: DepositTotal) {
  const deposits = total.deposits;
  total.realPaymentCount = money(BigInt(total.realPaymentCount) + BigInt(row.paymentCount));
  if (!row.method) return;
  const gross = BigInt(row.gross), returned = BigInt(row.returned);
  deposits.gross = money(BigInt(deposits.gross) + gross);
  deposits.returned = money(BigInt(deposits.returned) + returned);
  deposits.total = money(BigInt(deposits.gross) - BigInt(deposits.returned));
  deposits.byMethodGross[row.method] = money(BigInt(deposits.byMethodGross[row.method]) + gross);
  deposits.byMethodReturned[row.method] = money(BigInt(deposits.byMethodReturned[row.method]) + returned);
  deposits.byMethod[row.method] = money(BigInt(deposits.byMethodGross[row.method]) - BigInt(deposits.byMethodReturned[row.method]));
  deposits.byPurpose[row.purpose] = money(BigInt(deposits.byPurpose[row.purpose]) + gross - returned);
}

export async function readFinance(tx: FinanceTx, from: string, to: string) {
  const bind = [tx.storeId, from, to];
  const sales = await tx.db.query<SalesRow>(`
    WITH rows AS (${salesRows}), hourly AS (
      SELECT *, extract(hour FROM at AT TIME ZONE $4)::integer AS hour FROM rows
    )
    SELECT business_date::text AS day, hour, coalesce(sum(gross), 0) AS gross, coalesce(sum(discount), 0) AS discount,
      -coalesce(sum(amount) FILTER (WHERE NOT original), 0) AS refund, coalesce(sum(amount), 0) AS sales,
      coalesce(sum(amount) FILTER (WHERE kind = 'menu'), 0) AS menu,
      coalesce(sum(amount) FILTER (WHERE kind = 'custom-pickup'), 0) AS "customPickup",
      coalesce(sum(cost), 0) AS "knownCost", coalesce(sum(amount) FILTER (WHERE cost IS NULL), 0) AS "unknownCostSales",
      coalesce(sum(CASE WHEN kind = 'custom-pickup' THEN quantity ELSE 1 END)
        FILTER (WHERE cost IS NULL), 0) AS "unknownCostCount",
      count(DISTINCT source_id) FILTER (WHERE original AND kind = 'menu') +
        coalesce(sum(quantity) FILTER (WHERE kind = 'custom-pickup'), 0) AS orders
    FROM hourly GROUP BY GROUPING SETS ((), (business_date), (business_date, hour))
    ORDER BY business_date, hour
  `, [...bind, timezone(tx)]);
  const deposits = await tx.db.query<DepositTotal>(`
    WITH rows AS (${depositRows}), period AS (SELECT * FROM rows WHERE business_date BETWEEN $2 AND $3)
    SELECT business_date::text AS day, purpose, split->>'method' AS method,
      coalesce(sum((split->>'amount')::bigint) FILTER (WHERE kind = 'payment'), 0) AS gross,
      coalesce(sum((split->>'amount')::bigint) FILTER (WHERE kind <> 'payment'), 0) AS returned,
      0::bigint AS "paymentCount"
    FROM period CROSS JOIN LATERAL jsonb_array_elements(splits) split
    GROUP BY GROUPING SETS ((purpose, method), (business_date, purpose, method))
    UNION ALL
    SELECT business_date::text, NULL, NULL, 0, 0, count(*) FILTER (WHERE kind = 'payment')
    FROM period GROUP BY GROUPING SETS ((), (business_date))
  `, bind);
  const expenses = await tx.db.query<SumRow>(`
    SELECT business_date::text AS day, coalesce(sum(amount), 0) AS amount FROM pos.expense
    WHERE store_id = $1 AND business_date BETWEEN $2 AND $3 AND status = 'confirmed'
    GROUP BY GROUPING SETS ((), (business_date))
  `, bind);
  const accounts = await tx.db.query<AccountRow>(`
    SELECT business_date::text AS day, account, kind, sum(amount) AS amount FROM pos.member_account_entry
    WHERE store_id = $1 AND business_date BETWEEN $2 AND $3 AND kind IN ('use', 'sale', 'collection', 'reversal')
    GROUP BY GROUPING SETS ((account, kind), (business_date, account, kind))
  `, bind);

  const salesMethods = await readSalesByMethod(tx, from, to);
  const totals = emptyTotals();
  const days = new Map<string, FinanceTotals>();
  const hours: { businessDate: string; hour: number; sales: number }[] = [];
  const group = (day: string | null) => {
    if (day === null) return totals;
    let total = days.get(day);
    if (!total) days.set(day, total = emptyTotals());
    return total;
  };
  for (const row of sales.rows) {
    if (row.day !== null && row.hour !== null) hours.push({ businessDate: row.day, hour: row.hour, sales: money(row.sales) });
    else setSales(group(row.day), row);
  }
  for (const row of salesMethods) group(row.day).sales.byMethod[row.method] = row.amount;
  for (const row of deposits.rows) addDeposit(group(row.day), row);
  for (const row of expenses.rows) group(row.day).expenses = money(row.amount);
  for (const row of accounts.rows) {
    const activity = group(row.day).settlementActivity;
    if (row.kind === 'use') activity.chargeUsed = -money(row.amount);
    if (row.kind === 'sale') activity.receivableCreated = money(row.amount);
    if (row.kind === 'collection') activity.receivableCollected = -money(row.amount);
    if (row.kind === 'reversal') {
      if (row.account === 'charge') activity.chargeReversal = money(row.amount);
      else activity.receivableReversal = money(row.amount);
    }
  }
  for (const total of [totals, ...days.values()]) total.profit = money(BigInt(total.sales.total) - BigInt(total.expenses));
  return { from, to, totals, days: [...days.keys()].sort().map(businessDate => ({ businessDate, ...days.get(businessDate)! })), hours };
}

export async function readLedger(tx: FinanceTx, query: unknown) {
  const { from, to } = await period(tx, query, []);
  const summary = await readFinance(tx, from, to);
  return { ...summary, asOf: tx.at.toISOString(), sourceRevision: revision(summary) };
}

type DepositRow = {
  depositId: string; paymentId: string; correctionId: string | null; settlementId: string; purpose: Purpose;
  businessDate: string; at: Date; kind: 'payment' | 'refund' | 'cancel';
  splits: MethodSplit[]; amount: string; transactionNo: string;
};

export async function listDeposits(tx: FinanceTx, query: unknown) {
  const { from, to, cursor, limit, filter } = await period(tx, query, purposes);
  const { rows } = await tx.db.query<DepositRow>(`
    WITH rows AS (${depositRows})
    SELECT id AS "depositId", payment_id AS "paymentId", correction_id AS "correctionId", settlement_id AS "settlementId",
      purpose, business_date::text AS "businessDate", at, kind, splits, amount, transaction_no AS "transactionNo"
    FROM rows WHERE business_date BETWEEN $2 AND $3 AND ($4::text IS NULL OR purpose = $4)
      AND ($5::uuid IS NULL OR (business_date, at, id) < (SELECT business_date, at, id FROM rows WHERE id = $5))
    ORDER BY business_date DESC, at DESC, id DESC LIMIT $6
  `, [tx.storeId, from, to, filter, cursor, limit + 1]);
  return page(tx, rows.map(row => ({ ...row, amount: money(row.amount) })), limit, row => row.depositId);
}

type MarginRow = {
  marginId: string; kind: 'menu' | 'custom-pickup'; menuId: string | null; name: string; recipeVersion: string | null; settlementId: string | null;
  sourceId: string; quantity: string; sales: string; discount: string; refund: string;
  unitPrice: string | null; unitCost: string | null; knownCost: string; unknownCostCount: string; options: unknown;
};

export async function listMargins(tx: FinanceTx, query: unknown) {
  const { from, to, cursor, limit } = await period(tx, query, []);
  const { rows } = await tx.db.query<MarginRow>(`
    WITH rows AS (${salesRows}), grouped AS (
      SELECT min(recognition_id::text)::uuid AS id, kind, menu_id AS "menuId", name, recipe_version AS "recipeVersion",
        sum(quantity) AS quantity,
        sum(amount) AS sales, sum(discount) AS discount, -coalesce(sum(amount) FILTER (WHERE NOT original), 0) AS refund,
        unit_price AS "unitPrice", unit_cost AS "unitCost", options, coalesce(sum(cost), 0) AS "knownCost",
        coalesce(sum(CASE WHEN kind = 'custom-pickup' THEN quantity ELSE 1 END)
          FILTER (WHERE cost IS NULL), 0) AS "unknownCostCount"
      FROM rows GROUP BY kind, menu_id, name, recipe_version, unit_price, unit_cost, options,
        CASE WHEN kind = 'custom-pickup' THEN source_id END
      HAVING kind <> 'custom-pickup' OR sum(amount) <> 0 OR sum(quantity) <> 0
    )
    SELECT grouped.*, id AS "marginId", rows.source_id AS "sourceId", rows.settlement_id AS "settlementId"
    FROM grouped JOIN rows ON rows.recognition_id = grouped.id
    WHERE $4::uuid IS NULL OR id > $4 ORDER BY id LIMIT $5
  `, [tx.storeId, from, to, cursor, limit + 1]);
  const result = page(tx, rows.map(({ knownCost, unknownCostCount, ...row }) => {
    const sales = money(row.sales);
    const cost = money(unknownCostCount) || (row.kind === 'custom-pickup' && sales) ? null : money(knownCost);
    const unitPrice = row.unitPrice === null ? null : money(row.unitPrice);
    const unitCost = row.unitCost === null ? null : money(row.unitCost);
    return { ...row, sales, cost, knownCost: money(knownCost), unknownCostCount: money(unknownCostCount),
      quantity: money(row.quantity), discount: money(row.discount), refund: money(row.refund), unitPrice, unitCost,
      contribution: cost === null ? null : money(BigInt(sales) - BigInt(cost)),
      unitMargin: unitPrice === null || unitCost === null ? null : money(BigInt(unitPrice) - BigInt(unitCost)) };
  }), limit, row => row.marginId);
  const { totals } = await readFinance(tx, from, to);
  return { ...result, from, to, totals, sourceRevision: revision([result.sourceRevision, totals]) };
}
