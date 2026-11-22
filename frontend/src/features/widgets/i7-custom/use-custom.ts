import { useContext, useSyncExternalStore } from 'react';
import { selectCustomOrders } from '../../../data/iteration7/custom-orders';
import { CustomOrderContext } from './context';
const noSubscription = () => () => {};
const noRead = () => null;
export function useCustomOrderSource() {
  const context = useContext(CustomOrderContext);
  const read = useSyncExternalStore(context?.port.subscribe ?? noSubscription, context?.port.read ?? noRead, context?.port.read ?? noRead);
  return { port: context?.port ?? null, read, retry: context?.retry, state: context?.state ?? 'error' as const };
}
export function useCustomOrderModel(query: Parameters<typeof selectCustomOrders>[1] = {}) {
  const source = useCustomOrderSource();
  const model = source.read && source.state !== 'error' && source.state !== 'loading' ? selectCustomOrders(source.read, query) : null;
  return { ...source, model, rows: source.state === 'empty' ? [] : model?.orders ?? [] };
}

export function useCustomOrderSummary() {
  const { model, state } = useCustomOrderModel();
  return state === 'error' || !model ? '주문제작 내역을 불러오지 못했어요' : state === 'empty' ? '아직 등록한 주문제작이 없어요' : `진행 중 ${model.summary.inProgress}건 · 승인 대기 ${model.summary.approvalPending}건 · 오늘 픽업 ${model.summary.todayPickup}건`;
}

export function usePickupCount(date: string): number | null {
  const { rows, port, state } = useCustomOrderModel();
  return port && state !== 'error' && state !== 'loading' ? rows.filter(row => row.pickup?.date === date && row.pickup.status === 'confirmed').length : null;
}
