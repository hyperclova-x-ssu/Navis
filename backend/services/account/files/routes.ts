import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { SessionClaims } from '../keys.ts';
import { currentRole, uuidPattern } from '../sessions.ts';
import { createPromoArtifacts, maxArtifactBytes, type Purpose, type Registration, type ResourceScope } from './artifacts.ts';
import type { PromoStorage } from './storage.ts';

export interface PromoFileOptions {
  marketingToken: string;
  storageDirectory: string;
  now?: () => number;
}

const internalPath = '/internal/v1/promo-artifacts';
const browserPath = '/api/v1/promo-artifacts';
const browserPurposes = ['promo_input', 'promo_output'] as const;
const workloadPurposes = [...browserPurposes, 'promo_checkpoint'] as const satisfies readonly Purpose[];
const browserTtlMs = 60_000;

const uuid = { type: 'string', pattern: uuidPattern };
const identifier = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const fileParams = object({ fileId: uuid });
const resourceBody = object({ storeId: uuid, resourceId: identifier });
const actor = object({ sid: uuid, sub: uuid, store_id: uuid, role: { enum: ['owner', 'staff'] } });

function object(properties: Record<string, object>) {
  return { type: 'object', required: Object.keys(properties), additionalProperties: false, properties };
}

const statusCodes = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  STORE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  ARTIFACT_CONFLICT: 409,
  ARTIFACT_NOT_READY: 409,
} as const;

function failure(reply: FastifyReply, code: keyof typeof statusCodes) {
  return reply.code(statusCodes[code]).send({ code });
}

function browserGrantSigner(now: () => number) {
  const secret = randomBytes(32);
  const signature = (fileId: string, value: string) => createHmac('sha256', secret)
    .update(`${fileId}.${value}`).digest('base64url');

  return {
    issue(fileId: string, storeId: string) {
      const expires = now() + browserTtlMs;
      const claims = `${storeId.toLowerCase()}.${expires}`;
      const token = `${claims}.${signature(fileId, claims)}`;
      return { url: `${browserPath}/${fileId}?grant=${token}`, expiresAt: new Date(expires).toISOString() };
    },
    verify(fileId: string, token?: string) {
      const [storeId, expires, received, ...extra] = token?.split('.') ?? [];
      if (extra.length || !storeId || !new RegExp(uuidPattern).test(storeId) ||
          !expires || !/^\d{1,16}$/.test(expires) || !received || !/^[A-Za-z0-9_-]{43}$/.test(received)) {
        return 'UNAUTHENTICATED' as const;
      }
      const expected = signature(fileId, `${storeId}.${expires}`);
      if (!timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return 'UNAUTHENTICATED' as const;
      if (Number(expires) <= now()) return 'TOKEN_EXPIRED' as const;
      return { storeId };
    },
  };
}

export function registerPromoFileRoutes(
  app: FastifyInstance,
  pool: Pool,
  storage: PromoStorage,
  { marketingToken, now = Date.now }: PromoFileOptions,
) {
  const artifacts = createPromoArtifacts(pool, storage);
  const links = browserGrantSigner(now);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expectedAuthorization = digest(`Bearer ${marketingToken}`);

  app.register(async (service) => {
    service.addHook('onRequest', async (request, reply) => {
      const authorization = request.headers.authorization;
      if (!authorization || !timingSafeEqual(digest(authorization), expectedAuthorization)) {
        return failure(reply, 'UNAUTHENTICATED');
      }
    });
    service.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxArtifactBytes },
      (_request, body, done) => done(null, body));

    service.post<{ Body: Registration }>(internalPath, {
      schema: {
        body: object({
          storeId: uuid, resourceId: identifier, artifactId: identifier,
          purpose: { enum: workloadPurposes }, mime: { type: 'string', maxLength: 32 },
          sizeBytes: { type: 'integer', minimum: 1, maximum: maxArtifactBytes },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        }),
      },
    }, async ({ body }, reply) => {
      const result = await artifacts.register(body);
      return typeof result === 'string' ? failure(reply, result) : result;
    });

    service.put<{ Params: { fileId: string }; Querystring: { storeId: string } }>(`${internalPath}/:fileId/bytes`, {
      bodyLimit: maxArtifactBytes,
      schema: { params: fileParams, querystring: object({ storeId: uuid }) },
    }, async ({ body, params, query }, reply) => {
      if (!Buffer.isBuffer(body)) return failure(reply, 'INVALID_REQUEST');
      const result = await artifacts.upload(query.storeId, params.fileId, body);
      return result ? failure(reply, result) : reply.code(204).send();
    });

    service.post<{ Params: { fileId: string }; Body: ResourceScope }>(`${internalPath}/:fileId/verify`, {
      schema: { params: fileParams, body: resourceBody },
    }, async ({ body, params }, reply) => {
      const result = await artifacts.verify(body, params.fileId);
      return typeof result === 'string' ? failure(reply, result) : result;
    });

    service.post<{ Params: { fileId: string }; Body: ResourceScope }>(`${internalPath}/:fileId/read`, {
      schema: { params: fileParams, body: resourceBody },
    }, async ({ body, params }, reply) => {
      const result = await artifacts.read(body.storeId, params.fileId, workloadPurposes, body.resourceId);
      return typeof result === 'string' ? failure(reply, result) : reply.type(result.mime).send(result.bytes);
    });

    service.post<{ Params: { fileId: string }; Body: { resourceId: string; actor: SessionClaims } }>(
      `${internalPath}/:fileId/browser-grant`, {
        schema: { params: fileParams, body: object({ resourceId: identifier, actor }) },
      }, async ({ body, params }, reply) => {
        // Marketing resolves the authorized photo or published job result before forwarding its exact file binding.
        const role = await currentRole(pool, body.actor);
        if (!role) return failure(reply, 'UNAUTHENTICATED');
        if (role !== body.actor.role) return failure(reply, 'STORE_FORBIDDEN');

        const result = await artifacts.read(body.actor.store_id, params.fileId, browserPurposes, body.resourceId);
        if (typeof result === 'string') return failure(reply, result);
        return links.issue(result.fileId, body.actor.store_id);
      });

    service.post<{ Params: { fileId: string }; Body: ResourceScope }>(`${internalPath}/:fileId/model-input`, {
      schema: { params: fileParams, body: resourceBody },
    }, async ({ body, params }, reply) => {
      const result = await artifacts.read(body.storeId, params.fileId, ['promo_input'], body.resourceId);
      if (typeof result === 'string') return failure(reply, result);
      return { mime: result.mime, base64: result.bytes.toString('base64') };
    });

    service.post<{ Body: { storeId: string } }>(`${internalPath}/cleanup`, {
      schema: { body: object({ storeId: uuid }) },
    }, async ({ body }) => artifacts.cleanup(body.storeId));
  });

  app.get<{ Params: { fileId: string }; Querystring: { grant?: string } }>(`${browserPath}/:fileId`, {
    schema: { params: fileParams, querystring: {
      type: 'object', properties: { grant: { type: 'string', maxLength: 100 } }, additionalProperties: false,
    } },
  }, async ({ params, query }, reply) => {
    reply.header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff');
    const grant = links.verify(params.fileId, query.grant);
    if (typeof grant === 'string') return failure(reply, grant);
    const result = await artifacts.read(grant.storeId, params.fileId, browserPurposes);
    return typeof result === 'string' ? failure(reply, result) : reply.type(result.mime).send(result.bytes);
  });
}
