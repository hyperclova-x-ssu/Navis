import { createMarketingProvider, type MarketingBindingOptions } from '../../naver/binding.ts';
import { createCouponPort } from '../../naver/pn05-coupons.ts';
import { invalid } from './wire.ts';
import type { NaverCouponPort } from './clients.ts';

export function createPersonaCouponPort(config: Pick<MarketingBindingOptions, 'storeId' | 'providerAccount' | 'privateTokenFile' | 'virtualOrigin'>): NaverCouponPort {
  const port = createCouponPort(createMarketingProvider({ ...config, mode: 'virtual',
    operations: ['pn05.coupons.list', 'pn05.issues.list', 'pn05.promotions.list', 'pn05.membership.list',
      'pn05.coupons.create', 'pn05.coupons.delete', 'pn05.issues.update',
      'pn05.promotions.create', 'pn05.promotions.extend', 'pn05.promotions.end'],
  }));
  const limit = 100;
  const offset = (cursor?: string) => {
    if (cursor === undefined) return 0;
    if (!/^(0|[1-9]\d{0,6})$/.test(cursor)) throw invalid('cursor');
    return Number(cursor);
  };
  const page = <T>(items: T[], start: number) => ({ items, nextCursor: items.length === limit ? String(start + limit) : null });
  return {
    createPlaceCoupon: port.createPlaceCoupon,
    deletePlaceCoupon: port.deletePlaceCoupon,
    setIssueUsage: port.setIssueUsage,
    createOrderPromotion: port.createOrderPromotion,
    extendOrderPromotion: port.extendOrderPromotion,
    endOrderPromotion: port.endOrderPromotion,
    async listPlaceCoupons({ cursor, signal } = {}) {
      const start = offset(cursor);
      return page((await port.listPlaceCoupons({ offset: start, limit, signal })).items, start);
    },
    async listCouponIssues({ couponRef, couponNumber, cursor, signal }) {
      if (couponNumber !== undefined) throw invalid('couponNumber', 'ISSUE_SEARCH_UNAVAILABLE');
      const start = offset(cursor);
      return page((await port.listCouponIssues({ couponRef, offset: start, limit, signal })).items, start);
    },
    async listOrderPromotions({ cursor, signal } = {}) {
      const start = offset(cursor);
      return page((await port.listOrderPromotions({ offset: start, limit, signal })).items, start);
    },
    readMembership: signal => port.listMembershipBenefits({ limit, signal }),
  };
}
