import type { AccessTokenResponse, ErrorResponse } from '../../../../backend/packages/contracts';

const SESSION_HINT_KEY = 'navis.has-session';

function hasSessionHint(): boolean {
  try { return globalThis.localStorage?.getItem(SESSION_HINT_KEY) === '1'; } catch { return false; }
}

function setSessionHint(present: boolean): void {
  try {
    if (present) globalThis.localStorage?.setItem(SESSION_HINT_KEY, '1');
    else globalThis.localStorage?.removeItem(SESSION_HINT_KEY);
  } catch { /* Storage can be unavailable. The session works in memory. */ }
}

/** A rejected backend response. `reason`/`field` come from the domain error body when present. */
export class SessionError extends Error {
  constructor(readonly status: number, readonly code?: ErrorResponse['code'] | string, readonly reason?: string, readonly field?: string, readonly details?: unknown) {
    super('Backend request failed');
  }
}

async function reject(response: Response): Promise<never> {
  const error: { code?: string; reason?: string; field?: string; details?: unknown } | null = await response.json().catch(() => null);
  throw new SessionError(response.status, error?.code, error?.reason, error?.field, error?.details);
}

export async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.status === 204 ? undefined as T : response.json();
  return reject(response);
}

/** A file body (authorized attachment read); errors still carry the JSON error body. */
export async function readBlob(response: Response): Promise<Blob> {
  return response.ok ? response.blob() : reject(response);
}

/**
 * The browser session shared by every same-origin backend read and write: the access token lives in memory only,
 * the rotating refresh cookie is the browser's, and one TOKEN_EXPIRED refresh is shared across parallel requests and tabs.
 * `call` runs one authorized request and returns its parsed JSON.
 */
export interface SessionOptions {
  /**
   * `demo` starts a demo session. `refresh-first` tries the rotating refresh cookie if this browser previously started a session,
   * then demo where available or `UNAUTHENTICATED/SESSION_REQUIRED` (sign in).
   */
  readonly start?: 'demo' | 'refresh-first';
}
export function createSessionClient(request: typeof fetch = fetch, options: SessionOptions = {}) {
  let credentials: AccessTokenResponse | undefined;
  let authRequest: Promise<AccessTokenResponse> | undefined;
  let sessionVersion = 0;

  function authenticate(action: 'demo' | 'refresh' | 'resume'): Promise<AccessTokenResponse> {
    if (authRequest) return authRequest;
    const version = sessionVersion;
    const issue = async (endpoint: 'demo' | 'refresh') => {
      if (version !== sessionVersion) throw new SessionError(401, 'UNAUTHENTICATED');
      const response = await request(`/api/v1/auth/${endpoint}`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
      });
      if (endpoint === 'refresh' && response.status === 401 && version === sessionVersion) setSessionHint(false);
      const next = await readJson<AccessTokenResponse>(response);
      if (!next?.accessToken || !next.storeId) throw new Error('Missing backend session');
      if (version !== sessionVersion) throw new SessionError(401, 'UNAUTHENTICATED');
      credentials = next;
      setSessionHint(true);
      return next;
    };
    const send = async () => {
      if (action !== 'resume') return issue(action);
      // Read under the cookie lock so the decision sees sessions just started by another tab.
      if (hasSessionHint()) {
        try { return await issue('refresh'); } catch (error) {
          if (!(error instanceof SessionError) || error.status !== 401 || version !== sessionVersion) throw error;
        }
      }
      try { return await issue('demo'); } catch (error) {
        if (error instanceof SessionError && [401, 403, 404].includes(error.status)) throw new SessionError(401, 'UNAUTHENTICATED', 'SESSION_REQUIRED');
        throw error;
      }
    };
    // Both endpoints set the same cookie. Let the browser apply one response
    // before another tab sends its request with that cookie.
    const locks = globalThis.navigator?.locks;
    const pending = Promise.resolve(locks ? locks.request('navis-refresh-cookie', send) : send())
      .finally(() => { if (authRequest === pending) authRequest = undefined; });
    return authRequest = pending;
  }

  /** The session in use, starting one when there is none (concurrent callers share the start). */
  function ensure(): Promise<AccessTokenResponse> {
    if (authRequest) return authRequest;
    if (credentials) return Promise.resolve(credentials);
    return authenticate(options.start === 'refresh-first' ? 'resume' : 'demo');
  }

  /** `send` receives the current credentials and returns the raw response; `call` parses it, refreshes once on TOKEN_EXPIRED, and ends the session on 401/403. */
  async function call<T>(send: (auth: AccessTokenResponse) => Promise<Response>, parse: (response: Response) => Promise<T> = readJson<T>): Promise<T> {
    const version = sessionVersion;
    try {
      const auth = await ensure();
      let result: T;
      try {
        result = await parse(await send(auth));
      } catch (error) {
        if (!(error instanceof SessionError && error.status === 401 && error.code === 'TOKEN_EXPIRED')
          || version !== sessionVersion) throw error;

        // A parallel request may have refreshed this token while the 401 was in flight.
        const refreshed = await (authRequest ?? (credentials !== auth && credentials ? credentials : authenticate('refresh')));
        result = await parse(await send(refreshed));
      }
      if (version !== sessionVersion) throw new SessionError(401, 'UNAUTHENTICATED');
      return result;
    } catch (error) {
      if (version === sessionVersion && error instanceof SessionError && (error.status === 401 || error.status === 403)) {
        credentials = undefined;
        sessionVersion += 1;
      }
      throw error;
    }
  }

  return {
    call,
    /** The store of the current session (starts the session when there is none). */
    async storeId(): Promise<string> { return (await ensure()).storeId; },
    /** Take over credentials issued by an explicit sign-in or store selection (the account domain). */
    adopt(next: AccessTokenResponse) { sessionVersion += 1; authRequest = undefined; credentials = next; setSessionHint(true); },
    /** Drop the in-memory token (sign-out, store change). In-flight results of the old session are discarded. */
    reset({ forgetSession = false } = {}) {
      sessionVersion += 1;
      credentials = undefined;
      authRequest = undefined;
      if (forgetSession) setSessionHint(false);
    },
    get current(): AccessTokenResponse | undefined { return credentials; },
  };
}
