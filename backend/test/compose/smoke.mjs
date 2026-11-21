/* global AbortSignal, console, fetch, URL */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const project = 'navis-backend-local';
const origin = 'http://127.0.0.1:18180';
const backend = new URL('../../', import.meta.url);
function compose(...args) {
  return execFileSync('docker', ['compose', '--env-file', '.env.local', '-p', project, ...args], {
    cwd: backend, encoding: 'utf8',
  });
}

function edge(path, init) {
  return fetch(new URL(path, origin), { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
}

const authPath = '/api/v1/auth';
const catalogPath = '/api/v1/inventory/catalog';
const auth = (endpoint, headers = {}) => edge(`${authPath}/${endpoint}`, {
  method: 'POST', headers: { origin, ...headers },
});
const read = (storeId, token, headers = {}) => edge(`${catalogPath}?storeId=${storeId}`, {
  headers: { authorization: `Bearer ${token}`, ...headers },
});
async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { code });
}

const { storeId, items, syntheticStoreId } = JSON.parse(
  compose('run', '--rm', '--no-deps', 'tools', 'node', 'test/compose/fixtures.ts', 'expected'),
);

const published = compose('ps', '--format', '{{.Service}} {{.Ports}}').trim().split('\n')
  .filter(line => line.includes('->'));
assert.deepEqual(published, ['edge 127.0.0.1:18180->80/tcp']);

const spoofedRequestId = 'f'.repeat(32);
const root = await edge('/', { headers: { 'x-request-id': spoofedRequestId } });
assert.equal(root.status, 200);
assert.match(root.headers.get('content-type') ?? '', /^text\/html/);
assert.match(await root.text(), /<script type="module"[^>]+src="\/assets\//);
const health = await edge('/api/healthz');
assert.deepEqual(await health.json(), { service: 'api-gateway', status: 'ok' });
assert.deepEqual(await (await edge('/api')).json(), { code: 'NOT_FOUND' });
assert.equal((await edge('/api/internal/v1/auth/jwks')).status, 404);
console.log('Only loopback edge is published. / serves Vite HTML and /api serves Fastify.');

await error(await auth('demo', { origin: 'http://localhost:18180' }), 403, 'STORE_FORBIDDEN');
// fetch uses the URL's Host. Use Node HTTP to send the deliberately wrong Host.
const wrongHostStatus = await new Promise((resolve, reject) => {
  const request = httpRequest(new URL(`${authPath}/demo`, origin), {
    method: 'POST', headers: { origin, host: 'localhost:18180' }, signal: AbortSignal.timeout(10_000),
  }, response => {
    response.resume();
    resolve(response.statusCode);
  });
  request.once('error', reject);
  request.end();
});
assert.equal(wrongHostStatus, 403);

const login = await auth('demo');
assert.equal(login.status, 200);
assert.equal(login.headers.get('cache-control'), 'no-store');
const cookie = login.headers.get('set-cookie') ?? '';
// Keep the cookie and JWT in process memory, including when assertions fail.
assert.ok(cookie.startsWith('navis_refresh=') && cookie.includes('Path=/api/v1/auth')
  && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'), 'Expected scoped refresh cookie');
const originalCookie = cookie.split(';', 1)[0];
const initial = await login.json();
assert.equal(initial.storeId, storeId);
assert.equal(initial.expiresIn, 600);
assert.ok(typeof initial.accessToken === 'string');

const result = await read(storeId, initial.accessToken, {
  'x-request-id': spoofedRequestId, 'x-navis-store-id': syntheticStoreId,
  'x-navis-store-role': 'staff', 'x-navis-workload-token': 't305-untrusted-marker',
});
assert.equal(result.status, 200);
assert.equal(result.headers.get('cache-control'), 'no-store');
assert.equal(items.length, 24);
assert.deepEqual(await result.json(), { items });
await error(await read(syntheticStoreId, initial.accessToken, { 'x-navis-store-id': syntheticStoreId, 'x-navis-store-role': 'owner' }), 403, 'STORE_FORBIDDEN');
await error(await read(storeId, 'invalid'), 401, 'UNAUTHENTICATED');

const requestId = result.headers.get('x-request-id') ?? '';
const frontendId = root.headers.get('x-request-id') ?? '';
for (const id of [requestId, frontendId]) {
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.notEqual(id, spoofedRequestId);
}
for (const service of ['edge', 'api-gateway', 'account', 'inventory']) {
  const logs = compose('logs', '--no-color', '--tail', '150', service);
  assert.ok(logs.includes(`"requestId":"${requestId}"`), `Expected catalog request ID in ${service} logs`);
  assert.ok(!logs.includes('t305-untrusted-marker'), `Unexpected header in ${service} logs`);
}
assert.ok(compose('logs', '--no-color', '--tail', '60', 'frontend').includes(`"requestId":"${frontendId}"`));
console.log(`Catalog matches all ${items.length} seed rows and five wire fields. Store B was denied. Request ID ${requestId} matched all four hops.`);

const rotated = await auth('refresh', { cookie: originalCookie });
assert.equal(rotated.status, 200);
const next = await rotated.json();
assert.equal((await read(storeId, next.accessToken)).status, 200);
await error(await auth('refresh', { cookie: originalCookie }), 401, 'UNAUTHENTICATED');
await error(await read(storeId, initial.accessToken), 401, 'UNAUTHENTICATED');
await error(await read(storeId, next.accessToken), 401, 'UNAUTHENTICATED');
console.log('Refresh rotated the cookie. Reuse revoked both access JWTs for their next protected read.');

const active = await auth('demo');
assert.equal(active.status, 200);
const { accessToken } = await active.json();
compose('pause', 'account');
try {
  await error(await read(storeId, accessToken), 503, 'SERVICE_UNAVAILABLE');
} finally {
  compose('unpause', 'account');
}
assert.equal((await read(storeId, accessToken)).status, 200);
console.log('Unavailable account failed closed with 503. The session read succeeded once account recovered.');
