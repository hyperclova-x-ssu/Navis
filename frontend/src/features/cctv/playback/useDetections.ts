import {useCallback, useEffect, useState} from 'react';
import {DetectionError, clearDetectionsCache, loadDetections, validateDetections} from '../../../data/cctv';
import type {DetectionLoad} from '../../../data/cctv';
import {PortError, type PortTransport} from '../../../data/reality/00';

export const sampleMediaPath = '/insight/cctv-samples';
export const sampleIsBundled = (error: unknown) => error instanceof PortError && error.reason === 'CCTV_SAMPLE_BUNDLED';

async function readDetections(signal: AbortSignal, url?: string, transport?: PortTransport) {
  if (!transport || url !== undefined) return loadDetections(signal, url);
  try {
    const raw = await transport.request<unknown>({method: 'GET', path: `${sampleMediaPath}/store-sample-detections.json`, signal});
    return validateDetections(raw);
  } catch (error) {
    if (sampleIsBundled(error)) return loadDetections(signal);
    throw error;
  }
}

/** Starts the JSON fetch on mount, aborts it on unmount. retry() clears the cache and starts over (API-13 6). */
export function useDetections(url?: string, transport?: PortTransport, scope = 0, blocked = false): {load: DetectionLoad; retry: () => void; attempt: number} {
  const [attempt, setAttempt] = useState(0);
  const key = `${scope}|${attempt}|${url ?? ''}`;
  const unavailable = blocked && !!transport && url === undefined;
  const [done, setDone] = useState<{key: string; transport?: PortTransport; result: DetectionLoad} | null>(null);
  useEffect(() => {
    if (unavailable) return;
    const ac = new AbortController();
    readDetections(ac.signal, url, transport).then(
      file => { if (!ac.signal.aborted) setDone({key, transport, result: {status: 'ready', file}}); },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        setDone({key, transport, result: {status: 'error', reason: e instanceof DetectionError ? e.reason : 'NETWORK'}});
      },
    );
    return () => ac.abort();
  }, [url, key, transport, unavailable]);
  const retry = useCallback(() => { clearDetectionsCache(); setAttempt(n => n + 1); }, []);
  const load: DetectionLoad = unavailable ? {status: 'error', reason: 'NETWORK'}
    : done && done.key === key && done.transport === transport ? done.result : {status: 'loading'};
  return {load, retry, attempt};
}
