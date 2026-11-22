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
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { FeatureId, PreviewSelection, QueryCondition } from '../contracts';
import { withWidgetFailureCopy } from './commands/failure-copy';
import { PREVIEW_AWARE, type DataCommand, type DataCommandResult } from './commands/types';
import type { WidgetDataStore } from './db/store';
import { selectWidget } from './models/select';
import type { ModelOf, WidgetView } from './models/types';
import { NORMAL_PREVIEW } from './preview/selection';
import { NORMAL_VARIANT, previewViewContext, resolveClosingVariant, resolveVariant } from './preview/variants';
import { selectStaffSchedule } from './iteration7/staff/selectors';
import type { StaffScheduleModel, StaffScheduleQuery } from './iteration7/staff/types';
import { TODAY } from './db/time';
import { isDataWidgetId } from './conditions';
import { undoDataNotice, undoDataNoticeResult } from './widget-data';
import { widgetDomains, type DomainState, type RealDomain, type RealPort } from './reality/00/port';

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
  const domains = featureId && isDataWidgetId(featureId) ? widgetDomains(featureId) : NO_DOMAINS;
  const real = useDomainsStateValue(value?.store.real, domains, false);
  if (!value || !snapshot || !featureId || !isDataWidgetId(featureId)) return null;
  const status = applyDomainState(selectWidget(snapshot, featureId, condition, real.mode === 'http' ? NORMAL_VARIANT : resolveVariant(featureId, value.preview), featureId === 'briefing' ? { ...previewViewContext(value.preview), ...value.viewContext } : undefined), real).status;
  if (featureId === 'credit-receivable' && real.mode === 'http' && status === 'ready' && !selectMoneyRead(snapshot).members.length) return 'empty';
  return status;
}

/* ── REAL-PLAN F00: domain state for widgets whose domain runs over HTTP ────────────────────────────────── */
const FIXTURE_STATE: DomainState = Object.freeze({ mode: 'fixture', status: 'fixture', pending: 0, refreshing: false, complete: true });
/** `load` = start the first load when a domain is HTTP and idle (widgets that read the domain trigger it). */
function useDomainStateValue(port: RealPort | undefined, domain: RealDomain | undefined, load = false): DomainState {
  return useDomainsStateValue(port, domain ? [domain] : NO_DOMAINS, load);
}
const NO_DOMAINS: readonly RealDomain[] = Object.freeze([]);
/** One state for several domains (the widget's own plus its dependencies): the worst of the HTTP ones, loading before ready. */
function combineStates(states: readonly DomainState[]): DomainState {
  const http = states.filter(state => state.mode === 'http');
  if (!http.length) return FIXTURE_STATE;
  if (http.length === 1) return http[0];
  const error = http.find(state => state.status === 'error');
  const pending = http.find(state => state.status === 'idle' || state.status === 'loading');
  const stale = http.find(state => state.status === 'stale');
  const lead = error ?? pending ?? stale ?? http[0];
  return Object.freeze({
    ...lead, status: lead.status, pending: http.reduce((n, state) => n + state.pending, 0), refreshing: http.some(state => state.refreshing),
    complete: http.every(state => state.complete),
  });
}
function useDomainsStateValue(port: RealPort | undefined, domains: readonly RealDomain[], load: boolean): DomainState {
  const key = domains.join('|');
  const read = useMemo(() => {
    // The combined object is rebuilt only when one of the per-domain states changes, so `useSyncExternalStore` stays stable.
    let inputs: readonly DomainState[] = [], output: DomainState = FIXTURE_STATE;
    return () => {
      if (!port || !key) return FIXTURE_STATE;
      const next = key.split('|').map(domain => port.state(domain as RealDomain));
      if (next.length === inputs.length && next.every((state, index) => state === inputs[index])) return output;
      inputs = next; output = combineStates(next);
      return output;
    };
  }, [port, key]);
  const state = useSyncExternalStore(port ? port.subscribe : NO_SUBSCRIBE, read, () => FIXTURE_STATE);
  useEffect(() => {
    if (!load || !port || !key) return;
    for (const domain of key.split('|') as RealDomain[]) if (port.state(domain).mode === 'http' && port.state(domain).status === 'idle') void port.load(domain);
  }, [load, port, key, state]);
  return state;
}
const decorated = new WeakMap<object, Map<string, WidgetView<unknown>>>();
/** First load → empty "loading"; failed first load → error; stale/partial → a note on the normal model. Fixture mode returns the view untouched. */
function applyDomainState<M>(view: WidgetView<M>, state: DomainState): WidgetView<M> {
  if (state.mode === 'fixture') return view;
  if (state.status === 'idle' || state.status === 'loading') return cached(view, 'loading', () => ({ status: 'empty', featureId: view.featureId, variant: view.variant, messageKey: 'data.real.loading' }));
  if (state.status === 'error') return cached(view, 'error', () => ({ status: 'error', featureId: view.featureId, variant: view.variant, messageKey: 'data.real.error' }));
  const notes = [...(state.status === 'stale' ? [{ messageKey: 'data.real.stale' }] : []), ...(state.complete ? [] : [{ messageKey: 'data.real.partial' }])];
  if (view.status !== 'ready' || !notes.length) return view;
  return cached(view, notes.map(note => note.messageKey).join('+'), () => ({ ...view, notes: [...(view.notes ?? []), ...notes] }));
}
function cached<M>(view: WidgetView<M>, key: string, make: () => WidgetView<unknown>): WidgetView<M> {
  let byKey = decorated.get(view);
  if (!byKey) decorated.set(view, byKey = new Map());
  let next = byKey.get(key);
  if (!next) byKey.set(key, next = make());
  return next as WidgetView<M>;
}

