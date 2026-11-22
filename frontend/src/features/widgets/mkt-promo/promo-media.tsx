import { useEffect, useState } from 'react';
import { useRealPort } from '../../../data/react';

/** Store media requires the same bearer as its JSON projection. Do not send it to an arbitrary media URL. */
export function usePromoMedia(url: string | undefined, storeId: string | undefined) {
  const port = useRealPort();
  const prefix = storeId ? `/api/v1/stores/${encodeURIComponent(storeId)}/` : undefined;
  const privatePath = url && prefix && url.startsWith(prefix) ? url.slice(prefix.length - 1) : undefined;
  const [loaded, setLoaded] = useState<{ src?: string; key: string; failed?: true }>();
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setLoaded(undefined); setAttempt(current => current + 1); };
  useEffect(() => {
    if (!port || !privatePath || !url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void port.transport.request<Blob>({ method: 'GET', path: privatePath, responseAs: 'blob', signal: controller.signal }).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ src: objectUrl, key: url });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key: url, failed: true });
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [port, privatePath, url, attempt]);
  if (privatePath) return loaded?.key === url ? { src: loaded?.src, failed: loaded?.failed, retry } : { retry };
  if (storeId && (!url?.startsWith('/') || url.startsWith('//') || url.startsWith('/api/v1/stores/'))) return { failed: true, retry };
  return { src: url, retry };
}
