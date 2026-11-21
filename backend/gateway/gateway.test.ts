import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway } from './app.ts';

const store = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const sid = '44444444-4444-4444-8444-444444444444';
const requestId = 'a'.repeat(32);
const catalog = { items: [{ menuId: user, name: 'Tea', category: 'drink', price: 3100, saleStatus: 'selling' }] };
const claims = { sub: user, sid, store_id: store, role: 'owner' };
const key = await generateKeyPair('ES256');
const jwks = { keys: [{ ...await exportJWK(key.publicKey), kid: 'account-key', alg: 'ES256', use: 'sig' }] };

async function token(patch: JWTPayload = {}, kid = 'account-key', privateKey = key.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    ...claims, iss: 'navis-account', aud: 'navis-api', iat: now, exp: now + 600, ...patch,
  }).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
}

function setup() {
  let authorization: () => Response = () => new Response(null, { status: 204 });
  let keys: () => Response = () => Response.json(jwks);
  let auth: () => Response = () => Response.json({ accessToken: 'browser-token', expiresIn: 600, storeId: store }, {
    headers: { 'set-cookie': 'navis_refresh=test; Path=/api/v1/auth; HttpOnly; SameSite=Strict' },
  });
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    switch (new URL(String(url)).pathname) {
      case '/internal/v1/auth/jwks': return keys();
      case '/internal/v1/auth/authorize': return authorization();
      case '/internal/v1/inventory/catalog': return Response.json(catalog);
      case '/api/v1/auth/demo':
      case '/api/v1/auth/refresh': return auth();
      case '/readyz': return new Response(null, { status: 200 });
      default: throw new Error('Unexpected upstream');
    }
  });
  const app = createGateway({
    accountUrl: 'http://account:3000', inventoryUrl: 'http://inventory:3000',
    accountToken: 'account-workload', inventoryToken: 'inventory-workload', fetcher,
    browserPost: (url, headers, signal) => fetcher(url, { method: 'POST', headers, signal }),
    logging: false,
  });
  closers.push(() => app.close());

  function read(accessToken: string, storeId = store, headers = {}) {
    return app.inject({
      method: 'GET', url: `/api/v1/inventory/catalog?storeId=${storeId}`,
      headers: { authorization: `Bearer ${accessToken}`, 'x-request-id': requestId, ...headers },
    });
  }
  const calls = () => fetcher.mock.calls.map(([url, init]) => ({
    url: String(url), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body,
  }));

  return {
    app, read, calls,
    setAuthorization: (response: () => Response) => { authorization = response; },
    setKeys: (response: () => Response) => { keys = response; },
    setAuth: (response: () => Response) => { auth = response; },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map(close => close()));
});

