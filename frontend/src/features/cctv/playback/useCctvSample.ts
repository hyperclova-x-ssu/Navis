import {useEffect, useState} from 'react';
import {VIDEO_URL} from '../../../data/cctv';
import {useOptionalWidgetDataStore} from '../../../data/react';
import type {PortTransport} from '../../../data/reality/00';
import type {PortSession} from '../../../data/reality/00/transport';
import {sampleIsBundled, sampleMediaPath, useDetections} from './useDetections';

export function useCctvSample(videoOverride?: string, detectionsOverride?: string) {
  const port = useOptionalWidgetDataStore()?.real;
  const transport = port?.mode('cctv') === 'http' ? port.transport : undefined;
  const [session, setSession] = useState({version: 0, blocked: false, transport});
  useEffect(() => (transport as Partial<PortSession> | undefined)?.onScopeChange?.(error => {
    setSession(current => ({version: current.version + 1, blocked: !!error, transport}));
  }), [transport]);
  const scope = session.version;
  const blocked = session.transport === transport && session.blocked;

  const {load, retry, attempt} = useDetections(detectionsOverride, transport, scope, blocked);
  const remote = videoOverride === undefined ? transport : undefined;
  const [loaded, setLoaded] = useState<{attempt: number; scope: number; transport: PortTransport; src?: string; failed?: true}>();
  useEffect(() => {
    if (!remote || blocked) return;
    const controller = new AbortController();
    const {signal} = controller;
    let objectUrl: string | undefined;
    const key = {attempt, scope, transport: remote};
    void remote.request<Blob>({method: 'GET', path: `${sampleMediaPath}/store-sample.mp4`, responseAs: 'blob', signal}).then(blob => {
      if (signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({...key, src: objectUrl});
    }).catch(error => {
      if (signal.aborted) return;
      setLoaded(sampleIsBundled(error) ? {...key, src: VIDEO_URL} : {...key, failed: true});
    });
    return () => {controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl);};
  }, [remote, attempt, scope, blocked]);

  const current = loaded && loaded.transport === remote && loaded.attempt === attempt && loaded.scope === scope ? loaded : undefined;
  return {
    load, retry, attempt, scope,
    src: remote ? current?.src : videoOverride ?? VIDEO_URL,
    failed: !!remote && (blocked || current?.failed === true),
  };
}
