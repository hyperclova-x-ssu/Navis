import type { FeatureId, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { creditCopy, money } from './copy';
import { CreditDetail, CreditPanel } from './widget';
import type { UseCreditBinding } from './types';

/** Registration and condition/example-state hooks belong to T-271.M3. */
export function createCreditWidget(id: FeatureId, useBinding: UseCreditBinding): WidgetModule {
  function Panel(props: WidgetPanelProps) { const binding = useBinding(props.condition); return <CreditPanel {...props} {...binding} />; }
  function Detail(props: WidgetDetailProps) { const binding = useBinding(props.condition); return <CreditDetail {...props} {...binding} />; }
  function useSummary({ condition }: Parameters<WidgetModule['useSummary']>[0]) {
    const { view } = useBinding(condition);
    return view.status === 'ready' ? `총 충전금 ${money(view.model.chargeBalance)} · 총 외상 ${money(view.model.receivableBalance)}` : view.status === 'empty' ? creditCopy.empty : creditCopy.error;
  }
  return { id, Panel, Detail, useSummary };
}
