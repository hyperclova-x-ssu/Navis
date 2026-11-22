import { timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { navisBrowserRoutes, navisChatPath, parseBrowserBodies, promoBrowserRoutes } from '../infra/browser-api.ts';
import { createApp } from '../infra/http.ts';
import {
  accessTokenResponseSchema, catalogQuerySchema, catalogResponseSchema, errorResponseSchema,
  type AccessTokenResponse, type CatalogResponse, type ErrorCode,
} from '../packages/contracts/index.ts';
import {
  accountRoutes, bookingRoutes, calendarStaffRoutes, customOrderRoutes, financeRoutes, insightRecordRoutes, inventoryRoutes,
  marketingCouponRoutes, marketingGroupRoutes, marketingLocalRoutes, marketingNoticeRoutes, marketingPromoRoutes, maxUploadBytes,
  memberPosRoutes, memberRoutes, posRoutes,
  purchaseRoutes, stockRoutes, uploadTypes,
} from './records.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errorsByStatus = { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 503: errorResponseSchema };
const authBody = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false }] } as const;
const jwtClockSkewSeconds = 5;
const jwksCacheMs = 30_000;
const edgeProofPattern = /^[a-f0-9]{64}$/;

type BrowserPost = (url: URL, headers: Headers, signal: AbortSignal, body?: string) => Promise<Response>;
type NavisRequest = (url: URL, options: {
  method: string; headers: Headers; body?: Uint8Array<ArrayBuffer>; signal: AbortSignal;
}) => Promise<Response>;
type ServiceTargets = {
  insightUrl: string; insightToken: string;
  marketingUrl: string; marketingToken: string;
};

interface GatewayOptions {
  accountUrl: string;
  inventoryUrl: string;
  accountToken: string;
  inventoryToken: string;
  pos?: { url: string; token: string; fixture?: boolean };
  customer?: { url: string; token: string };
  insightRecords?: { url: string; token: string };
  marketingRecords?: { url: string; token: string; localCommandToken?: string };
  accountOrigin?: string;
  phase3?: ServiceTargets & { smsToken: string };
  hostedDemo?: { origin: string; edgeProof: string };
  browserApis?: Pick<ServiceTargets, 'marketingUrl' | 'marketingToken'> & { origin: string; navisUrl: string };
  fetcher?: typeof fetch;
  browserPost?: BrowserPost;
  navisRequest?: NavisRequest;
  logging?: boolean;
}

// Node fetch rewrites Host to the upstream hostname. Account authorizes the
// browser using the original Host and Origin, so preserve Host on this hop.
const postBrowserAuth: BrowserPost = (url, headers, signal, body) => new Promise((resolve, reject) => {
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = send(url, { method: 'POST', headers: Object.fromEntries(headers), signal }, res => {
    const status = res.statusCode ?? 503;
    const responseHeaders = new Headers();
    for (const cookie of res.headers['set-cookie'] ?? []) responseHeaders.append('set-cookie', cookie);
    for (const name of ['content-type', 'retry-after']) {
      const value = res.headers[name];
      if (typeof value === 'string') responseHeaders.set(name, value);
    }
    const hasBody = status !== 204 && status !== 205 && status !== 304;
    if (!hasBody) res.resume();
    const stream = hasBody ? Readable.toWeb(res) as ReadableStream<Uint8Array> : null;
    resolve(new Response(stream, { status, headers: responseHeaders }));
  });
  req.once('error', reject);
  req.end(body);
});

// The standalone Navis host also checks the public Host against Origin.
const requestNavis: NavisRequest = (url, { method, headers, body, signal }) => new Promise((resolve, reject) => {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const outgoing = Object.fromEntries(headers);
  if (body) outgoing['content-length'] = String(body.byteLength);
  const req = send(url, { method, headers: outgoing, signal }, res => {
    const status = res.statusCode ?? 503;
    const responseHeaders = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    }
    const hasBody = method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
    const stream = hasBody ? Readable.toWeb(res) as ReadableStream<Uint8Array> : null;
    if (!hasBody) res.resume();
    resolve(new Response(stream, { status, headers: responseHeaders }));
  });
  req.once('error', reject);
  req.end(body);
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

function proxyResponse(reply: FastifyReply, response: Response, streaming = false, browser = false) {
  const headers = ['content-type', 'content-range', 'accept-ranges', 'retry-after', 'x-content-type-options', 'content-disposition'];
  if (browser) headers.push('allow', 'content-length', 'content-disposition', 'x-navis-protocol', 'x-navis-agent-mode');
  for (const name of headers) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  if (browser) {
    const cookies = response.headers.getSetCookie().filter(cookie => cookie.startsWith('navis_demo_session='));
    if (cookies.length) reply.header('set-cookie', cookies);
  }
  if (streaming) reply.header('x-accel-buffering', 'no');
  reply.code(response.status);
  return response.body ? reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)) : reply.send();
}

