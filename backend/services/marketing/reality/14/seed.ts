import type { PoolClient } from 'pg';
import type { SeedContext } from '../../../../packages/db/seed-context.ts';
import { historyForSeed, insertSeedRows } from '../../../../packages/db/seed-history.ts';
import { demoIdentity } from '../../../account/identity.ts';
import { fingerprint } from '../../../pos/wire.ts';
import { bumpRevision, type Origin, type Route } from './records.ts';
import type { Terms } from './benefit.ts';

type Coupon = { coupon_id: string; name: string; origin: Origin; benefit_type: Terms['benefitType'];
  benefit_value: number; starts_on: string; ends_on: string; status: 'active' | 'ended' };
type Code = { code_id: string; coupon_id: string; code: string; route: Route; issue_count: number; activated_at: string };
type Discount = { discount_id: string; origin_bill_id: string; coupon_code_id: string | null; amount: number };

/** Copy historical issuance and recognized uses without creating sends, claims or outbox work. */
export async function seedCoupons(db: PoolClient, storeId: string, context: SeedContext) {
  const store = { store_id: storeId };
  const codes = (context.rows.coupon_code as Code[]).filter(code => code.activated_at <= context.cutoff);
  const activated = new Map(codes.map(code => [code.coupon_id, code.activated_at]));
  const coupons = new Map((context.rows.coupon as Coupon[]).filter(row => activated.has(row.coupon_id))
    .map(row => [row.coupon_id, row]));
  const terms = (coupon: Coupon) => ({
    benefitType: coupon.benefit_type, benefitValue: coupon.benefit_value, targetRef: null, endsOn: coupon.ends_on,
  });
  const created = await insertSeedRows(db, 'marketing.coupon',
    'store_id, coupon_id, origin, name, benefit_type, benefit_value, starts_on, ends_on, status, origin_ref, business_date, created_at, revision',
    [...coupons.values()].map(coupon => ({ ...store, ...coupon, origin_ref: { source: 'cafe-history' },
      business_date: coupon.starts_on, created_at: activated.get(coupon.coupon_id), revision: 1 })));
  const codeById = new Map(codes.map(row => [row.code_id, row]));
  const sales = new Map(historyForSeed(context).filter(sale => sale.at).map(sale => [sale.bill.bill_id, sale]));
  const redemptions = (context.rows.bill_discount as Discount[]).flatMap(discount => {
    const code = discount.coupon_code_id && codeById.get(discount.coupon_code_id);
    const sale = sales.get(discount.origin_bill_id);
    if (!code || !sale || discount.amount <= 0) return [];
    const coupon = coupons.get(code.coupon_id)!;
    const reversal = sale.correction?.kind === 'cancel' ? sale.correction : null;
    return [{
      ...store, redemption_id: discount.discount_id, code_id: code.code_id, coupon_id: code.coupon_id,
      actor_id: demoIdentity.userId, request_key: 'cafe-seed:' + discount.discount_id, request_hash: fingerprint(discount),
      // The Customer owner API uses the member ID as its customer reference.
      bill_id: sale.bill.bill_id, customer_id: sale.bill.member_id, discount: discount.amount,
      scope: { kind: 'bill', targetLineIds: [] }, terms: { ...terms(coupon), startsOn: coupon.starts_on, validHours: null },
      business_date: sale.businessDate, state: reversal ? 'reversed' : 'committed', held_at: sale.at,
      hold_until: sale.at, settlement_id: sale.settlementId, order_id: sale.order.order_id, committed_at: sale.at,
      correction_id: reversal?.correction_id ?? null, reversed_at: reversal?.at ?? null, revision: reversal ? 2 : 1,
    }];
  });
  // The generated café history assigns discounts independently of its nominal issue count.
  // Preserve the discounts already recognized in that history and reconcile its synthetic issuance.
  const committedByCode = new Map<string, number>();
  for (const row of redemptions) {
    if (row.state === 'committed') committedByCode.set(row.code_id, (committedByCode.get(row.code_id) ?? 0) + 1);
  }
  const issued = await insertSeedRows(db, 'marketing.coupon_code',
    'store_id, code_id, coupon_id, code, route, issue_count, activated_at, issued_terms, created_at, revision',
    codes.map(code => ({ ...store, ...code, code: code.code.replaceAll('-', ''), revision: 1,
      issue_count: Math.max(code.issue_count, committedByCode.get(code.code_id) ?? 0),
      issued_terms: terms(coupons.get(code.coupon_id)!), created_at: code.activated_at })));
  const redeemed = await insertSeedRows(db, 'marketing.coupon_redemption',
    'store_id, redemption_id, code_id, coupon_id, actor_id, request_key, request_hash, bill_id, customer_id, discount, scope, terms, business_date, state, held_at, hold_until, settlement_id, order_id, committed_at, correction_id, reversed_at, revision',
    redemptions);
  if (created || issued) await bumpRevision({ db, storeId }, 'coupons');
  if (redeemed) await bumpRevision({ db, storeId }, 'redemptions');
  if (created || issued || redeemed) await db.query(`
    UPDATE marketing.r19_projection_state SET revision = revision + 1,
      updated_at = greatest(updated_at, $2::timestamptz) WHERE store_id = $1
  `, [storeId, context.cutoff]);
}
