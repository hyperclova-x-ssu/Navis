import { useState, type ReactNode } from 'react';
import type { Locale } from '../../contracts';
import { I18nProvider } from '../../i18n';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';

/** Test-only: the app shell (T-054) supplies these providers; a briefing test needs the fake DB and a language. */
export function DataHost({ children, locale = 'ko' }: { readonly children: ReactNode; readonly locale?: Locale }) {
  const [store] = useState(() => createWidgetDataStore());
  return <I18nProvider locale={locale}><WidgetDataProvider store={store}>{children}</WidgetDataProvider></I18nProvider>;
}
