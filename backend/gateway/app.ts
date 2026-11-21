import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { createApp } from '../infra/http.ts';
import {
  accessTokenResponseSchema, catalogQuerySchema, catalogResponseSchema, errorResponseSchema,
  type AccessTokenResponse, type CatalogResponse, type ErrorCode,
} from '../packages/contracts/index.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorsByStatus = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 503: errorResponseSchema };
const authBody = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false }] } as const;
const jwtClockSkewSeconds = 5;
const jwksCacheMs = 30_000;

type BrowserPost = (url: URL, headers: Headers, signal: AbortSignal) => Promise<Response>;

interface GatewayOptions {
  accountUrl: string;
  inventoryUrl: string;
  accountToken: string;
  inventoryToken: string;
  fetcher?: typeof fetch;
  browserPost?: BrowserPost;
  logging?: boolean;
}

// Node fetch rewrites Host to the upstream hostname. Account authorizes the
// browser using the original Host and Origin, so preserve Host on this hop.
const postBrowserAuth: BrowserPost = (url, headers, signal) => new Promise((resolve, reject) => {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = send(url, { method: 'POST', headers: Object.fromEntries(headers), signal }, res => {
    const status = res.statusCode ?? 503;
    if (status !== 200) {
      res.destroy();
      resolve(new Response(null, { status: status >= 200 && status <= 599 ? status : 503 }));
      return;
    }
    const responseHeaders = new Headers();
    for (const cookie of res.headers['set-cookie'] ?? []) responseHeaders.append('set-cookie', cookie);
    const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
    resolve(new Response(body, { status, headers: responseHeaders }));
  });
  req.once('error', reject);
  req.end();
});

function sessionClaims({ sid, sub, store_id, role, iat, exp }: JWTPayload, now: number) {
  if (typeof sid !== 'string' || !uuid.test(sid) || typeof sub !== 'string' || !uuid.test(sub)
    || typeof store_id !== 'string' || !uuid.test(store_id) || (role !== 'owner' && role !== 'staff')
    || typeof iat !== 'number' || !Number.isSafeInteger(iat) || iat > now + jwtClockSkewSeconds
    || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > 600) return null;
  return { sub, sid, store_id, role };
}

function reject(reply: FastifyReply, status: number, code: ErrorCode) {
  return reply.code(status).send({ code });
}

