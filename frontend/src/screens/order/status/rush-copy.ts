import type { MessageBundle } from '../../../i18n';

/** UXP-19: the "주문 몰림" tile shows the number the rule is built on (orders in the last 10 minutes), not a bare word. */
const ko = { 'pos.recentOrders': '최근 10분 주문' } as const;
export const rushBundle: MessageBundle<keyof typeof ko> = {
  id: 'pos-order-rush', ko,
  en: { 'pos.recentOrders': 'Orders, last 10 min' },
  'zh-Hans': { 'pos.recentOrders': '最近10分钟订单' },
  'zh-Hant': { 'pos.recentOrders': '最近10分鐘訂單' },
};
