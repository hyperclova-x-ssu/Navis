import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { createPersonaCallback } from '../../../../packages/naver/transport/index.ts';
import { createPersonaApp, type PersonaCapability } from '../../../naver-virtual/app.ts';
import { personaCapability as pn03 } from '../../../naver-virtual/capabilities/pn03/index.ts';
import { personaCapability as pn04 } from '../../../naver-virtual/capabilities/pn04/index.ts';
import { personaCapability as pn05 } from '../../../naver-virtual/capabilities/pn05/index.ts';
import { personaCapability as pn06 } from '../../../naver-virtual/capabilities/pn06/index.ts';
import { personaCapability as pn07 } from '../../../naver-virtual/capabilities/pn07/index.ts';
import { personaCapability as pn10 } from '../../../naver-virtual/capabilities/pn10/index.ts';
import { personaCapability as pn11 } from '../../../naver-virtual/capabilities/pn11/index.ts';
import { personaCapability as pn12 } from '../../../naver-virtual/capabilities/pn12/index.ts';
import { personaCapability as pn13 } from '../../../naver-virtual/capabilities/pn13/index.ts';
import { personaCapability as pn14 } from '../../../naver-virtual/capabilities/pn14/index.ts';
import { personaCapability as pn16 } from '../../../naver-virtual/capabilities/pn16/index.ts';
import { personaCapability as pn17 } from '../../../naver-virtual/capabilities/pn17/index.ts';
import { PERSONA_ACCOUNT_ID } from '../../../naver-virtual/clock.ts';
import { migratePersona } from '../../../naver-virtual/migrate.ts';
import { createPersonaSeedContext, seedPersona } from '../../../naver-virtual/seed.ts';
import { createMarketingProvider, OPERATIONS, type OperationId } from '../binding.ts';
import { registerTalkTalkInbound, type InboundEvent } from '../pn06-talktalk.ts';

/**
 * Runs the committed naver-virtual provider (PN-P0..P5 registrars, migrations and seed) against a
 * disposable PostgreSQL for PN-A2 integration tests and the Compose proof. Synthetic grants only.
 */
export const FIXED_NOW = new Date('2026-11-17T06:45:00Z');
export const ACCOUNT = PERSONA_ACCOUNT_ID;
export const STORE_ID = '7f0c0b3e-2a54-4d7e-9b1e-0f7cf1a00001';
export const PERSONA_ORIGIN = 'http://naver-virtual:3000';
export const WEBHOOK_URL = 'http://marketing:3000/internal/v1/naver/talktalk/webhook';
export const CAPABILITIES: PersonaCapability[] = [pn03, pn04, pn05, pn06, pn07, pn10, pn11, pn12, pn13, pn14, pn16, pn17];

export const TOKENS = { marketing: 'marketing-persona-token-0001', fixture: 'fixture-dispatch-token-0001' };
const callbackToken = 'synthetic-talktalk-callback-0001';
export const SERVICE_IDS = { sms: 'ncp:sms:kr:000000000001:cafe', alimtalk: 'ncp:kkobizmsg:kr:000000000002:cafe',
  brandmessage: 'ncp:kkobizmsg:kr:000000000003:cafe', mail: 'ncp:mail:kr:000000000004:cafe' };
export const SENDER = { sms: '01000000000', mail: 'owner@example.test' };
export const OBJECTS = { bucket: 'navis-promo', keyPrefix: 'marketing/' };
export const CAFE = { clubid: '10000001', menuid: '1', accessToken: 'fixture-cafe-write' };
const WIRE = {
  apiKey: { keyId: 'fixture-hub-id', key: 'fixture-hub-key' },
  sens: { accessKey: 'fixture-access', secretKey: 'fixture-signing' },
  studio: { apiKey: 'fixture-studio' },
  s3: { accessKeyId: 'FIXTUREACCESSKEY01', secretAccessKey: 'fixture-object-secret' },
  talktalk: 'ct_fixture_chatbot',
};

/** Provider-side credential values for the marketing workload grant (persona `providerCredentials`). */
function providerCredentials(operation: OperationId): Record<string, string> | undefined {
  const spec = OPERATIONS[operation];
  if (spec.auth === 'api-key') return WIRE.apiKey;
  if (spec.auth === 'talktalk') return { talktalkAuthorization: WIRE.talktalk, talktalkCallbackToken: callbackToken };
  if (spec.auth === 'studio') return WIRE.studio;
  if (spec.auth === 's3') return { ...WIRE.s3, ...OBJECTS };
  if (spec.auth === 'sens') {
    const product = operation.split('.')[1] as keyof typeof SERVICE_IDS;
    return { ...WIRE.sens, serviceId: SERVICE_IDS[product], sender: product === 'mail' ? SENDER.mail : SENDER.sms,
      plusFriendId: '@ansungjalbu', templateCode: 'cafe-order', consentedRecipients: '01000000001,01000000002', channelFriends: '01000000001' };
  }
  return undefined;
}

export const MARKETING_OPERATIONS = Object.keys(OPERATIONS) as OperationId[];

