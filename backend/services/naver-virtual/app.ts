import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  PERSONA_ACCOUNT_HEADER, PERSONA_TOKEN_HEADER, personaAccountPattern, personaOperationPattern, type PersonaGrant,
} from '../../packages/naver/config/index.ts';
import type { PersonaCallback } from '../../packages/naver/transport/index.ts';
import { createPersonaClock, PERSONA_ACCOUNT_ID } from './clock.ts';
import { assertPersonaReady, PersonaEffectError, personaEffect, personaTransaction } from './db.ts';
import type { PersonaMigration } from './migrate.ts';
import type { PersonaSeedContext } from './seed.ts';

declare module 'fastify' {
  interface FastifyContextConfig { personaOperation?: string }
}

export type PersonaContext = {
  accountId(request: FastifyRequest): string;
  workload(request: FastifyRequest): string;
  providerCredential(request: FastifyRequest, name: string): string | undefined;
  transaction<T>(request: FastifyRequest, work: (client: PoolClient) => Promise<T>): Promise<T>;
  effect<T extends string | null>(request: FastifyRequest, fingerprint: string, work: (client: PoolClient) => Promise<T>):
    Promise<{ ref: T; replayed: boolean }>;
  callback: PersonaCallback;
  now(): Date;
};

export type PersonaCapability = {
  id: string;
  register(app: FastifyInstance, context: PersonaContext): void | Promise<void>;
  migrations?: readonly PersonaMigration[];
  seed?: (client: PoolClient, context: PersonaSeedContext) => Promise<void>;
};

const capabilityIds = Array.from({ length: 17 }, (_, index) => `pn${String(index + 1).padStart(2, '0')}`);

export async function loadPersonaCapabilities(required: readonly string[] = []): Promise<PersonaCapability[]> {
  if (required.some(id => !capabilityIds.includes(id))) throw new Error('Invalid required persona capability');
  const capabilities = await Promise.all(capabilityIds.map(async id => {
    const entry = new URL(`./capabilities/${id}/index.ts`, import.meta.url);
    if (!existsSync(entry)) {
      if (required.includes(id)) throw new Error(`Required persona capability ${id} is missing`);
      return undefined;
    }
    const { personaCapability } = await import(entry.href) as { personaCapability?: PersonaCapability };
    if (personaCapability?.id !== id || typeof personaCapability.register !== 'function') {
      throw new Error(`Invalid persona capability registrar ${id}`);
    }
    return personaCapability;
  }));
  return capabilities.filter(capability => capability !== undefined);
}

export type PersonaAppOptions = {
  pool: Pool;
  grants: readonly PersonaGrant[];
  capabilities: readonly PersonaCapability[];
  now?: () => Date;
  callback?: PersonaCallback;
  ready?: () => Promise<void>;
  logging?: boolean;
};

const validToken = /^[!-~]{16,512}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

function validateGrants(grants: readonly PersonaGrant[]) {
  const seen = new Set<string>();
  return grants.map(({ token, operations, ...grant }) => {
    if (!validToken.test(token) || token.includes(',') || seen.has(token)
      || !personaAccountPattern.test(grant.accountId) || !personaAccountPattern.test(grant.workload)
      || !operations.length || operations.some(operation => !personaOperationPattern.test(operation))) {
      throw new Error('Invalid or duplicate persona workload grant');
    }
    seen.add(token);
    return { ...grant, operations: new Set(operations), tokenDigest: digest(token) };
  });
}

export function createPersonaApp({ pool, grants, capabilities, now = createPersonaClock(), callback, ready, logging = true }: PersonaAppOptions) {
  const allowlist = validateGrants(grants);
  const auth = new WeakMap<FastifyRequest, { grant: (typeof allowlist)[number]; operation: string }>();
  const scope = (request: FastifyRequest) => {
    const authorized = auth.get(request);
    if (!authorized) throw new Error('Persona account scope is unavailable');
    return authorized;
  };
  const app = Fastify({
    logger: logging ? { base: { service: 'naver-virtual' } } : false,
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PersonaEffectError) return reply.code(error.statusCode).send({ code: error.code });
    const errorStatus = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500 ? errorStatus : 503;
    if (status === 503) request.log.error({ operation: request.routeOptions.config?.personaOperation }, 'Persona handler unavailable');
    return reply.code(status).send({ code: status === 503 ? 'SERVICE_UNAVAILABLE' : 'INVALID_REQUEST' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'NOT_FOUND' }));

  // Internal Navis workload probes. Provider wire schemas live with their capability registrars.
  app.get('/healthz', async () => ({ service: 'naver-virtual', status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await (ready?.() ?? assertPersonaReady(pool, PERSONA_ACCOUNT_ID, capabilities.filter(c => c.seed).map(c => c.id)));
      return { service: 'naver-virtual', status: 'ready' };
    } catch {
      return reply.code(503).send({ service: 'naver-virtual', status: 'unavailable' });
    }
  });

  const ids = new Set<string>();
  for (const capability of capabilities) {
    if (!capabilityIds.includes(capability.id) || ids.has(capability.id)) throw new Error('Invalid or duplicate persona capability');
    ids.add(capability.id);
    app.register(async router => {
      router.addHook('onRoute', route => {
        const operation = route.config?.personaOperation;
        if (!operation || !personaOperationPattern.test(operation) || !operation.startsWith(`${capability.id}.`)) {
          throw new Error(`Invalid personaOperation on ${capability.id} route`);
        }
      });
      router.addHook('onRequest', async (request, reply) => {
        const token = request.headers[PERSONA_TOKEN_HEADER];
        if (typeof token !== 'string' || !validToken.test(token) || token.includes(',')) return reply.code(401).send();
        const tokenDigest = digest(token);
        const grant = allowlist.find(candidate => timingSafeEqual(candidate.tokenDigest, tokenDigest));
        if (!grant) return reply.code(401).send();
        const operation = request.routeOptions.config.personaOperation!;
        if (request.headers[PERSONA_ACCOUNT_HEADER] !== grant.accountId || !grant.operations.has(operation)) return reply.code(403).send();
        auth.set(request, { grant, operation });
      });
      await capability.register(router, {
        accountId: request => scope(request).grant.accountId,
        workload: request => scope(request).grant.workload,
        providerCredential(request, name) {
          const { grant, operation } = scope(request);
          const credentials = grant.providerCredentials?.[operation];
          return credentials && Object.hasOwn(credentials, name) ? credentials[name] : undefined;
        },
        transaction: (request, work) => personaTransaction(pool, scope(request).grant.accountId, work),
        effect(request, fingerprint, work) {
          const { grant, operation } = scope(request);
          const key = request.headers['idempotency-key'];
          return personaEffect(pool, grant.accountId, operation, typeof key === 'string' ? key : undefined, fingerprint, work);
        },
        async callback(target, options) {
          if (!callback || !(target === 'talktalk' && capability.id === 'pn06' || target === 'aicall' && capability.id === 'pn08')) {
            throw new Error('Persona callback is unavailable in this capability');
          }
          return callback(target, options);
        },
        now,
      });
    });
  }
  return app;
}
