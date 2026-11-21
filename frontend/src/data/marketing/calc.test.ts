/** Pure calculations (DATA_MODEL 10.15.4, R2 RELAY ③): one rounding function for every surface. */
import { describe, expect, it } from 'vitest';
import { benefitComparison, expiryDiscount, ratePercent, roundPercent } from '../widget-data';
import { belowPercent, isNightHour } from './calc';

describe('roundPercent / ratePercent (half up to a whole %)', () => {
  it('R2 RELAY ③: 22.4→22, 21.54→22, 34.29→34, 18.75→19, and .5 goes up', () => {
    expect([22.4, 21.54, 34.29, 18.75].map(roundPercent)).toEqual([22, 22, 34, 19]);
    expect([0.5, 1.5, 22.5, 99.49, 0].map(roundPercent)).toEqual([1, 2, 23, 99, 0]);
  });
  it('rates from counts use exact integer half-up (28÷125, 28÷130, 12÷35, 3÷16, 6÷41, 28÷120)', () => {
    expect([[28, 125], [28, 130], [12, 35], [3, 16], [6, 41], [28, 120], [7, 33], [6, 36]].map(([u, i]) => ratePercent(u, i))).toEqual([22, 22, 34, 19, 15, 23, 21, 17]);
    expect(ratePercent(1, 8)).toBe(13); // 12.5 → 13
    expect(ratePercent(0, 0)).toBeNull();
    expect(ratePercent(0, 10)).toBe(0);
  });
});

describe('expiryDiscount (최대 할인율 = 1 − 원가 ÷ 판매가)', () => {
  it('croissant 3,500/1,200: limit 65.7% (slider 65), at 40%: 2,100원 · 900원 each · 6 → 5,400 · discard loss 7,200', () => {
    const d = expiryDiscount(3_500, 1_200, 40, 6);
    expect(d).toEqual({ rate: 40, price: 3_500, discountedPrice: 2_100, marginEach: 900, qty: 6, ifAllSold: 5_400, lossIfDiscarded: 7_200, maxRatePercent: 65.7, maxSliderRate: 65, withinLimit: true });
    expect(expiryDiscount(3_500, 1_200, 65).marginEach).toBeGreaterThanOrEqual(0);
    expect(expiryDiscount(3_500, 1_200, 66)).toMatchObject({ withinLimit: false, marginEach: -10 });
    expect(expiryDiscount(3_500, 1_200, 40.5).withinLimit).toBe(false);
  });
});

describe('benefitComparison (latte 5,000/1,750, shot 300)', () => {
  it('free shot 2,950 / 10% off 2,750 / 500 off 2,750; free shot recommended by 200', () => {
    const b = benefitComparison({ price: 5_000, unitCost: 1_750 }, 300);
    expect(b.options.map((o) => [o.id, o.marginPerCoupon, o.recommended])).toEqual([['free-shot', 2_950, true], ['percent-10', 2_750, false], ['amount-500', 2_750, false]]);
    expect(b.recommendedId).toBe('free-shot');
    expect(b.differenceVsNext).toBe(200);
    expect(b.options[1].name).toEqual({ key: 'data.marketing.benefit.percent', params: { p: 10 } });
  });
  it('the largest kept amount wins when the shot costs more', () => {
    expect(benefitComparison({ price: 5_000, unitCost: 1_750 }, 900).recommendedId).toBe('percent-10');
  });
});

describe('helpers', () => {
  it('below 60% is strict and integer-safe; night is 21:00–08:00', () => {
    expect([belowPercent(2, 5), belowPercent(3, 5), belowPercent(4, 9), belowPercent(1, 0)]).toEqual([true, false, true, false]);
    expect([7, 8, 20, 21, 23, 0].map(isNightHour)).toEqual([true, false, false, true, true, true]);
  });
});
