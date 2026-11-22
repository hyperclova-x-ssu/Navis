import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import { eventLine, saleCost, type SaleLine } from '../../services/pos/catalog.ts';
import { fingerprint, type PaymentMethod } from '../../services/pos/wire.ts';
import type { SeedContext } from './seed-context.ts';

/** Stable IDs for operational tables with no one-to-one ID in the canonical dataset. */
export function seedId(key: string) {
  const hash = createHash('sha256').update('ansungjalbu:service-seed:' + key).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function shiftSeedDate(day: string, days: number) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
}

export function seoulSeedTime(at: string) {
  return new Date(Date.parse(at) + 9 * 3_600_000).toISOString();
}

/** Identifiers are fixed table and column names supplied by the service seed modules. */
export async function insertSeedRows(db: PoolClient, table: string, columns: string, rows: readonly object[]) {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const result = await db.query(`
      INSERT INTO ${table} (${columns})
      SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
      ON CONFLICT DO NOTHING
    `, [JSON.stringify(rows.slice(offset, offset + 1000))]);
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export function groupSeedRows<T, K>(rows: readonly T[], key: (row: T) => K) {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

export type SeedDay = { business_day_id: string; business_date: string; seq: number; drawer_opening: number; drawer_actual: number };
type SeedBill = { bill_id: string; business_day_id: string; member_id: string | null; reservation_id: string | null; recognized_at: string };
type SeedOrder = { order_id: string; origin_bill_id: string; order_no: number; ordered_at: string;
  completed_at: string | null; type: 'dine_in' | 'takeout' };
type SeedAllocation = { bill_id: string; order_line_id: string; allocation_id: string; qty: number };
type SeedLine = { allocation_id: string; menu_id: string; base_price_at_sale: number; option_price_at_sale: number;
  unit_cost_at_sale: number; option_cost_at_sale: number };
type SeedOption = { order_line_id: string; option_id: string };
type SeedDiscount = { allocation_id: string; amount: number };
type SeedPayment = { bill_id: string; payment_id: string; amount: number; counted_method: PaymentMethod;
  transaction_no: string; approval_no: string | null };
type SeedCorrection = { payment_id: string; correction_id: string; at: string; kind: 'cancel' | 'refund'; amount: number; seq: number };
type SeedCorrectionLine = { correction_id: string; allocation_id: string; amount: number | null; qty: number };
const salesByContext = new WeakMap<SeedContext, ReturnType<typeof buildSales>>();

export function historyForSeed(context: SeedContext) {
  const saved = salesByContext.get(context);
  if (saved) return saved;
  const sales = buildSales(context);
  salesByContext.set(context, sales);
  return sales;
}

function buildSales({ rows, cutoff }: SeedContext) {
  const days = new Map((rows.business_day as SeedDay[]).map(row => [row.business_day_id, row.business_date]));
  const orders = new Map((rows.pos_order as SeedOrder[]).map(row => [row.origin_bill_id, row]));
  const allocations = groupSeedRows(rows.bill_allocation as SeedAllocation[], row => row.bill_id);
  const snapshots = new Map((rows.settlement_line as SeedLine[]).map(row => [row.allocation_id, row]));
  const options = groupSeedRows(rows.order_line_option as SeedOption[], row => row.order_line_id);
  const discounts = new Map((rows.discount_allocation as SeedDiscount[]).map(row => [row.allocation_id, row.amount]));
  const payments = new Map((rows.payment as SeedPayment[]).map(row => [row.bill_id, row]));
  const corrections = new Map((rows.payment_correction as SeedCorrection[]).map(row => [row.payment_id, row]));
  const correctionLines = groupSeedRows(rows.correction_line as SeedCorrectionLine[], row => row.correction_id);
  const menus = new Map<string, typeof seedCatalog.menu[number]>(seedCatalog.menu.map(row => [row.dbId, row]));

  return (rows.bill as SeedBill[]).flatMap(bill => {
    const order = orders.get(bill.bill_id)!;
    if (order.ordered_at > cutoff) return [];
    const at = bill.recognized_at <= cutoff ? bill.recognized_at : null;
    const payment = at ? payments.get(bill.bill_id) : undefined;
    const candidate = payment && corrections.get(payment.payment_id);
    const correction = candidate && candidate.at <= cutoff ? candidate : undefined;
    const lines = allocations.get(bill.bill_id)!.map((allocation): SaleLine => {
      const snapshot = snapshots.get(allocation.allocation_id)!;
      const menu = menus.get(snapshot.menu_id)!;
      const selected = new Set(options.get(allocation.order_line_id)?.map(option => option.option_id));
      const gross = allocation.qty * (snapshot.base_price_at_sale + snapshot.option_price_at_sale);
      const discount = discounts.get(allocation.allocation_id) ?? 0;
      return {
        orderLineId: allocation.order_line_id, allocationId: allocation.allocation_id,
        menuId: snapshot.menu_id, name: menu.name, qty: allocation.qty,
        basePrice: snapshot.base_price_at_sale, optionPrice: snapshot.option_price_at_sale,
        baseCost: snapshot.unit_cost_at_sale, optionCost: snapshot.option_cost_at_sale,
        recipeVersion: fingerprint(menu.recipeBase),
        options: menu.groups.flatMap(group => group.options.filter(option => selected.has(option.optionId)).map(option => ({
          optionId: option.optionId, name: option.name, extraPrice: option.extraPrice, extraCost: option.extraCost,
          recipeVersion: fingerprint(option.extraRecipe),
        }))),
        gross, discount, amount: gross - discount,
      };
    });
    const gross = lines.reduce((sum, line) => sum + line.gross, 0);
    const discount = lines.reduce((sum, line) => sum + line.discount, 0);
    const payable = gross - discount;
    const quote = { lines, gross, discount, payable };
    const cost = lines.reduce((sum, line) => sum + (saleCost(line, line.qty) ?? 0), 0);
    const changes = correction ? correctionLines.get(correction.correction_id)!.map(row => {
      const line = lines.find(item => item.allocationId === row.allocation_id)!;
      return {
        ...eventLine(line, row.qty), qty: row.qty,
        amount: row.amount ?? line.amount,
        cost: correction.kind === 'cancel' ? -(saleCost(line, row.qty) ?? 0) : 0,
        gross: correction.kind === 'cancel' ? line.gross : 0,
        discount: correction.kind === 'cancel' ? line.discount : 0,
      };
    }) : [];
    if ((payment?.amount ?? 0) !== (at ? payable : 0)
        || (correction && changes.reduce((sum, line) => sum + line.amount, 0) !== correction.amount)) {
      throw new Error('Café history does not reconcile with the generator');
    }
    return [{
      bill, order, at, payment, correction, changes, cost, lines,
      quote: { ...quote, quoteRevision: Number.parseInt(fingerprint(quote).slice(0, 13), 16) },
      businessDate: days.get(bill.business_day_id)!, settlementId: seedId('settlement:' + bill.bill_id),
    }];
  });
}
