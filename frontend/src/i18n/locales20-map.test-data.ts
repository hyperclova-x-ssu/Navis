/**
 * LOCALES.md §20 (persona-linked feature copy, D-343~D-347) row -> message key(s).
 * `match` is the exact first-column text of the row; a cell holding `a / b / c` maps to the keys in that order.
 * Test data only: the widgets read the keys, this list proves the catalog says what the table says.
 */
export interface Locales20Row {
  readonly match: string;
  readonly keys: readonly string[];
  readonly separator?: RegExp;
}

const parts = /\s*\/\s*| · /u;

/** Approved copy for UI that uses a different presentation or has yet to ship this wording. */
export const locales20ReferenceRows = [
  '쿠폰 · 멤버십 빈 목록',
  '쿠폰 · 멤버십 안내',
  '새소식 · 길이',
  '예약 · 스마트콜',
] as const;

export const locales20Map: readonly Locales20Row[] = [
  { match: '세무 · 버튼', keys: ['common.linked.tax.openHometax'] },
  { match: '세무 · 납부 기록', keys: ['common.linked.tax.addPayment', 'common.linked.tax.markPaid'] },
  { match: '세무 · 안내', keys: ['common.linked.tax.paymentNote'] },
  { match: '세무 · 자료 버튼', keys: ['common.linked.tax.accountantFile'] },
  { match: '정부지원 · 버튼', keys: ['common.linked.grants.openNotice', 'common.linked.grants.copyDraft', 'common.linked.grants.markApplied'] },
  { match: '정부지원 · 안내', keys: ['common.linked.grants.appliedNote'] },
  { match: '정부지원 · 추천', keys: ['common.linked.grants.recommended'] },
  { match: '캘린더 · 버튼', keys: ['common.linked.calendar.downloadFile', 'common.linked.calendar.addToNaver'] },
  { match: '캘린더 · 결과', keys: ['common.linked.calendar.added', 'common.linked.calendar.addFailed'] },
  { match: '동네 변화 · 안내', keys: ['common.linked.local.changesNote'] },
  { match: '상권분석 · 이름', keys: ['common.linked.trade.movement'] },
  { match: '상권분석 · 소제목', keys: ['common.linked.trade.movementAt'] },
  { match: '상권분석 · 출처', keys: ['common.linked.trade.source'] },
  { match: '상권분석 · 매장 판매', keys: ['common.linked.trade.ourSales'] },
  { match: '상권분석 · 빈 시간', keys: ['common.linked.trade.noData'] },
  { match: '로컬 트렌드 · 이름', keys: ['common.linked.trends.searchInterest', 'common.linked.trends.ourMenuTrend'] },
  { match: '메시지·리뷰 · 톡톡', keys: ['common.linked.reply.talkInquiry'] },
  { match: '메시지·리뷰 · 별점', keys: ['common.linked.reply.noRating'] },
  { match: '메시지·리뷰 · 답글 버튼', keys: ['common.linked.reply.post'] },
  { match: '메시지·리뷰 · 답글 안내', keys: ['common.linked.reply.postNote'] },
  { match: '메시지·리뷰 · 지난 대화', keys: ['common.linked.reply.olderChats'] },
  { match: '메시지·리뷰 · 초안 구분', keys: ['common.linked.reply.draftNavis', 'common.linked.reply.draftNaver'] },
  { match: '홍보 영상 · 사진', keys: ['common.linked.promo.photos', 'common.linked.promo.upload'] },
  { match: '홍보 영상 · 올리기', keys: ['common.linked.promo.postClip', 'common.linked.promo.postPlace', 'common.linked.promo.saveLink'] },
  { match: '쿠폰 · 구분', keys: ['common.linked.coupon.naver', 'common.linked.coupon.orderPromo', 'common.linked.coupon.membership', 'common.linked.coupon.navisCode'] },
  { match: '공지 · 톡톡', keys: ['common.linked.notice.chooseInTalk'] },
  { match: '공지 · 반영 지연', keys: ['common.linked.notice.savedDelay'] },
  { match: '예약 · 변경 불가', keys: ['common.linked.booking.npayLocked'] },
  { match: '예약 · 전화', keys: ['common.linked.booking.callRequest', 'common.linked.booking.confirm'] },
  { match: '예약 · 통화 안내', keys: ['common.linked.booking.noAudio'] },
  { match: '예약 · 취소 사유', keys: ['widget.voice-booking.real.cancelReason', 'widget.voice-booking.real.cancelReasonHint'], separator: parts },
  { match: '예약 · 환불 조건', keys: ['widget.voice-booking.real.refund', 'widget.voice-booking.real.refundFull', 'widget.voice-booking.real.refundRate', 'widget.voice-booking.real.refundAmount'], separator: parts },
  { match: '예약 · 환불 한도', keys: ['widget.voice-booking.real.refundLimit'] },
  { match: '예약 · 취소 확인', keys: ['widget.voice-booking.real.irreversible'] },
  { match: '예약 · 취소 결과', keys: ['widget.voice-booking.real.canceledRefund'] },
  { match: '톡톡 마케팅 · 대상 묶음', keys: ['data.real.inbox.notice.audience.benefit-subscribers', 'data.real.inbox.notice.audience.recent-visitor-reviewers'] },
  { match: '톡톡 마케팅 · 배정량', keys: ['data.real.inbox.notice.quota'] },
  { match: '톡톡 마케팅 · 배정 없음', keys: ['data.real.inbox.error.QUOTA_EXHAUSTED'] },
  { match: '톡톡 마케팅 · 밤', keys: ['data.real.inbox.notice.night'] },
  { match: '커뮤니티 · 카페 글 결과', keys: ['data.real.local.cafe.posted', 'data.real.local.cafe.view'], separator: parts },
  { match: '메시지·리뷰 · 답글 막힘', keys: ['data.real.inbox.error.REPLY_CONTAINS_CONTACT'] },
];
