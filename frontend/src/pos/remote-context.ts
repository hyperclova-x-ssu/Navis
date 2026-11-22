import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PosBridge, SyncState } from '../data/reality/02/bridge';

/**
 * REAL-PLAN F02: present only when the POS runs over HTTP (the run host provides it). Fixture builds have no bridge, so every
 * POS screen keeps its existing local behavior when this context is null.
 */
const PosBridgeContext = createContext<PosBridge | null>(null);
export const PosBridgeProvider = PosBridgeContext.Provider;
export const usePosBridge = (): PosBridge | null => useContext(PosBridgeContext);

const idle: SyncState = { status: 'idle', complete: true };
const none = () => () => undefined;
/** The bridge's read state (loading, ready, error with its cause); `undefined` outside HTTP mode. */
export function usePosSyncState(): SyncState | undefined {
  const bridge = usePosBridge();
  const state = useSyncExternalStore(bridge ? bridge.subscribe : none, bridge ? bridge.state : () => idle, () => idle);
  return bridge ? state : undefined;
}
