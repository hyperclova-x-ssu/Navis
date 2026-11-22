import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import { accessTokenResponseSchema, errorResponseSchema } from '../../packages/contracts/index.ts';
import { registerAttachments } from './files/attachments.ts';
import { registerPromoInputRoutes } from './files/promo-input.ts';
import { registerPromoFileRoutes, type PromoFileOptions } from './files/routes.ts';
import { createLocalPromoStorage, withNcpPromoStorage, type PromoStorage } from './files/storage.ts';
import { normalizedLogin } from './identity.ts';
import type { SessionClaims, SigningKeys } from './keys.ts';
import { accountErrors, registerAccountRecords } from './reality/00/routes.ts';
import { readProfile } from './reality/00/settings.ts';
import { AccountError, actorFrom, invalid, record, uuid as uuidRe } from './reality/00/wire.ts';
import { changeStore, createDemoSession, currentRole, login, logout, refreshCookieName, refreshCredential, rotateRefresh, uuidPattern } from './sessions.ts';
import { inStore } from './transaction.ts';

const loopbackOrigin = 'http://127.0.0.1:18180';
const authPath = '/api/v1/auth';
const internalPath = '/internal/v1/auth';
const uuid = { type: 'string', pattern: uuidPattern } as const;
const authResponse = {
  200: accessTokenResponseSchema,
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  503: errorResponseSchema,
};
const authSchema = {
  body: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false }] },
  response: authResponse,
} as const;
const jwksSchema = {
  type: 'object',
  required: ['keys'],
  properties: {
    keys: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use'],
        properties: {
          kty: { const: 'EC' },
          crv: { const: 'P-256' },
          x: { type: 'string' },
          y: { type: 'string' },
          kid: { type: 'string' },
          alg: { const: 'ES256' },
          use: { const: 'sig' },
        },
      },
    },
  },
} as const;

interface AccountOptions {
  pool: Pool;
  keys: SigningKeys;
  gatewayToken: string;
  demoAuth?: string;
  replayDemoAuth?: boolean;
  hostedDemoAuth?: string;
  publicOrigin?: string;
  logging?: boolean;
  promoFiles?: PromoFileOptions & { storage?: PromoStorage };
  sensStoreId?: string;
  inventoryFilesToken?: string;
  posReferenceToken?: string;
  insightFilesToken?: string;
  community?: { token: string; pairs: readonly (readonly [string, string])[] };
}

type Issued = NonNullable<Awaited<ReturnType<typeof createDemoSession>>>;

