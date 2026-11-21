/**
 * Archived order-status wording, first connected to the main app in iteration 6 (D-242).
 * The translations in merge-cnn were archived by D-230 before main-app delivery.
 * D-209 / T-244c: newly shipped copy is Korean-only; other locales fall back to ko.
 * Keep the legacy keys so the POS screen can reuse the order-status wording.
 */
import type { MessageBundle } from '../types';

const ko = {
  'widget.order-status.core.unit': '진행 중 주문',
  'widget.order-status.count': '{n}건',
  'widget.order-status.core.allDone': '모두 완료했어요',
  'widget.order-status.open': '진행 중',
  'widget.order-status.avgWait': '평균 대기',
  'widget.order-status.avgWait.value': '{n}분',
  'widget.order-status.avgWait.none': '아직 없어요',
  'widget.order-status.missing': '누락 의심',
  'widget.order-status.missing.count': '누락 의심 {n}건',
  'widget.order-status.slow': '오래 걸려요',
  'widget.order-status.slow.count': '오래 걸리는 주문 {n}건',
  'widget.order-status.rush.chip': '주문이 몰려요',
  'widget.order-status.rush.label': '몰림',
  'widget.order-status.rush.normal': '보통',
  'widget.order-status.rush.notice': '주문이 몰려요. 최근 10분에 주문이 늘었고 아직 안 끝난 주문이 쌓이고 있어요',
  'widget.order-status.basis': '{date} · {time} 기준',
  'widget.order-status.list.open': '진행 중 주문',
  'widget.order-status.list.done': '완료된 주문',
  'widget.order-status.row.time': '{time} 주문 · {n}분째',
  'widget.order-status.row.doneTime': '{time} 주문 · {n}분 걸림',
  'widget.order-status.row.elapsed': '{n}분째',
  'widget.order-status.complete': '완료',
  'widget.order-status.completing': '완료됨',
  'widget.order-status.undoRow': '되돌리기',
  'widget.order-status.undoFailed': '되돌리지 못했어요. 다시 눌러 주세요',
  'widget.order-status.hint': '완료를 눌렀는지 확인해 주세요',
  'widget.order-status.empty.open': '진행 중인 주문이 없어요',
  'widget.order-status.empty.done': '아직 완료한 주문이 없어요',
  'widget.order-status.aria.row': '{no}번 {item}, {time} 주문, {n}분째, {status}',
  'widget.order-status.aria.complete': '{no}번 주문 완료',
  'widget.order-status.aria.reopen': '{no}번 주문 진행 중으로 되돌리기',
  'widget.order-status.aria.completed': '{no}번 주문을 완료했어요. 진행 중 {n}건',
  'widget.order-status.undoBar': '#{no} 완료했어요',
  'widget.order-status.summary.open': '진행 중 주문 {n}건',
  'widget.order-status.summary.avg': '평균 대기 {m}분',
  'widget.order-status.summary.missing': '누락 의심 {k}건',
  'widget.order-status.item.qty': '{item} {n}',
  'widget.order-status.item.sep': ', ',
} as const;

export type OrdersKey = keyof typeof ko;
/** POS screen bundle; the seven widget folders remain unchanged (ARCHITECTURE 16.2). */
export const ordersBundle: MessageBundle<OrdersKey> = Object.freeze({
  id: 'pos-order-status', ko: Object.freeze(ko), en: {}, 'zh-Hans': {}, 'zh-Hant': {},
});
