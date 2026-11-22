import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbConfig, dbPool } from '../../packages/db/index.ts';
import { runMigrations } from '../../packages/db/migrate.ts';
import { createAccountApp } from './app.ts';
import { definePromoArtifactTests } from './files/artifacts.test-cases.ts';
import { createSigningKeys } from './keys.ts';
import { seed } from './seed.ts';

const migrations = fileURLToPath(new URL('./migrations/', import.meta.url));
const origin = 'http://127.0.0.1:18180';
const store = 'c05409a6-f082-5964-a787-c1ed3184988b';
const owner = '9fee123c-ad63-5539-9775-3381f3c67ffe';
const otherStore = '33123a19-6780-4d38-9bca-ce96efcf8559';
const workloadHeaders = { authorization: `Bearer ${randomBytes(32).toString('hex')}` };
const browserHeaders = { ...workloadHeaders, host: new URL(origin).host, origin };
const issuer = 'navis-account';
const audience = 'navis-api';

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicJwk: publicKey.export({ format: 'jwk' }) };
}

const initial = newKey();
const keys = await createSigningKeys(initial.pem);
const migrate = dbPool('account', 'migrate', 'test');
const runtime = new Pool({ ...dbConfig('account', 'runtime', 'test'), max: 1 });
const defaults = { pool: runtime, gatewayToken: workloadHeaders.authorization.slice(7), keys, logging: false };
const apps: FastifyInstance[] = [];

function app(options: Partial<Parameters<typeof createAccountApp>[0]> = {}) {
  const server = createAccountApp({ ...defaults, ...options });
  apps.push(server);
  return server;
}

const enabled = app({ demoAuth: '1' });

function demo(server = enabled, headers = browserHeaders) {
  return server.inject({ method: 'POST', url: '/api/v1/auth/demo', headers });
}

function refresh(cookie: string, server = enabled, headers = browserHeaders) {
  return server.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { ...headers, cookie } });
}

function authorize(token: string, server = enabled, claims: Record<string, unknown> = {}) {
  const { sid, sub, store_id, role } = decodeJwt(token);
  return server.inject({
    method: 'POST', url: '/internal/v1/auth/authorize', headers: workloadHeaders,
    payload: { sid, sub, store_id, role, ...claims },
  });
}

async function jwks(server = enabled) {
  const response = await server.inject({ method: 'GET', url: '/internal/v1/auth/jwks', headers: workloadHeaders });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json();
}

async function issue(server = enabled, headers = browserHeaders) {
  const response = await demo(server, headers);
  expect(response.statusCode).toBe(200);
  const cookie = response.headers['set-cookie'];
  if (typeof cookie !== 'string') throw new Error('Expected one refresh cookie');
  const { accessToken, expiresIn, storeId } = response.json();
  return { response, accessToken: accessToken as string, expiresIn, storeId, cookie: cookie.split(';')[0], setCookie: cookie };
}

beforeAll(async () => {
  await runMigrations('account', migrations, 'test');
  await seed(migrate);
});
afterAll(async () => {
  await Promise.all(apps.map((server) => server.close()));
  await Promise.all([migrate.end(), runtime.end()]);
});

it('applies and records the named migration once and seeds twice without duplicating fixtures', async () => {
  await runMigrations('account', migrations, 'test');
  await seed(migrate);
  const history = await migrate.query(
    'SELECT count(*)::int AS count FROM account.schema_migrations WHERE name = $1', ['20261120000100_account'],
  );
  expect(history.rows).toEqual([{ count: 1 }]);
  const members = await migrate.query('SELECT store_id, user_id, role FROM account.store_member ORDER BY store_id');
  expect(members.rows).toEqual([
    { store_id: otherStore, user_id: '62001ca1-8761-5e9a-bd5e-e99fa4010279', role: 'owner' },
    { store_id: store, user_id: owner, role: 'owner' },
  ]);
});

