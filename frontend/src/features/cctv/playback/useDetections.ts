import {useCallback, useEffect, useState} from 'react';
import {DetectionError, clearDetectionsCache, loadDetections} from '../../../data/cctv';
import type {DetectionLoad} from '../../../data/cctv';

/** Starts the JSON fetch on mount, aborts it on unmount. retry() clears the cache and starts over (API-13 6). */
export function useDetections(url?: string): {load: DetectionLoad; retry: () => void; attempt: number} {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${url ?? ''}`;
  const [done, setDone] = useState<{key: string; result: DetectionLoad} | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    loadDetections(ac.signal, url).then(
      file => { if (!ac.signal.aborted) setDone({key, result: {status: 'ready', file}}); },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setDone({key, result: {status: 'error', reason: e instanceof DetectionError ? e.reason : 'NETWORK'}});
      },
    );
    return () => ac.abort();
  }, [url, key]);
  const retry = useCallback(() => { clearDetectionsCache(); setAttempt(n => n + 1); }, []);
  const load: DetectionLoad = done && done.key === key ? done.result : {status: 'loading'};
  return {load, retry, attempt};
}
