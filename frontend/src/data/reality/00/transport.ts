import { createSessionClient, readBlob, readJson, SessionError } from '../../backend-catalog/session';
import type { AccessTokenResponse } from '../../../../../backend/packages/contracts';
import { PortError, type ListPage, type PortErrorCode, type PortReads, type PortRequest, type PortTransport, type ReadRequest } from './port';

const KNOWN: ReadonlySet<string> = new Set<PortErrorCode>(['INVALID_REQUEST', 'VALIDATION', 'UNAUTHENTICATED', 'TOKEN_EXPIRED', 'STORE_FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE']);
const DEFAULT_TIMEOUT_MS = 15_000;

function codeFor(status: number, code: string | undefined): PortErrorCode {
  if (code && KNOWN.has(code)) return code as PortErrorCode;
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'STORE_FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVICE_UNAVAILABLE';
  return 'UNKNOWN';
}

/**
 * Server error `details` reach the widgets as `DataCommandResult.details`. Keep only plain JSON (depth ≤ 3, ≤ 40 values, strings ≤ 200 chars,
 * arrays ≤ 20 items, no prototype keys) so a misbehaving response cannot inject objects or flood a notice.
 */
export function sanitizeDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let budget = 40;
  const clean = (item: unknown, depth: number): unknown => {
    if (budget-- <= 0 || depth > 3) return undefined;
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') return item.slice(0, 200);
    if (Array.isArray(item)) return item.slice(0, 20).map(child => clean(child, depth + 1)).filter(child => child !== undefined);
    if (typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const cleaned = clean(child, depth + 1);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      return out;
    }
    return undefined;
  };
  const result = clean(value, 0) as Record<string, unknown>;
  return Object.keys(result).length ? Object.freeze(result) : undefined;
}

/** Map any failure of a request to a `PortError`. After a write was sent, a network failure, timeout or 5xx has an unknown outcome. */
export function toPortError(error: unknown, method: PortRequest['method'], timedOut = false): PortError {
  if (error instanceof PortError) return error;
  const write = method !== 'GET';
  if (error instanceof SessionError) {
    const code = codeFor(error.status, error.code);
    // F15 additive: a service that answers with only a domain `code` (B15: `{code:'CLOSURE_CHANGED'}`) is read as that reason.
    const reason = error.reason ?? (error.code && error.code !== code ? error.code : undefined);
    return new PortError(error.status, code, reason, error.field, write && error.status >= 500, sanitizeDetails(error.details));
  }
  if (timedOut) return new PortError(0, 'TIMEOUT', undefined, undefined, write);
  return new PortError(0, 'NETWORK', undefined, undefined, write);
}

