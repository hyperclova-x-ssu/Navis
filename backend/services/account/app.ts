import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createApp } from '../../infra/http.ts';
import { accessTokenResponseSchema, errorResponseSchema } from '../../packages/contracts/index.ts';
import { registerPromoFileRoutes, type PromoFileOptions } from './files/routes.ts';
import { createLocalPromoStorage } from './files/storage.ts';
import type { SessionClaims, SigningKeys } from './keys.ts';
import { createDemoSession, currentRole, refreshCookieName, refreshCredential, rotateRefresh, uuidPattern } from './sessions.ts';

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
  publicOrigin?: string;
  logging?: boolean;
  promoFiles?: PromoFileOptions;
}

type Issued = NonNullable<Awaited<ReturnType<typeof createDemoSession>>>;

function sendSession(reply: FastifyReply, issued: Issued, secure: boolean) {
  const maxAge = Math.max(0, Math.floor((issued.sessionExpiry.getTime() - Date.now()) / 1000));
  reply.header('set-cookie',
    `${refreshCookieName}=${issued.refresh}; Path=${authPath}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  return reply.send(issued.access);
}

export function createAccountApp({ pool, keys, gatewayToken, demoAuth, publicOrigin = loopbackOrigin, logging = true, promoFiles }: AccountOptions) {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || (publicOrigin !== loopbackOrigin && origin.protocol !== 'https:')) {
    throw new Error('Invalid account public origin');
  }
  if (!gatewayToken) throw new Error('Missing account workload credential');
  if (promoFiles && (!promoFiles.marketingToken || promoFiles.marketingToken === gatewayToken)) {
    throw new Error('Promo files require a distinct marketing workload credential');
  }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expectedAuthorization = digest(`Bearer ${gatewayToken}`);
  const secure = origin.protocol === 'https:';

  const app = createApp('account', async () => {
    await pool.query('SELECT 1 FROM account.auth_session LIMIT 0');
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
    if (request.headers.host !== origin.host || request.headers.origin !== publicOrigin) {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    }
  }

  if (demoAuth === '1' && publicOrigin === loopbackOrigin) {
    app.post(`${authPath}/demo`, { onRequest: [verifyWorkload, verifyBrowser], schema: authSchema }, async (_request, reply) => {
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
  if (promoFiles) registerPromoFileRoutes(app, pool, createLocalPromoStorage(promoFiles.storageDirectory), promoFiles);
  return app;
}
