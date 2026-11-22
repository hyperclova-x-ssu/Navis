export const couponChatCopy = {
  itemLabel: '품목',
  chooseCode: '어떤 쿠폰인지 알려 주세요',
  chooseExpiryItem: '어떤 품목의 쿠폰인지 알려 주세요',
  chooseRecipient: '쿠폰 화면에서 문자에 동의한 받는 사람을 골라 주세요',
  ambiguousExclusion: '그 이름으로는 받는 사람을 한 명으로 고를 수 없어요',
  chooseSlot: '쿠폰을 준비할 날짜와 시간을 알려 주세요',
  /** No slot has a regular who visits then and consented to text messages. The next step is named only where the screen has it (the NAVER place coupon form is a real-mode panel). */
  noSlotRecipients: (real: boolean) => `받는 사람이 없어요. 이 시간에 자주 오면서 문자에 동의한 단골이 없어서 빈 시간 쿠폰은 보낼 수 없어요.${real
    ? ' 문자 없이 쓰는 네이버 플레이스 쿠폰은 진행 중인 쿠폰 화면에서 만들 수 있어요.' : ''}`,
  chooseSlotInWindow: (window: string) => `보낼 쿠폰의 날짜와 시간을 알려 주세요. 지금 고를 수 있는 기간은 ${window}예요.`,
  missingSlot: '해당 날짜와 시간에 준비할 빈 시간 쿠폰이 없어요',
  chooseSendDate: '예약 발송 날짜를 하나 알려 주세요',
  placeNewsOnly: '플레이스 소식에 올린 쿠폰만 여기에서 변경할 수 있어요',
  /** D-365: the 마케팅 성과 screen left the product; coupon use stays visible in 진행 중인 쿠폰. */
  performanceGone: '마케팅 성과 화면은 없어졌어요. 쿠폰이 이번 달에 몇 장 쓰였는지는 진행 중인 쿠폰에서 볼 수 있어요.',
  /** D-365, a question about its numbers that never named the screen. */
  performanceStopped: '이 숫자는 이제 따로 보여 드리지 않아요. 쿠폰이 이번 달에 몇 장 쓰였는지는 진행 중인 쿠폰에서 볼 수 있어요.',
} as const;