export function buildUrl(storeId: string | null, request: Pick<PortRequest, 'path' | 'query' | 'scope'>): string {
  const base = request.scope === 'root' ? request.path : `/api/v1/stores/${encodeURIComponent(storeId ?? '')}${request.path}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/**
 * Authenticated JSON requests over the existing same-origin session (`backend-catalog/session`): bearer from memory, one shared
 * TOKEN_EXPIRED refresh, `no-store`, `Idempotency-Key`, `expectedRevision` merged into the JSON body.
 */
export interface AnonymousRequest { readonly method: 'POST'; readonly path: string; readonly body?: unknown; readonly idempotencyKey?: string }
export type PortSession = PortTransport & {
  readonly session: ReturnType<typeof createSessionClient>;
  adopt(session: AccessTokenResponse): void;
  reset(options?: { forgetSession?: boolean }): void;
  onScopeChange(listener: (error?: PortError) => void): () => void;
  /** A root-scoped request that needs no session (sign-in, sign-out): same-origin cookies only, no bearer, no session start. */
  anonymous<T>(request: AnonymousRequest): Promise<T>;
};
export function createPortTransport(request: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): PortSession {
  const session = createSessionClient(request, { start: 'refresh-first' });
  const scopeListeners = new Set<(error?: PortError) => void>();
  let scopeVersion = 0;
  const changed = (error?: PortError) => { scopeVersion += 1; for (const listener of scopeListeners) listener(error); };
  const lostAccess = (error: PortError, started: number) => {
    if (started === scopeVersion && (error.status === 401 || error.status === 403)) changed(error);
    return error;
  };
  return {
    session,
    adopt(next) { session.adopt(next); changed(); },
    onScopeChange(listener) { scopeListeners.add(listener); return () => { scopeListeners.delete(listener); }; },
    async storeId() {
      const started = scopeVersion;
      try { return await session.storeId(); } catch (error) { throw lostAccess(toPortError(error, 'GET'), started); }
    },
    reset(options?: { forgetSession?: boolean }) { session.reset(options); changed(); },
    async anonymous<T>(req: AnonymousRequest): Promise<T> {
      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (req.body !== undefined) headers['content-type'] = 'application/json';
        if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
        return await readJson<T>(await request(req.path, {
          method: req.method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        }));
      } catch (error) { throw toPortError(error, req.method); }
    },
    async request<T>(req: PortRequest): Promise<T> {
      const started = scopeVersion;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const body = req.bytes ? req.bytes : req.expectedRevision !== undefined
        ? { ...(req.body && typeof req.body === 'object' ? req.body : {}), expectedRevision: req.expectedRevision }
        : req.body;
      try {
        return await session.call<T>(async auth => {
          if (started !== scopeVersion) throw new PortError(401, 'UNAUTHENTICATED', 'SESSION_ENDED');
          req.signal?.throwIfAborted();
          const headers: Record<string, string> = { authorization: `Bearer ${auth.accessToken}`, accept: req.responseAs === 'blob' ? '*/*' : 'application/json' };
          if (req.bytes) headers['content-type'] = req.bytes.type || 'application/octet-stream';
          else if (body !== undefined) headers['content-type'] = 'application/json';
          if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
          return request(buildUrl(auth.storeId, req), {
            method: req.method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
            ...(body !== undefined ? { body: req.bytes ? req.bytes : JSON.stringify(body) } : {}),
          });
        }, req.responseAs === 'blob' ? readBlob as (response: Response) => Promise<T> : undefined);
      } catch (error) {
        throw lostAccess(toPortError(error, req.method, timeout.aborted && !req.signal?.aborted), started);
      }
    },
  };
}

/* ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────── */
const MAX_LIMIT = 200;

function checkPage<T>(value: unknown): ListPage<T> {
  const page = value as Partial<ListPage<T>> | null;
  if (!page || !Array.isArray(page.items) || typeof page.asOf !== 'string' || !Number.isInteger(page.sourceRevision)
    || !(page.nextCursor === null || typeof page.nextCursor === 'string')) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  }
  return page as ListPage<T>;
}

export function createPortReads(transport: PortTransport): PortReads {
  const get = <T>(read: ReadRequest, query: ReadRequest['query'], signal?: AbortSignal) =>
    transport.request<T>({ method: 'GET', path: read.path, scope: read.scope, query, signal });
  const bounded = (read: ReadRequest, cursor?: string) => {
    const limit = Math.min(Number(read.query?.limit ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT);
    return { ...read.query, limit, ...(cursor ? { cursor } : {}) };
  };
  return {
    async page<T>(read: ReadRequest, options: { readonly cursor?: string; readonly signal?: AbortSignal } = {}) {
      return checkPage<T>(await get(read, bounded(read, options.cursor), options.signal));
    },
    async all<T>(read: ReadRequest, options: { readonly maxPages?: number; readonly signal?: AbortSignal } = {}) {
      const maxPages = options.maxPages ?? 20;
      const items: T[] = [];
      let cursor: string | undefined, pages = 0;
      for (;;) {
        const page = checkPage<T>(await get(read, bounded(read, cursor), options.signal));
        items.push(...page.items);
        pages += 1;
        if (page.nextCursor === null) return { items, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: true };
        if (pages >= maxPages) return { items, asOf: page.asOf, sourceRevision: page.sourceRevision, complete: false };
        cursor = page.nextCursor;
      }
    },
    one<T>(read: ReadRequest, options: { readonly signal?: AbortSignal } = {}) {
      return get<T>(read, read.query, options.signal);
    },
  };
}
