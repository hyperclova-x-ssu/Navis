import type { CouponBenefit } from '../../marketing/types';

/** Sender contact and free opt-out are pending owner approval and have no store settings contract yet. */
export const smsSenderConfigured: boolean = false;

export const couponReminderSms = '받으신 쿠폰이 곧 끝나요. 끝나기 전에 들러 주세요.';

export function queuedCouponSmsTime(localAt: string) {
  const hour = Number(localAt.slice(11, 13));
  return hour >= 21 ? '내일 8시' : hour < 8 ? '오늘 8시' : null;
}

export function expirySmsCopy(menuName: string, benefit: CouponBenefit) {
  const last = menuName.trim().at(-1)?.charCodeAt(0) ?? 0;
  const hangul = last - 0xac00;
  const object = `${menuName}${hangul >= 0 && hangul <= 11171 && hangul % 28 !== 0 ? '을' : '를'}`;
  const won = benefit.value.toLocaleString('en-US');
  const offer = benefit.kind === 'percent' ? `${benefit.value}% 할인해요`
    : benefit.kind === 'amount' ? `${won}원 할인해요` : `세트 가격 ${won}원에 드려요`;
  return `${object} 오늘만 ${offer}. 오늘 마감 전까지 쓸 수 있어요.`;
}
