import type { MessageBundle } from '../types';

/** D-383 checkout and member-widget copy falls back to Korean. */
export const membershipPosBundle = {
  id: 'membership-pos',
  ko: {
    'membershipPos.choose': '회원권 1회 사용',
    'membershipPos.record': '회원권 1회 사용 기록하기',
    'membershipPos.recordWithTender': '회원권 1회 사용 · {method} {amount} 기록하기',
    'membershipPos.countHelp': '남은 횟수에서 1회를 차감해요',
    'membershipPos.periodHelp': '이용 내역에 1회를 기록해요',
    'membershipPos.loadError': '회원권을 불러오지 못했어요',
    'membershipPos.unavailable': '회원권을 지금 사용할 수 없어요. 남은 횟수와 대상 메뉴를 확인해 주세요',
    'membershipPos.recordFromMember': '1회 사용 기록하기',
    'membershipPos.cancel': '사용 취소하기',
    'membershipPos.confirmCancel': '사용 취소 확인',
    'membershipPos.handoffTitle': '회원권 사용',
    'membershipPos.handoffHelp': '대상 메뉴를 담고 결제에서 회원권 1회 사용을 확인해 주세요',
    'membershipPos.returnToMember': '회원목록으로 돌아가기',
  },
  en: {},
  'zh-Hans': {},
  'zh-Hant': {},
} as const satisfies MessageBundle<string>;
