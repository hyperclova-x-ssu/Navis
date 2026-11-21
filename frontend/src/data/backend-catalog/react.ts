import { useEffect, useSyncExternalStore } from 'react';
import type { CatalogItem } from '../../../../backend/packages/contracts';
import { createBackendCatalogClient } from './client';

export const isHttpCatalogEnabled = import.meta.env.VITE_NAVIS_DATA_SOURCE === 'http';

type CatalogState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly items: readonly CatalogItem[]; readonly refreshing: boolean }
  | { readonly status: 'empty'; readonly featureId: 'menu'; readonly variant: 'http'; readonly messageKey: 'data.state.menu.no-menus' }
  | { readonly status: 'error'; readonly featureId: 'menu'; readonly variant: 'http'; readonly messageKey: 'data.state.menu.error' };

const client = createBackendCatalogClient();
const listeners = new Set<() => void>();
let state: CatalogState = { status: 'idle' };

function publish(next: CatalogState) {
  state = next;
  for (const listener of listeners) listener();
}

export function reloadBackendCatalog() {
  if (state.status === 'loading' || (state.status === 'ready' && state.refreshing)) return;
  publish(state.status === 'ready' ? { ...state, refreshing: true } : { status: 'loading' });
  void client.read().then(
    items => publish(items.length ? { status: 'ready', items, refreshing: false } : {
      status: 'empty', featureId: 'menu', variant: 'http', messageKey: 'data.state.menu.no-menus',
    }),
    () => publish({ status: 'error', featureId: 'menu', variant: 'http', messageKey: 'data.state.menu.error' }),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() { return state; }

export function useBackendCatalog(revalidate = false) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (state.status === 'idle' || (revalidate && (state.status === 'ready' || state.status === 'empty'))) {
      reloadBackendCatalog();
    }
  }, [revalidate]);
  return snapshot;
}
