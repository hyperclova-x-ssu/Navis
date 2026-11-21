/**
 * The one coupon benefit model (owner decision 2026-11-20): 정률 할인 N% · 금액 할인 N원 · 세트 가격 N원, as `{kind, value}`.
 * A coupon stores it in `benefitType` + `benefitValue` only (`setPrice` is `set_price`, the type the POS already reads);
 * the handler, the projectors and every coupon widget use these functions, so the wording and the rules never differ.
 * Pure: no store, no clock.
 */
import type { DataText } from '../db/types';
import { expiryDiscount } from './calc';
import type { BenefitType, Coupon, CouponBenefit, CouponBenefitKind } from './types';

export const COUPON_BENEFIT_KINDS: readonly CouponBenefitKind[] = ['percent', 'amount', 'setPrice'];
const STORED: Readonly<Record<CouponBenefitKind, BenefitType>> = { percent: 'percent', amount: 'amount', setPrice: 'set_price' };

/** The stored pair for a benefit (the only place a coupon keeps it). */
export const benefitStored = (b: CouponBenefit): Pick<Coupon, 'benefitType' | 'benefitValue'> => ({ benefitType: STORED[b.kind], benefitValue: b.value });
/** The benefit of a stored coupon; null for a free item (slot coupons give a menu option, not one of the three). */
export function couponBenefit(c: Pick<Coupon, 'benefitType' | 'benefitValue'>): CouponBenefit | null {
  switch (c.benefitType) {
    case 'percent': return { kind: 'percent', value: c.benefitValue };
    case 'amount': return { kind: 'amount', value: c.benefitValue };
    case 'set_price': return { kind: 'setPrice', value: c.benefitValue };
    default: return null;
  }
}

/** What the customer pays for an item sold at `price` with this benefit (percent rounds half up, as the slider did). */
export function benefitPrice(price: number, b: CouponBenefit): number {
  return b.kind === 'percent' ? Math.round((price * (100 - b.value)) / 100) : b.kind === 'amount' ? price - b.value : b.value;
}

/** Why a benefit cannot be used; each name is the tail of `data.marketing.error.<name>` (`kind` → `benefitInvalid`). */
export type BenefitProblem = 'kind' | 'percentRange' | 'amountRange' | 'setPriceRange' | 'overPrice' | 'overLimit';
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Percent is a whole 1–100; amount and set price are whole won above 0 and not above the item price. On top of that the
 * AC-293 limit stays for all three: the price the customer pays never goes below the unit cost (“버리는 것보다 이득”),
 * which for a percent is the old slider stop at 65. An unknown cost cannot be checked, so it is refused (the `partial` state).
 */
export function benefitProblem(b: CouponBenefit | null | undefined, price: number, cost: number | null): BenefitProblem | null {
  if (!b || typeof b !== 'object' || !COUPON_BENEFIT_KINDS.includes(b.kind)) return 'kind';
  const v: unknown = b.value;
  if (b.kind === 'percent') {
    if (!whole(v) || v < 1 || v > 100) return 'percentRange';
  } else {
    if (!whole(v) || v < 1) return b.kind === 'amount' ? 'amountRange' : 'setPriceRange';
    if (v > price) return 'overPrice';
  }
  if (cost === null) return 'overLimit';
  if (b.kind === 'percent') return b.value > expiryDiscount(price, cost, 0).maxSliderRate ? 'overLimit' : null;
  return benefitPrice(price, b) < cost ? 'overLimit' : null;
}
/** The highest value of a kind that still passes `benefitProblem` (for the hint under the field); 0 when nothing does. */
export function benefitMax(kind: CouponBenefitKind, price: number, cost: number): number {
  if (kind === 'percent') return expiryDiscount(price, cost, 0).maxSliderRate;
  return Math.max(0, kind === 'amount' ? price - cost : price);
}

/* ───────────── wording: one family of message keys per kind ───────────── */
const PARAM: Readonly<Record<CouponBenefitKind, string>> = { percent: 'p', amount: 'amount', setPrice: 'price' };
const SUFFIX: Readonly<Record<CouponBenefitKind, string>> = { percent: '', amount: 'Amount', setPrice: 'SetPrice' };
/** Won with thousands commas (“2,800”), the same in every language; a percent stays a number. */
const won = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const params = (b: CouponBenefit): Readonly<Record<string, string | number>> => ({ [PARAM[b.kind]]: b.kind === 'percent' ? b.value : won(b.value) });

/** “40% 할인” · “500원 할인” · “세트 가격 2,800원”: the short benefit shown in the form, summary and lists. */
export const benefitName = (b: CouponBenefit): DataText => ({ key: `data.marketing.benefit.${b.kind}`, params: params(b) });
/** The sell-today coupon name: “크루아상 오늘만 40%” and its amount / set price siblings. */
export const expiryCouponName = (itemNameKey: string, b: CouponBenefit): DataText => ({ key: `data.marketing.coupon.expiryToday${SUFFIX[b.kind]}`, params: params(b), keyParams: { item: itemNameKey } });
/** The text-message body (without the fixed ad head and opt-out tail). */
export const expirySmsBody = (itemNameKey: string, b: CouponBenefit): DataText => ({ key: `data.marketing.sms.expiry${SUFFIX[b.kind]}`, params: params(b), keyParams: { item: itemNameKey } });
/** The public post line, with the generated coupon code. */
export const expiryPostText = (itemNameKey: string, b: CouponBenefit, code: string): DataText => ({ key: `data.marketing.post.expiry${SUFFIX[b.kind]}`, params: { ...params(b), code }, keyParams: { item: itemNameKey } });
