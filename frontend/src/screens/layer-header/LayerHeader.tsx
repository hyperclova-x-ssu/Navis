import type { ReactNode } from 'react';
import { store as demoStore } from '../../data/db/generated/manifest.json';
import { TODAY } from '../../data/widget-data';
import { useAccountStoreName } from '../../app/account-context-value';
import { useDashboardT } from '../dashboard/use-dashboard-t';

/**
 * D-366: the one top header of every board-sized layer (관리, 마케팅 and 주문/결제). The store name (the signed-in account's active
 * store, or the sample cafe on fixture builds) is the title, the date sits beside it and the right-side buttons are the caller's
 * `children`. 관리/마케팅 and the POS screen render this same component, so the three headers cannot drift apart again.
 * `labelKey` is the layer's own name; it is the title only while no store name exists and the language is not Korean.
 * With `editToolbar` the title is read aloud only (the toolbar owns the row), as the dashboard did before.
 */
export interface LayerHeaderProps {
  readonly labelKey: string;
  readonly editToolbar?: ReactNode;
  readonly children?: ReactNode;
}
export function LayerHeader({ labelKey, editToolbar, children }: LayerHeaderProps) {
  const { t, translator } = useDashboardT(), accountStoreName = useAccountStoreName();
  const storeName = (accountStoreName === null ? demoStore?.name : accountStoreName)?.trim();
  const title = storeName || (translator.locale === 'ko' ? t('dashboard.title') : t(labelKey));
  const lang = storeName ? 'ko' : undefined;
  return <header className="dashboard-header">
    {editToolbar
      ? <><h1 className="ui-sr-only" lang={lang}>{title}</h1>{editToolbar}</>
      : <><div><h1 lang={lang}>{title}</h1><p>{translator.format.date(TODAY, 'long')}</p></div><div className="dashboard-header-actions">{children}</div></>}
  </header>;
}
