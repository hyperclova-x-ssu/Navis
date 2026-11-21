/**
 * T-072 React face of the live client (API-19.2·19.3). One `LiveClient` per page; every hook call holds a
 * reference while mounted, so the `/ws/view` socket lives exactly as long as some consumer does.
 */
import {useEffect, useMemo, useSyncExternalStore} from 'react';
import type {CctvView, LiveConnection, ServerDownReason} from '../../../data/cctv';
import type {Locale} from '../../../i18n';
import {ERROR_KEYS, postPair, type CnnError, type PairResult} from './api';
import {LiveClient, type LiveSnapshot} from './client';
import {cnnBaseUrl} from './config';
import {liveCctvView, maskOutline, type ZoneOutlineFn} from './liveView';

let client: LiveClient | null = null;

export function getLiveClient(): LiveClient {
  if (!client) client = new LiveClient({base: cnnBaseUrl()});
  return client;
}

/** Tests and dev: swap the page client (e.g. with fakes). */
export function setLiveClientForTest(c: LiveClient | null): void {
  client = c;
}

function useLiveSnapshot(video: boolean, enabled = true): LiveSnapshot {
  const c = getLiveClient();
  useEffect(() => (enabled ? c.acquire({video}) : undefined), [c, video, enabled]);
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

/** Live `CctvView`; `video:false` = no JPEG subscription (1×1 panel). `enabled:false` holds no socket. */
export function useLiveCctvView(opts: {video: boolean; enabled?: boolean; outline?: ZoneOutlineFn}): CctvView {
  const s = useLiveSnapshot(opts.video, opts.enabled ?? true);
  const outline = opts.outline ?? maskOutline;
  return useMemo(() => liveCctvView(s, outline), [s, outline]);
}

export function useLiveConnection(): {connection: LiveConnection; serverDown?: ServerDownReason; retry(): void} {
  const s = useLiveSnapshot(false);
  const c = getLiveClient();
  return useMemo(
    () => ({connection: s.connection, ...(s.serverDown ? {serverDown: s.serverDown} : {}), retry: () => c.retry()}),
    [s.connection, s.serverDown, c],
  );
}

export type PairError = CnnError<'CAMERA_CONNECTED' | 'RATE_LIMITED' | 'UNREACHABLE' | 'NOT_CONFIGURED'>;

/** API-19.3: POST /api/pair. BAD_ORIGIN and other failures come back as UNREACHABLE (contract PairError). */
export async function requestPairing(opts: {replace: boolean; lang: Locale}): Promise<({ok: true} & PairResult) | PairError> {
  const c = getLiveClient();
  const r = await postPair({base: cnnBaseUrl()}, opts);
  if (r.ok) {
    c.notePaired();
    return {ok: true, ...r.value};
  }
  const code = r.code === 'CAMERA_CONNECTED' || r.code === 'RATE_LIMITED' || r.code === 'NOT_CONFIGURED' ? r.code : 'UNREACHABLE';
  return {ok: false, code, key: ERROR_KEYS[code]};
}
