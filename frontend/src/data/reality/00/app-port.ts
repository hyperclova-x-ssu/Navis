import type { WidgetDataStore } from '../../db/store';
import { autoloadedAdapters } from './autoload';
import { createRealPort } from './real-port';
import { createPortTransport } from './transport';
import { dataSourceFor } from './registry';
import { REAL_DOMAINS, type RealPort } from './port';

let sharedTransport: ReturnType<typeof createPortTransport> | undefined;
let activePort: RealPort | undefined;
/** One browser session per tab: a restarted run reuses it instead of opening a new demo session. */
export function appTransport() {
  if (!sharedTransport) {
    sharedTransport = createPortTransport();
    sharedTransport.onScopeChange(error => activePort?.reset({ keepSession: true, error }));
  }
  return sharedTransport;
}

/**
 * The app composition: one port per run when the build asks for HTTP and at least one adapter is registered.
 * Returns undefined otherwise, so fixture builds keep their exact current behavior.
 */
export function createAppRealPort(store: WidgetDataStore): RealPort | undefined {
  const adapters = autoloadedAdapters();
  if (!adapters.length || !REAL_DOMAINS.some(domain => dataSourceFor(domain) === 'http')) return undefined;
  const port = createRealPort({ store, adapters, transport: appTransport() });
  const previous = activePort;
  activePort = port;
  if (previous) queueMicrotask(() => previous.reset({ keepSession: true }));
  store.bindReal(port);
  return port;
}