function sendSession(reply: FastifyReply, issued: Issued, secure: boolean) {
  const maxAge = Math.max(0, Math.floor((issued.sessionExpiry.getTime() - Date.now()) / 1000));
  reply.header('set-cookie',
    `${refreshCookieName}=${issued.refresh}; Path=${authPath}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  return reply.send(issued.access);
}

export function createAccountApp({
  pool, keys, gatewayToken, demoAuth, replayDemoAuth, hostedDemoAuth, publicOrigin = loopbackOrigin, logging = true, promoFiles, inventoryFilesToken,
  posReferenceToken, insightFilesToken, community, sensStoreId,
}: AccountOptions) {
  const origin = new URL(publicOrigin);
  const localHttp = origin.protocol === 'http:' && origin.hostname === '127.0.0.1';
  if (origin.origin !== publicOrigin || (!localHttp && origin.protocol !== 'https:')) {
    throw new Error('Invalid account public origin');
  }
  if (!gatewayToken) throw new Error('Missing account workload credential');
  if (promoFiles && (!promoFiles.marketingToken || promoFiles.marketingToken === gatewayToken)) {
    throw new Error('Promo files require a distinct marketing workload credential');
  }
  if (sensStoreId && (!uuidRe.test(sensStoreId) || !promoFiles)) throw new Error('Invalid NCP SENS settings scope');
  if (inventoryFilesToken && (inventoryFilesToken === gatewayToken || inventoryFilesToken === promoFiles?.marketingToken)) {
    throw new Error('Menu photo verification requires a distinct inventory workload credential');
  }
  if (posReferenceToken && [gatewayToken, inventoryFilesToken, promoFiles?.marketingToken].includes(posReferenceToken)) {
    throw new Error('Custom reference verification requires a distinct POS workload credential');
  }
  if (insightFilesToken && [gatewayToken, inventoryFilesToken, posReferenceToken, promoFiles?.marketingToken].includes(insightFilesToken)) {
    throw new Error('Manual image verification requires a distinct Insight workload credential');
  }
  if (community && (!community.token
    || [gatewayToken, inventoryFilesToken, posReferenceToken, promoFiles?.marketingToken, insightFilesToken].includes(community.token))) {
    throw new Error('Community participation requires a distinct Marketing read credential');
  }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expectedAuthorization = digest(`Bearer ${gatewayToken}`);
  const secure = origin.protocol === 'https:';

  const app = createApp('account', async () => {
    await pool.query('SELECT 1 FROM account.auth_session LIMIT 0');
    await pool.query('SELECT 1 FROM account.credential LIMIT 0');
    if (promoFiles) await pool.query('SELECT 1 FROM account.file_object LIMIT 0');
  }, logging);
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  async function verifyWorkload(request: FastifyRequest, reply: FastifyReply) {
    const { authorization } = request.headers;
    if (!authorization || !timingSafeEqual(digest(authorization), expectedAuthorization)) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    }
  }

  async function verifyBrowser(request: FastifyRequest, reply: FastifyReply) {
    const site = request.headers['sec-fetch-site'];
    if (request.headers.host !== origin.host || request.headers.origin !== publicOrigin || (site && site !== 'same-origin')) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  }

  const hostedDemo = hostedDemoAuth === '1' && secure;
  const disposableDemo = replayDemoAuth && localHttp && Boolean(origin.port) && hostedDemoAuth !== '1';
  if (hostedDemo || (demoAuth === '1' && (publicOrigin === loopbackOrigin || disposableDemo))) {
    app.post(`${authPath}/demo`, { onRequest: [verifyWorkload, verifyBrowser], schema: authSchema }, async (request, reply) => {
      if (hostedDemo && request.headers['x-navis-demo-gate-verified'] !== '1') {
        return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      }
      const issued = await createDemoSession(pool, keys);
      if (!issued) return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      return sendSession(reply, issued, secure);
    });
  }

  app.post(`${authPath}/refresh`, { onRequest: [verifyWorkload, verifyBrowser], schema: authSchema }, async (request, reply) => {
    const credential = refreshCredential(request.headers.cookie);
    if (!credential) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    const issued = await rotateRefresh(pool, keys, credential.storeId, credential.tokenHash);
    if (!issued) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    return sendSession(reply, issued, secure);
  });

  const sessionOptions = { onRequest: [verifyWorkload, verifyBrowser], bodyLimit: 4096 };
  let windowEnds = 0;
  let attempts = 0;
  let activeLogins = 0;
  const attemptsByLogin = new Map<string, number>();
  app.post(`${authPath}/login`, sessionOptions, (request, reply) => accountErrors(reply, async () => {
    const { loginId: input, password } = record(request.body, ['loginId', 'password']);
    const loginId = normalizedLogin(input);
    if (!loginId || typeof password !== 'string' || !password || Buffer.byteLength(password) > 256) {
      throw new AccountError(401, 'UNAUTHENTICATED', 'BAD_CREDENTIALS');
    }
    const now = Date.now();
    if (now >= windowEnds) {
      windowEnds = now + 60_000;
      attempts = 0;
      attemptsByLogin.clear();
    }
    const prior = attemptsByLogin.get(loginId) ?? 0;
    if (attempts >= 60 || prior >= 10 || activeLogins >= 3) {
      reply.header('retry-after', activeLogins >= 3 ? '1' : String(Math.ceil((windowEnds - now) / 1000)));
      throw new AccountError(429, 'RATE_LIMITED', 'LOGIN_RATE_LIMITED');
    }
    attempts++;
    attemptsByLogin.set(loginId, prior + 1);
    activeLogins++;
    try {
      const issued = await login(pool, keys, loginId, password);
      if (!issued) throw new AccountError(401, 'UNAUTHENTICATED', 'BAD_CREDENTIALS');
      return sendSession(reply, issued, secure);
    } finally {
      activeLogins--;
    }
  }));
  app.post(`${authPath}/logout`, sessionOptions, async (request, reply) => {
    record(request.body ?? {}, []);
    const credential = refreshCredential(request.headers.cookie);
    if (credential) await logout(pool, credential);
    return reply.header('set-cookie', `${refreshCookieName}=; Path=${authPath}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`)
      .code(204).send();
  });
  app.post(`${authPath}/store`, sessionOptions, (request, reply) => accountErrors(reply, async () => {
    const actor = actorFrom(request);
    const { storeId } = record(request.body, ['storeId']);
    if (typeof storeId !== 'string' || !uuidRe.test(storeId)) throw invalid('storeId');
    const credential = refreshCredential(request.headers.cookie);
    if (!credential) throw new AccountError(401, 'UNAUTHENTICATED');
    const result = await changeStore(pool, keys, actor, credential, storeId.toLowerCase());
    if (result.status === 401) throw new AccountError(401, 'UNAUTHENTICATED');
    if (result.status === 403) throw new AccountError(403, 'STORE_FORBIDDEN');
    return sendSession(reply, result.issued, secure);
  }));

  app.get(`${internalPath}/jwks`, {
    onRequest: verifyWorkload,
    schema: { response: { 200: jwksSchema, 401: errorResponseSchema } },
  }, async () => keys.jwks);

  app.post<{ Body: SessionClaims }>(`${internalPath}/authorize`, {
    onRequest: verifyWorkload,
    schema: {
      body: {
        type: 'object',
        required: ['sid', 'sub', 'store_id', 'role'],
        additionalProperties: false,
        properties: { sid: uuid, sub: uuid, store_id: uuid, role: { type: 'string', enum: ['owner', 'staff'] } },
      },
      response: { 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 503: errorResponseSchema },
    },
  }, async (request, reply) => {
    const role = await currentRole(pool, request.body);
    if (!role) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (role !== request.body.role) return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    return reply.code(204).send();
  });
  if (promoFiles) {
    const local = createLocalPromoStorage(promoFiles.storageDirectory);
    const storage = promoFiles.storage ? withNcpPromoStorage(local, promoFiles.storage) : local;
    registerPromoFileRoutes(app, pool, storage, promoFiles);
    registerPromoInputRoutes(app, pool, promoFiles.marketingToken);
    if (sensStoreId) {
      const expected = digest(`Bearer ${promoFiles.marketingToken}`);
      app.get<{ Params: { storeId: string } }>('/internal/v1/account/stores/:storeId/sens-settings', {
        onRequest: async (req, reply) => {
          if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) {
            return reply.code(401).send({ code: 'UNAUTHENTICATED' });
          }
          if (req.params.storeId !== sensStoreId) return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
        },
      }, async (_req, reply) => {
        const profile = await inStore(pool, sensStoreId, db => readProfile(db, sensStoreId));
        if (!profile) return reply.code(404).send({ code: 'NOT_FOUND' });
        return { storeName: profile.name, ...profile.smsSettings };
      });
    }
  }
  registerAccountRecords(app, pool, verifyWorkload);
  registerAttachments(app, pool, verifyWorkload, {
    inventoryToken: inventoryFilesToken, posToken: posReferenceToken, insightToken: insightFilesToken,
  });
  if (community) {
    const expected = digest(`Bearer ${community.token}`);
    async function activeStore(storeId: string) {
      return inStore(pool, storeId, async db => {
        const { rows: [row] } = await db.query<{ storeId: string; displayName: string }>(`
          SELECT store_id AS "storeId", display_name AS "displayName" FROM account.store s WHERE store_id=$1
            AND EXISTS (SELECT 1 FROM account.store_member m WHERE m.store_id=s.store_id AND m.role='owner')`, [storeId]);
        return row;
      });
    }
    app.get<{ Params: { storeId: string } }>('/internal/v1/account/stores/:storeId/community-peers', {
      onRequest: async (req, reply) => {
        reply.header('cache-control', 'no-store');
        const credential = req.headers.authorization;
        if (!credential || !timingSafeEqual(expected, digest(credential))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      },
    }, async (req, reply) => {
      const storeId = req.params.storeId.toLowerCase();
      if (!uuidRe.test(storeId)) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const candidateIds = new Set(community.pairs.flatMap(([left, right]) => left === storeId ? [right] : right === storeId ? [left] : []));
      if (!candidateIds.size || !await activeStore(storeId)) return { items: [] };
      const peers = await Promise.all([...candidateIds].map(activeStore));
      return { items: peers.filter(Boolean) };
    });
  }
  return app;
}