it('forces RLS and clears store scope on a reused runtime connection', async () => {
  const policy = await migrate.query(`
    SELECT relname, relrowsecurity AND relforcerowsecurity AS forced
    FROM pg_class WHERE relnamespace = 'account'::regnamespace
      AND relname IN ('store', 'store_member', 'auth_session', 'refresh_token') ORDER BY relname
  `);
  expect(policy.rows).toEqual(['auth_session', 'refresh_token', 'store', 'store_member'].map((relname) => ({ relname, forced: true })));
  expect((await runtime.query('SELECT store_id FROM account.store_member')).rows).toEqual([]);
  await issue();
  expect((await runtime.query('SELECT sid FROM account.auth_session')).rows).toEqual([]);
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.store_id', $1, true)", [otherStore]);
    expect((await client.query('SELECT store_id FROM account.store_member')).rows).toEqual([{ store_id: otherStore }]);
    expect((await client.query('SELECT sid FROM account.auth_session')).rows).toEqual([]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

it('verifies only the current owner’s complete custom reference images for the POS workload', async () => {
  const posReferenceToken = randomBytes(32).toString('hex');
  const inventoryFilesToken = randomBytes(32).toString('hex');
  const server = app({ demoAuth: '1', posReferenceToken, inventoryFilesToken });
  const { accessToken } = await issue(server);
  const claims = decodeJwt(accessToken);
  const root = `/internal/v1/account/stores/${store}/files`;
  const headers = { ...workloadHeaders, 'x-navis-store-id': store, 'x-navis-store-role': 'owner',
    'x-navis-user-id': owner, 'x-navis-session-id': String(claims.sid), 'idempotency-key': randomUUID() };
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ncYQAAAAASUVORK5CYII=', 'base64');
  const metadata = { purpose: 'custom-reference-photo', size: image.length, sha256: createHash('sha256').update(image).digest('hex') };
  expect((await server.inject({ method: 'POST', url: root, headers,
    payload: { ...metadata, contentType: 'application/pdf' } })).statusCode).toBe(400);
  const reserved = await server.inject({ method: 'POST', url: root, headers, payload: { ...metadata, contentType: 'image/png' } });
  expect(reserved.statusCode).toBe(200);
  const { fileId } = reserved.json();
  const check = (token = posReferenceToken, storeId = store, actorId = owner) => server.inject({
    method: 'POST', url: `/internal/v1/account/stores/${storeId}/files/${fileId}/custom-reference-photo-verify`,
    headers: { authorization: `Bearer ${token}` }, payload: { actorId },
  });
  expect((await check(inventoryFilesToken)).statusCode).toBe(401);
  expect((await check()).statusCode).toBe(404);
  expect((await server.inject({ method: 'PUT', url: `${root}/${fileId}/content`, payload: image,
    headers: { ...headers, 'content-type': 'image/png' } })).statusCode).toBe(204);
  expect((await server.inject({ method: 'POST', url: `${root}/${fileId}/complete`, headers, payload: {} })).statusCode).toBe(200);
  expect((await check()).statusCode).toBe(204);
  expect((await check(posReferenceToken, otherStore)).statusCode).toBe(404);
  const otherOwner = '62001ca1-8761-5e9a-bd5e-e99fa4010279';
  await migrate.query(`INSERT INTO account.store_member (store_id, user_id, role, created_at, updated_at)
    VALUES ($1, $2, 'owner', now(), now())`, [store, otherOwner]);
  try {
    expect((await check(posReferenceToken, store, otherOwner)).statusCode).toBe(404);
  } finally {
    await migrate.query('DELETE FROM account.store_member WHERE store_id = $1 AND user_id = $2', [store, otherOwner]);
  }
  expect((await server.inject({ method: 'DELETE', url: `${root}/${fileId}`, headers })).statusCode).toBe(204);
  expect((await check()).statusCode).toBe(404);
});

it('omits demo by default and guards browser and workload requests', async () => {
  expect((await demo(app())).statusCode).toBe(404);
  expect((await demo(app({ demoAuth: 'true' }))).statusCode).toBe(404);
  for (const headers of [
    { ...browserHeaders, origin: 'http://localhost:18180' },
    { ...browserHeaders, origin: '' },
    { ...browserHeaders, host: 'localhost:18180' },
  ]) {
    expect((await demo(enabled, headers)).statusCode).toBe(403);
  }
  expect((await demo(enabled, { ...browserHeaders, authorization: '' })).statusCode).toBe(401);
  expect((await enabled.inject({ method: 'GET', url: '/internal/v1/auth/jwks' })).statusCode).toBe(401);
  expect((await enabled.inject({ method: 'POST', url: '/internal/v1/auth/authorize', payload: {} })).statusCode).toBe(401);
  const badBody = await enabled.inject({
    method: 'POST', url: '/internal/v1/auth/authorize', headers: workloadHeaders, payload: { sid: 'unknown' },
  });
  expect(badBody.statusCode).toBe(400);
  expect(badBody.json()).toEqual({ code: 'INVALID_REQUEST' });
});

it('signs ES256 claims and uses a strict HTTP-only cookie with an eight-hour session', async () => {
  const issued = await issue();
  expect(issued.response.headers['cache-control']).toBe('no-store');
  expect(issued.storeId).toBe(store);
  expect(issued.expiresIn).toBe(600);
  expect(/; Path=\/api\/v1\/auth;/.test(issued.setCookie)).toBe(true);
  expect(/; HttpOnly; SameSite=Strict/.test(issued.setCookie)).toBe(true);
  expect(/; Secure/.test(issued.setCookie)).toBe(false);
  const publicKeys = await jwks();
  expect(publicKeys.keys.map(Object.keys)).toEqual([['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use']]);
  const { protectedHeader, payload } = await jwtVerify(issued.accessToken, createLocalJWKSet(publicKeys), { issuer, audience, algorithms: ['ES256'] });
  expect(protectedHeader).toMatchObject({ kid: publicKeys.keys[0].kid, alg: 'ES256' });
  expect(payload).toMatchObject({ iss: issuer, aud: audience, sub: owner, store_id: store, role: 'owner' });
  expect(payload.exp! - payload.iat!).toBe(600);
  const details = await migrate.query(`
    SELECT extract(epoch FROM (expires_at - created_at))::int AS seconds
    FROM account.auth_session WHERE store_id = $1 AND sid = $2
  `, [store, payload.sid]);
  expect(details.rows).toEqual([{ seconds: 8 * 60 * 60 }]);
  expect((await authorize(issued.accessToken)).statusCode).toBe(204);
  expect((await authorize(issued.accessToken, enabled, { store_id: otherStore })).statusCode).toBe(401);
  expect((await authorize(issued.accessToken, enabled, { sub: randomUUID() })).statusCode).toBe(401);
  expect((await authorize(issued.accessToken, enabled, { role: 'staff' })).statusCode).toBe(403);
  await expect(jwtVerify(issued.accessToken, createLocalJWKSet(publicKeys), {
    issuer, audience, currentDate: new Date(payload.exp! * 1000),
  })).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
});

it('rotates a hash-only refresh credential and revokes the family on replay', async () => {
  const issued = await issue();
  const independent = await issue();
  const { sid } = decodeJwt(issued.accessToken);
  const before = await migrate.query('SELECT expires_at FROM account.auth_session WHERE store_id = $1 AND sid = $2', [store, sid]);
  const wrongOrigin = await refresh(issued.cookie, enabled, { ...browserHeaders, origin: 'https://example.invalid' });
  expect(wrongOrigin.statusCode).toBe(403);
  expect((await refresh(issued.cookie, enabled, { ...browserHeaders, host: 'localhost:18180' })).statusCode).toBe(403);
  expect((await refresh(`${issued.cookie}; ${issued.cookie}`)).statusCode).toBe(401);
  const rotated = await refresh(issued.cookie);
  expect(rotated.statusCode).toBe(200);
  const newCookie = String(rotated.headers['set-cookie']).split(';')[0];
  expect(newCookie !== issued.cookie).toBe(true);
  const laterToken = rotated.json().accessToken as string;
  expect(decodeJwt(laterToken).sid).toBe(sid);
  const stored = await migrate.query(`
    SELECT token_hash, consumed_at IS NOT NULL AS used FROM account.refresh_token
    WHERE store_id = $1 AND sid = $2 ORDER BY used DESC
  `, [store, sid]);
  expect(stored.rows.map((row) => Buffer.isBuffer(row.token_hash) && row.token_hash.length === 32)).toEqual([true, true]);
  const oldHash = createHash('sha256').update(issued.cookie.slice(issued.cookie.indexOf('=') + 1)).digest();
  expect(oldHash.equals(stored.rows[0].token_hash)).toBe(true);
  expect(stored.rows.map((row) => row.used)).toEqual([true, false]);
  const after = await migrate.query('SELECT expires_at FROM account.auth_session WHERE store_id = $1 AND sid = $2', [store, sid]);
  expect(after.rows).toEqual(before.rows);
  expect((await authorize(laterToken)).statusCode).toBe(204);
  const reuse = await refresh(issued.cookie);
  expect(reuse.statusCode).toBe(401);
  expect(reuse.json()).toEqual({ code: 'UNAUTHENTICATED' });
  expect((await refresh(newCookie)).statusCode).toBe(401);
  expect((await authorize(issued.accessToken)).statusCode).toBe(401);
  expect((await authorize(laterToken)).statusCode).toBe(401);
  expect((await authorize(independent.accessToken)).statusCode).toBe(204);
});

it('serializes concurrent use of the same refresh credential across DB connections', async () => {
  const pool = dbPool('account', 'runtime', 'test');
  const concurrent = app({ demoAuth: '1', pool });
  try {
    const issued = await issue(concurrent);
    const results = await Promise.all([refresh(issued.cookie, concurrent), refresh(issued.cookie, concurrent)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
    expect((await authorize(issued.accessToken, concurrent)).statusCode).toBe(401);
  } finally {
    await pool.end();
  }
});

it('revokes every member session on committed removal and keeps them revoked after rejoining', async () => {
  const first = await issue();
  const second = await issue();
  try {
    await migrate.query('DELETE FROM account.store_member WHERE store_id = $1 AND user_id = $2', [store, owner]);
    expect((await demo()).statusCode).toBe(403);
    expect((await authorize(first.accessToken)).statusCode).toBe(401);
    expect((await refresh(second.cookie)).statusCode).toBe(401);
  } finally {
    await seed(migrate);
  }
  expect((await authorize(first.accessToken)).statusCode).toBe(401);
  expect((await authorize(second.accessToken)).statusCode).toBe(401);
  expect((await refresh(first.cookie)).statusCode).toBe(401);
  expect((await authorize((await issue()).accessToken)).statusCode).toBe(204);
});

it('caps refreshed access to the absolute limit and denies both credentials after it', async () => {
  const issued = await issue();
  const { sid } = decodeJwt(issued.accessToken);
  async function setExpiry(seconds: number) {
    await migrate.query(`
      UPDATE account.auth_session
      SET created_at = statement_timestamp() + make_interval(secs => $3) - interval '8 hours',
          expires_at = statement_timestamp() + make_interval(secs => $3)
      WHERE store_id = $1 AND sid = $2
    `, [store, sid, seconds]);
  }
  await setExpiry(60);
  const refreshed = await refresh(issued.cookie);
  expect(refreshed.statusCode).toBe(200);
  const { expiresIn, accessToken } = refreshed.json();
  const claims = decodeJwt(accessToken);
  expect(expiresIn).toBe(claims.exp! - claims.iat!);
  expect(expiresIn).toBeLessThanOrEqual(60);
  expect(expiresIn).toBeGreaterThan(0);
  await setExpiry(-1);
  expect((await authorize(accessToken)).statusCode).toBe(401);
  expect((await refresh(String(refreshed.headers['set-cookie']).split(';')[0])).statusCode).toBe(401);
});

it('returns 503 when the real account DB connection is unavailable', async () => {
  const issued = await issue();
  const disconnected = new Pool({ ...dbConfig('account', 'runtime', 'test'), port: 1 });
  const offline = app({ pool: disconnected, demoAuth: '1' });
  try {
    for (const response of [await authorize(issued.accessToken, offline), await demo(offline), await refresh(issued.cookie, offline)]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect((await offline.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  } finally {
    await disconnected.end();
  }
});

it('publishes the next verifier before activation and retains the old verification key', async () => {
  const next = newKey();
  const published = app({ demoAuth: '1', keys: await createSigningKeys(initial.pem, [next.publicJwk]) });
  const started = await issue(published);
  const publishedLocalSet = createLocalJWKSet(await jwks(published));
  const rotated = app({ demoAuth: '1', keys: await createSigningKeys(next.pem, [initial.publicJwk]) });
  const refreshed = await refresh(started.cookie, rotated);
  expect(refreshed.statusCode).toBe(200);
  const signedByOld = await jwtVerify(started.accessToken, publishedLocalSet, { issuer, audience });
  const signedByNew = await jwtVerify(refreshed.json().accessToken, publishedLocalSet, { issuer, audience });
  expect(signedByOld.protectedHeader.kid).not.toBe(signedByNew.protectedHeader.kid);
  await jwtVerify(started.accessToken, createLocalJWKSet(await jwks(rotated)), { issuer, audience });
  expect((await authorize(started.accessToken, rotated)).statusCode).toBe(204);
  const invalidPrivateJwk = { ...next.publicJwk, d: 'private-member-placeholder' };
  await expect(createSigningKeys(initial.pem, [invalidPrivateJwk])).rejects.toThrow('public');
});

it('sets Secure for HTTPS refresh and omits demo outside the canonical loopback origin', async () => {
  const issued = await issue();
  const httpsOrigin = 'https://navis.example.invalid';
  const https = app({ demoAuth: '1', publicOrigin: httpsOrigin });
  const headers = { ...browserHeaders, host: new URL(httpsOrigin).host, origin: httpsOrigin };
  expect((await demo(https, headers)).statusCode).toBe(404);
  const rotated = await refresh(issued.cookie, https, headers);
  expect(rotated.statusCode).toBe(200);
  expect(/; Secure(?:;|$)/.test(String(rotated.headers['set-cookie']))).toBe(true);
});

it('issues the seeded hosted owner only for the configured HTTPS origin and verified gateway', async () => {
  const publicOrigin = 'https://navis.example.invalid';
  const hosted = app({ hostedDemoAuth: '1', publicOrigin });
  const headers = { ...workloadHeaders, host: new URL(publicOrigin).host, origin: publicOrigin };
  const verified = { ...headers, 'x-navis-demo-gate-verified': '1' };
  expect((await demo(app({ publicOrigin }), verified)).statusCode).toBe(404);
  expect((await demo(app({ hostedDemoAuth: '1' }), browserHeaders)).statusCode).toBe(404);
  expect((await demo(hosted, headers)).statusCode).toBe(403);
  expect((await demo(hosted, { ...verified, authorization: '' })).statusCode).toBe(401);
  expect((await demo(hosted, { ...verified, origin: 'https://other.example' })).statusCode).toBe(403);
  const issued = await issue(hosted, verified);
  expect(issued.setCookie).toMatch(/; Secure$/);
  expect(decodeJwt(issued.accessToken)).toMatchObject({ sub: owner, store_id: store, role: 'owner' });
  expect((await refresh(issued.cookie, hosted, headers)).statusCode).toBe(200);
});

definePromoArtifactTests();
