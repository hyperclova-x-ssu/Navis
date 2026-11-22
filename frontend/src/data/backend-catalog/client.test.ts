import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackendCatalogClient } from './client';

const storeId = '11111111-1111-4111-8111-111111111111';
const item = { menuId: '22222222-2222-4222-8222-222222222222', name: 'Tea', category: 'tea', seasonal: 'autumn', price: 3100, saleStatus: 'selling' };
const access = (accessToken: string) => Response.json({ accessToken, expiresIn: 600, storeId });
const catalog = () => Response.json({ items: [item] });
const expired = () => Response.json({ code: 'TOKEN_EXPIRED' }, { status: 401 });
const unauthenticated = () => Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
const demo = '/api/v1/auth/demo';
const refresh = '/api/v1/auth/refresh';
const read = `/api/v1/inventory/catalog?storeId=${storeId}`;

afterEach(() => vi.unstubAllGlobals());

describe('HTTP menu client', () => {
  it('opens a demo session and reuses its in-memory access token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(access('initial'))
      .mockImplementation(async () => catalog());
    const client = createBackendCatalogClient(fetcher);
    expect(await client.read()).toEqual([item]);
    expect(await client.read()).toEqual([item]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([demo, read, read]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer initial');
  });

  it('shares one refresh across concurrent expiry responses and retries with the new bearer', async () => {
    const fetcher = vi.fn<typeof fetch>(async (path, request) => {
      if (path === demo) return access('initial');
      if (path === refresh) return access('rotated');
      return new Headers(request?.headers).get('authorization') === 'Bearer initial' ? expired() : catalog();
    });
    const client = createBackendCatalogClient(fetcher);
    expect(await Promise.all([client.read(), client.read()])).toEqual([[item], [item]]);
    const paths = fetcher.mock.calls.map(([path]) => path);
    expect(paths.filter(path => path === demo)).toHaveLength(1);
    expect(paths.filter(path => path === refresh)).toHaveLength(1);
    expect(paths.filter(path => path === read)).toHaveLength(4);
  });

  it('waits for a pending refresh in another tab before sending the shared cookie', async () => {
    let tail = Promise.resolve();
    vi.stubGlobal('navigator', { locks: {
      request: (_name: string, callback: () => Promise<unknown>) => {
        const acquired = tail.then(callback);
        tail = acquired.then(() => {}, () => {});
        return acquired;
      },
    } });

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
    let cookieVersion = 0;
    let initialExpired = false;
    let expiredReads = 0;
    const submittedVersions: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (path, request) => {
      if (path === demo) return access('initial');
      if (path === refresh) {
        const submitted = cookieVersion;
        submittedVersions.push(submitted);
        if (submitted === 0) await holdFirst;
        if (submitted !== cookieVersion) return unauthenticated();
        return access(`rotated-${++cookieVersion}`);
      }
      if (initialExpired && new Headers(request?.headers).get('authorization') === 'Bearer initial') {
        expiredReads += 1;
        return expired();
      }
      return catalog();
    });
    const tabs = [createBackendCatalogClient(fetcher), createBackendCatalogClient(fetcher)];
    await Promise.all(tabs.map(tab => tab.read()));
    initialExpired = true;

    const pending = Promise.allSettled(tabs.map(tab => tab.read()));
    try {
      await vi.waitFor(() => expect(expiredReads).toBe(2));
      expect(submittedVersions).toEqual([0]);
    } finally {
      releaseFirst();
    }
    expect(await pending).toEqual(tabs.map(() => ({ status: 'fulfilled', value: [item] })));
    expect(submittedVersions).toEqual([0, 1]);
  });

  it('retries an expired read at most once and discards rejected credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(access('initial')).mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(access('rotated')).mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(access('new-session')).mockResolvedValueOnce(catalog());
    const client = createBackendCatalogClient(fetcher);
    await expect(client.read()).rejects.toThrow();
    expect(await client.read()).toEqual([item]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([demo, read, refresh, read, demo, read]);
  });

  it('rejects a revoked read without issuing a new session or refreshing in that read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(access('initial'))
      .mockResolvedValueOnce(catalog()).mockResolvedValueOnce(unauthenticated());
    const client = createBackendCatalogClient(fetcher);
    expect(await client.read()).toEqual([item]);
    await expect(client.read()).rejects.toThrow();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([demo, read, read]);
  });

  it('does not publish a concurrent success after its session is rejected', async () => {
    let complete!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { complete = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(access('initial'))
      .mockReturnValueOnce(slow).mockResolvedValueOnce(unauthenticated());
    const client = createBackendCatalogClient(fetcher);
    const pending = client.read();
    await expect(client.read()).rejects.toThrow();
    complete(catalog());
    await expect(pending).rejects.toThrow();
  });
});
