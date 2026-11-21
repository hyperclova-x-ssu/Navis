/**
 * T-072 mode store (API-19.1, F-56). Page memory only: starts `mock`, a reload is `mock` again (Q-342).
 * Not in RunState or the fake DB (ARCHITECTURE 14.6).
 */
import {useSyncExternalStore} from 'react';
import type {CctvMode} from '../../../data/cctv';

let mode: CctvMode = 'mock';
const listeners = new Set<() => void>();

export function getCctvMode(): CctvMode {
  return mode;
}

/** Changes the mode for every subscriber in the same render pass (M-32). */
export function setCctvMode(next: CctvMode): void {
  if (next === mode) return;
  mode = next;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useCctvMode(): CctvMode {
  return useSyncExternalStore(subscribe, getCctvMode, getCctvMode);
}

/** Tests only: back to the first value. */
export function resetCctvModeForTest(): void {
  mode = 'mock';
  listeners.clear();
}