/** Adapter-side credential files (synthetic), read through PN-P0 `readCredential`. */
export const CREDENTIAL_FILES: Record<string, string> = {
  '/run/secrets/persona/marketing-token': TOKENS.marketing,
  '/run/secrets/naver/apihub.json': JSON.stringify(WIRE.apiKey),
  '/run/secrets/naver/sens.json': JSON.stringify(WIRE.sens),
  '/run/secrets/naver/studio.json': JSON.stringify(WIRE.studio),
  '/run/secrets/naver/objects.json': JSON.stringify(WIRE.s3),
  '/run/secrets/naver/talktalk-authorization': WIRE.talktalk,
};
export const readCredential = (overrides: Record<string, string> = {}) => (path: string) => {
  const value = overrides[path] ?? CREDENTIAL_FILES[path];
  if (value === undefined) throw new Error('missing credential');
  return value;
};

export async function preparePersonaDatabase(databaseUrl: string, now = FIXED_NOW) {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nvirtual_run') THEN CREATE ROLE nvirtual_run; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nvirtual_mig') THEN CREATE ROLE nvirtual_mig; END IF; END $$;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE SCHEMA IF NOT EXISTS naver_virtual; GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run`);
    await migratePersona(admin, CAPABILITIES);
    await seedPersona(admin, CAPABILITIES, createPersonaSeedContext(now));
  } finally {
    await admin.end();
  }
}

/** Start the real persona app; `callbackFetcher` delivers the TalkTalk callback to the marketing receiver. */
export async function startPersona(options: { databaseUrl: string; now?: () => Date; host?: string; port?: number; callbackFetcher?: typeof fetch }) {
  const now = options.now ?? (() => FIXED_NOW);
  const pool = new pg.Pool({ connectionString: options.databaseUrl, options: '-c role=nvirtual_run', max: 4 });
  const grants = [
    { workload: 'marketing', accountId: ACCOUNT, token: TOKENS.marketing, operations: MARKETING_OPERATIONS,
      providerCredentials: Object.fromEntries(MARKETING_OPERATIONS.flatMap(operation => {
        const value = providerCredentials(operation);
        return value ? [[operation, value]] : [];
      })) },
    { workload: 'persona-fixture', accountId: ACCOUNT, token: TOKENS.fixture, operations: ['pn06.fixture.dispatch'],
      providerCredentials: { 'pn06.fixture.dispatch': { talktalkCallbackToken: callbackToken } } },
  ];
  const app = createPersonaApp({
    pool, grants, capabilities: CAPABILITIES, now, logging: false,
    callback: createPersonaCallback({ talktalk: WEBHOOK_URL }, options.callbackFetcher),
    ready: async () => { await pool.query('SELECT 1'); },
  });
  const address = await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  return { app, address, pool, close: async () => { await app.close(); await pool.end(); } };
}

/** Marketing-side TalkTalk receiver with an in-memory inbox standing in for the B15 ledger. */
export async function startMarketingReceiver(options: { host?: string; port?: number } = {}) {
  const inbox: InboundEvent[] = [];
  const app = Fastify({ logger: false });
  registerTalkTalkInbound(app, { mode: 'virtual', callbackToken, onEvent: async event => { inbox.push(event); } });
  const address = await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  return { app, address, inbox };
}

/**
 * Deliver a request addressed to the private persona origin to a local listener while keeping the
 * original Host header, so signed wires (S3 SigV4 over `host`) verify exactly as on the Compose network.
 */
async function forward(target: string, url: URL, init: RequestInit = {}): Promise<Response> {
  const destination = new URL(target);
  const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers).entries());
  const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer());
  if (body) headers['content-length'] = String(body.length);
  headers.host = url.host;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: destination.hostname, port: destination.port, method: init.method ?? 'GET',
      path: url.pathname + url.search, headers, signal: init.signal ?? undefined }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(new Response([204, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** Records every adapter request and refuses any destination other than the private persona origin. */
export function personaFetcher(target: string) {
  const calls: { method: string; path: string; body?: string }[] = [];
  const blocked: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== PERSONA_ORIGIN) {
      blocked.push(url.origin);
      throw new Error('Blocked non-persona destination');
    }
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body });
    return forward(target, url, init);
  };
  return { fetcher, calls, blocked };
}

export function marketingProvider(options: { target: string; now?: () => Date; overrides?: Record<string, string>; providerAccount?: string }) {
  const guard = personaFetcher(options.target);
  const provider = createMarketingProvider({
    storeId: STORE_ID, providerAccount: options.providerAccount ?? ACCOUNT, mode: 'virtual', virtualOrigin: PERSONA_ORIGIN,
    privateTokenFile: '/run/secrets/persona/marketing-token', now: options.now ?? (() => FIXED_NOW),
    credentialFiles: {
      'api-key': '/run/secrets/naver/apihub.json', sens: '/run/secrets/naver/sens.json', studio: '/run/secrets/naver/studio.json',
      s3: '/run/secrets/naver/objects.json', talktalk: '/run/secrets/naver/talktalk-authorization',
    },
    fetcher: guard.fetcher, readCredential: readCredential(options.overrides),
  });
  return { provider, guard };
}
