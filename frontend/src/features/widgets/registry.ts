/** API-201: collect every widget folder with the unchanged eager glob and strict ID validation. */
import type { WidgetModule } from '../../contracts';
import { collectWidgetModules } from '../../catalog/widget-modules';
import { createElement, useMemo, useSyncExternalStore } from 'react';
import { useDataDispatch, useNotices, useStoreEnvironment, useWidgetDataStore, useWidgetView, useCustomOrderRead, useCustomOrderDispatch } from '../../data/react';
import { dataBundles } from '../../data/widget-data';
import { selectStoreClosures } from '../../data/iteration7/notices';
import { useBundle } from '../../i18n';
import { noticeBusinessNow } from '../../data/iteration7/notices/commands';
import { createNoticePort, createNoticeWidget, noticeView } from './i7-notice';
import { createEnvironmentPort, createEnvironmentWidget, environmentView } from './i7-environment';
import { createCustomOrderWidget, type CustomOrderBinding, type CustomOrderPort } from './i7-custom';
import { CustomerAnalysisDetail } from './mgmt-customers/customer-analysis';
import { useM2WidgetBindings, useRunCreditBinding } from '../../app/pos-host';
import { createCreditWidget } from './i7-credit';
import type { WidgetDetailProps } from '../../contracts';
export { collectWidgetModules } from '../../catalog/widget-modules';
export type { WidgetFolderModules } from '../../catalog/widget-modules';

const folders = import.meta.glob<{ widgets?: readonly WidgetModule[] }>('./*/index.ts', { eager: true });

function useNoticeBinding() {
  const view = useNotices(), dispatch = useDataDispatch(), store = useWidgetDataStore(), host = useM2WidgetBindings();
  const groups = useWidgetView('customer-groups'), { t } = useBundle(...dataBundles);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const port = useMemo(() => createNoticePort(dispatch, id => store.getSnapshot().tables.noticeDraft.find(draft => draft.noticeId === id), () => host?.resetPreview('notice-send'), () => `notice:${globalThis.crypto.randomUUID()}`), [dispatch, store, host]);
  return { view: view.status === 'ready' ? noticeView(view.model, selectStoreClosures(snapshot), groups.status === 'ready' ? groups.model.groups.map(group => ({ groupId: group.id, name: t(group.nameKey) })) : [], noticeBusinessNow(snapshot)) : { status: view.status === 'error' ? 'error' as const : 'empty' as const }, port };
}
function useEnvironmentBinding() {
  const view = useStoreEnvironment(), dispatch = useDataDispatch(), host = useM2WidgetBindings();
  const port = useMemo(() => createEnvironmentPort(dispatch, () => host?.resetPreview('store-environment')), [dispatch, host]);
  return { view: view.status === 'ready' ? environmentView(view.model) : { status: view.status === 'error' ? 'error' as const : 'empty' as const }, port };
}
function useCustomBinding(): CustomOrderBinding {
  const host = useM2WidgetBindings(), view = useWidgetView('custom-order'), read = useCustomOrderRead(), dispatch = useCustomOrderDispatch(), store = useWidgetDataStore();
  // Standalone dev readers still share the canonical source; money dialogs live in App.
  const fallback = useMemo<CustomOrderPort>(() => ({ read: () => read, subscribe: store.subscribe, dispatch: command => {
    const result = dispatch(command);
    return result.ok ? { ...result, value: result.value as import('../../data/iteration7/custom-orders').CustomCommandValue } : result;
  }, openSettlement: () => {}, openReversal: () => {}, members: [] }), [read, store, dispatch]);
  return { port: host?.customPort ?? fallback, state: view.status === 'error' ? 'error' : view.status === 'ready' ? 'ready' : 'empty' };
}
function LinkedCustomerAnalysisDetail(props: WidgetDetailProps) {
  const host = useM2WidgetBindings();
  return createElement(CustomerAnalysisDetail, { ...props, ...host?.cctv });
}
/** Keep the eager folder order, then append the landed controlled modules. */
export const widgetModules: readonly WidgetModule[] = Object.freeze([
  ...collectWidgetModules(folders).map(module => module.id === 'customer-analysis' ? { ...module, Detail: LinkedCustomerAnalysisDetail } : module),
  createNoticeWidget('notice-send', useNoticeBinding),
  createEnvironmentWidget('store-environment', useEnvironmentBinding),
  createCustomOrderWidget(useCustomBinding),
  createCreditWidget('credit-receivable', useRunCreditBinding),
]);
