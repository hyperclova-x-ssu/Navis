import { useSyncExternalStore } from 'react';
import type { RunStore } from '../../contracts';
export const useRun = (run: RunStore) => useSyncExternalStore(run.subscribe, run.getState, run.getState);