export function createGateway({
  accountUrl, accountToken, inventoryUrl, inventoryToken, pos, customer, insightRecords, marketingRecords,
  accountOrigin, phase3, hostedDemo, browserApis, fetcher = fetch,
  browserPost = postBrowserAuth, navisRequest = requestNavis, logging = true,
}: GatewayOptions) {
  const account = new URL(accountUrl);
  const inventory = new URL(inventoryUrl);
  const posUrl = pos && new URL(pos.url);
  const customerUrl = customer && new URL(customer.url);
  const insightRecordsUrl = insightRecords && new URL(insightRecords.url);
  const marketingRecordsUrl = marketingRecords && new URL(marketingRecords.url);
  const origin = new URL(accountOrigin ?? hostedDemo?.origin ?? browserApis?.origin ?? 'http://127.0.0.1:18180');
  const demoOrigin = hostedDemo && new URL(hostedDemo.origin);
  if (hostedDemo && (demoOrigin?.protocol !== 'https:' || demoOrigin.origin !== hostedDemo.origin
    || !edgeProofPattern.test(hostedDemo.edgeProof))) {
    throw new Error('Hosted demo requires an exact HTTPS origin and a valid edge proof file');
  }
  const expectedProof = hostedDemo && Buffer.from(hostedDemo.edgeProof, 'hex');
  const insight = phase3 && new URL(phase3.insightUrl);
  const marketing = phase3 && new URL(phase3.marketingUrl);
  const request = (upstream: URL, path: string, init: RequestInit = {}) => fetcher(new URL(path, upstream), {
    ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(2_000),
  });
  const dependencies = new Set([account.href, inventory.href]);
  if (posUrl) dependencies.add(posUrl.href);
  if (insightRecordsUrl) dependencies.add(insightRecordsUrl.href);
  if (marketingRecordsUrl) dependencies.add(marketingRecordsUrl.href);
  if (insight && marketing) {
    dependencies.add(insight.href);
    dependencies.add(marketing.href);
  }
  const app = createApp('api-gateway', async () => {
    await Promise.all(Array.from(dependencies, async upstream => {
      const response = await request(new URL(upstream), '/readyz');
      await response.body?.cancel();
      if (!response.ok) throw new Error('Upstream unavailable');
    }));
  }, logging);

  app.addHook('onRequest', async (_req, reply) => { reply.header('cache-control', 'no-store'); });

  // Allowlist headers per hop. The browser never supplies a workload credential or store context.
  const workloadHeaders = (credential: string, requestId: string) => ({
    authorization: `Bearer ${credential}`, 'x-request-id': requestId,
  });

  if (browserApis) {
    const publicOrigin = new URL(browserApis.origin);
    const loopbackHttp = publicOrigin.protocol === 'http:' && publicOrigin.hostname === '127.0.0.1';
    if (browserApis.origin !== publicOrigin.origin || (!loopbackHttp && publicOrigin.protocol !== 'https:')) {
      throw new Error('Invalid public origin for browser API');
    }
    const workloads = [
      { routes: navisBrowserRoutes, upstream: new URL(browserApis.navisUrl), navis: true },
      { routes: promoBrowserRoutes, upstream: new URL(browserApis.marketingUrl), token: browserApis.marketingToken, navis: false },
    ] as const;
    app.register(async routes => {
      parseBrowserBodies(routes);
      // These fixture endpoints sit behind the edge password gate. Fetch Metadata and
      // an exact public Host/Origin are required at this hop for browser requests.
      routes.addHook('onRequest', async (req, reply) => {
        const { host, origin, 'sec-fetch-site': site } = req.headers;
        const read = req.method === 'GET' || req.method === 'HEAD';
        const sameOrigin = origin === publicOrigin.origin
          || (origin === undefined && read && site === 'same-origin');
        if (host !== publicOrigin.host || (site !== undefined && site !== 'same-origin') || !sameOrigin) {
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
      });
      for (const workload of workloads) {
        const { routes: endpoints, upstream, navis } = workload;
        for (const endpoint of endpoints) {
          routes.route<{ Body?: Buffer }>({
            ...endpoint, exposeHeadRoute: false,
            async handler(req, reply) {
              const path = req.url.split('?', 1)[0];
              if (!/^\/api\/(navis|promo)(\/[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)+$/i.test(path)) {
                return reject(reply, 400, 'INVALID_REQUEST');
              }
              const headers = new Headers(navis
                ? { host: publicOrigin.host, 'x-request-id': req.id }
                : workloadHeaders(workload.token, req.id));
              for (const name of ['origin', 'content-type', 'x-navis-protocol', 'range', 'idempotency-key']) {
                const value = req.headers[name];
                if (typeof value === 'string') headers.set(name, value);
              }
              if (navis) {
                if (req.headers['sec-fetch-site'] === 'same-origin') headers.set('sec-fetch-site', 'same-origin');
                const session = req.headers.cookie?.split(';').map(cookie => cookie.trim())
                  .find(cookie => cookie.startsWith('navis_demo_session='));
                if (session) headers.set('cookie', session);
              }
              const controller = new AbortController();
              const streaming = path === navisChatPath;
              const timeout = streaming ? 180_000 : path.startsWith('/api/navis/media/') ? 45_000 : 10_000;
              let timer: ReturnType<typeof setTimeout>;
              const renewTimeout = () => {
                clearTimeout(timer);
                timer = setTimeout(() => controller.abort(), timeout).unref();
              };
              const cancel = () => { clearTimeout(timer); controller.abort(); };
              reply.raw.once('close', cancel);
              renewTimeout();
              try {
                const options = {
                  method: req.method, headers, signal: controller.signal,
                  body: req.body ? new Uint8Array(req.body) : undefined,
                };
                const response = navis
                  ? await navisRequest(new URL(req.url, upstream), options)
                  : await request(upstream, req.url, options);
                if (streaming && response.body) {
                  const body = response.body.pipeThrough(new TransformStream({
                    transform(chunk, stream) { renewTimeout(); stream.enqueue(chunk); },
                  }));
                  return proxyResponse(reply, new Response(body, response), true, true);
                }
                return proxyResponse(reply, response, false, true);
              } catch (error) {
                cancel();
                throw error;
              }
            },
          });
        }
      }
    });
  }

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
    app.post(path, { schema: { body: authBody, response: { 200: accessTokenResponseSchema, 404: errorResponseSchema, ...errorsByStatus } } }, async (req, reply) => {
      const headers = new Headers(workloadHeaders(accountToken, req.id));
      if (req.headers.host) headers.set('host', req.headers.host);
      if (req.headers.origin) headers.set('origin', req.headers.origin);
      if (endpoint === 'refresh' && req.headers.cookie) headers.set('cookie', req.headers.cookie);
      if (endpoint === 'demo' && demoOrigin && expectedProof) {
        const proof = req.headers['x-navis-edge-demo-proof'];
        if (req.headers.host !== demoOrigin.host || req.headers.origin !== demoOrigin.origin
          || typeof proof !== 'string' || !edgeProofPattern.test(proof)
          || !timingSafeEqual(Buffer.from(proof, 'hex'), expectedProof)) {
          return reject(reply, 403, 'STORE_FORBIDDEN');
        }
        // Reissue the assertion on the authenticated account hop. Never forward the edge proof.
        headers.set('x-navis-demo-gate-verified', '1');
      }

      const response = await browserPost(new URL(path, account), headers, AbortSignal.timeout(2_000));
      if (response.status === 200) {
        const credentials: AccessTokenResponse = await response.json();
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(credentials);
      }
      await response.body?.cancel();
      if (response.status === 404 && endpoint === 'demo') return reject(reply, 404, 'NOT_FOUND');
      if (response.status === 400) return reject(reply, 400, 'INVALID_REQUEST');
      if (response.status === 401) return reject(reply, 401, 'UNAUTHENTICATED');
      if (response.status === 403) return reject(reply, 403, 'STORE_FORBIDDEN');
      return reject(reply, 503, 'SERVICE_UNAVAILABLE');
    });
  }

  async function authenticate(req: FastifyRequest, reply: FastifyReply, storeId?: string, ownerOnly = true) {
    const deny = (status: number, code: ErrorCode) => { reject(reply, status, code); return null; };
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1];
    let kid: string;
    try {
      if (!bearer) return deny(401, 'UNAUTHENTICATED');
      const header = decodeProtectedHeader(bearer);
      if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !header.kid) {
        return deny(401, 'UNAUTHENTICATED');
      }
      kid = header.kid;
    } catch {
      return deny(401, 'UNAUTHENTICATED');
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
        return deny(401, 'TOKEN_EXPIRED');
      }
      return deny(401, 'UNAUTHENTICATED');
    }
    if (!claims) return deny(401, 'UNAUTHENTICATED');

    const decision = await request(account, '/internal/v1/auth/authorize', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(claims),
    });
    await decision.body?.cancel();
    if (decision.status === 401) return deny(401, 'UNAUTHENTICATED');
    if (decision.status === 403) return deny(403, 'STORE_FORBIDDEN');
    if (decision.status !== 204) return deny(503, 'SERVICE_UNAVAILABLE');
    if ((ownerOnly && claims.role !== 'owner') || (storeId && claims.store_id.toLowerCase() !== storeId.toLowerCase())) {
      return deny(403, 'STORE_FORBIDDEN');
    }

    return claims;
  }

  const sameOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    const { host, origin: supplied, 'sec-fetch-site': site } = req.headers;
    const validOrigin = supplied === origin.origin || (req.method === 'GET' && supplied === undefined && site === 'same-origin');
    if (host !== origin.host || (site !== undefined && site !== 'same-origin') || !validOrigin) {
      return reject(reply, 403, 'STORE_FORBIDDEN');
    }
  };
  const actorHeaders = (claims: NonNullable<Awaited<ReturnType<typeof authenticate>>>, credential: string, req: FastifyRequest) => ({
    ...workloadHeaders(credential, req.id),
    'x-navis-store-id': claims.store_id.toLowerCase(), 'x-navis-store-role': claims.role,
    'x-navis-user-id': claims.sub, 'x-navis-session-id': claims.sid,
  });

  for (const endpoint of ['login', 'logout', 'store'] as const) {
    const path = `/api/v1/auth/${endpoint}`;
    app.post(path, { onRequest: sameOrigin, bodyLimit: 4096 }, async (req, reply) => {
      const claims = endpoint === 'store' ? await authenticate(req, reply, undefined, false) : undefined;
      if (endpoint === 'store' && !claims) return reply;
      const headers = new Headers(claims ? actorHeaders(claims, accountToken, req) : workloadHeaders(accountToken, req.id));
      headers.set('host', origin.host);
      headers.set('origin', origin.origin);
      const cookies = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith('navis_refresh='));
      if (endpoint !== 'login' && cookies?.length) headers.set('cookie', cookies.join('; '));
      if (req.body !== undefined) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reject(reply, 400, 'INVALID_REQUEST');
        headers.set('content-type', 'application/json');
      }
      const response = await browserPost(new URL(path, account), headers, AbortSignal.timeout(4_000),
        req.body === undefined ? undefined : JSON.stringify(req.body));
      const refreshCookies = response.headers.getSetCookie().filter(cookie => cookie.startsWith('navis_refresh='));
      if (refreshCookies.length) reply.header('set-cookie', refreshCookies);
      return proxyResponse(reply, response);
    });
  }

  app.get('/api/v1/stores', { onRequest: sameOrigin }, async (req, reply) => {
    const claims = await authenticate(req, reply, undefined, false);
    if (!claims) return reply;
    const response = await request(account, '/internal/v1/account/stores', { headers: actorHeaders(claims, accountToken, req) });
    return proxyResponse(reply, response);
  });

  for (const type of uploadTypes) app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const recordTargets = [
    { service: 'account', prefix: '', upstream: account, token: accountToken, routes: accountRoutes, clock: 'none' },
    { service: 'inventory', prefix: '/inventory', upstream: inventory, token: inventoryToken, routes: inventoryRoutes, clock: 'none' },
    { service: 'inventory', prefix: '/inventory', upstream: inventory, token: inventoryToken,
      routes: [...stockRoutes, ...purchaseRoutes], clock: 'all' },
    ...(pos && posUrl && !pos.fixture ? [
      { service: 'pos', prefix: '/pos', upstream: posUrl, token: pos.token, routes: [...posRoutes, ...memberPosRoutes], clock: 'writes' },
      { service: 'pos', prefix: '/pos', upstream: posUrl, token: pos.token, routes: [...financeRoutes, ...customOrderRoutes], clock: 'all' },
    ] : []),
    ...(customer && customerUrl ? [{ service: 'customer', prefix: '', upstream: customerUrl, token: customer.token,
      routes: [...calendarStaffRoutes, ...memberRoutes, ...bookingRoutes], clock: 'all' }] : []),
    ...(insightRecords && insightRecordsUrl ? [{ service: 'insight', prefix: '', upstream: insightRecordsUrl,
      token: insightRecords.token, routes: insightRecordRoutes, clock: 'all' }] : []),
    ...(marketingRecords && marketingRecordsUrl ? [
      { service: 'marketing', prefix: '', upstream: marketingRecordsUrl, token: marketingRecords.token,
        routes: marketingPromoRoutes, clock: 'none' },
      { service: 'marketing', prefix: '/marketing', upstream: marketingRecordsUrl, token: marketingRecords.token,
        routes: [...marketingNoticeRoutes, ...marketingGroupRoutes, ...marketingCouponRoutes,
          ...marketingLocalRoutes.filter(([method]) => method === 'GET')], clock: 'all' },
      ...(marketingRecords.localCommandToken ? [{
        service: 'marketing', prefix: '/marketing', upstream: marketingRecordsUrl, token: marketingRecords.localCommandToken,
        routes: marketingLocalRoutes.filter(([method]) => method !== 'GET'), clock: 'all',
      }] : []),
    ] : []),
  ];
  for (const { service, prefix, upstream, token, routes, clock } of recordTargets) {
    for (const [method, suffix] of routes) {
      const upload = method === 'PUT' && suffix.endsWith('/content');
      const ownerOnly = service !== 'account' || suffix.startsWith('/files') || (method !== 'GET' && suffix !== '/preferences');
      app.route<{ Params: { storeId: string } & Record<string, string> }>({
        method, url: `/api/v1/stores/:storeId${prefix}${suffix}`, exposeHeadRoute: false, onRequest: sameOrigin,
        bodyLimit: upload ? maxUploadBytes : (service === 'insight' ? 192 : 128) * 1024,
        async handler(req, reply) {
          const { storeId, ...params } = req.params;
          const selector = suffix === '/insight/financial-center/recommendations/:ref' ? /^[a-z0-9_-]{1,64}$/i
            : service === 'pos' && suffix.startsWith('/naver/') ? /^[a-z0-9_~-][a-z0-9_.~-]{0,159}$/i
            : service === 'marketing' ? /^[a-z0-9_][a-z0-9_.:-]{0,127}$/i : service === 'customer' && suffix.startsWith('/reservations/')
            ? /^[a-z0-9-][a-z0-9_-]{0,79}$/i
            : /^[a-z0-9-][a-z0-9.-]{0,79}$/i;
          if (!uuid.test(storeId) || Object.values(params).some(value => !selector.test(value))) {
            return reject(reply, 400, 'INVALID_REQUEST');
          }
          const claims = await authenticate(req, reply, storeId, ownerOnly);
          if (!claims) return reply;
          const store = claims.store_id.toLowerCase();
          const headers = new Headers(actorHeaders(claims, token, req));
          const photoContent = service === 'marketing' && suffix === '/marketing/photos/:photoId/content';
          const referenceMedia = service === 'marketing' && suffix === '/promo/references/:referenceId/:asset';
          const cctvSample = service === 'insight' && suffix === '/insight/cctv-samples/:asset';
          const cacheableMedia = photoContent || referenceMedia || cctvSample;
          if (((service === 'marketing' && suffix.endsWith('/video.mp4')) || referenceMedia || cctvSample)
            && typeof req.headers.range === 'string') {
            headers.set('range', req.headers.range);
          }
          if (cacheableMedia && typeof req.headers['if-none-match'] === 'string') {
            headers.set('if-none-match', req.headers['if-none-match']);
          }
          const key = req.headers['idempotency-key'];
          if (typeof key === 'string') headers.set('idempotency-key', key);
          let body: string | Uint8Array<ArrayBuffer> | undefined;
          if (req.body !== undefined) {
            const type = req.headers['content-type']?.split(';')[0];
            if (upload && type && uploadTypes.includes(type) && Buffer.isBuffer(req.body)) body = new Uint8Array(req.body);
            else if (!upload && type === 'application/json') body = JSON.stringify(req.body);
            else return reject(reply, 400, 'INVALID_REQUEST');
            headers.set('content-type', type!);
          }
          const query = req.url.split('?').slice(1).join('?');
          if (query.length > 4096) return reject(reply, 400, 'INVALID_REQUEST');
          if (service === 'insight' && (suffix === '/insight/table-links' || suffix === '/insight/zones/:id/table-link')) {
            const profileResponse = await request(account, `/internal/v1/account/stores/${store}/profile`,
              { headers: actorHeaders(claims, accountToken, req) });
            if (!profileResponse.ok) return proxyResponse(reply, profileResponse);
            const { paymentStyle, businessType, tableLayout, posPreferences } = await profileResponse.json();
            const tableMode = paymentStyle === 'postpaid' && ['cafe', 'restaurant', 'pub'].includes(businessType)
              && Boolean(tableLayout) && posPreferences?.showTables !== false;
            headers.set('x-navis-pos-tables-enabled', tableMode ? '1' : '0');
          }
          if (clock === 'all' || (clock === 'writes' && method !== 'GET')) {
            const clockResponse = await request(account, `/internal/v1/account/stores/${store}/operating-clock`,
              { headers: actorHeaders(claims, accountToken, req) });
            if (!clockResponse.ok) return proxyResponse(reply, clockResponse);
            const { timezone, businessDayStart } = await clockResponse.json();
            if (typeof timezone !== 'string' || typeof businessDayStart !== 'string') return reject(reply, 503, 'SERVICE_UNAVAILABLE');
            headers.set('x-navis-store-timezone', timezone);
            headers.set('x-navis-business-day-start', businessDayStart);
          }
          const path = suffix.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name]));
          const timeout = suffix === '/inquiries/:id/navis-draft-preview' ? 12_500 : 7_000;
          const response = await request(upstream, `/internal/v1/${service}/stores/${store}${path}${query ? `?${query}` : ''}`, {
            method, headers, body, signal: AbortSignal.timeout(timeout),
          });
          if (cacheableMedia && [200, 206, 304].includes(response.status)) {
            for (const name of ['content-length', 'etag', 'vary']) {
              const value = response.headers.get(name);
              if (value !== null) reply.header(name, value);
            }
            const cache = response.headers.get('cache-control');
            if (cache?.startsWith('private,')) reply.header('cache-control', cache);
          }
          if ((service === 'insight' || service === 'marketing') && response.status >= 400 && response.status < 500
            && response.headers.get('content-type')?.startsWith('application/json')) {
            const failure = await response.clone().json().catch(() => null);
            if (typeof failure?.code === 'string' && failure.reason === undefined) {
              await response.body?.cancel();
              const reason = suffix.startsWith('/marketing/promo/') && failure.code === 'REVISION_CONFLICT' ? 'STALE_REVISION' : failure.code;
              return proxyResponse(reply, Response.json({ ...failure, reason }, {
                status: response.status, headers: response.headers,
              }));
            }
          }
          return proxyResponse(reply, response);
        },
      });
    }
  }

  app.get<{ Querystring: { storeId: string } }>('/api/v1/inventory/catalog', {
    schema: { querystring: catalogQuerySchema, response: { 200: catalogResponseSchema, ...errorsByStatus } },
  }, async (req, reply) => {
    const claims = await authenticate(req, reply, req.query.storeId);
    if (!claims) return reply;
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

  if (phase3 && insight && marketing) {
    const root = '/api/v1/stores/:storeId';
    const endpoints = [
      { method: 'POST', path: '/navis/chat', upstream: insight, service: 'insight', token: phase3.insightToken, sse: true },
      { method: 'POST', path: '/navis/proposals/:proposalId/confirm', upstream: insight, service: 'insight', token: phase3.insightToken },
      { method: 'GET', path: '/briefing/cctv', upstream: insight, service: 'insight', token: phase3.insightToken },
      ...(!marketingRecords ? [
        { method: 'GET', path: '/promo/jobs/:jobId', upstream: marketing, service: 'marketing', token: phase3.marketingToken },
        { method: 'GET', path: '/promo/jobs/:jobId/video.mp4', upstream: marketing, service: 'marketing', token: phase3.marketingToken, video: true },
      ] as const : []),
      { method: 'GET', path: '/sens/test-card', upstream: marketing, service: 'marketing', token: phase3.marketingToken },
      { method: 'POST', path: '/sens/attempts', upstream: marketing, service: 'marketing', token: phase3.smsToken, sms: true },
      { method: 'GET', path: '/sens/attempts/:receiptId', upstream: marketing, service: 'marketing', token: phase3.marketingToken },
      { method: 'GET', path: '/forecasts/:targetDate/:modelVersion', upstream: inventory, service: 'inventory', token: inventoryToken },
    ] as const;

    for (const route of endpoints) {
      app.route<{ Params: { storeId: string } & Record<string, string> }>({
        method: route.method, url: root + route.path,
        bodyLimit: 'sse' in route ? 256 * 1024 : 16 * 1024,
        async handler(req, reply) {
          const { storeId, ...params } = req.params;
          if (!uuid.test(storeId)) return reject(reply, 400, 'INVALID_REQUEST');
          const claims = await authenticate(req, reply, storeId);
          if (!claims) return reply;

          // Match complete path segments and constrain their alphabet before building the private URL.
          if (Object.values(params).some(value => !/^[a-zA-Z0-9-][a-zA-Z0-9.-]{0,79}$/.test(value))) {
            return reject(reply, 400, 'INVALID_REQUEST');
          }
          const path = route.path.replace(/:(\w+)/g, (_, key: string) => encodeURIComponent(params[key]));
          const headers = new Headers({
            ...workloadHeaders(route.token, req.id), 'x-navis-store-id': claims.store_id,
            'x-navis-store-role': claims.role, 'x-navis-user-id': claims.sub,
          });
          if (route.method === 'POST') {
            if (req.body === undefined || req.headers['content-type']?.split(';')[0] !== 'application/json') {
              return reject(reply, 400, 'INVALID_REQUEST');
            }
            headers.set('content-type', 'application/json');
          }
          if ('sms' in route) {
            const card = req.body as { source?: unknown; proposalId?: unknown } | null;
            if (card?.source !== 'card' || typeof card.proposalId !== 'string' || !uuid.test(card.proposalId)) {
              return reject(reply, 400, 'INVALID_REQUEST');
            }
            headers.set('idempotency-key', `navis:${card.proposalId}`);
          }
          if ('sse' in route) {
            if (req.headers['x-navis-protocol'] !== 'agent-v1') return reject(reply, 400, 'INVALID_REQUEST');
            headers.set('x-navis-protocol', 'agent-v1');
          }
          if ('video' in route && req.headers.range) headers.set('range', req.headers.range);

          const downstream = new AbortController();
          reply.raw.once('close', () => downstream.abort());
          const signal = AbortSignal.any([downstream.signal, AbortSignal.timeout('sse' in route ? 65_000 : 5_000)]);
          const download = 'video' in route && new URLSearchParams(req.url.split('?')[1]).get('download') === '1';
          const response = await request(route.upstream, `/internal/v1/${route.service}/stores/${claims.store_id}${path}${download ? '?download=1' : ''}`, {
            method: route.method, headers, signal,
            body: route.method === 'POST' ? JSON.stringify(req.body) : undefined,
          });
          return proxyResponse(reply, response, 'sse' in route);
        },
      });
    }

    app.post('/api/v1/insight/cctv/aggregates', async (req, reply) => {
      const authorization = req.headers.authorization;
      if (!authorization || !/^Bearer [^\s,]{1,512}$/i.test(authorization)) return reject(reply, 401, 'UNAUTHENTICATED');
      if (req.body === undefined || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return reject(reply, 400, 'INVALID_REQUEST');
      }
      const response = await request(insight, '/internal/v1/insight/cctv/aggregates', {
        method: 'POST', headers: { authorization, 'x-request-id': req.id, 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      return proxyResponse(reply, response);
    });
  }

  return app;
}
