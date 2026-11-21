import { useMemo } from 'react';
import { useBundle, type MessageParams, type Translator } from '../../i18n';
import { uiBundle } from '../../ui';
import { navisBundle } from '../../features/assistant';
import { dataBundles } from '../../data/widget-data';
import { dashboardBundle } from './messages';

/** Every phrase the dashboard shows: its own dashboard.* plus common, widget names, ui.*, navis.* and data notices. */
const bundles = [dashboardBundle, uiBundle, navisBundle, ...dataBundles] as const;
export interface DashboardT { readonly translator: Translator; readonly t: (key: string, params?: MessageParams) => string; readonly has: (key: string) => boolean; readonly name: (featureId: string) => string }
export function useDashboardT(): DashboardT {
  const translator = useBundle(...bundles) as unknown as Translator;
  return useMemo(() => ({
    translator,
    t: (key, params) => translator.t(key, params),
    has: (key) => translator.has(key),
    name: (featureId) => translator.t(`widget.${featureId}.title`),
  }), [translator]);
}
