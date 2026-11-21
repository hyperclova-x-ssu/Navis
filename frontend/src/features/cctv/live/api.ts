/**
 * T-072 HTTP client (API-14 health, API-15 pair, API-18 zones). Every call times out after 2 s (AbortController).
 * Errors never throw: they come back as `{ok:false, code, key}` where `key` is the screen message key (`cctv.*`).
 * Server times (`expiresAt`, `serverT`) are monotonic seconds — use `expiresInSec`, never compare with Date.now().
 */
import type {Locale} from '../../../i18n';

export const HTTP_TIMEOUT_MS = 2000;

export interface MaskRle { readonly cols: 160; readonly rows: 90; readonly runs: readonly number[] }
export interface Zone { readonly id: string; readonly number: number; readonly source: 'suggested' | 'drawn'; readonly mask: MaskRle }
export interface ZoneSet { readonly revision: number; readonly savedAt: string | null; readonly frameAspect: number | null; readonly zones: readonly Zone[] }
export interface SuggestedZone extends Zone { readonly method?: 'segment' | 'seated' }

export type CameraState = 'none' | 'waiting' | 'connected' | 'live';

export interface Health {
  readonly ok: boolean;
  readonly camera: CameraState;
  readonly zonesRevision: number;
  readonly mode?: string;
  readonly [k: string]: unknown;
}

export interface PairResult {
  readonly code: string;
  readonly cameraUrl: string;
  readonly qrSvg: string;
  /** Server clock (monotonic s). Kept for the contract; compare `expiresInSec` instead. */
  readonly expiresAt: number;
  readonly expiresInSec: number;
}

/** Error codes the client can return (server codes + client-side ones). */
export type CnnErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNREACHABLE'
  | 'BAD_ORIGIN'
  | 'CAMERA_CONNECTED'
  | 'RATE_LIMITED'
  | 'REVISION_CONFLICT'
  | 'INVALID_ZONES'
  | 'NO_FRAME'
  | 'UNKNOWN';

export interface CnnError<C extends CnnErrorCode = CnnErrorCode> {
  readonly ok: false;
  readonly code: C;
  /** Screen message key in `cctvBundle`. */
  readonly key: string;
  /** 409 REVISION_CONFLICT: the server's current set (the draft is kept). */
  readonly current?: ZoneSet;
  readonly message?: string;
}
export type CnnOk<T> = {readonly ok: true; readonly value: T};
export type CnnResult<T, C extends CnnErrorCode = CnnErrorCode> = CnnOk<T> | CnnError<C>;

/**
 * Error code → screen key. REVISION_CONFLICT and NO_FRAME have no own text in `cctvBundle` yet
 * (R4 "다른 곳에서 바뀌었어요" is not in DS 13); they use the nearest existing key.
 */
export const ERROR_KEYS: Readonly<Record<CnnErrorCode, string>> = {
  NOT_CONFIGURED: 'cctv.conn.serverNotConfigured',
  UNREACHABLE: 'cctv.conn.serverUnreachable',
  BAD_ORIGIN: 'cctv.conn.serverBadOrigin',
  CAMERA_CONNECTED: 'cctv.conn.live',
  RATE_LIMITED: 'cctv.conn.retry',
  REVISION_CONFLICT: 'cctv.zones.conflict',
  INVALID_ZONES: 'cctv.zones.saveFailed',
  NO_FRAME: 'cctv.conn.noFrame',
  UNKNOWN: 'cctv.conn.serverDown',
};

const err = <C extends CnnErrorCode>(code: C, extra: Partial<Omit<CnnError, 'ok' | 'code' | 'key'>> = {}): CnnError<C> => ({ok: false, code, key: ERROR_KEYS[code], ...extra});

export interface HttpDeps {
  readonly base: string | null;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const KNOWN = new Set<string>(Object.keys(ERROR_KEYS));

async function call<T>(deps: HttpDeps, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<CnnResult<T>> {
  if (!deps.base) return err('NOT_CONFIGURED');
  const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(deps.base + path, {
      method,
      signal: ctl.signal,
      headers: body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    clearTimeout(timer);
    return err('UNREACHABLE');
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return {ok: true, value: data as T};
  const e = (data as {error?: {code?: string; message?: string}; current?: ZoneSet} | null) ?? {};
  const serverCode = e.error?.code;
  let code: CnnErrorCode;
  if (serverCode && KNOWN.has(serverCode)) code = serverCode as CnnErrorCode;
  else if (res.status === 403) code = 'BAD_ORIGIN';
  else if (res.status === 429) code = 'RATE_LIMITED';
  else if (res.status >= 500) code = 'UNREACHABLE';
  else code = 'UNKNOWN';
  return err(code, {message: e.error?.message, current: e.current});
}

export function fetchHealth(deps: HttpDeps): Promise<CnnResult<Health>> {
  return call<Health>(deps, 'GET', '/api/health');
}

export function postPair(deps: HttpDeps, opts: {replace: boolean; lang: Locale}): Promise<CnnResult<PairResult>> {
  return call<PairResult>(deps, 'POST', '/api/pair', {lang: opts.lang, replace: opts.replace});
}

export function getZones(deps: HttpDeps): Promise<CnnResult<ZoneSet>> {
  return call<ZoneSet>(deps, 'GET', '/api/zones');
}

export function putZones(deps: HttpDeps, body: {baseRevision: number; frameAspect: number | null; zones: readonly Zone[]}): Promise<CnnResult<ZoneSet>> {
  return call<ZoneSet>(deps, 'PUT', '/api/zones', body);
}

export function suggestZones(deps: HttpDeps): Promise<CnnResult<{zones: readonly SuggestedZone[]; frameAspect: number}>> {
  return call(deps, 'POST', '/api/zones/suggest', {});
}
