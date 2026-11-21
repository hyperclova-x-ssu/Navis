/**
 * Render helper for kit and widget tests (API-07 v4): wraps I18nProvider, UiProvider, WidgetDataProvider and
 * WidgetRegistryProvider so a test only chooses the language, preset and data it cares about.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { Locale, PreviewSelection, ScreenPreset, Theme, WidgetModule } from '../contracts';
import { I18nProvider } from '../i18n';
import { screenPresets } from '../layout/presets';
import { createWidgetDataStore } from '../data/db/store';
import type { WidgetDataStore } from '../data/db/store';
import { WidgetDataProvider } from '../data/react';
import { WidgetRegistryProvider } from '../features/widgets/registry-context';
import { UiProvider } from './UiProvider';

export interface KitRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  readonly locale?: Locale;
  readonly preset?: ScreenPreset;
  readonly theme?: Theme;
  readonly textScale?: 100 | 125;
  readonly reducedMotion?: boolean;
  readonly store?: WidgetDataStore;
  readonly preview?: PreviewSelection;
  readonly modules?: readonly WidgetModule[];
}
const NO_MODULES: readonly WidgetModule[] = [];

export function KitProviders({ children, locale = 'ko', preset = screenPresets.A, theme = 'light', textScale = 100, reducedMotion = false, store, preview, modules = NO_MODULES }: KitRenderOptions & { readonly children?: ReactNode }) {
  // A fresh fake DB per mounted tree unless a test supplies its own.
  const [ownStore] = useState(() => store ?? createWidgetDataStore());
  const dataStore = store ?? ownStore;
  return (
    <I18nProvider locale={locale}>
      <UiProvider screenPreset={preset} theme={theme} textScale={textScale} reducedMotion={reducedMotion}>
        <WidgetDataProvider store={dataStore} preview={preview}>
          <WidgetRegistryProvider modules={modules}>{children}</WidgetRegistryProvider>
        </WidgetDataProvider>
      </UiProvider>
    </I18nProvider>
  );
}

export function renderWithKit(ui: ReactElement, options: KitRenderOptions = {}): RenderResult {
  const { locale, preset, theme, textScale, reducedMotion, store, preview, modules, ...rest } = options;
  return render(ui, { ...rest, wrapper: ({ children }) => <KitProviders locale={locale} preset={preset} theme={theme} textScale={textScale} reducedMotion={reducedMotion} store={store} preview={preview} modules={modules}>{children}</KitProviders> });
}
