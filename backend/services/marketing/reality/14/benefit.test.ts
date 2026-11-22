import { describe, expect, it } from 'vitest';
import { benefitPrice as browserPrice, benefitProblem as browserProblem } from '../../../../../frontend/src/data/marketing/benefit.ts';
import { benefitPrice, benefitProblem, couponCode, maxPercent, maxRatePercent, quoteCouponDiscount, type Terms } from './benefit.ts';

const browserNames: Record<string, string> = {
  kind: 'BENEFIT_INVALID', percentRange: 'PERCENT_RANGE', amountRange: 'AMOUNT_RANGE', setPriceRange: 'SET_PRICE_RANGE',
  overPrice: 'OVER_PRICE', overLimit: 'OVER_LIMIT',
};

describe('benefit rules', () => {
  it('match the browser widget rules over a price, cost and value grid', () => {
    for (const price of [0, 1, 990, 3500, 4800]) {
      for (const cost of [null, 0, 1200, 3500, 5000]) {
        for (const kind of ['percent', 'amount', 'setPrice'] as const) {
          for (const value of [-1, 0, 1, 33, 65, 66, 100, 101, 1200, 2300, 3500, 3501, 2.5]) {
            const expected = browserProblem({ kind, value }, price, cost);
            expect(benefitProblem({ kind, value }, price, cost)).toBe(expected === null ? null : browserNames[expected]);
            if (Number.isInteger(value) && value > 0) expect(benefitPrice(price, { kind, value })).toBe(browserPrice(price, { kind, value }));
          }
        }
      }
    }
    expect(benefitProblem({ kind: 'free', value: 1 }, 3500, 1200)).toBe('BENEFIT_INVALID');
    expect([maxPercent(3500, 1200), maxRatePercent(3500, 1200)]).toEqual([65, 65.7]);
  });

  it('quotes line-targeted, free-item and windowed discounts like the POS loyalty quote', () => {
    const base: Terms = { benefitType: 'percent', benefitValue: 10, targetRef: null, startsOn: '2026-11-17', endsOn: '2026-11-30', validHours: null };
    const lines = [
      { lineId: 'a', menuId: 'latte', gross: 4500, basePrice: 4000, options: [{ optionId: 'opt-extra-shot', extraPrice: 500 }] },
      { lineId: 'b', menuId: 'croissant', gross: 3500, basePrice: 3500, options: [] },
    ];
    const at = { date: '2026-11-17', weekday: 2, hour: 15.75 };
    expect(quoteCouponDiscount(base, lines, at)).toEqual({ ok: true, amount: 800, scope: 'bill', targetLineIds: ['a', 'b'] });
    expect(quoteCouponDiscount({ ...base, benefitType: 'free_item', benefitValue: 0, targetRef: 'opt-extra-shot' }, lines, at))
      .toEqual({ ok: true, amount: 500, scope: 'line', targetLineIds: ['a'] });
    expect(quoteCouponDiscount({ ...base, benefitType: 'set_price', benefitValue: 2800, targetRef: 'croissant' }, lines, at))
      .toEqual({ ok: true, amount: 700, scope: 'line', targetLineIds: ['b'] });
    expect(quoteCouponDiscount({ ...base, validHours: [{ weekday: 2, startHour: 14, endHour: 15 }] }, lines, at))
      .toEqual({ ok: false, reason: 'COUPON_HOURS' });
    expect(quoteCouponDiscount({ ...base, endsOn: '2026-11-16' }, lines, at)).toEqual({ ok: false, reason: 'COUPON_ENDED' });
    expect(quoteCouponDiscount({ ...base, targetRef: 'bagel' }, lines, at)).toEqual({ ok: false, reason: 'COUPON_MENU_REQUIRED' });
  });

  it('generates codes without ambiguous characters', () => {
    const code = couponCode('NV', new Uint8Array([0, 1, 2, 3, 31, 32, 255, 8]));
    expect(code).toMatch(/^NV[A-HJ-NP-Z2-9]{8}$/);
  });
});
