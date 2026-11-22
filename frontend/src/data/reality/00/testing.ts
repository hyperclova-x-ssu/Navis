/** F00 test helper: an in-memory backend behind a `fetch` stub (session endpoints included). Not shipped in the app bundle. */
export interface RecordedCall {
  readonly method: string;
  /** Store-relative path (`/inventory/menu`) for `/api/v1/stores/{id}…`, otherwise the full pathname. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly headers: Headers;
}
export interface Reply { readonly status: number; readonly body: unknown }
export const reply = (status: number, body: unknown): Reply => ({ status, body });
type Handler = (call: RecordedCall) => unknown | Promise<unknown>;
interface Route { readonly method: string; readonly match: string | RegExp; readonly handler: Handler }
export const TEST_STORE_ID = '11111111-1111-4111-8111-111111111111';

export function fakeBackend(storeId = TEST_STORE_ID) {
  const routes: Route[] = [];
  const calls: RecordedCall[] = [];
  /** Session starts in order: `demo` / `refresh`. Both succeed unless a test registers its own route for them. */
  const authCalls: string[] = [];
  let tokenSeq = 0;
  const prefix = `/api/v1/stores/${storeId}`;
  const on = (method: string, match: string | RegExp, handler: Handler) => { routes.unshift({ method, match, handler }); };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = method === 'POST' && (url.pathname === '/api/v1/auth/demo' || url.pathname === '/api/v1/auth/refresh');
    if (auth) {
      authCalls.push(url.pathname.slice('/api/v1/auth/'.length));
      const own = routes.find(r => r.method === method && r.match === url.pathname);
      if (!own) return Response.json({ accessToken: `token-${++tokenSeq}`, expiresIn: 600, storeId });
    }
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const call: RecordedCall = {
      method, path, query: Object.fromEntries(url.searchParams), headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find(r => r.method === method && (typeof r.match === 'string' ? r.match === path : r.match.test(path)));
    if (!route) return Response.json({ code: 'NOT_FOUND', reason: 'NO_ROUTE' }, { status: 404 });
    const result = await route.handler(call);
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      const { status, body } = result as Reply;
      return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
    }
    return Response.json(result);
  };
  return {
    fetch: fetcher, calls, authCalls, storeId, on,
    /** Calls made to `method path` (store-relative). */
    callsTo: (method: string, path: string | RegExp) => calls.filter(c => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))),
  };
}
