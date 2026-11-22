/**
 * F06 NAVER booking cancel (D-347 PN02 · AC-1617 · AC-1618 · SCREENS SCR-225, LOCALES §20): key → [ko, en, zh-Hans, zh-Hant].
 * Every sentence says what the records show: the provider takes the refund instruction and decides the money, so no line claims a refund was paid.
 */
import type { MessageBundle } from '../../../i18n';
import type { Row } from '../../messages/sourced';

/** The widget's own cancel sentences (a bundle of `useBundle`). */
export const bookingCancelRows = {
  'widget.voice-booking.real.cancelOpen': ['예약 취소하기', 'Cancel booking', '取消预约', '取消預約'],
  'widget.voice-booking.real.cancelCompletedNpay': ['네이버 예약 취소', 'Cancel NAVER booking', '取消 NAVER 预约', '取消 NAVER 預約'],
  'widget.voice-booking.real.cancelTitle': ['예약 취소', 'Cancel booking', '取消预约', '取消預約'],
  'widget.voice-booking.real.cancelReason': ['취소 사유', 'Cancellation reason', '取消原因', '取消原因'],
  'widget.voice-booking.real.cancelReasonHint': ['손님에게 보여요', 'The customer will see this', '顾客可以看到', '顧客可以看到'],
  'widget.voice-booking.real.cancelReasonNeeded': ['취소 사유를 적어 주세요', 'Enter a cancellation reason', '请填写取消原因', '請填寫取消原因'],
  'widget.voice-booking.real.completedNote': ['이용이 끝난 예약도 취소할 수 있어요 · 실제 환불은 정산 상태에 따라 네이버에서 정해요',
    'A booking that was already used can still be canceled · NAVER decides the actual refund from the settlement status',
    '已使用的预约也可以取消 · 实际退款由 NAVER 根据结算状态决定', '已使用的預約也可以取消 · 實際退款由 NAVER 依結算狀態決定'],
  'widget.voice-booking.real.refundNeeded': ['Npay로 결제된 예약이에요. 취소하려면 환불 조건을 정해 주세요', 'This booking was paid with Npay. Choose the refund to cancel it',
    '此预约已通过 Npay 支付，请先选择退款条件再取消', '此預約已透過 Npay 支付，請先選擇退款條件再取消'],
  'widget.voice-booking.real.refundPick': ['환불 조건을 골라 주세요', 'Choose a refund option', '请选择退款条件', '請選擇退款條件'],
  'widget.voice-booking.real.refund': ['환불 조건', 'Refund', '退款条件', '退款條件'],
  'widget.voice-booking.real.refundFull': ['전액', 'Full', '全额', '全額'],
  'widget.voice-booking.real.refundRate': ['비율', 'Percentage', '按比例', '按比例'],
  'widget.voice-booking.real.refundAmount': ['금액', 'Amount', '指定金额', '指定金額'],
  'widget.voice-booking.real.refundRateValue': ['환불 비율', 'Refund percentage', '退款比例', '退款比例'],
  'widget.voice-booking.real.refundAmountValue': ['환불 금액', 'Refund amount', '退款金额', '退款金額'],
  'widget.voice-booking.real.refundRateBad': ['0에서 100 사이로 넣어 주세요', 'Enter a value from 0 to 100', '请输入 0 到 100 之间的数值', '請輸入 0 到 100 之間的數值'],
  'widget.voice-booking.real.refundAmountBad': ['0 이상의 정수로 넣어 주세요', 'Enter a whole number, 0 or more', '请输入 0 或以上的整数', '請輸入 0 或以上的整數'],
  'widget.voice-booking.real.paymentAmount': ['결제 금액 {n}원', 'Paid amount ₩{n}', '支付金额 {n} 韩元', '支付金額 {n} 韓元'],
  'widget.voice-booking.real.refundLimit': ['결제 금액 {n}원까지 돌려줄 수 있어요', 'You can refund up to the paid amount of ₩{n}', '最多可退还支付金额 {n} 韩元', '最多可退還支付金額 {n} 韓元'],
  'widget.voice-booking.real.cancelReview': ['취소 내용 확인하기', 'Review cancellation', '确认取消内容', '確認取消內容'],
  'widget.voice-booking.real.cancelClose': ['닫기', 'Close', '关闭', '關閉'],
  'widget.voice-booking.real.confirmBadge': ['한 번 더 확인', 'Confirm once more', '再次确认', '再次確認'],
  'widget.voice-booking.real.irreversible': ['취소하면 되돌릴 수 없어요', "Once canceled, this can't be undone", '取消后无法恢复', '取消後無法復原'],
  'widget.voice-booking.real.summaryNumber': ['예약번호', 'Booking number', '预约号', '預約號碼'],
  'widget.voice-booking.real.summaryProduct': ['예약 상품', 'Booking product', '预约商品', '預約商品'],
  'widget.voice-booking.real.summaryUsage': ['이용 일시', 'Date and time of use', '使用日期时间', '使用日期時間'],
  'widget.voice-booking.real.summaryReason': ['취소 사유', 'Cancellation reason', '取消原因', '取消原因'],
  'widget.voice-booking.real.summaryRefund': ['환불 조건', 'Refund', '退款条件', '退款條件'],
  'widget.voice-booking.real.summaryRefundRate': ['결제 금액의 {n}%', '{n}% of the paid amount', '支付金额的 {n}%', '支付金額的 {n}%'],
  'widget.voice-booking.real.summaryRefundAmount': ['{n}원', '₩{n}', '{n} 韩元', '{n} 韓元'],
  'widget.voice-booking.real.dropCancel': ['변경 취소하기', "Don't cancel", '不取消了', '不取消了'],
  'widget.voice-booking.real.cancelNaver': ['{number} 예약 취소하기', 'Cancel booking {number}', '取消预约 {number}', '取消預約 {number}'],
  'widget.voice-booking.real.cancelling': ['취소하고 있어요', 'Canceling', '正在取消', '正在取消'],
  // Result (AC-1617, AC-1618): what was done, never "refunded"; the provider has no inverse of a cancel.
  'widget.voice-booking.real.canceled': ['예약을 취소했어요', 'Booking canceled', '已取消预约', '已取消預約'],
  'widget.voice-booking.real.canceledRefund': ['예약을 취소했어요 · 환불은 네이버에서 처리해요', 'Booking canceled · NAVER will process the refund', '已取消预约 · 退款由 NAVER 处理', '已取消預約 · 退款由 NAVER 處理'],
  'widget.voice-booking.real.canceledNoUndo': ['네이버 예약 취소는 되돌릴 수 없어요', "A canceled NAVER booking can't be restored", 'NAVER 预约取消后无法恢复', 'NAVER 預約取消後無法復原'],
  // Failures of the cancel press.
  'widget.voice-booking.real.cancelRefused': ['예약 상태가 바뀌었어요. 다시 읽었으니 확인하고 다시 눌러 주세요', 'The booking changed. It was read again; check it and press again',
    '预约状态已变化，已重新读取，请确认后再按一次', '預約狀態已變更，已重新讀取，請確認後再按一次'],
  'widget.voice-booking.real.providerRefused': ['네이버가 이 취소를 받지 않았어요. 예약 상태를 다시 읽었으니 확인하고 다시 눌러 주세요', "NAVER didn't accept this cancellation. The booking was read again; check it and press again",
    'NAVER 未接受此次取消。已重新读取预约状态，请确认后再按一次', 'NAVER 未接受此次取消。已重新讀取預約狀態，請確認後再按一次'],
  'widget.voice-booking.real.providerUnknown': ['네이버에서 처리됐는지 아직 확인하지 못했어요. 목록을 다시 읽었으니 예약 결과를 확인해 주세요', "We couldn't confirm yet whether NAVER processed it. The list was read again; check the booking result",
    '尚无法确认 NAVER 是否已处理。已重新读取列表，请确认预约结果', '尚無法確認 NAVER 是否已處理。已重新讀取列表，請確認預約結果'],
} as const satisfies Readonly<Record<string, Row>>;

/** The receipt toast the shell resolves (`data.real.*`, composed in `messages/real.ts` like the other pairs' rows). */
export const bookingRows = {
  'data.real.booking.canceled': bookingCancelRows['widget.voice-booking.real.canceled'],
  'data.real.booking.canceledRefund': bookingCancelRows['widget.voice-booking.real.canceledRefund'],
} as const satisfies Readonly<Record<string, Row>>;

const column = (index: 0 | 1 | 2 | 3) => Object.fromEntries(Object.entries(bookingCancelRows).map(([key, row]) => [key, row[index]])) as Record<keyof typeof bookingCancelRows, string>;

export type BookingCancelKey = keyof typeof bookingCancelRows;
export const bookingCancelCopy: MessageBundle<BookingCancelKey> = { id: 'widget.booking.cancel', ko: column(0), en: column(1), 'zh-Hans': column(2), 'zh-Hant': column(3) };
