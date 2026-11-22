/**
 * API-13 widget registry context (T-045). The module list is supplied by the app shell (T-054 registry.ts);
 * panels, details and the dashboard read modules only through these hooks. The module set of one provider must not change
 * while mounted, because a module's hooks (useSummary, useTapTarget) are called in place.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { DashboardLayerId, DetailRef, FeatureId, QueryCondition, RunStore, WidgetHost, WidgetModule } from '../../contracts';
import { useI18n } from '../../i18n';

const EMPTY: ReadonlyMap<FeatureId, WidgetModule> = new Map();
const RegistryContext = createContext<ReadonlyMap<FeatureId, WidgetModule>>(EMPTY);
const DEFAULT_CONDITION: QueryCondition = Object.freeze({ kind: 'default' });

export function WidgetRegistryProvider({ modules, children }: { readonly modules: readonly WidgetModule[]; readonly children?: ReactNode }) {
  const map = useMemo(() => new Map(modules.map((module) => [module.id, module] as const)), [modules]);
  return <RegistryContext.Provider value={map}>{children}</RegistryContext.Provider>;
}

/** The module for a widget, or undefined (iteration-3 compatibility: the caller falls back to the generic content). */
export function useWidgetModule(id: FeatureId): WidgetModule | undefined {
  return useContext(RegistryContext).get(id);
}

function useNameOnly(): string { return ''; }

/** Accessible key sentence of a widget in the current language and example variant. Without a module (or an empty sentence) it is the widget name. */
export function useWidgetSummary(featureId: FeatureId, condition: QueryCondition = DEFAULT_CONDITION): string {
  const module = useWidgetModule(featureId);
  const { t } = useI18n();
  const args = useMemo(() => ({ featureId, condition }), [featureId, condition]);
  const sentence = (module?.useSummary ?? useNameOnly)(args);
  return sentence || t(`widget.${featureId}.title`);
}

function useNoTarget(): null { return null; }

/**
 * What a short press on the panel opens (API-13 v4.1): the module's own tap target if it has one (it may be null),
 * nothing when the module has no Detail (marketing-today), otherwise the widget's own detail.
 * With no module it keeps the iteration-3 behavior (own detail).
 */
export function useWidgetTapTarget(featureId: FeatureId, condition: QueryCondition = DEFAULT_CONDITION): DetailRef | null {
  const module = useWidgetModule(featureId);
  const args = useMemo(() => ({ featureId, condition }), [featureId, condition]);
  const custom = (module?.useTapTarget ?? useNoTarget)(args);
  if (module?.useTapTarget) return custom;
  if (module && module.Detail === null) return null;
  return { featureId };
}

export interface WidgetHostOptions {
  readonly featureId: FeatureId;
  readonly layer: DashboardLayerId;
  /** Focus key restored when the opened detail closes. Default `panel:{featureId}`; the dashboard passes its own panel or button key. */
  readonly focusKey?: string;
}

/** One host per widget for the dashboard and its detail (API-13): every method maps to a RunStore action. */
export function createWidgetHost(run: Pick<RunStore, 'actions'> & Partial<Pick<RunStore, 'getState' | 'subscribe'>>, { featureId, layer, focusKey }: WidgetHostOptions): WidgetHost {
  const { actions, getState, subscribe } = run;
  // Lets an open briefing detail follow an acknowledgement made elsewhere (the chat card); hosts built without a live run keep their own press state.
  const briefingAcknowledged = getState && subscribe
    ? { subscribe: (listener: () => void) => subscribe(() => listener()), getSnapshot: () => getState().briefing === 'dismissed' }
    : undefined;
  return {
    layer,
    resetPreview: () => actions.resetWidgetPreview(featureId),
    openSettings: () => actions.openSettings(),
    hasSmsSettings: () => {
      const sms = getState?.().shopSettings.smsSettings;
      return !!(sms?.senderNumber && sms.optOutNumber);
    },
    openClosing: (returnFocusKey) => actions.openClosing(returnFocusKey),
    openLinked: (ref) => { actions.openLinkedDetail(ref); },
    openDetail: (ref) => { actions.openDetailRef(ref, focusKey ?? `panel:${featureId}`); },
    notify: ({ kind, messageKey, params, undoToken, undoUntil }) => actions.showNotice({
      kind, messageKey, featureId, ...(params ? { params } : {}), ...(undoToken ? { undo: { target: 'data' as const, token: undoToken } } : {}),
      ...(undoToken && undoUntil && Number.isFinite(Date.parse(undoUntil)) ? { undoUntil: Date.parse(undoUntil) } : {}),
    }),
    supersedeSuccessNotice: () => actions.supersedeWidgetSuccessNotice(featureId),
    acknowledgeBriefing: () => actions.acknowledgeBriefing(),
    ...(briefingAcknowledged ? { briefingAcknowledged } : {}),
  };
}
