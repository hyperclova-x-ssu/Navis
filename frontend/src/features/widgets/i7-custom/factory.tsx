import { useSyncExternalStore } from 'react';
import { selectCustomOrders } from '../../../data/iteration7/custom-orders';
import type { WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { CustomOrderProvider, type CustomOrderPort } from './port';
import { CustomOrderDetail, CustomOrderPanel } from './widget';

export interface CustomOrderBinding { readonly port: CustomOrderPort; readonly state?: 'ready' | 'empty' | 'error' }
/** Composition supplies a hook backed by the current run and its example state. */
export function createCustomOrderWidget(useBinding: () => CustomOrderBinding) {
  function Panel(props: WidgetPanelProps) {
    const binding = useBinding();
    return <CustomOrderProvider {...binding}><CustomOrderPanel {...props} /></CustomOrderProvider>;
  }
  function Detail(props: WidgetDetailProps) {
    const binding = useBinding();
    return <CustomOrderProvider {...binding}><CustomOrderDetail {...props} /></CustomOrderProvider>;
  }
  function useSummary() {
    const { port, state = 'ready' } = useBinding();
    const read = useSyncExternalStore(port.subscribe, port.read, port.read);
    if (state === 'error') return '주문제작 내역을 불러오지 못했어요';
    if (state === 'empty') return '아직 등록한 주문제작이 없어요';
    const { summary } = selectCustomOrders(read);
    return `진행 중 ${summary.inProgress}건 · 승인 대기 ${summary.approvalPending}건 · 오늘 픽업 ${summary.todayPickup}건`;
  }
  return { id: 'custom-order' as const, Panel, Detail, useSummary };
}
