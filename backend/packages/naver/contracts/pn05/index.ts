export const couponSources = {
  create: 'https://help.naver.com/service/30026/contents/20833?lang=ko',
  delete: 'https://help.naver.com/service/30026/contents/20837?lang=ko&osType=COMMONOS',
  usage: 'https://help.naver.com/service/30026/contents/20843?lang=ko&osType=COMMONOS',
  usable: 'https://help.naver.com/service/11713/contents/20805?lang=ko',
  order: 'https://help.naver.com/service/30026/contents/20710?osType=COMMONOS',
  membership: 'https://smartplace.naver.com/notices/1100',
  membershipCoupons: 'https://help.naver.com/service/30026/contents/25061?lang=ko&osType=COMMONOS',
  messageCoupon: 'https://help.naver.com/service/30026/contents/21111?lang=ko',
} as const;

export type CouponBenefit = { type: 'amount' | 'percent'; value: number } | { type: 'gift'; item: string };
export type CouponAudience = 'all' | 'benefit-subscribers' | 'marketing-message';
export type PlaceCouponWrite = {
  type: 'place' | 'booking' | 'order';
  name: string;
  benefit: CouponBenefit;
  audience: CouponAudience;
  displayPeriod?: { from: string; to: string } | null;
  quantity?: number | null;
  conditions?: string | null;
};
export type PlaceCoupon = PlaceCouponWrite & { ref: string };
export type CouponIssue = {
  ref: string; maskedNumber: string; issuedOn: string; expiresOn: string; used: boolean;
};
export type PromotionWrite = {
  name: string;
  from: string;
  to: string;
  orderAmountPerStamp: number;
  coupons: {
    stampCount: number; name: string; validDays: number;
    canCombine: boolean; canUseAlone: boolean; instructions?: string;
  }[];
  instructions?: string;
};
export type OrderPromotion = PromotionWrite & { ref: string; state: 'upcoming' | 'active' | 'ended' };
export type MembershipProvider = '도도포인트' | 'OKPOS 단골플러스' | '페이히어';
export type MembershipBenefit = {
  ref: string; provider: MembershipProvider; type: 'points' | 'stamps' | 'coupon'; benefit: string;
  validDays?: number; visible?: boolean; paused?: boolean;
};
