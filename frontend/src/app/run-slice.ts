import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { RunState, RunStore } from '../contracts';

const shallowEqual = <T extends object>(a: T, b: T): boolean => {
  for (const key of Object.keys(a) as (keyof T)[]) if (!Object.is(a[key], b[key])) return false;
  return true;
};

/**
 * A component that reads only a few run fields subscribes to those fields. The run store notifies on every drop-cell change of a
 * widget drag (preview pending, then accepted), a notice or a selection; this hook keeps the same snapshot object while the picked
 * fields are equal, so such a host (and every provider value it builds) stays still. `select` must be a stable function.
 */
export function useRunSlice<T extends object>(run: RunStore, select: (state: RunState) => T, equal: (a: T, b: T) => boolean = shallowEqual): T {
  const cache = useRef<{ readonly state: RunState; readonly value: T } | null>(null);
  const snapshot = useCallback(() => {
    const state = run.getState(), before = cache.current;
    if (before?.state === state) return before.value;
    const value = select(state);
    const kept = before && equal(before.value, value) ? before.value : value;
    cache.current = { state, value: kept };
    return kept;
  }, [run, select, equal]);
  return useSyncExternalStore(run.subscribe, snapshot, snapshot);
}
