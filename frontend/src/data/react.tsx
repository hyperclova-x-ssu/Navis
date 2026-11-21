import { selectNotices, type NoticesModel, type NoticesQuery } from './iteration7/notices';
import type { StoreEnvironmentModel } from './iteration7/environment';
import type { CustomOrderCommand } from './iteration7/custom-orders';
import { selectMoneyRead, selectAccountingPresentation } from './pos/projection';
import { selectCustomOrderRead } from './pos/projection';
import type { BriefingViewContext } from './derive/operations';
/**
 * React adapter for the fake DB (API-09 v4). The app shell creates one store per run and passes
 * the RunState sample-state selection; widgets read with `useWidgetView` and write with `useDataDispatch`.
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { FeatureId, PreviewSelection, QueryCondition } from '../contracts';
import { PREVIEW_AWARE, type DataCommand, type DataCommandResult } from './commands/types';
import type { WidgetDataStore } from './db/store';
import { selectWidget } from './models/select';
import type { ModelOf, WidgetView } from './models/types';
import { NORMAL_PREVIEW } from './preview/selection';
import { previewViewContext, resolveClosingVariant, resolveVariant } from './preview/variants';
import { selectStaffSchedule } from './iteration7/staff/selectors';
import type { StaffScheduleModel, StaffScheduleQuery } from './iteration7/staff/types';
import { TODAY } from './db/time';
import { isDataWidgetId } from './conditions';

interface DataContextValue { readonly store: WidgetDataStore; readonly preview: PreviewSelection; readonly viewContext?: BriefingViewContext }
const DataContext = createContext<DataContextValue | null>(null);
const DEFAULT_CONDITION: QueryCondition = Object.freeze({ kind: 'default' });

export function WidgetDataProvider({ store, preview = NORMAL_PREVIEW, viewContext, children }: { readonly store: WidgetDataStore; readonly preview?: PreviewSelection; readonly viewContext?: BriefingViewContext; readonly children?: ReactNode }) {
  const value = useMemo(() => ({ store, preview, viewContext }), [store, preview, viewContext]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useDataContext(): DataContextValue {
  const value = useContext(DataContext);
  if (!value) throw new Error('WidgetDataProvider is missing: wrap the tree with <WidgetDataProvider store={…} preview={…}>.');
  return value;
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
/**
 * The status of a widget's view under the current sample state, or null when there is no data provider or the feature is not a data widget.
 * It never throws, so a frame (DetailOverlay: an empty or failed widget gets the compact window, K-E 11) can ask without owning the provider.
 */
export function useWidgetViewStatus(featureId: FeatureId | null | undefined, condition: QueryCondition = DEFAULT_CONDITION): WidgetView<unknown>['status'] | null {
  const value = useContext(DataContext);
  const snapshot = useSyncExternalStore(value ? value.store.subscribe : NO_SUBSCRIBE, value ? value.store.getSnapshot : () => null, value ? value.store.getSnapshot : () => null);
  if (!value || !snapshot || !featureId || !isDataWidgetId(featureId)) return null;
  return selectWidget(snapshot, featureId, condition, resolveVariant(featureId, value.preview), featureId === 'briefing' ? { ...previewViewContext(value.preview), ...value.viewContext } : undefined).status;
}

/** The run's data store (e.g. for Navis facts of the normal variant). */
export function useWidgetDataStore(): WidgetDataStore {
  return useDataContext().store;
}

/** The widget's view under the current sample state (memoized per revision/condition/variant). */
export function useWidgetView<F extends FeatureId>(featureId: F, condition: QueryCondition = DEFAULT_CONDITION): WidgetView<ModelOf<F>> {
  const { store, preview, viewContext } = useDataContext();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return selectWidget(snapshot, featureId, condition, resolveVariant(featureId, preview), featureId === 'briefing' ? {...previewViewContext(preview),...viewContext} : undefined);
}

/** Dispatches a data command; commands affected by a sample state get its variant (send-failure). */
export function useDataDispatch(): (command: DataCommand) => DataCommandResult {
  const { store, preview } = useDataContext();
  return useCallback((command: DataCommand) => {
    if (command.type === 'closing.closeDay') {
      const variant = resolveClosingVariant(preview);
      if (variant === 'error') return { ok: false, code: 'PREVIEW_FAILURE', reason: 'PAYMENTS_UNAVAILABLE', messageKey: 'data.management.error.PAYMENTS_UNAVAILABLE' };
      return store.dispatch({ ...command, scenario: variant === 'no-payments' ? 'empty' : 'normal' });
    }
    const widget = PREVIEW_AWARE[command.type];
    return store.dispatch(widget && (command.type === 'inquiry.send' || command.type === 'inquiry.post') ? { ...command, previewVariant: resolveVariant(widget, preview) } : command);
  }, [store, preview]);
}

/** Undo for a data notice (`undo: {target:'data', token}`). */
export function useDataUndo(): (token: string) => DataCommandResult {
  const { store } = useDataContext();
  return useCallback((token: string) => store.undo(token), [store]);
}

/** Same preview envelope as the panel, with an independent week/month/date query. */
export function useStaffSchedule(query: StaffScheduleQuery = { startDate: TODAY, endDate: TODAY }): WidgetView<StaffScheduleModel> {
  const { store, preview } = useDataContext();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const view = selectWidget(snapshot, 'staff-schedule', DEFAULT_CONDITION, resolveVariant('staff-schedule', preview));
  return view.status === 'ready' ? { ...view, model: selectStaffSchedule(snapshot, query) } : view;
}

export function useNotices(query: NoticesQuery = {}): WidgetView<NoticesModel> {
  const {store} = useDataContext();
  const snapshot = useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const view = useWidgetView('notice-send');
  return view.status === 'ready' ? {...view,model:selectNotices(snapshot,query)} : view;
}
export function useStoreEnvironment(): WidgetView<StoreEnvironmentModel> { return useWidgetView('store-environment'); }
export function useCustomOrderRead() {
  const {store}=useDataContext();
  return selectCustomOrderRead(useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot));
}
export function useCustomOrderDispatch(): (command:CustomOrderCommand)=>DataCommandResult { return useDataDispatch(); }

export function useMoneyRead(){const {store,preview}=useDataContext();const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);const variant=resolveVariant('credit-receivable',preview);return selectMoneyRead(snapshot,variant==='error'?'error':variant==='empty'?'empty':'normal');}
export function useAccountingViews(){const {store}=useDataContext();return selectAccountingPresentation(useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot));}
