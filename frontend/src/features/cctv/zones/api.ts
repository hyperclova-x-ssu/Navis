/**
 * T-073 API-18 seam for the editor. The HTTP calls are T-072's `live/api.ts` (getZones / putZones / suggestZones);
 * this file only adapts their CnnResult to promises the editor awaits, and lets tests pass a fake.
 */
import { getZones, putZones, suggestZones, type CnnErrorCode, type CnnResult, type HttpDeps } from '../live/api';
import { cnnBaseUrl } from '../live/config';
import type { Zone, ZoneSet } from './types';

/** First suggest call loads the segmentation model (moa 3.6 s measured by T-072); allow 8 s. */
export const SUGGEST_TIMEOUT_MS = 8000;

export class ZonesApiError extends Error {
  constructor(readonly code: CnnErrorCode, readonly key: string, readonly current?: ZoneSet) { super(code); this.name = 'ZonesApiError'; }
}
export interface PutZonesBody { readonly baseRevision: number; readonly frameAspect: number | null; readonly zones: readonly Zone[] }
export interface SuggestResult { readonly zones: readonly Zone[]; readonly frameAspect: number | null }
export interface ZonesApi {
  get(): Promise<ZoneSet>;
  put(body: PutZonesBody): Promise<ZoneSet>;
  suggest(): Promise<SuggestResult>;
}

const unwrap = async <T,>(p: Promise<CnnResult<T>>): Promise<T> => {
  const r = await p;
  if (r.ok) return r.value;
  throw new ZonesApiError(r.code, r.key, r.current);
};

export function createZonesApi(deps: Omit<HttpDeps, 'base'> & { readonly base?: string | null } = {}): ZonesApi {
  const http: HttpDeps = { ...deps, base: deps.base === undefined ? cnnBaseUrl() : deps.base };
  return {
    get: () => unwrap(getZones(http)),
    put: body => unwrap(putZones(http, body)),
    suggest: () => unwrap(suggestZones({ ...http, timeoutMs: SUGGEST_TIMEOUT_MS })),
  };
}
