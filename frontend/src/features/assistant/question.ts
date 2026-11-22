/** Shared existing AC-321 vocabulary; context selection uses every matching topic. */
import type { FeatureId } from '../../contracts';

export const norm = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s'’"?!.,]+/gu, '');
type Rule = readonly [FeatureId, readonly string[]];
export const CUSTOMERS = ['손님', '고객', '방문', 'customer', 'visitor', 'guest', '客人', '顾客', '顧客', '访客', '訪客', '客流'];
export const TOMORROW_WORDS = ['내일', '예상', 'tomorrow', 'forecast', '明天', '明日', '预计', '預計', '预测', '預測'];
export const EVENT_WORDS = ['행사', 'event', '活动', '活動'];
export const PAST_WORDS = ['지난달', '지난주', '작년', '내년', '어제', 'lastmonth', 'lastweek', 'lastyear', 'nextyear', 'yesterday', '上个月', '上個月', '上周', '上週', '去年', '昨天', '昨日'];
export const WEEK_WORDS = ['최근', '이번주', '일주일', '7일', 'last7', 'thisweek', 'pastweek', 'sevendays', '7天', '一周', '一週', '最近'];
export const STOCK_MERGED_WORDS = ['온오프라인', '판매상품', 'online', 'offline', '线上', '線上', '线下', '線下'];
/** Order matters: the more specific word wins (e.g. a promo video is not a plain promotion). */
const RULES: readonly Rule[] = [
  ['credit-receivable', ['충전', '외상', '미수금']],
  ['custom-order', ['주문제작', '맞춤주문', '케이크주문', 'customorder', '定制订单', '訂製訂單']],
  ['notice-send', ['휴무', '공지', 'notices', 'closurenotice', '休业通知', '休業通知']],
  ['store-environment', ['매장환경', '온도', '습도', '음악', 'temperature', 'humidity', 'music', '温度', '溫度', '湿度', '濕度', '音乐', '音樂']],
  ['promo-video', ['영상', 'video', '视频', '影片', '視頻']],
  ['expiry-coupon', ['크루아상', '할인', '소진', 'discount', 'croissant', 'sellout', '折扣', '可颂', '可頌', '打折']],
  ['slot-coupon', ['한산', '빈시간', '빈자리', 'quiet', 'slow', 'emptyslot', '空闲', '空閒', '闲时', '空檔', '冷清', '清闲', '清閒', '安静', '安靜']],
  ['members', ['단골몇명', '회원몇명']],
  ['customer-groups', ['단골', '안오는', 'regular', 'lapsed', '常客', '老客', '熟客', '回头客', '回頭客']],
  ['coupon-status', ['쿠폰', 'coupon', '优惠券', '優惠券', '折价券', '折價券']],
  ['marketing-today', ['홍보', 'promote', 'promotion', 'marketing', '推广', '推廣', '宣传', '宣傳']],
  ['menu', ['카페라테', '카페라떼', '메뉴원가']],
  ['ledger', ['매출', '입금', '수입', '가계부', '벌었', 'earn', 'imake', 'imade', 'sales', 'revenue', 'income', '销售', '銷售', '营业', '營業', '收入', '赚', '賺']],
  ['inventory-booking', ['재고', '물품', '유통기한', '소비기한', '폐기', ...STOCK_MERGED_WORDS, 'stock', 'inventory', '库存', '庫存']],
  ['staff-schedule', ['근무', '직원스케줄', '시간표', 'staffschedule', 'staffing', 'shiftroster', '排班', '班表']],
  ['calendar', ['일정', '달력', '캘린더', 'schedule', 'calendar', '日程', '日历', '日曆', '行程', '行事曆']],
  ['customer-analysis', CUSTOMERS],
  ['margin', ['마진', '원가', '이익', 'margin', 'profit', '利润', '利潤', '毛利', '成本']],
  ['tax', ['세금', '부가세', 'tax', '税', '稅']],
  ['grants', ['지원금', '정부', 'grant', 'subsid', '补助', '補助', '政府']],
  ['members', ['회원권', '회원목록', '멤버십', 'membership', '会员', '會員']],
  ['voice-booking', ['예약', '픽업', 'pickup', 'reservation', 'booking', '预约', '預約', '訂位', '订位']],
  ['menu', ['메뉴', 'menu', '菜单', '菜單']],
  ['suppliers', ['발주', '거래처', '납품', 'supplier', 'delivery', '供应', '供應', '订货', '訂貨']],
  ['manuals', ['매뉴얼', '마감', 'manual', 'closing', '手册', '手冊']],
  ['local-changes', ['동네변화', '주변', 'localchange', 'nearby', '周边', '周邊']],
  ['trade-area', ['상권', '유동', 'tradearea', 'footfall', '商圈', '人流']],
  ['local-trends', ['트렌드', '키워드', 'trend', 'keyword', '趋势', '趨勢', '关键词', '關鍵字', '热门', '熱門']],
  ['ai-response', ['리뷰', '문의', '후기', 'review', 'inquiry', 'message', '评价', '評價', '留言', '评论', '評論']],
  ['community', ['커뮤니티', 'community', '社区', '社區', '社群']],
  ['briefing', ['브리핑', 'briefing', '简报', '簡報']],
];
export const normalizedRules = RULES.map(([id, words]) => [id, words.map(norm)] as const);
export const has = (text: string, words: readonly string[]) => words.some((word) => text.includes(norm(word)));
export const isDemandQuestion = (text: string) => has(norm(text), CUSTOMERS) && has(norm(text), TOMORROW_WORDS);
export const isPosQuestion = (text: string) => has(norm(text), ['주문', '누락']) && !has(norm(text), ['주문제작', '맞춤주문', '케이크주문']);

/** Which widget a question is about (any of the four languages), or null. */
export function matchWidget(text: string): FeatureId | null {
  const key = norm(text);
  if (has(key, CUSTOMERS) && has(key, TOMORROW_WORDS)) return null;
  if (has(key, ['우유', 'milk']) && has(key, ['사용', '썼', '쓴', 'used'])) return 'inventory-booking';
  // "재고 제일 적게 남은 재료" is about stock, not the promo video's materials, unless it also names a video or a promotion.
  const stockAsk = has(key, ['재고', '유통기한', '소비기한', '폐기']) && !has(key, ['영상', '홍보', '릴스', '쇼츠', '사진']);
  for (const [id, words] of normalizedRules) {
    if (stockAsk && id === 'promo-video') continue;
    if (words.some((word) => key.includes(word))) return id;
  }
  return null;
}

export const REMOVED_WORDS = ['손님예측', '알바모집', '채용', '구인', '자리배치', '배치도', '매장인테리어', '인테리어'] as const;
export const isDrawerQuestion = (text: string) => /시재|예상\s*현금|실제\s*현금|현금.*(?:차이|모자라|남아|맞아)/u.test(text);