export function createGateway({
  accountUrl, accountToken, inventoryUrl, inventoryToken, fetcher = fetch, browserPost = postBrowserAuth, logging = true,
}: GatewayOptions) {
  const account = new URL(accountUrl);
  const inventory = new URL(inventoryUrl);
  const request = (upstream: URL, path: string, init: RequestInit = {}) => fetcher(new URL(path, upstream), {
    ...init, redirect: 'error', signal: AbortSignal.timeout(2_000),
  });
  const app = createApp('api-gateway', async () => {
    await Promise.all([account, inventory].map(async upstream => {
      const response = await request(upstream, '/readyz');
      await response.body?.cancel();
      if (!response.ok) throw new Error('Upstream unavailable');
    }));
  }, logging);

  app.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'no-store'); });

  // Allowlist headers per hop. The browser never supplies a workload credential or store context.
  const workloadHeaders = (credential: string, requestId: string) => ({
    authorization: `Bearer ${credential}`, 'x-request-id': requestId,
  });

  type ResolveKey = ReturnType<typeof createLocalJWKSet>;
  let cachedJwks: { resolveKey: ResolveKey; kids: Set<string | undefined>; expiresAt: number } | undefined;
  let pendingJwks: Promise<ResolveKey> | undefined;

  function verificationKeys(kid: string, headers: HeadersInit) {
    if (cachedJwks && Date.now() < cachedJwks.expiresAt && cachedJwks.kids.has(kid)) {
      return cachedJwks.resolveKey;
    }
    return pendingJwks ??= (async () => {
      const response = await request(account, '/internal/v1/auth/jwks', { method: 'GET', headers });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('Account JWKS unavailable');
      }
      const jwks: JSONWebKeySet = await response.json();
      const resolveKey = createLocalJWKSet(jwks);
      cachedJwks = { resolveKey, kids: new Set(jwks.keys.map(key => key.kid)), expiresAt: Date.now() + jwksCacheMs };
      return resolveKey;
    })().finally(() => { pendingJwks = undefined; });
  }

  for (const endpoint of ['demo', 'refresh'] as const) {
    const path = `/api/v1/auth/${endpoint}`;
    app.post(path, { schema: { body: authBody, response: { 200: accessTokenResponseSchema, ...errorsByStatus } } }, async (req, reply) => {
      const headers = new Headers(workloadHeaders(accountToken, req.id));
      if (req.headers.host) headers.set('host', req.headers.host);
      if (req.headers.origin) headers.set('origin', req.headers.origin);
      if (endpoint === 'refresh' && req.headers.cookie) headers.set('cookie', req.headers.cookie);

      const response = await browserPost(new URL(path, account), headers, AbortSignal.timeout(2_000));
      if (response.status === 200) {
        const credentials: AccessTokenResponse = await response.json();
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(credentials);
      }
      await response.body?.cancel();
      if (response.status === 404 && endpoint === 'demo') return reply.code(404).send({ code: 'NOT_FOUND' });
      if (response.status === 400) return reject(reply, 400, 'INVALID_REQUEST');
      if (response.status === 401) return reject(reply, 401, 'UNAUTHENTICATED');
      if (response.status === 403) return reject(reply, 403, 'STORE_FORBIDDEN');
      return reject(reply, 503, 'SERVICE_UNAVAILABLE');
    });
  }

  app.get<{ Querystring: { storeId: string } }>('/api/v1/inventory/catalog', {
    schema: { querystring: catalogQuerySchema, response: { 200: catalogResponseSchema, ...errorsByStatus } },
  }, async (req, reply) => {
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1];
    let kid: string;
    try {
      if (!bearer) return reject(reply, 401, 'UNAUTHENTICATED');
      const header = decodeProtectedHeader(bearer);
      if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid) {
        return reject(reply, 401, 'UNAUTHENTICATED');
      }
      kid = header.kid;
    } catch {
      return reject(reply, 401, 'UNAUTHENTICATED');
    }

    const headers = workloadHeaders(accountToken, req.id);
    const resolveKey = await verificationKeys(kid, headers);
    const currentDate = new Date();
    const now = Math.floor(currentDate.getTime() / 1_000);
    let claims;
    try {
      const { payload } = await jwtVerify(bearer, resolveKey, {
        algorithms: ['ES256'], issuer: 'navis-account', audience: 'navis-api', currentDate, clockTolerance: jwtClockSkewSeconds,
      });
      claims = sessionClaims(payload, now);
    } catch (error) {
      if (error instanceof errors.JWTExpired && sessionClaims(error.payload, now)) {
        return reject(reply, 401, 'TOKEN_EXPIRED');
      }
      return reject(reply, 401, 'UNAUTHENTICATED');
    }
    if (!claims) return reject(reply, 401, 'UNAUTHENTICATED');

    const decision = await request(account, '/internal/v1/auth/authorize', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(claims),
    });
    await decision.body?.cancel();
    if (decision.status === 401) return reject(reply, 401, 'UNAUTHENTICATED');
    if (decision.status === 403) return reject(reply, 403, 'STORE_FORBIDDEN');
    if (decision.status !== 204) return reject(reply, 503, 'SERVICE_UNAVAILABLE');
    if (claims.role !== 'owner' || claims.store_id.toLowerCase() !== req.query.storeId.toLowerCase()) {
      return reject(reply, 403, 'STORE_FORBIDDEN');
    }

    const query = new URLSearchParams({ storeId: claims.store_id });
    const response = await request(inventory, `/internal/v1/inventory/catalog?${query}`, {
      method: 'GET',
      headers: {
        ...workloadHeaders(inventoryToken, req.id), 'x-navis-store-id': claims.store_id, 'x-navis-store-role': claims.role,
      },
    });
    if (response.status === 200) {
      const catalog: CatalogResponse = await response.json();
      return reply.send(catalog);
    }
    await response.body?.cancel();
    if (response.status === 400) return reject(reply, 400, 'INVALID_REQUEST');
    if (response.status === 403) return reject(reply, 403, 'STORE_FORBIDDEN');
    return reject(reply, 503, 'SERVICE_UNAVAILABLE');
  });

  return app;
}
