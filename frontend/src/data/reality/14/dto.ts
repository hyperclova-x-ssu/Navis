import type { BenefitType, CouponOrigin, CouponRoute, CouponStatus, ValidHours } from '../../marketing/types';
import type { CommandReceipt } from '../00';

export const couponPath = '/marketing/coupons';
export const redemptionPath = '/marketing/coupon-redemptions';
export const naverCouponHelp = 'https://help.naver.com/service/30026/contents/20833?lang=ko';

export interface CouponTermsDto {
  readonly benefitType: BenefitType;
  readonly benefitValue: number;
  readonly targetRef: string | null;
  readonly endsOn: string;
}

export interface CouponCodeDto {
  readonly codeId: string;
  readonly code: string;
  readonly route: CouponRoute;
  readonly issueCount: number;
  readonly activated: boolean;
  readonly activatedAt: string | null;
  readonly unpublishedAt: string | null;
  readonly issuedTerms: CouponTermsDto | null;
  readonly used: number;
  readonly discountSum: number;
  readonly eligible: boolean;
  readonly revision: number;
}

export interface CouponDto extends CouponTermsDto {
  readonly couponId: string;
  readonly origin: CouponOrigin;
  readonly originRef: { readonly slotIds?: readonly string[]; readonly itemId?: string; readonly batchId?: string; readonly menuName?: string };
  readonly name: string;
  readonly validHours: readonly ValidHours[] | null;
  readonly startsOn: string;
  readonly status: CouponStatus;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly daysLeft: number;
  readonly endingSoon: boolean;
  readonly basis: { readonly maxRatePercent: number | null; readonly price: number; readonly unitCost: number | null } | null;
  readonly futureIssueCount: number | null;
  readonly issued: number;
  readonly used: number;
  readonly discountSum: number;
  readonly reminderTargets: number;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canExtend: boolean;
  readonly canEnd: boolean;
  readonly canNotify: boolean;
  readonly codes: readonly CouponCodeDto[];
  readonly revision: number;
}

export interface CouponUsageDto {
  readonly issued: number;
  readonly used: number;
  readonly asOf: string;
  readonly sourceRevision: number;
}

type NaverRow = Readonly<Record<string, unknown>>;
export interface NaverLedgerDto {
  readonly sourceRevision?: number;
  readonly approvalsEnabled?: boolean;
  readonly placeCoupons: { readonly items: readonly NaverRow[]; readonly nextCursor: string | null };
  readonly orderPromotions: { readonly items: readonly NaverRow[]; readonly nextCursor: string | null };
  readonly membership: NaverRow;
}

export interface CouponReceipt extends CommandReceipt {
  readonly codeId?: string;
  readonly queued?: number;
  readonly issued?: number;
  readonly delivery?: 'queued';
  readonly scheduledLocal?: string;
  readonly post?: string;
}

export interface CouponQuoteLine {
  readonly lineId: string;
  readonly menuId: string;
  readonly gross: number;
  readonly basePrice: number;
  readonly options: readonly { readonly optionId: string; readonly extraPrice: number }[];
}

export interface CouponQuote {
  readonly couponName: string;
  readonly discount: number;
}

export interface CheckoutCoupon {
  readonly code: string;
  readonly customerId?: string;
  readonly discount: number;
}
