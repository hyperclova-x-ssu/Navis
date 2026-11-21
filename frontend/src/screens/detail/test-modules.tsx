/**
 * Test-only providers for the detail overlay: the app shell supplies a language, the fake DB and the widget registry.
 * Detail bodies are stubs registered through the provider (the real widget folders belong to other tasks).
 */
import { useState, type ReactNode } from 'react';
import type { FeatureId, Locale, WidgetDetailProps, WidgetModule } from '../../contracts';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { I18nProvider } from '../../i18n';

export function stubDetailModule(id: FeatureId, extra?: (props: WidgetDetailProps) => ReactNode): WidgetModule {
  return {
    id,
    Panel: () => null,
    useSummary: () => '',
    Detail: props => <section aria-label={`${id} 본문`} data-testid={`body-${id}`} data-view={props.detailRef.view ?? ''}>{`본문 ${id}`}{extra?.(props)}</section>,
  };
}
export const stubDetailModules = (ids: readonly FeatureId[]): readonly WidgetModule[] => ids.map(id => stubDetailModule(id));

export function DetailHost({ children, modules, locale = 'ko' }: { readonly children: ReactNode; readonly modules: readonly WidgetModule[]; readonly locale?: Locale }) {
  const [store] = useState(() => createWidgetDataStore());
  return <I18nProvider locale={locale}><WidgetDataProvider store={store}><WidgetRegistryProvider modules={modules}>{children}</WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
}