/** The run's data port (REAL-PLAN F00), or undefined when the app runs on the fixture store only (`port?.files`, `port?.load`). */
export function useRealPort(): RealPort | undefined { return useDataContext().store.real; }
/**
 * Lifecycle of one domain: `fixture`, or `idle/loading/ready/stale/error` plus `pending` writes. It starts the first load itself, so a widget
 * only calls this hook (no manual load). Pending financial/stock/send actions stay visibly pending until `pending` returns to 0.
 */
export function useDomainState(domain: RealDomain): DomainState { return useDomainStateValue(useDataContext().store.real, domain, true); }
/** Retry after an error or a stale refresh (a real re-read, not a cached answer). */
export function useRealRetry(domain: RealDomain): () => void {
  const port = useDataContext().store.real;
  return useCallback(() => { if (port) void port.retry(domain); }, [port, domain]);
}

/** The run's data store (e.g. for Navis facts of the normal variant). */
export function useWidgetDataStore(): WidgetDataStore {
  return useDataContext().store;
}

/** The run's data store, or `undefined` outside a `WidgetDataProvider` (a widget rendered on its own port in a test or story). */
export function useOptionalWidgetDataStore(): WidgetDataStore | undefined {
  return useContext(DataContext)?.store;
}

/** The widget's view under the current sample state (memoized per revision/condition/variant). */
export function useWidgetView<F extends FeatureId>(featureId: F, condition: QueryCondition = DEFAULT_CONDITION): WidgetView<ModelOf<F>> {
  const { store, preview, viewContext } = useDataContext();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const real = useDomainsStateValue(store.real, isDataWidgetId(featureId) ? widgetDomains(featureId) : NO_DOMAINS, true);
  // HTTP domains show real rows only: a stored sample-state preference never supplies fixture rows.
  return applyDomainState(selectWidget(snapshot, featureId, condition, real.mode === 'http' ? NORMAL_VARIANT : resolveVariant(featureId, preview), featureId === 'briefing' ? {...previewViewContext(preview),...viewContext} : undefined), real);
}

function preparedCommand(command: DataCommand, preview: PreviewSelection): { readonly command: DataCommand } | { readonly result: DataCommandResult } {
  if (command.type === 'closing.closeDay') {
    const variant = resolveClosingVariant(preview);
    if (variant === 'error') return { result: { ok: false, code: 'PREVIEW_FAILURE', reason: 'PAYMENTS_UNAVAILABLE', messageKey: 'data.management.error.PAYMENTS_UNAVAILABLE' } };
    return { command: { ...command, scenario: variant === 'no-payments' ? 'empty' : 'normal' } };
  }
  const widget = PREVIEW_AWARE[command.type];
  return { command: widget && (command.type === 'inquiry.send' || command.type === 'inquiry.post') ? { ...command, previewVariant: resolveVariant(widget, preview) } : command };
}

/**
 * Dispatches a data command; commands affected by a sample state get its variant (send-failure). In an HTTP domain an optimistic command
 * returns its local preview with `pending: true`; commands that must wait for the receipt return `ASYNC_REQUIRED` — use `useDataExecute`.
 */
export function useDataDispatch(): (command: DataCommand) => DataCommandResult {
  const { store, preview } = useDataContext();
  return useCallback((command: DataCommand) => {
    const prepared = preparedCommand(command, preview);
    return 'result' in prepared ? prepared.result : store.dispatch(prepared.command);
  }, [store, preview]);
}

/** Authoritative dispatch: always a Promise, resolved after the server receipt and the dependent re-read (fixture domains resolve with the local result). */
export function useDataExecute(): (command: DataCommand) => Promise<DataCommandResult> {
  const { store, preview } = useDataContext();
  return useCallback((command: DataCommand) => {
    const prepared = preparedCommand(command, preview);
    return 'result' in prepared ? Promise.resolve(prepared.result) : store.execute(prepared.command).then(withWidgetFailureCopy);
  }, [store, preview]);
}

/** Undo for a data notice (`undo: {target:'data', token}`) that resolves after a real (server) receipt is undone; fixture tokens resolve at once. */
export function useDataUndoAsync(): (token: string) => Promise<DataCommandResult> {
  const { store } = useDataContext();
  return useCallback((token: string) => undoDataNotice(store, token), [store]);
}

/** Undo for a notice toast: a fixture token answers synchronously, a real receipt returns a Promise that resolves after the server answers. Show the toast from the result either way. */
export function useDataUndoNotice(): (token: string) => DataCommandResult | Promise<DataCommandResult> {
  const { store } = useDataContext();
  return useCallback((token: string) => undoDataNoticeResult(store, token), [store]);
}

/** Undo for a data notice (`undo: {target:'data', token}`). Sync: for a real receipt it only starts the undo (`pending: true`) — toasts use `useDataUndoAsync`. */
export function useDataUndo(): (token: string) => DataCommandResult {
  const { store } = useDataContext();
  return useCallback((token: string) => store.undo(token), [store]);
}

/** Same preview envelope as the panel, with an independent week/month/date query. */
export function useStaffSchedule(query: StaffScheduleQuery = { startDate: TODAY, endDate: TODAY }): WidgetView<StaffScheduleModel> {
  const { store, preview } = useDataContext();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const real = useDomainsStateValue(store.real, widgetDomains('staff-schedule'), true);
  const view = applyDomainState(selectWidget(snapshot, 'staff-schedule', DEFAULT_CONDITION, real.mode === 'http' ? NORMAL_VARIANT : resolveVariant('staff-schedule', preview)), real);
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
