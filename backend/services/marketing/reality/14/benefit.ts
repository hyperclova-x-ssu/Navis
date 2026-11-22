/**
 * Pure coupon benefit rules shared by issue, update and POS redemption. They mirror the browser rules in
 * `src/data/marketing/{benefit,calc}.ts` and `src/pos/loyalty/discounts.ts` so the widget, Navis card and POS
 * compute the same values. No clock, store or randomness.
 */
export type BenefitType = 'free_item' | 'percent' | 'amount' | 'set_price';
export type BenefitKind = 'percent' | 'amount' | 'setPrice';
export type Benefit = { kind: BenefitKind; value: number };
export type BenefitProblem = 'BENEFIT_INVALID' | 'PERCENT_RANGE' | 'AMOUNT_RANGE' | 'SET_PRICE_RANGE' | 'OVER_PRICE' | 'OVER_LIMIT';

export const benefitKinds: readonly BenefitKind[] = ['percent', 'amount', 'setPrice'];
const stored: Record<BenefitKind, BenefitType> = { percent: 'percent', amount: 'amount', setPrice: 'set_price' };
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

export const benefitStored = (benefit: Benefit) => ({ benefitType: stored[benefit.kind], benefitValue: benefit.value });
export function benefitOf(type: BenefitType, value: number): Benefit | null {
  if (type === 'percent') return { kind: 'percent', value };
  if (type === 'amount') return { kind: 'amount', value };
  if (type === 'set_price') return { kind: 'setPrice', value };
  return null;
}

/** Percent rounds half up, as the expiry slider did. */
export function benefitPrice(price: number, benefit: Benefit) {
  return benefit.kind === 'percent' ? Math.round((price * (100 - benefit.value)) / 100)
    : benefit.kind === 'amount' ? price - benefit.value : benefit.value;
}

/** Highest whole percent that keeps the discounted price at or above cost (65 for 3,500/1,200). */
export function maxPercent(price: number, cost: number) {
  return price > 0 ? Math.max(0, Math.floor((1 - cost / price) * 100 + 1e-9)) : 0;
}
export function maxRatePercent(price: number, cost: number) {
  return price > 0 ? Math.round((1 - cost / price) * 1000 + 1e-9) / 10 : 0;
}

/** AC-293: the customer price never goes below unit cost. An unknown cost cannot be checked and is refused. */
export function benefitProblem(benefit: unknown, price: number, cost: number | null): BenefitProblem | null {
  if (!benefit || typeof benefit !== 'object') return 'BENEFIT_INVALID';
  const { kind, value } = benefit as { kind?: unknown; value?: unknown };
  if (!benefitKinds.includes(kind as BenefitKind)) return 'BENEFIT_INVALID';
  if (kind === 'percent') {
    if (!whole(value) || value < 1 || value > 100) return 'PERCENT_RANGE';
  } else {
    if (!whole(value) || value < 1) return kind === 'amount' ? 'AMOUNT_RANGE' : 'SET_PRICE_RANGE';
    if (value > price) return 'OVER_PRICE';
  }
  if (cost === null) return 'OVER_LIMIT';
  if (kind === 'percent') return (value as number) > maxPercent(price, cost) ? 'OVER_LIMIT' : null;
  return benefitPrice(price, { kind: kind as BenefitKind, value: value as number }) < cost ? 'OVER_LIMIT' : null;
}

/** Sell-today economics at one benefit for `qty` items. */
export function expiryEconomics(price: number, cost: number, benefit: Benefit, qty: number) {
  const discountedPrice = benefitPrice(price, benefit);
  const marginEach = discountedPrice - cost;
  return { price, discountedPrice, marginEach, qty, ifAllSold: marginEach * qty, lossIfDiscarded: cost * qty,
    maxRatePercent: maxRatePercent(price, cost), maxPercent: maxPercent(price, cost) };
}

export type RedeemLine = { lineId: string; menuId: string; gross: number; basePrice: number; options: { optionId: string; extraPrice: number }[] };
export type Terms = { benefitType: BenefitType; benefitValue: number; targetRef: string | null; startsOn: string; endsOn: string;
  validHours: { weekday: number; startHour: number; endHour: number }[] | null };
export type DiscountOutcome = { ok: true; amount: number; scope: 'bill' | 'line'; targetLineIds: string[] }
  | { ok: false; reason: string };

const percentOf = (amount: number, percent: number) => Number(BigInt(amount) * BigInt(percent) / 100n);
export const extraShot = 'opt-extra-shot';
const isShot = (optionId: string) => optionId === extraShot || optionId.endsWith(':shot');

/** Validity window, weekday/hour window, and line targeting for a presented code (browser `quoteDiscount`). */
export function quoteCouponDiscount(terms: Terms, lines: readonly RedeemLine[], local: { date: string; weekday: number; hour: number }): DiscountOutcome {
  if (terms.startsOn > local.date || terms.endsOn < local.date) return { ok: false, reason: 'COUPON_ENDED' };
  if (terms.validHours?.length && !terms.validHours.some(h => h.weekday === local.weekday && local.hour >= h.startHour && local.hour < h.endHour)) {
    return { ok: false, reason: 'COUPON_HOURS' };
  }
  const shot = terms.targetRef === extraShot;
  const targets = terms.targetRef ? lines.filter(line => shot ? line.options.some(option => isShot(option.optionId))
    : line.menuId === terms.targetRef) : [...lines];
  if (!targets.length) return { ok: false, reason: shot ? 'COUPON_SHOT_REQUIRED' : 'COUPON_MENU_REQUIRED' };
  const eligibleGross = targets.reduce((sum, line) => sum + line.gross, 0);
  let amount: number;
  if (terms.benefitType === 'percent') amount = percentOf(eligibleGross, terms.benefitValue);
  else if (terms.benefitType === 'amount') amount = Math.min(terms.benefitValue, eligibleGross);
  else if (terms.benefitType === 'set_price') amount = eligibleGross - terms.benefitValue;
  else amount = shot ? targets[0].options.find(option => isShot(option.optionId))!.extraPrice : targets[0].basePrice;
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'COUPON_INVALID_BENEFIT' };
  const targetLineIds = (terms.benefitType === 'free_item' ? targets.slice(0, 1) : targets).map(line => line.lineId);
  return { ok: true, amount, scope: terms.targetRef ? 'line' : 'bill', targetLineIds };
}

/** Uppercase base32-like code without ambiguous characters. */
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function couponCode(prefix: 'NV' | 'PN' | 'SM', bytes: Uint8Array) {
  let out = prefix;
  for (let index = 0; index < 8; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

/** 21:00–07:59 local is night; D-331 proposes the next calendar day at 08:00. */
export const isNightHour = (hour: number) => hour >= 21 || hour < 8;
