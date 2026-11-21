import type { AccessTokenResponse, CatalogItem, CatalogResponse, ErrorResponse } from '../../../../backend/packages/contracts';

class CatalogError extends Error {
  constructor(readonly status: number, readonly code?: ErrorResponse['code']) {
    super('Catalog request failed');
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json();
  const error: Partial<ErrorResponse> | null = await response.json().catch(() => null);
  throw new CatalogError(response.status, error?.code);
}

export function createBackendCatalogClient(request: typeof fetch = fetch) {
  let credentials: AccessTokenResponse | undefined;
  let authRequest: Promise<AccessTokenResponse> | undefined;
  let sessionVersion = 0;

  function authenticate(endpoint: 'demo' | 'refresh') {
    const version = sessionVersion;
    authRequest ??= (async () => {
      const response = await request(`/api/v1/auth/${endpoint}`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
      });
      const next = await readJson<AccessTokenResponse>(response);
      if (!next?.accessToken || !next.storeId) throw new Error('Missing catalog session');
      if (version !== sessionVersion) throw new CatalogError(401, 'UNAUTHENTICATED');
      credentials = next;
      return next;
    })().finally(() => { authRequest = undefined; });
    return authRequest;
  }

  async function readCatalog(auth: AccessTokenResponse) {
    const query = new URLSearchParams({ storeId: auth.storeId });
    const response = await request(`/api/v1/inventory/catalog?${query}`, {
      credentials: 'same-origin', redirect: 'error', headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    const result = await readJson<CatalogResponse>(response);
    if (!Array.isArray(result?.items)) throw new Error('Invalid catalog response');
    return result.items;
  }

  async function read(): Promise<readonly CatalogItem[]> {
    const version = sessionVersion;
    try {
      const auth = await (authRequest ?? credentials ?? authenticate('demo'));
      let items;
      try {
        items = await readCatalog(auth);
      } catch (error) {
        if (!(error instanceof CatalogError && error.status === 401 && error.code === 'TOKEN_EXPIRED')
          || version !== sessionVersion) throw error;

        // A parallel read may have refreshed this token while the 401 was in flight.
        const refreshed = await (authRequest ?? (credentials !== auth && credentials ? credentials : authenticate('refresh')));
        items = await readCatalog(refreshed);
      }
      if (version !== sessionVersion) throw new CatalogError(401, 'UNAUTHENTICATED');
      return items;
    } catch (error) {
      if (version === sessionVersion && error instanceof CatalogError && (error.status === 401 || error.status === 403)) {
        credentials = undefined;
        sessionVersion += 1;
      }
      throw error;
    }
  }

  return { read };
}
