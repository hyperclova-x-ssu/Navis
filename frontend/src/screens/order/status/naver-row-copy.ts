import type { MessageBundle } from '../../../i18n';

/** UXP-18 / SCR-249: NAVER orders read like rows of the order table; only what NAVER sends is shown. */
const ko = {
  'naver.number': '네이버 {id}', 'naver.quickLabel': '빠른 선택', 'naver.prep': '준비 {n}분', 'naver.quick': '{n}분',
  'naver.startWith': '{n}분으로 준비 시작', 'naver.lookups': '네이버 결제·상품 조회',
} as const;
export const naverRowBundle: MessageBundle<keyof typeof ko> = {
  id: 'pos-naver-rows', ko,
  en: { 'naver.number': 'NAVER {id}', 'naver.quickLabel': 'Quick pick', 'naver.prep': 'Prep {n} min', 'naver.quick': '{n} min', 'naver.startWith': 'Start preparing, {n} min', 'naver.lookups': 'NAVER payment and product lookups' },
  'zh-Hans': { 'naver.number': 'NAVER {id}', 'naver.quickLabel': '快速选择', 'naver.prep': '准备 {n} 分钟', 'naver.quick': '{n} 分钟', 'naver.startWith': '{n} 分钟后开始准备', 'naver.lookups': 'NAVER 付款与商品查询' },
  'zh-Hant': { 'naver.number': 'NAVER {id}', 'naver.quickLabel': '快速選擇', 'naver.prep': '準備 {n} 分鐘', 'naver.quick': '{n} 分鐘', 'naver.startWith': '{n} 分鐘後開始準備', 'naver.lookups': 'NAVER 付款與商品查詢' },
};
