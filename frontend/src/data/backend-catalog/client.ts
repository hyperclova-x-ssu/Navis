import type { CatalogItem, CatalogResponse } from '../../../../backend/packages/contracts';
import { createSessionClient } from './session';

export function createBackendCatalogClient(request: typeof fetch = fetch) {
  const session = createSessionClient(request);

  async function read(): Promise<readonly CatalogItem[]> {
    const result = await session.call<CatalogResponse>(auth => {
      const query = new URLSearchParams({ storeId: auth.storeId });
      return request(`/api/v1/inventory/catalog?${query}`, {
        credentials: 'same-origin', redirect: 'error', headers: { authorization: `Bearer ${auth.accessToken}` },
      });
    });
    if (!Array.isArray(result?.items)) throw new Error('Invalid catalog response');
    return result.items;
  }

  return { read };
}
