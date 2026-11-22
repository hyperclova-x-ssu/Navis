import { useEffect, useMemo, useState } from 'react';
import { PortError } from '../../../data/reality/00/port';

export function useNaverRead<T>(load?: (signal: AbortSignal) => Promise<T>) {
  const [retry, setRetry] = useState(0);
  const request = useMemo(() => ({ load, retry }), [load, retry]);
  const [state, setState] = useState<{ request: typeof request; result?: T; error?: PortError }>();
  useEffect(() => {
    if (!request.load) return;
    const abort = new AbortController();
    void request.load(abort.signal).then(result => {
      if (!abort.signal.aborted) setState({ request, result });
    }, error => {
      if (!abort.signal.aborted) setState({ request, error: error instanceof PortError ? error : new PortError(0, 'NETWORK') });
    });
    return () => abort.abort();
  }, [request]);
  return { ...(state?.request === request ? state : undefined), refresh: () => setRetry(value => value + 1) };
}
