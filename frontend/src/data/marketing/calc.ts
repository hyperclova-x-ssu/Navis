/**
 * Pure marketing calculations (DATA_MODEL 10.15.4 ‘순수 계산’, ARCHITECTURE 11.13.4). Screens and Navis
 * call the same functions; nothing here reads the store, the clock or randomness.
 */
import type { BenefitComparison, BenefitOption, ExpiryDiscount, SlotBenefitId } from './types';

/** Quiet hour: expected below this percent of the same weekday/hour average (plan-2, Q-33). */
export const QUIET_THRESHOLD_PERCENT = 60;
/** Recommended sell-today discount (plan-2 기본 40%), capped by the limit. */
export const RECOMMENDED_EXPIRY_RATE = 40;
/** Issue limit for a public post (place news, blog, clip) when posting (Q-41). */
export const PUBLIC_ISSUE_LIMIT = 10;
/** Coupon extension (Q-41). */
export const EXTEND_DAYS = 7;
/** ‘곧 끝나요’: active and ending within this many days. */
export const ENDING_SOON_DAYS = 3;
/** Second discount hint (text only, plan-2). */
export const SECOND_DISCOUNT_HOURS = 3;
/** A video needs at least this many picked photos (D-80, AC-329·344). */
export const MIN_PROMO_PHOTOS = 5;

/**
 * Whole-percent rounding with half up (R2 RELAY ③): 22.4 → 22, 21.54 → 22, 34.29 → 34, 18.75 → 19.
 * The tiny epsilon keeps values like 22.499999… from binary floating point on the documented side.
 */
export function roundPercent(x: number): number {
  return Math.floor(x + 0.5 + 1e-9);
}

/** used ÷ issued as a whole percent (exact integer half-up); null when nothing was issued. */
export function ratePercent(used: number, issued: number): number | null {
  if (!(issued > 0)) return null;
  return Math.floor((200 * used + issued) / (2 * issued));
}

/** True when `x` is below `threshold` percent of `base` (integer-safe). */
export const belowPercent = (x: number, base: number, threshold = QUIET_THRESHOLD_PERCENT): boolean => base > 0 && x * 100 < base * threshold;

/** D-312 permits coupon sends at any hour. F-278 applies its own rule to promotional notices. */
export const NIGHT_SEND_RESTRICTION = false;
/** True for 21:00–07:59; only labels a scheduled send (`MessageSend.isNight`), it never blocks one. */
export const isNightHour = (hour: number): boolean => hour >= 21 || hour < 8;

/**
 * Sell-today discount at an integer `rate` %: price after discount, won kept per item, totals for `qty`.
 * Limit = 1 − cost ÷ price (65.7% for 3,500/1,200); the slider stops at the whole percent below it (65).
 */
export function expiryDiscount(price: number, cost: number, rate: number, qty = 1): ExpiryDiscount {
  const maxRatePercent = price > 0 ? Math.round((1 - cost / price) * 1000 + 1e-9) / 10 : 0;
  const maxSliderRate = price > 0 ? Math.max(0, Math.floor((1 - cost / price) * 100 + 1e-9)) : 0;
  const discountedPrice = Math.round((price * (100 - rate)) / 100);
  const marginEach = discountedPrice - cost;
  return {
    rate, price, discountedPrice, marginEach, qty,
    ifAllSold: marginEach * qty,
    lossIfDiscarded: cost * qty,
    maxRatePercent, maxSliderRate,
    withinLimit: Number.isInteger(rate) && rate >= 0 && rate <= maxSliderRate,
  };
}

const BENEFITS: readonly { readonly id: SlotBenefitId; readonly type: BenefitOption['type']; readonly value: number; readonly name: BenefitOption['name'] }[] = [
  { id: 'free-shot', type: 'free_item', value: 0, name: { key: 'data.marketing.benefit.freeShot' } },
  { id: 'percent-10', type: 'percent', value: 10, name: { key: 'data.marketing.benefit.percent', params: { p: 10 } } },
  { id: 'amount-500', type: 'amount', value: 500, name: { key: 'data.marketing.benefit.amount', params: { amount: 500 } } },
];
export const SLOT_BENEFIT_IDS: readonly SlotBenefitId[] = BENEFITS.map((b) => b.id);

/**
 * Won kept per coupon on one menu for each slot benefit (latte 5,000/1,750, shot 300 →
 * free shot 2,950 / 10% off 2,750 / 500 off 2,750). The recommendation is the largest; ties keep list order.
 */
export function benefitComparison(menu: { readonly price: number; readonly unitCost: number }, shotCost: number | null): BenefitComparison {
  const kept = (b: (typeof BENEFITS)[number]): number =>
    b.type === 'free_item' ? menu.price - menu.unitCost - (shotCost ?? 0)
      : b.type === 'percent' ? Math.round((menu.price * (100 - b.value)) / 100) - menu.unitCost
        : menu.price - b.value - menu.unitCost;
  const benefits = shotCost === null ? BENEFITS.filter(b => b.type !== 'free_item') : BENEFITS;
  const values = benefits.map(kept);
  const best = values.reduce((bi, v, i) => (v > values[bi] ? i : bi), 0);
  const next = Math.max(...values.filter((_, i) => i !== best));
  const options: BenefitOption[] = benefits.map((b, i) => ({ id: b.id, type: b.type, value: b.value, name: b.name, marginPerCoupon: values[i], recommended: i === best }));
  return { options, recommendedId: benefits[best].id, differenceVsNext: values[best] - next };
}
