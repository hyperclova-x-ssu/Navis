import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PosReadSnapshot } from '../contracts/pos';
import { orderStatusRuntime, type PosRuntime, type PosStatusRuntime } from './runtime';

/** The app owns a single runtime per run, supplied by its session coordinator. */
export const PosContext = createContext<PosRuntime | null>(null);
export const PosProvider = PosContext.Provider;
export function usePosSession(): PosRuntime {
  const runtime = useContext(PosContext);
  if (!runtime) throw new Error('PosProvider is required');
  return runtime;
}
export function usePosSnapshot(): PosReadSnapshot {
  const runtime = usePosSession();
  return useSyncExternalStore(runtime.subscribe, runtime.read, runtime.read);
}
export function usePosSelector<T>(selector: (read: PosReadSnapshot) => T): T {
  return selector(usePosSnapshot());
}

/** Status actions are required only by the M2 shell/status consumers. */
export function usePosStatusSession(): PosStatusRuntime { return orderStatusRuntime(usePosSession()); }
