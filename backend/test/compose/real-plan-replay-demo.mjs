import assert from 'node:assert/strict';
import { createAccountApp } from '../../services/account/app.ts';

const publicOrigin = 'http://127.0.0.1:18482';
const gatewayToken = 'fixture-gateway-account-token';
const host = new URL(publicOrigin).host;
const call = (app, extra = {}) => app.inject({ method: 'POST', url: '/api/v1/auth/demo',
  headers: { host, origin: publicOrigin, 'sec-fetch-site': 'same-origin', ...extra } });
const apps = [];
function start(options) {
  const pool = { query() { throw new Error('These route guards must not touch PostgreSQL'); } };
  const app = createAccountApp({ pool, gatewayToken, publicOrigin, logging: false, ...options });
  apps.push(app);
  return app;
}

try {
  assert.equal((await call(start({ demoAuth: '1' }))).statusCode, 404);
  assert.equal((await call(start({ replayDemoAuth: true }))).statusCode, 404);
  const replay = start({ demoAuth: '1', replayDemoAuth: true });
  assert.equal((await call(replay)).statusCode, 401);
  const authorization = `Bearer ${gatewayToken}`;
  assert.equal((await call(replay, { authorization, origin: 'http://127.0.0.1:18180' })).statusCode, 403);
  assert.equal((await call(replay, { authorization, host: '127.0.0.1:18180' })).statusCode, 403);
  assert.equal((await call(replay, { authorization, 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  const hosted = start({ publicOrigin: 'https://demo.example', demoAuth: '1', replayDemoAuth: true });
  assert.equal((await call(hosted, { origin: 'https://demo.example', host: 'demo.example', authorization })).statusCode, 404);
  console.info('PASS disposable alternate-port demo route retains workload, origin and hosted guards');
} finally {
  await Promise.all(apps.map(app => app.close()));
}
