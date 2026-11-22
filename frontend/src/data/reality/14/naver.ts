import { PortError, type PortTransport } from '../00';

const resource = '/marketing/naver-coupons';
const approvals = '/marketing/naver-coupon-approvals';

export type PlaceCouponWrite = {
  readonly type: 'place' | 'booking' | 'order';
  readonly name: string;
  readonly audience: 'all' | 'benefit-subscribers' | 'marketing-message';
  readonly benefit: { readonly type: 'amount' | 'percent'; readonly value: number } | { readonly type: 'gift'; readonly item: string };
  readonly displayPeriod?: { readonly from: string; readonly to: string };
  readonly quantity?: number;
  readonly conditions?: string;
};

export interface PromotionReward {
  readonly stampCount: number;
  readonly name: string;
  readonly validDays: number;
  readonly canCombine: boolean;
  readonly canUseAlone: boolean;
  readonly instructions?: string;
}

export interface PromotionWrite {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly orderAmountPerStamp: number;
  readonly coupons: readonly PromotionReward[];
  readonly instructions?: string;
}

export type NaverCouponIntent =
  | { readonly operation: 'place.create'; readonly command: PlaceCouponWrite }
  | { readonly operation: 'promotion.create'; readonly command: PromotionWrite }
  | { readonly operation: 'place.delete' | 'promotion.end'; readonly targetRef: string; readonly command: { readonly confirmed: true } }
  | { readonly operation: 'issue.usage'; readonly targetRef: string; readonly command: { readonly status: 'used' | 'unused' } }
  | { readonly operation: 'promotion.extend'; readonly targetRef: string; readonly command: { readonly endDate: string } };

export interface NaverCouponCard {
  readonly intent: NaverCouponIntent;
  readonly expectedRevision: number;
  readonly attemptKey: string;
  readonly approvalId?: string;
  readonly expiresAt?: string;
  readonly confirmed?: true;
}

export interface NaverIssue {
  readonly ref: string;
  readonly maskedNumber: string;
  readonly issuedOn: string;
  readonly expiresOn: string;
  readonly used: boolean;
}

export const requiresExtraConfirmation = (intent: NaverCouponIntent) => intent.operation === 'place.delete' || intent.operation === 'promotion.end';

export function naverCouponApprovalExpired({ expiresAt }: NaverCouponCard, now = Date.now()) {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

export function naverIssues(transport: PortTransport, couponRef: string, signal: AbortSignal) {
  return transport.request<{ readonly items: readonly NaverIssue[] }>({
    method: 'GET', path: `${resource}/place/${encodeURIComponent(couponRef)}/issues`, signal,
  });
}

export async function issueNaverCouponApproval(transport: PortTransport, card: NaverCouponCard, signal: AbortSignal) {
  const { intent, expectedRevision, approvalId, attemptKey } = card;
  const stage = approvalId ? 'confirm' : 'press';
  const response = await transport.request<{ readonly approvalId: string; readonly expiresAt?: string }>({
    method: 'POST', path: approvals, signal, idempotencyKey: `${attemptKey}:${stage}`,
    body: { ...intent, expectedRevision, stage, ...(approvalId ? { approvalId } : {}) },
  });
  if (!response.approvalId || approvalId && response.approvalId !== approvalId) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  }
  return response;
}

export function submitNaverCoupon(transport: PortTransport, card: NaverCouponCard, signal: AbortSignal) {
  const { intent, expectedRevision, approvalId } = card;
  if (!approvalId || requiresExtraConfirmation(intent) && !card.confirmed) {
    throw new PortError(409, 'CONFLICT', 'EXTRA_CONFIRMATION_REQUIRED');
  }
  const target = 'targetRef' in intent ? encodeURIComponent(intent.targetRef) : '';
  const route = {
    'place.create': { method: 'POST', path: `${resource}/place` },
    'place.delete': { method: 'DELETE', path: `${resource}/place/${target}` },
    'issue.usage': { method: 'PATCH', path: `${resource}/issues/${target}/usage` },
    'promotion.create': { method: 'POST', path: `${resource}/promotions` },
    'promotion.extend': { method: 'POST', path: `${resource}/promotions/${target}/extend` },
    'promotion.end': { method: 'POST', path: `${resource}/promotions/${target}/end` },
  } as const;
  return transport.request<{ readonly receiptId: string; readonly state: 'pending' | 'applied' | 'failed' }>({
    ...route[intent.operation], signal, idempotencyKey: card.attemptKey,
    body: { ...intent.command, approvalId, expectedRevision },
  });
}
