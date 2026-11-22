import type { MessageBundle } from '../../../i18n';

export const customOrderListBundle = {
  id: 'widget.custom-order.list',
  ko: {
    'widget.custom-order.search': '검색',
    'widget.custom-order.searchPlaceholder': '주문번호나 손님 이름으로 찾아보세요',
    'widget.custom-order.tomorrowAt': '내일 {time}',
    'widget.custom-order.pickupPast': '지난 시간에는 새 예약을 넣을 수 없어요',
    'widget.custom-order.productKind': '상품 종류',
    'widget.custom-order.referencePhotos': '참고 사진',
    'widget.custom-order.productKindHint': '템플릿 이름이 ‘상품 종류 + 주문서’로 만들어져요',
    'widget.custom-order.productKindRequired': '상품 종류를 넣어 주세요',
    'widget.custom-order.keywords': '키워드',
    'widget.custom-order.keywordsHint': '템플릿 이름 뒤에 붙어요(선택)',
    'widget.custom-order.noResults': '검색 결과가 없어요',
    'widget.custom-order.empty': '아직 등록한 주문제작이 없어요',
    'widget.custom-order.history.created': '주문을 접수했어요',
    'widget.custom-order.history.updated': '주문 내용을 고쳤어요',
    'widget.custom-order.history.quoted': '견적 {amount}',
    'widget.custom-order.history.approved': '손님이 승인했어요',
    'widget.custom-order.history.rejected': '손님이 거절했어요',
    'widget.custom-order.history.revision_requested': '손님이 수정을 요청했어요',
    'widget.custom-order.history.stage': '진행 상태 {stage}',
    'widget.custom-order.history.rescheduled': '픽업 일시 {value}',
    'widget.custom-order.history.canceled': '주문을 취소했어요',
    'widget.custom-order.history.settled': '결제 {amount}',
    'widget.custom-order.history.received': '수령 완료 {amount}',
    'widget.custom-order.history.refunded': '환불 {amount}',
  },
  en: {
    'widget.custom-order.search': 'Search',
    'widget.custom-order.searchPlaceholder': 'Search by order number or customer name',
    'widget.custom-order.tomorrowAt': 'Tomorrow {time}',
    'widget.custom-order.pickupPast': "You can't add a booking for a time that has passed",
    'widget.custom-order.productKind': 'Product type',
    'widget.custom-order.referencePhotos': 'Reference photos',
    'widget.custom-order.productKindHint': 'The template is named “product type + order form”',
    'widget.custom-order.productKindRequired': 'Enter a product type',
    'widget.custom-order.keywords': 'Keywords',
    'widget.custom-order.keywordsHint': 'Added after the template name (optional)',
    'widget.custom-order.noResults': 'No results found',
    'widget.custom-order.empty': 'No custom orders yet',
    'widget.custom-order.history.created': 'Order received',
    'widget.custom-order.history.updated': 'Order details changed',
    'widget.custom-order.history.quoted': 'Quote {amount}',
    'widget.custom-order.history.approved': 'Customer approved',
    'widget.custom-order.history.rejected': 'Customer declined',
    'widget.custom-order.history.revision_requested': 'Customer asked for changes',
    'widget.custom-order.history.stage': 'Status {stage}',
    'widget.custom-order.history.rescheduled': 'Pickup time {value}',
    'widget.custom-order.history.canceled': 'Order canceled',
    'widget.custom-order.history.settled': 'Payment {amount}',
    'widget.custom-order.history.received': 'Picked up {amount}',
    'widget.custom-order.history.refunded': 'Refund {amount}',
  },
  'zh-Hans': {
    'widget.custom-order.search': '搜索',
    'widget.custom-order.searchPlaceholder': '按订单编号或顾客姓名搜索',
    'widget.custom-order.tomorrowAt': '明天 {time}',
    'widget.custom-order.pickupPast': '不能为已过去的时间新增预约',
    'widget.custom-order.productKind': '商品类型',
    'widget.custom-order.referencePhotos': '参考照片',
    'widget.custom-order.productKindHint': '模板名称为“商品类型 + 订单表”',
    'widget.custom-order.productKindRequired': '请填写商品类型',
    'widget.custom-order.keywords': '关键词',
    'widget.custom-order.keywordsHint': '会附加在模板名称后面（可选）',
    'widget.custom-order.noResults': '没有搜索结果',
    'widget.custom-order.empty': '还没有登记的定制订单',
    'widget.custom-order.history.created': '已接收订单',
    'widget.custom-order.history.updated': '订单内容已修改',
    'widget.custom-order.history.quoted': '报价 {amount}',
    'widget.custom-order.history.approved': '顾客已同意',
    'widget.custom-order.history.rejected': '顾客已拒绝',
    'widget.custom-order.history.revision_requested': '顾客要求修改',
    'widget.custom-order.history.stage': '进度 {stage}',
    'widget.custom-order.history.rescheduled': '取货时间 {value}',
    'widget.custom-order.history.canceled': '订单已取消',
    'widget.custom-order.history.settled': '付款 {amount}',
    'widget.custom-order.history.received': '已取货 {amount}',
    'widget.custom-order.history.refunded': '退款 {amount}',
  },
  'zh-Hant': {
    'widget.custom-order.search': '搜尋',
    'widget.custom-order.searchPlaceholder': '依訂單編號或顧客姓名搜尋',
    'widget.custom-order.tomorrowAt': '明天 {time}',
    'widget.custom-order.pickupPast': '不能為已過去的時間新增預約',
    'widget.custom-order.productKind': '商品類型',
    'widget.custom-order.referencePhotos': '參考照片',
    'widget.custom-order.productKindHint': '範本名稱為「商品類型 + 訂單表」',
    'widget.custom-order.productKindRequired': '請填寫商品類型',
    'widget.custom-order.keywords': '關鍵字',
    'widget.custom-order.keywordsHint': '會附加在範本名稱後面（選填）',
    'widget.custom-order.noResults': '沒有搜尋結果',
    'widget.custom-order.empty': '尚未登記任何客製訂單',
    'widget.custom-order.history.created': '已接收訂單',
    'widget.custom-order.history.updated': '訂單內容已修改',
    'widget.custom-order.history.quoted': '報價 {amount}',
    'widget.custom-order.history.approved': '顧客已同意',
    'widget.custom-order.history.rejected': '顧客已拒絕',
    'widget.custom-order.history.revision_requested': '顧客要求修改',
    'widget.custom-order.history.stage': '進度 {stage}',
    'widget.custom-order.history.rescheduled': '取貨時間 {value}',
    'widget.custom-order.history.canceled': '訂單已取消',
    'widget.custom-order.history.settled': '付款 {amount}',
    'widget.custom-order.history.received': '已取貨 {amount}',
    'widget.custom-order.history.refunded': '退款 {amount}',
  },
} satisfies MessageBundle<
  | 'widget.custom-order.search' | 'widget.custom-order.searchPlaceholder' | 'widget.custom-order.tomorrowAt' | 'widget.custom-order.pickupPast' | 'widget.custom-order.productKind'
  | 'widget.custom-order.productKindHint' | 'widget.custom-order.productKindRequired' | 'widget.custom-order.keywords' | 'widget.custom-order.keywordsHint'
  | 'widget.custom-order.noResults' | 'widget.custom-order.empty' | 'widget.custom-order.referencePhotos'
  | `widget.custom-order.history.${'created' | 'updated' | 'quoted' | 'approved' | 'rejected' | 'revision_requested' | 'stage' | 'rescheduled' | 'canceled' | 'settled' | 'received' | 'refunded'}`
