import type { Pool, PoolClient } from 'pg';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { seedSupplement } from '../../../frontend/src/data/db/generated/supplement.ts';
import { createSeedContext, type SeedContext } from '../../packages/db/seed-context.ts';
import { historyForSeed, insertSeedRows, seedId, shiftSeedDate, type SeedDay } from '../../packages/db/seed-history.ts';
import { seedNaverOrderLinks } from '../../packages/db/seed-naver-orders.ts';
import { saleCost, type MenuSnapshot } from './catalog.ts';
import { seedCustomOrders } from './reality/08/seed.ts';
import { readClosing } from './reality/09/closings.ts';
import { typeKey } from './reality/18/input.ts';
import { withStoreTransaction } from './transaction.ts';
import { fingerprint } from './wire.ts';

// Direct catalog fixtures remain available to service tests and archive
// replays. Both operating seed CLI commands pass an explicit seed context.
export async function seed(pool: Pool, context = { ...createSeedContext(), operatingHistory: false }) {
  const { storeId, name } = seedCatalog.store;
  await withStoreTransaction(pool, storeId, async (db) => {
    await db.query('INSERT INTO pos.store (store_id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [storeId, name]);

    for (const menu of seedCatalog.menu) {
      if (context.archivedMenuIds.includes(menu.dbId)) continue;
      const snapshot: MenuSnapshot = {
        name: menu.name, basePrice: menu.price, baseCost: menu.unitCost,
        recipeVersion: fingerprint(menu.recipeBase), saleStatus: menu.saleStatus,
        groups: menu.groups.map((group) => ({
          required: group.required,
          options: group.options.map((option) => ({
            optionId: option.optionId, name: option.name, extraPrice: option.extraPrice,
            extraCost: option.extraCost, recipeVersion: fingerprint(option.extraRecipe),
          })),
        })),
      };
      await db.query(`
        INSERT INTO pos.catalog_menu (store_id, menu_id, snapshot)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [storeId, menu.dbId, snapshot]);
    }
    if (context.operatingHistory) {
      await seedHistory(db, storeId, context);
      await seedNaverOrderLinks(db, storeId, context.businessDate);
      await seedCustomOrders(db, storeId, context);
      await seedOpeningBalances(db, storeId, context);
    } else {
      const { businessDayStart, timezone } = seedCatalog.store;
      await db.query(`
        INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at, seq)
        VALUES ($1, $2, ($2::date + $3::time) AT TIME ZONE $4,
          ($2::date + 1 + $3::time) AT TIME ZONE $4, 153)
        ON CONFLICT DO NOTHING
      `, [storeId, context.businessDate, businessDayStart, timezone]);
    }
  }, { write: true });
}

async function seedOpeningBalances(db: PoolClient, storeId: string, context: SeedContext) {
  const day = shiftSeedDate(context.businessDate, -1);
  const opening = seedSupplement.balances.flatMap(row => [
    { memberId: row.memberId, account: 'charge', amount: row.chargeBalance },
    { memberId: row.memberId, account: 'receivable', amount: row.receivableBalance },
  ].filter(row => row.amount > 0).map(row => ({ ...row, id: seedId(`sample-opening:${row.account}:${row.memberId}`) })));
  await insertSeedRows(db, 'pos.member_account', 'store_id, member_id, revision',
    seedSupplement.balances.map(row => ({ store_id: storeId, member_id: row.memberId, revision: 1 })));
  await db.query(`
    WITH inserted AS (
      INSERT INTO pos.member_account_entry (store_id, txn_id, member_id, account, kind, amount, business_date, at)
      SELECT $1, o.id, o."memberId", o.account, 'opening', o.amount, $2,
        ($2::date + time '08:00') AT TIME ZONE 'Asia/Seoul'
      FROM jsonb_to_recordset($3) AS o(id uuid, "memberId" uuid, account text, amount bigint)
      WHERE NOT EXISTS (
        SELECT 1 FROM pos.member_account_entry
        WHERE store_id = $1 AND member_id = o."memberId" AND account = o.account
      )
      ON CONFLICT DO NOTHING RETURNING member_id
    )
    UPDATE pos.member_account a SET revision = revision + 1
    WHERE a.store_id = $1 AND a.member_id IN (SELECT member_id FROM inserted)
  `, [storeId, day, JSON.stringify(opening)]);
}

async function seedHistory(db: PoolClient, storeId: string, context: SeedContext) {
  const { rows, cutoff, businessDate } = context;
  const { businessDayStart: dayStart, timezone } = seedCatalog.store;
  const actorId = (rows.app_user[0] as { user_id: string }).user_id;
  const days = rows.business_day as SeedDay[];
  await db.query(`
    INSERT INTO pos.business_day (store_id, business_date, starts_at, ends_at, seq)
    SELECT $1, d.business_date, (d.business_date + $3::time) AT TIME ZONE $4,
      (d.business_date + 1 + $3::time) AT TIME ZONE $4, d.seq
    FROM jsonb_to_recordset($2::jsonb) d(business_date date, seq integer)
    ON CONFLICT (store_id, business_date) DO NOTHING
  `, [storeId, JSON.stringify(days), dayStart, timezone]);
  await insertSeedRows(db, 'pos.store_table', 'store_id, table_id, label, seats, layout_table_id',
    seedCatalog.tables.map(table => ({
      store_id: storeId, table_id: table.dbId, label: String(table.number), seats: table.seats, layout_table_id: table.tableId,
    })));

  const history = historyForSeed(context);
  // Existing operating days can have owner receipts. Only seed dates whose
  // existing bills already belong to this dataset, under the POS write lock.
  const historyIds = new Set(history.map(sale => sale.bill.bill_id));
  const { rows: existing } = await db.query<{ bill_id: string; day: string }>(`
    SELECT bill_id, business_date::text AS day FROM pos.bill
    WHERE store_id = $1 AND business_date BETWEEN $2 AND $3
  `, [storeId, context.start, context.end]);
  const occupied = new Set(existing.filter(row => !historyIds.has(row.bill_id)).map(row => row.day));
  const sales = history.filter(sale => !occupied.has(sale.businessDate));
  const settled = sales.filter(sale => sale.at !== null);
  const paid = settled.filter(sale => sale.payment);
  const corrected = paid.filter(sale => sale.correction);
  const row = { store_id: storeId };
  await insertSeedRows(db, 'pos.bill', 'store_id, bill_id, business_date, status, draft, created_at, recognized_at',
    sales.map(({ bill, order, businessDate, at, quote, lines }) => ({
      ...row, bill_id: bill.bill_id, business_date: businessDate, status: at ? 'paid' : 'open',
      draft: { quote, fixedDiscounts: true, ...(!at && { postpaid: true }), request: { type: order.type, discount: quote.discount,
        lines: lines.map(line => ({ menuId: line.menuId, qty: line.qty, optionIds: line.options.map(option => option.optionId) })) } },
      created_at: order.ordered_at, recognized_at: at,
    })));
  await insertSeedRows(db, 'pos.pos_order',
    'store_id, order_id, origin_bill_id, business_date, order_no, ordered_at, preparation, completed_at, status_history',
    sales.map(({ order, businessDate }) => {
      const completedAt = order.completed_at && order.completed_at <= cutoff ? order.completed_at : null;
      const status = completedAt ? 'completed' : 'accepted';
      return { ...row, ...order, business_date: businessDate, preparation: status, completed_at: completedAt,
        status_history: [{ status: 'accepted', at: order.ordered_at }, ...(completedAt ? [{ status, at: completedAt }] : [])] };
    }));
  await insertSeedRows(db, 'pos.order_line', 'store_id, order_line_id, order_id, snapshot',
    sales.flatMap(({ order, lines }) => lines.map(line => ({
      ...row, order_line_id: line.orderLineId, order_id: order.order_id, snapshot: line,
    }))));
  await insertSeedRows(db, 'pos.bill_allocation', 'store_id, allocation_id, bill_id, order_line_id, quantity',
    sales.flatMap(({ bill, lines }) => lines.map(line => ({
      ...row, allocation_id: line.allocationId, bill_id: bill.bill_id, order_line_id: line.orderLineId, quantity: line.qty,
    }))));
  await insertSeedRows(db, 'pos.settlement', 'store_id, settlement_id, bill_id, purpose, amount, at',
    settled.map(({ bill, settlementId, at, quote }) => ({
      ...row, settlement_id: settlementId, bill_id: bill.bill_id, purpose: 'sale', amount: quote.payable, at,
    })));
  const memberSales = settled.filter(sale => sale.bill.member_id !== null);
  await insertSeedRows(db, 'pos.member_account', 'store_id, member_id, revision',
    [...new Set(memberSales.map(sale => sale.bill.member_id))].map(memberId => ({ ...row, member_id: memberId, revision: 1 })));
  await insertSeedRows(db, 'pos.member_sale', 'store_id, settlement_id, member_id, cash_amount, contains_member_value',
    memberSales.map(sale => ({
      ...row, settlement_id: sale.settlementId, member_id: sale.bill.member_id,
      cash_amount: sale.quote.payable, contains_member_value: false,
    })));
  await insertSeedRows(db, 'pos.settlement_line', 'store_id, settlement_id, allocation_id, snapshot',
    settled.flatMap(({ settlementId, lines }) => lines.map(line => ({
      ...row, settlement_id: settlementId, allocation_id: line.allocationId, snapshot: line,
    }))));
  await insertSeedRows(db, 'pos.payment', 'store_id, payment_id, settlement_id, created_by, amount, splits, transaction_no, approval_no, at',
    paid.map(({ settlementId, payment: paymentOrNone, at }) => {
      const payment = paymentOrNone!;
      return { ...row, ...payment, settlement_id: settlementId, created_by: actorId, at,
        approval_no: payment.approval_no ?? payment.transaction_no,
        splits: [{ method: payment.counted_method, amount: payment.amount }] };
    }));
  await insertSeedRows(db, 'pos.payment_correction',
    'store_id, correction_id, payment_id, business_date, created_by, kind, amount, methods, allocations, seq, at',
    corrected.map(({ businessDate, correction, payment, changes }) => ({
      ...row, ...correction, business_date: businessDate, created_by: actorId, allocations: changes,
      methods: [{ method: payment!.counted_method, amount: correction!.amount }],
    })));
  const originalId = (allocationId: string) => seedId('recognition:' + allocationId);
  const recognitionColumns = 'store_id, recognition_id, settlement_id, allocation_id, business_date, amount, cost, at';
  await insertSeedRows(db, 'pos.sales_recognition', recognitionColumns,
    settled.flatMap(({ businessDate, settlementId, lines, at }) => lines.map(line => ({
      ...row, recognition_id: originalId(line.allocationId), settlement_id: settlementId, allocation_id: line.allocationId,
      business_date: businessDate, amount: line.amount, cost: saleCost(line, line.qty), at,
    }))));
  await insertSeedRows(db, 'pos.sales_recognition', recognitionColumns + ', correction_id, original_recognition_id',
    corrected.flatMap(({ businessDate, settlementId, correction, changes }) => changes.map(line => ({
      ...row, recognition_id: seedId('correction:' + line.allocationId), settlement_id: settlementId, allocation_id: line.allocationId,
      business_date: businessDate, amount: -line.amount, cost: line.cost, at: correction!.at,
      correction_id: correction!.correction_id, original_recognition_id: originalId(line.allocationId),
    }))));

  await db.query(`
    UPDATE pos.business_day day SET seq = d.seq FROM jsonb_to_recordset($2) d(business_date date, seq integer)
    WHERE day.store_id = $1 AND day.business_date = d.business_date AND day.seq < d.seq AND day.status = 'open'
  `, [storeId, JSON.stringify(days.filter(day => !occupied.has(day.business_date)))]);
  const expenses = (rows.expense as Array<{ expense_id: string; receipt_id: string | null; supplier_id: string | null;
    business_date: string; amount: number; category: string; created_at: string }>).filter(expense =>
    expense.created_at <= cutoff && !occupied.has(expense.business_date));
  await insertSeedRows(db, 'pos.expense_candidate', 'store_id, expense_id, receipt_id, supplier_id, business_date, amount, status',
    expenses.filter(expense => expense.receipt_id).map(expense => ({ ...row, ...expense, status: 'confirmed' })));
  await insertSeedRows(db, 'pos.expense',
    'store_id, expense_id, receipt_id, supplier_id, business_date, category, amount, evidence, memo, status, revision',
    expenses.map(expense => ({ ...row, ...expense, status: 'confirmed', revision: 1 })));

  const closes = new Map((rows.day_closing as Array<{ business_day_id: string; closed_at: string; closing_id: string }>)
    .filter(close => close.closed_at <= cutoff).map(close => [close.business_day_id, close]));
  await insertSeedRows(db, 'pos.drawer', 'store_id, business_date, opening, actual', days
    .filter(day => day.business_date <= businessDate && !occupied.has(day.business_date))
    .map(day => ({ ...row, business_date: day.business_date, opening: day.drawer_opening,
      actual: closes.has(day.business_day_id) ? day.drawer_actual : null })));
  for (const day of days) {
    const close = closes.get(day.business_day_id);
    if (!close || occupied.has(day.business_date)) continue;
    const current = await readClosing({ db, storeId, actorId, at: new Date(close.closed_at), clock: { timezone, dayStart } }, day.business_date);
    if (current.status === 'closed' || current.pendingBills.length) continue;
    const inserted = await insertSeedRows(db, 'pos.closing_snapshot',
      'store_id, closing_id, business_date, closed_by, closed_at, snapshot', [{
        ...row, closing_id: close.closing_id, business_date: day.business_date, closed_by: actorId, closed_at: close.closed_at,
        snapshot: { totals: current.totals, drawer: current.drawer },
      }]);
    if (inserted) await db.query("UPDATE pos.business_day SET status = 'closed' WHERE store_id = $1 AND business_date = $2",
      [storeId, day.business_date]);
  }
  const offset = (Date.parse(businessDate) - Date.parse('2026-11-17')) / 86_400_000;
  await insertSeedRows(db, 'pos.tax_payment',
    'store_id, tax_payment_id, tax_type, type_key, amount, due_on, status, revision, created_by, created_at, updated_at',
    seedSupplement.taxPayments.filter(tax => tax.amount > 0).map(tax => ({
      ...row, tax_payment_id: seedId(tax.id), tax_type: tax.type, type_key: typeKey(tax.type),
      amount: tax.amount, due_on: shiftSeedDate(tax.dueOn, offset), status: 'unpaid', revision: 1,
      created_by: actorId, created_at: cutoff, updated_at: cutoff,
    })));
}
