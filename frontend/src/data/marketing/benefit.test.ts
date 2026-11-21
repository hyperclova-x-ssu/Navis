/** One ordinary benefit model for every coupon (정률 할인 · 금액 할인 · 세트 가격): storage mapping, price, validation and the three message families. */
import { describe, expect, it } from 'vitest';
import { benefitName, benefitPrice, benefitProblem, benefitStored, couponBenefit, expiryCouponName, expiryPostText, expirySmsBody } from './benefit';
import { createTranslator } from '../../i18n';
import { dataBundles } from '../messages';
import { resolveDataText } from '../widget-data';

const CROISSANT = { price: 3_500, cost: 1_200 };

describe('storage: one benefitType + benefitValue pair, no side field', () => {
  it('maps the three kinds to the stored pair and back', () => {
    expect(benefitStored({ kind: 'percent', value: 40 })).toEqual({ benefitType: 'percent', benefitValue: 40 });
    expect(benefitStored({ kind: 'amount', value: 500 })).toEqual({ benefitType: 'amount', benefitValue: 500 });
    expect(benefitStored({ kind: 'setPrice', value: 2_800 })).toEqual({ benefitType: 'set_price', benefitValue: 2_800 });
    expect(couponBenefit({ benefitType: 'set_price', benefitValue: 2_800 })).toEqual({ kind: 'setPrice', value: 2_800 });
    expect(couponBenefit({ benefitType: 'percent', benefitValue: 10 })).toEqual({ kind: 'percent', value: 10 });
    expect(couponBenefit({ benefitType: 'free_item', benefitValue: 0 })).toBeNull();
  });
  it('the price a customer pays', () => {
    expect(benefitPrice(3_500, { kind: 'percent', value: 40 })).toBe(2_100);
    expect(benefitPrice(3_500, { kind: 'amount', value: 500 })).toBe(3_000);
    expect(benefitPrice(3_500, { kind: 'setPrice', value: 2_800 })).toBe(2_800);
  });
});

describe('validation (percent 1–100, amount and set price > 0 and not above the item price, never below cost)', () => {
  const problem = (kind: string, value: unknown, cost: number | null = CROISSANT.cost) => benefitProblem({ kind, value } as never, CROISSANT.price, cost);
  it('percent: whole 1–100, then the cost limit of AC-293 (65)', () => {
    expect([0, -5, 40.5, 101, Number.NaN].map((v) => problem('percent', v))).toEqual(['percentRange', 'percentRange', 'percentRange', 'percentRange', 'percentRange']);
    expect([66, 100].map((v) => problem('percent', v))).toEqual(['overLimit', 'overLimit']);
    expect([1, 40, 65].map((v) => problem('percent', v))).toEqual([null, null, null]);
  });
  it('amount: above 0, not above the price, price − amount not below cost', () => {
    expect([0, -1, 10.5].map((v) => problem('amount', v))).toEqual(['amountRange', 'amountRange', 'amountRange']);
    expect(problem('amount', 3_501)).toBe('overPrice');
    expect([2_301, 3_500].map((v) => problem('amount', v))).toEqual(['overLimit', 'overLimit']);
    expect([1, 500, 2_300].map((v) => problem('amount', v))).toEqual([null, null, null]);
  });
  it('set price: above 0, not above the price, not below cost', () => {
    expect([0, 99.5].map((v) => problem('setPrice', v))).toEqual(['setPriceRange', 'setPriceRange']);
    expect(problem('setPrice', 3_501)).toBe('overPrice');
    expect(problem('setPrice', 1_199)).toBe('overLimit');
    expect([1_200, 2_800, 3_500].map((v) => problem('setPrice', v))).toEqual([null, null, null]);
  });
  it('an unknown kind and an unknown cost are refused', () => {
    expect(problem('free', 1)).toBe('kind');
    expect(benefitProblem(null as never, 3_500, 1_200)).toBe('kind');
    expect(problem('percent', 10, null)).toBe('overLimit');
  });
});

describe('one wording everywhere: coupon name, text body, post line, short benefit', () => {
  const ko = createTranslator('ko', ...dataBundles);
  const resolve = (text: Parameters<typeof resolveDataText>[1]) => resolveDataText((key, params) => ko.t(key, params), text);
  it('keeps the percent keys as they were and adds amount and set price families', () => {
    expect(expiryCouponName('data.item.croissant', { kind: 'percent', value: 40 })).toEqual({ key: 'data.marketing.coupon.expiryToday', params: { p: 40 }, keyParams: { item: 'data.item.croissant' } });
    expect(expiryCouponName('data.item.croissant', { kind: 'amount', value: 500 })).toMatchObject({ key: 'data.marketing.coupon.expiryTodayAmount', params: { amount: '500' } });
    expect(expiryCouponName('data.item.croissant', { kind: 'setPrice', value: 2_800 })).toMatchObject({ key: 'data.marketing.coupon.expiryTodaySetPrice', params: { price: '2,800' } });
    expect(expirySmsBody('data.item.croissant', { kind: 'amount', value: 500 })).toMatchObject({ key: 'data.marketing.sms.expiryAmount', params: { amount: '500' } });
    expect(expirySmsBody('data.item.croissant', { kind: 'setPrice', value: 2_800 })).toMatchObject({ key: 'data.marketing.sms.expirySetPrice', params: { price: '2,800' } });
    expect(expiryPostText('data.item.croissant', { kind: 'percent', value: 40 }, 'AB12')).toEqual({ key: 'data.marketing.post.expiry', params: { p: 40, code: 'AB12' }, keyParams: { item: 'data.item.croissant' } });
    expect(expiryPostText('data.item.croissant', { kind: 'setPrice', value: 2_800 }, 'AB12')).toMatchObject({ key: 'data.marketing.post.expirySetPrice', params: { price: '2,800', code: 'AB12' } });
    expect(benefitName({ kind: 'percent', value: 40 })).toEqual({ key: 'data.marketing.benefit.percent', params: { p: 40 } });
    expect(benefitName({ kind: 'amount', value: 500 })).toEqual({ key: 'data.marketing.benefit.amount', params: { amount: '500' } });
    expect(benefitName({ kind: 'setPrice', value: 2_800 })).toEqual({ key: 'data.marketing.benefit.setPrice', params: { price: '2,800' } });
  });
  it('the Korean sentences say the benefit in the same words', () => {
    expect(resolve(benefitName({ kind: 'percent', value: 40 }))).toBe('40% 할인');
    expect(resolve(benefitName({ kind: 'amount', value: 500 }))).toBe('500원 할인');
    expect(resolve(benefitName({ kind: 'setPrice', value: 2_800 }))).toBe('세트 가격 2,800원');
    expect(resolve(expiryCouponName('data.item.croissant', { kind: 'setPrice', value: 2_800 }))).toContain('세트 가격 2,800원');
    expect(resolve(expirySmsBody('data.item.croissant', { kind: 'amount', value: 500 }))).toContain('500원 할인');
    expect(resolve(expiryPostText('data.item.croissant', { kind: 'setPrice', value: 2_800 }, 'AB12'))).toMatch(/세트 가격 2,800원.*AB12/);
  });
});