describe('catalog gateway', () => {
  it('forwards only verified store context and propagates the edge request ID', async () => {
    const { read, calls } = setup();
    const result = await read(await token(), store, {
      'x-navis-store-id': other, 'x-navis-store-role': 'staff', 'x-navis-session-id': other,
      'x-navis-workload-token': 'client-supplied', cookie: 'client=1',
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(catalog);
    expect(result.headers).toMatchObject({ 'cache-control': 'no-store', 'x-request-id': requestId });
    expect(calls()).toEqual([
      { url: 'http://account:3000/internal/v1/auth/jwks', method: 'GET', headers: {
        authorization: 'Bearer account-workload', 'x-request-id': requestId,
      }, body: undefined },
      { url: 'http://account:3000/internal/v1/auth/authorize', method: 'POST', headers: {
        authorization: 'Bearer account-workload', 'x-request-id': requestId, 'content-type': 'application/json',
      }, body: JSON.stringify(claims) },
      { url: `http://inventory:3000/internal/v1/inventory/catalog?storeId=${store}`, method: 'GET', headers: {
        authorization: 'Bearer inventory-workload', 'x-request-id': requestId, 'x-navis-store-id': store, 'x-navis-store-role': 'owner',
      }, body: undefined },
    ]);
  });

  it('validates the store query, requires a bearer, and keeps internal routes private', async () => {
    const { app, read, calls } = setup();
    for (const value of ['', 'not-a-uuid', `${store}&storeId=${store}`, `${store}&other=1`]) {
      const result = await read('unused', value);
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual({ code: 'INVALID_REQUEST' });
      expect(result.headers['cache-control']).toBe('no-store');
    }
    const missing = await app.inject(`/api/v1/inventory/catalog?storeId=${store}`);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect((await app.inject('/internal/v1/auth/jwks')).statusCode).toBe(404);
    expect(calls()).toEqual([]);
  });

  it.each([
    { iss: 'elsewhere' }, { aud: 'elsewhere' }, { sub: undefined }, { sub: 'not-a-uuid' },
    { sid: 'not-a-uuid' }, { store_id: 'not-a-uuid' }, { role: 'admin' },
    { iat: undefined }, { iat: 1.5 }, { exp: undefined },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
  ])('rejects invalid JWT claims %o', async (patch) => {
    const { read, calls } = setup();
    const result = await read(await token(patch));
    expect(result.statusCode).toBe(401);
    expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(calls().every(call => call.url.endsWith('/jwks'))).toBe(true);
  });

  it('rejects unknown or absent keys and non-ES256 signatures', async () => {
    const { read, calls } = setup();
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'account-key' })
      .sign(new Uint8Array(32));
    const missingKid = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).sign(key.privateKey);
    for (const value of [hs, missingKid, await token({}, 'unknown')]) {
      const result = await read(value);
      expect(result.statusCode).toBe(401);
      expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
    expect(calls().map(call => new URL(call.url).pathname)).toEqual(['/internal/v1/auth/jwks']);
  });

  it('allows five seconds of future issuance without extending the 600-second lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read } = setup();
    const now = Math.floor(Date.now() / 1000);
    expect((await read(await token({ iat: now + 5, exp: now + 605 }))).statusCode).toBe(200);
    for (const [iat, exp] of [[now + 6, now + 606], [now + 5, now + 606]]) {
      const result = await read(await token({ iat, exp }));
      expect(result.statusCode).toBe(401);
      expect(result.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
  });

  it('allows signed access until the expiration tolerance is exhausted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls } = setup();
    const exp = Math.floor(Date.now() / 1000) - 4;
    const access = await token({ iat: exp - 600, exp });
    expect((await read(access)).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 1000);
    const result = await read(access);
    expect(result.statusCode).toBe(401);
    expect(result.json()).toEqual({ code: 'TOKEN_EXPIRED' });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(calls().filter(call => call.url.endsWith('/authorize'))).toHaveLength(1);
  });

  it('refreshes the cached key set on rotation and expiry while authorizing every read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls, setKeys } = setup();
    const access = await token();
    expect((await read(access)).statusCode).toBe(200);
    expect((await read(access)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(1);

    const replacement = await generateKeyPair('ES256');
    const newVerifier = { ...await exportJWK(replacement.publicKey), kid: 'replacement', alg: 'ES256', use: 'sig' };
    setKeys(() => Response.json({ keys: [...jwks.keys, newVerifier] }));
    const rotated = await token({}, 'replacement', replacement.privateKey);
    expect((await read(rotated)).statusCode).toBe(200);
    expect((await read(access)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(2);

    vi.setSystemTime(Date.now() + 30_000);
    setKeys(() => Response.json({ keys: [newVerifier] }));
    const retired = await read(access);
    expect(retired.statusCode).toBe(401);
    expect(retired.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect((await read(rotated)).statusCode).toBe(200);
    expect(calls().filter(call => call.url.endsWith('/jwks'))).toHaveLength(3);
    expect(calls().filter(call => call.url.endsWith('/authorize'))).toHaveLength(5);
  });

  it('denies A/B store mismatches and staff reads even with spoofed owner headers', async () => {
    const { read, calls } = setup();
    for (const [access, requested] of [[await token(), other], [await token({ role: 'staff' }), store]]) {
      const result = await read(access, requested, { 'x-navis-store-id': requested, 'x-navis-store-role': 'owner' });
      expect(result.statusCode).toBe(403);
      expect(result.json()).toEqual({ code: 'STORE_FORBIDDEN' });
    }
    expect(calls().filter(call => call.url.includes('/authorize'))).toHaveLength(2);
    expect(calls().some(call => call.url.includes('inventory:3000'))).toBe(false);
  });

  it('asks account every time and fails closed on revocation, denial, and outage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { read, calls, setAuthorization, setKeys } = setup();
    const access = await token();
    expect((await read(access)).statusCode).toBe(200);
    for (const [status, expected, code] of [
      [401, 401, 'UNAUTHENTICATED'], [403, 403, 'STORE_FORBIDDEN'], [503, 503, 'SERVICE_UNAVAILABLE'],
      [200, 503, 'SERVICE_UNAVAILABLE'],
    ] as const) {
      setAuthorization(() => Response.json({ code }, { status }));
      const result = await read(access);
      expect(result.statusCode).toBe(expected);
      expect(result.json()).toEqual({ code });
    }
    setAuthorization(() => { throw new DOMException('Timed out', 'TimeoutError'); });
    expect((await read(access)).json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
    vi.setSystemTime(Date.now() + 30_000);
    setKeys(() => new Response(null, { status: 503 }));
    expect((await read(access)).json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
    expect(calls().filter(call => call.url.includes('inventory:3000'))).toHaveLength(1);
  });
});

describe('browser auth proxy', () => {
  it('proxies Host and Origin, plus Cookie only on refresh, and passes Set-Cookie back', async () => {
    const { app, calls, setAuth } = setup();
    const headers = {
      host: '127.0.0.1:18180', origin: 'http://127.0.0.1:18180', 'x-request-id': requestId,
      authorization: 'Bearer browser', cookie: 'navis_refresh=old', 'x-navis-store-id': other,
    };
    for (const endpoint of ['demo', 'refresh']) {
      const result = await app.inject({ method: 'POST', url: `/api/v1/auth/${endpoint}`, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ accessToken: 'browser-token', expiresIn: 600, storeId: store });
      expect(result.headers).toMatchObject({
        'cache-control': 'no-store', 'x-request-id': requestId,
        'set-cookie': ['navis_refresh=test; Path=/api/v1/auth; HttpOnly; SameSite=Strict'],
      });
      expect(calls().at(-1)?.headers).toEqual({
        host: headers.host, origin: headers.origin, authorization: 'Bearer account-workload',
        'x-request-id': requestId, ...(endpoint === 'refresh' ? { cookie: headers.cookie } : {}),
      });
    }
    setAuth(() => Response.json({ code: 'NOT_FOUND' }, { status: 404 }));
    const absent = await app.inject({ method: 'POST', url: '/api/v1/auth/demo', headers });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toEqual({ code: 'NOT_FOUND' });
  });
});
