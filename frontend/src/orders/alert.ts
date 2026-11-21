import type {OrderAlert, OrderSummary} from './types';

export const initialOrderAlert: OrderAlert = {visible: false, notifiedIds: []};
export interface OrderAlertContext {
  /** 화면이 관리 대시보드인가 */
  readonly onDashboard: boolean;
  /** POS layer; callers set orderDetailOpen for its status tab. Marketing sets both locations false. */
  readonly onPos?: boolean;
  /** 보이는 코치 */
  readonly coachVisible: boolean;
  /** 주요 overlay(drawer/detail/settings/briefing) 열림 */
  readonly overlayOpen: boolean;
  /** 열린 상세가 주문 현황인가 (이때 생긴 누락은 알림 없이 notified로만 기록) */
  readonly orderDetailOpen: boolean;
}
/** DATA_MODEL 13.5 OrderAlert 판정. 변화 없으면 같은 객체를 돌려준다. */
export function evaluateOrderAlert(alert: OrderAlert, summary: Pick<OrderSummary, 'missingIds' | 'missingCount'>, ctx: OrderAlertContext): OrderAlert {
  const fresh = summary.missingIds.filter(id => !alert.notifiedIds.includes(id));
  if (summary.missingCount === 0) return alert.visible ? {...alert, visible: false} : alert;
  if (fresh.length === 0) return alert;
  if (ctx.orderDetailOpen) return seenOrderAlert(alert, fresh);
  if ((!ctx.onDashboard && !ctx.onPos) || ctx.coachVisible || ctx.overlayOpen) return alert;
  return {visible: true, notifiedIds: [...alert.notifiedIds, ...fresh]};
}
export function seenOrderAlert(alert: OrderAlert, ids: readonly string[]): OrderAlert {
  const notifiedIds = [...new Set([...alert.notifiedIds, ...ids])];
  return notifiedIds.length === alert.notifiedIds.length ? alert : {...alert, notifiedIds};
}
export function dismissOrderAlert(alert: OrderAlert): OrderAlert {
  return alert.visible ? {...alert, visible: false} : alert;
}