>;

export const stageLabels = {
  received: '접수', quote_pending: '견적 대기', approval_pending: '손님 승인 대기', revision_requested: '수정 요청', payment_pending: '결제 대기', in_production: '제작 중', production_complete: '제작 완료', received_by_customer: '수령 완료', canceled: '취소',
} as const;
export const paymentLabels = { unpaid: '결제 전', paid: '결제 완료', canceled: '결제 취소', refunded: '환불' } as const;
export const channelLabels = { phone: '전화', message: '메시지', visit: '방문' } as const;
export const inputLabels = { text: '직접 입력', single: '단일 선택', multiple: '복수 선택', datetime: '날짜·시간 선택' } as const;
export const commandError = (reason?: string) => ({
  REQUIRED_FIELD: '필수 항목을 모두 넣어 주세요', INVALID_QUOTE_AMOUNT: '견적 금액을 1원 이상 넣어 주세요', APPROVAL_REQUIRED: '손님 승인을 먼저 기록해 주세요', QUOTE_CHANGED: '견적이 바뀌었어요. 다시 확인해 주세요', PAYMENT_REQUIRED: '결제를 먼저 완료해 주세요', INVALID_STAGE_TRANSITION: '현재 진행 상태를 확인해 주세요', PAYMENT_REVERSAL_REQUIRED: '결제 취소·환불을 먼저 확인해 주세요',
  // HTTP builds: the service's own refusals (B08). Nothing was saved in any of them.
  STALE_REVISION: '다른 곳에서 바뀌었어요. 새로 불러왔으니 다시 확인해 주세요', CONFIRMATION_REQUIRED: '한 번 더 확인해 주세요', DUPLICATE_CUSTOM_ORDER: '같은 주문이 이미 있어요', QUOTE_REISSUE_REQUIRED: '견적을 다시 내 주세요',
  BOOKING_PAST: '지난 날짜나 시각은 픽업으로 정할 수 없어요', MEMBER_NOT_FOUND: '찾을 수 없는 회원이에요', REFERENCE_PHOTO_NOT_FOUND: '참고 사진을 찾지 못했어요. 다시 올려 주세요',
  PHOTO_SERVICE_UNAVAILABLE: '사진을 저장하지 못했어요. 잠시 뒤 다시 해 주세요', FILE_INVALID: '올릴 수 없는 사진이에요. 사진 파일을 확인해 주세요', DAY_CLOSED: '마감한 날은 바꿀 수 없어요', ALLOCATION_SUM_MISMATCH: '받은 금액이 결제할 금액과 같아야 해요',
  TERMINAL_RECORD_REQUIRED: '단말기 승인 번호나 영수증 번호를 넣어 주세요', TERMINAL_REFERENCE_EXISTS: '이미 기록한 단말기 번호예요', TERMINAL_TIME_INVALID: '단말기 거래 시각을 확인해 주세요', REFUND_LIMIT: '환불할 수 있는 금액을 넘었어요',
  MEMBER_REQUIRED: '회원을 연결한 주문만 충전금·외상으로 받을 수 있어요', CHARGE_BALANCE_EXCEEDED: '충전금 잔액보다 많이 쓸 수 없어요', CHARGE_LIMIT: '충전금 잔액보다 많이 쓸 수 없어요',
  RECEIVABLE_LIMIT: '외상으로 둘 수 있는 한도를 넘었어요', RECEIVABLE_ALREADY_COLLECTED: '이 외상은 이미 수금했어요. 수금 기록을 먼저 되돌려 주세요',
  UNDO_EXPIRED: '되돌릴 수 있는 시간이 지났어요', SERVICE_UNAVAILABLE: '지금은 서버에 연결할 수 없어요. 잠시 뒤 다시 해 주세요',
}[reason ?? ''] ?? '저장하지 못했어요. 다시 시도해 주세요');
export const money = (amount: number) => `${new Intl.NumberFormat('ko-KR').format(amount)}원`;
export const maskName = (name: string) => name.includes('○') ? name : [...name].length > 1 ? `${[...name][0]}${'○'.repeat(Math.min([...name].length - 1, 2))}` : name;
export const maskPhone = (phone: string) => {
  if (phone.includes('*')) return phone;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '***';
};
/** The order number people read and say. Ids from the store data (`sample-custom-1`) are never shown; `CO-001` style numbers pass through. */
export const orderNumber = (id: string, orderNo?: number) => orderNo !== undefined && Number.isSafeInteger(orderNo) && orderNo > 0 ? `CO-${String(orderNo).padStart(3, '0')}`
  : /^CO-\d+$/.test(id) ? id : /(\d+)$/.test(id) ? `CO-${/(\d+)$/.exec(id)![1]!.padStart(3, '0')}` : '주문';
/** Local `YYYY-MM-DDTHH:MM` pickup stamps are compared as strings (same shape, store clock). */
export const isPastPickup = (value: string, now: string | undefined) => !!now && !!value && value.slice(0, 16) < now.slice(0, 16);
export const requestKey = () => `custom-ui:${crypto.randomUUID()}`;
