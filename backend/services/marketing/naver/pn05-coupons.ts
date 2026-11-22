import type {
  CouponIssue, MembershipBenefit, OrderPromotion, PlaceCoupon, PlaceCouponWrite, PromotionWrite,
} from '../../../packages/naver/contracts/pn05/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { arr, bool, int, isoDate, num, obj, oneOf, opaqueRef, opt, project, str, type Field, type Shape } from './schema.ts';
import { ownerText, partner, requireSecondConfirmation, seoulDate, segment } from './transport.ts';

/**
 * PN05 source-specific NAVER coupon ports (O Place coupon and Order promotion, P named membership)
 * for marketing B14. Navis codes, stock and POS redemption stay in their own ledger.
 * Contract: packages/naver/contracts/pn05 · persona capability pn05.
 *
 * Sources: create https://help.naver.com/service/30026/contents/20833 · delete keeps earlier downloads
 * https://help.naver.com/service/30026/contents/20837 · issue use/unuse, none after expiry
 * https://help.naver.com/service/30026/contents/20843 · marketing-message coupon (no display period or
 * quantity, delete 30 days after sending) https://help.naver.com/service/30026/contents/21111 ·
 * Order promotion https://help.naver.com/service/30026/contents/20710 · membership partners
 * https://smartplace.naver.com/notices/1100 and coupons https://help.naver.com/service/30026/contents/25061.
 */
const benefitShape: Shape = obj({ type: oneOf(['amount', 'percent', 'gift']), value: opt(num()), item: opt(str({ min: 1 })) });
const period = obj({ from: isoDate, to: isoDate });
export const placeCouponShape = obj({
  ref: opaqueRef, type: oneOf(['place', 'booking', 'order']), name: str(), benefit: benefitShape,
  audience: oneOf(['all', 'benefit-subscribers', 'marketing-message']),
  displayPeriod: { ...period, optional: true, nullable: true } as Field, quantity: { ...int({ min: 1 }), optional: true, nullable: true } as Field,
  conditions: opt(str()),
});
export const couponIssueShape = obj({ ref: opaqueRef, maskedNumber: str(), issuedOn: isoDate, expiresOn: isoDate, used: bool() });
const promotionCoupon = obj({
  stampCount: int({ min: 1, max: 10 }), name: str({ min: 2, max: 18 }), validDays: int({ min: 30, max: 999 }),
  canCombine: bool(), canUseAlone: bool(), instructions: opt(str({ min: 5, max: 100 })),
});
export const orderPromotionShape = obj({
  ref: opaqueRef, name: str({ min: 2, max: 20 }), from: isoDate, to: isoDate, state: oneOf(['upcoming', 'active', 'ended']),
  orderAmountPerStamp: int({ min: 1_000, max: 99_999_999 }), coupons: arr(promotionCoupon, { min: 1, max: 10 }),
  instructions: opt(str({ min: 5, max: 500 })),
});
export const membershipBenefitShape = obj({
  ref: opaqueRef, provider: oneOf(['도도포인트', 'OKPOS 단골플러스', '페이히어']), type: oneOf(['points', 'stamps', 'coupon']),
  benefit: str(), validDays: opt(int({ min: 0 })), visible: opt(bool()), paused: opt(bool()),
});
const items = (item: Shape) => obj({ items: arr(item, { max: 100 }) });

function benefitInput(value: PlaceCouponWrite['benefit']): PlaceCouponWrite['benefit'] {
  if (value?.type === 'gift') return { type: 'gift', item: ownerText(value.item, Infinity, 'benefit.item').trim() };
  if (value?.type === 'amount' && Number.isSafeInteger(value.value) && value.value >= 1) return { type: 'amount', value: value.value };
  if (value?.type === 'percent' && Number.isFinite(value.value) && value.value > 0 && value.value <= 100) return { type: 'percent', value: value.value };
  throw new NaverAdapterError('INVALID_INPUT', { detail: 'benefit' });
}

export function createCouponPort(provider: Provider, clock: { now(): Date } = { now: () => new Date() }) {
  const today = () => seoulDate(clock.now());

  function couponInput(value: PlaceCouponWrite): PlaceCouponWrite {
    if (!['place', 'booking', 'order'].includes(value?.type) || !['all', 'benefit-subscribers', 'marketing-message'].includes(value?.audience)) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'coupon' });
    }
    const extra = Object.keys(value).filter(key => !['type', 'name', 'benefit', 'audience', 'displayPeriod', 'quantity', 'conditions'].includes(key));
    if (extra.length) throw new NaverAdapterError('INVALID_INPUT', { detail: extra[0] });
    const write: PlaceCouponWrite = { type: value.type, name: ownerText(value.name, Infinity, 'name').trim(), benefit: benefitInput(value.benefit), audience: value.audience };
    if (value.audience === 'marketing-message') {
      // 21111: marketing-message coupons have no display period or issue quantity.
      if (value.displayPeriod !== undefined || value.quantity !== undefined) throw new NaverAdapterError('INVALID_INPUT', { detail: 'displayPeriod' });
    } else {
      if (value.displayPeriod != null) {
        const { from, to } = value.displayPeriod;
        if (![from, to].every(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) || from > to) {
          throw new NaverAdapterError('INVALID_INPUT', { detail: 'displayPeriod' });
        }
        write.displayPeriod = { from, to };
      }
      if (value.quantity != null) {
        if (!Number.isSafeInteger(value.quantity) || value.quantity < 1) throw new NaverAdapterError('INVALID_INPUT', { detail: 'quantity' });
        write.quantity = value.quantity;
      }
    }
    if (value.conditions != null) write.conditions = ownerText(value.conditions, Infinity, 'conditions').trim();
    return write;
  }

  function promotionInput(value: PromotionWrite): PromotionWrite {
    const extra = Object.keys(value ?? {}).filter(key => !['name', 'from', 'to', 'orderAmountPerStamp', 'coupons', 'instructions'].includes(key));
    if (extra.length || !Array.isArray(value.coupons) || !value.coupons.length || value.coupons.length > 10) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'promotion' });
    }
    const end = new Date(`${value.from}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    // 20710: start from the next day, period of one day up to one year.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.from) || !/^\d{4}-\d{2}-\d{2}$/.test(value.to) || value.from <= today()
      || value.to < value.from || value.to >= end.toISOString().slice(0, 10)) {
      throw new NaverAdapterError('INVALID_INPUT', { detail: 'period' });
    }
    const write: PromotionWrite = {
      name: ownerText(value.name, 20, 'name', 2).trim(), from: value.from, to: value.to, orderAmountPerStamp: value.orderAmountPerStamp,
      coupons: value.coupons.map(coupon => ({
        stampCount: coupon.stampCount, name: ownerText(coupon.name, 18, 'coupon.name', 2).trim(), validDays: coupon.validDays,
        canCombine: coupon.canCombine, canUseAlone: coupon.canUseAlone,
        ...(coupon.instructions === undefined ? {} : { instructions: ownerText(coupon.instructions, 100, 'coupon.instructions', 5).trim() }),
      })),
      ...(value.instructions === undefined ? {} : { instructions: ownerText(value.instructions, 500, 'instructions', 5).trim() }),
    };
    const check = obj({
      name: str(), from: isoDate, to: isoDate, orderAmountPerStamp: int({ min: 1_000, max: 99_999_999 }),
      coupons: arr(promotionCoupon, { min: 1, max: 10 }), instructions: opt(str()),
    });
    project(check, write, { strict: true, code: 'INVALID_INPUT' });
    return write;
  }

  return {
    async listPlaceCoupons(input: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
      const { json } = await partner(provider, 'pn05.coupons.list', { path: '/place/coupons', query: { limit: input.limit, offset: input.offset }, signal: input.signal });
      return project<{ items: PlaceCoupon[] }>(items(placeCouponShape), json, { strict: provider.strict });
    },

    async createPlaceCoupon(input: { coupon: PlaceCouponWrite; attemptKey: string; signal?: AbortSignal }) {
      const coupon = couponInput(input.coupon);
      const { json } = await partner(provider, 'pn05.coupons.create', { path: '/place/coupons', json: coupon, attemptKey: input.attemptKey, signal: input.signal });
      const created = project<PlaceCoupon>(placeCouponShape, json, { strict: provider.strict });
      if (created.name !== coupon.name || created.audience !== coupon.audience || JSON.stringify(created.benefit) !== JSON.stringify(coupon.benefit)) {
        throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$' });
      }
      return { effect: 'place-coupon-created' as const, coupon: created };
    },

    /** Stops new downloads; earlier downloads stay usable until their expiry (20837). */
    async deletePlaceCoupon(input: { ref: string; attemptKey: string; confirmation: unknown; signal?: AbortSignal }) {
      requireSecondConfirmation(input.confirmation);
      const { result } = await partner(provider, 'pn05.coupons.delete', { path: `/place/coupons/${segment(input.ref)}`, attemptKey: input.attemptKey, signal: input.signal });
      if (result.status !== 204) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: 'status' });
      return { effect: 'place-coupon-deleted' as const, earlierDownloadsStayValid: true };
    },

    async listCouponIssues(input: { couponRef: string; limit?: number; offset?: number; signal?: AbortSignal }) {
      const { json } = await partner(provider, 'pn05.issues.list', {
        path: `/place/coupons/${segment(input.couponRef)}/issues`, query: { limit: input.limit, offset: input.offset }, signal: input.signal,
      });
      return project<{ items: CouponIssue[] }>(items(couponIssueShape), json, { strict: provider.strict });
    },

    /** Used/unused change for a nonexpired issue; the provider refuses expired issues (409). */
    async setIssueUsage(input: { issueRef: string; used: boolean; attemptKey: string; signal?: AbortSignal }) {
      if (typeof input.used !== 'boolean') throw new NaverAdapterError('INVALID_INPUT', { detail: 'used' });
      const { json } = await partner(provider, 'pn05.issues.update', {
        path: `/place/coupon-issues/${segment(input.issueRef)}/usage`, json: { used: input.used }, attemptKey: input.attemptKey, signal: input.signal,
      });
      const issue = project<CouponIssue>(couponIssueShape, json, { strict: provider.strict });
      if (issue.used !== input.used) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.used' });
      return { effect: 'coupon-usage-changed' as const, issue };
    },

    async listOrderPromotions(input: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
      const { json } = await partner(provider, 'pn05.promotions.list', { path: '/order/promotions', query: { limit: input.limit, offset: input.offset }, signal: input.signal });
      return project<{ items: OrderPromotion[] }>(items(orderPromotionShape), json, { strict: provider.strict });
    },

    async createOrderPromotion(input: { promotion: PromotionWrite; attemptKey: string; signal?: AbortSignal }) {
      const promotion = promotionInput(input.promotion);
      const { json } = await partner(provider, 'pn05.promotions.create', { path: '/order/promotions', json: promotion, attemptKey: input.attemptKey, signal: input.signal });
      const created = project<OrderPromotion>(orderPromotionShape, json, { strict: provider.strict });
      if (created.name !== promotion.name || created.from !== promotion.from || created.to !== promotion.to) {
        throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$' });
      }
      return { effect: 'order-promotion-created' as const, promotion: created };
    },

    /** Running promotions only; the new end date is later than the current one (provider checks). */
    async extendOrderPromotion(input: { ref: string; to: string; attemptKey: string; signal?: AbortSignal }) {
      if (typeof input.to !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'to' });
      const { json } = await partner(provider, 'pn05.promotions.extend', {
        path: `/order/promotions/${segment(input.ref)}/extend`, json: { to: input.to }, attemptKey: input.attemptKey, signal: input.signal,
      });
      const promotion = project<OrderPromotion>(orderPromotionShape, json, { strict: provider.strict });
      if (promotion.to !== input.to) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.to' });
      return { effect: 'order-promotion-extended' as const, promotion };
    },

    async endOrderPromotion(input: { ref: string; attemptKey: string; confirmation: unknown; signal?: AbortSignal }) {
      requireSecondConfirmation(input.confirmation);
      const { json } = await partner(provider, 'pn05.promotions.end', {
        path: `/order/promotions/${segment(input.ref)}/end`, attemptKey: input.attemptKey, signal: input.signal,
      });
      const promotion = project<OrderPromotion>(orderPromotionShape, json, { strict: provider.strict });
      if (promotion.state !== 'ended') throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.state' });
      return { effect: 'order-promotion-ended' as const, promotion };
    },

    /** Linked named-membership benefits; an empty list means the official screen applies. */
    async listMembershipBenefits(input: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
      const { json } = await partner(provider, 'pn05.membership.list', { path: '/membership/benefits', query: { limit: input.limit, offset: input.offset }, signal: input.signal });
      return project<{ items: MembershipBenefit[] }>(items(membershipBenefitShape), json, { strict: provider.strict });
    },

  };
}
