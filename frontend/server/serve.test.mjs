import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { navisAgentFakeFetch } from './fixtures/navis-eval-fake.mjs';

const publicOrigin = 'https://navis.demo.ts.net';
const chatHeaders = { host: new URL(publicOrigin).host, origin: publicOrigin, 'content-type': 'application/json' };
const condition = { kind: 'default' };
const chatBody = JSON.stringify({
  runId: 'server-test', snapshotRevision: 1, locale: 'ko', layer: 'management', businessDate: '2026-11-21',
  intent: { kind: 'read', featureId: 'ledger', condition }, slots: [], searches: [],
  catalog: [{ id: 'ledger', name: '손익', layer: 'management', conditions: [condition] }],
  snapshot: [{ featureId: 'ledger', condition, facts: [
    { key: 'ledger.revenue', label: '매출', value: 1284000, unit: 'KRW', display: '128.4만 원', date: '2026-11-21' },
  ] }],
});

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'navis-serve-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(t, env = {}, secretsDir, mediaFetch) {
  const { createNavisServer } = await import('./serve.mjs');
  const dir = await scratch(t);
  const service = createNavisServer({
    env: { NAVIS_PORT: '0', NAVIS_PROMO_DIR: dir, NAVIS_ALLOWED_ORIGINS: publicOrigin, ...env },
    secretsDir: secretsDir ?? dir,
    mediaFetch,
  });
  t.after(() => service.close());
  const { port } = await service.listen();
  return { service, port };
}

function hit(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('standalone probes report liveness and readiness without an Origin', async t => {
  const { service, port } = await launch(t);
  await service.ready;
  for (const path of ['/healthz', '/readyz']) {
    const response = await hit(port, path);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { service: 'navis', status: 'ok' });
  }
});

test('standalone readiness stays down if promo cannot initialize its state', async t => {
  const file = join(await scratch(t), 'not-a-directory');
  await writeFile(file, 'fixture');
  const { service, port } = await launch(t, { NAVIS_PROMO_DIR: file });
  await assert.rejects(service.ready, { code: 'ENOTDIR' });
  assert.equal((await hit(port, '/readyz')).status, 503);
  assert.equal((await hit(port, '/healthz')).status, 200);
});

test('standalone server returns 404 outside its API prefixes', async t => {
  const { port } = await launch(t);
  for (const path of ['/', '/api', '/api/marketing/stores', '/api/navis-extra/chat', '/api/promo-extra/catalog']) {
    const response = await hit(port, path);
    assert.equal(response.status, 404, path);
  }
});

test('standalone server enforces origin and Host for all three middlewares', async t => {
  const { port } = await launch(t);
  const host = new URL(publicOrigin).host;
  for (const path of ['/api/navis/chat', '/api/navis/widget-drafts', '/api/navis/media/receipt-ocr', '/api/promo/jobs']) {
    for (const headers of [
      { host, origin: 'https://other.demo.ts.net' },
      { host: 'other.demo.ts.net', origin: publicOrigin },
      { host: `${host}:8443`, origin: publicOrigin },
      { host, origin: publicOrigin, 'sec-fetch-site': 'cross-site' },
      { host, 'sec-fetch-site': 'same-origin' },
    ]) assert.equal((await hit(port, path, { method: 'POST', headers })).status, 403, path);
  }
  const trusted = { host, 'sec-fetch-site': 'same-origin' };
  const promo = await hit(port, '/api/promo/catalog', { headers: trusted });
  assert.equal(promo.status, 200);
  assert.ok(JSON.parse(promo.body).photos.length > 0);
  const widget = await hit(port, '/api/navis/reply-test-targets', { headers: trusted });
  assert.equal(widget.status, 200);
  assert.equal(JSON.parse(widget.body).mode, 'fake');
  const media = await hit(port, '/api/navis/media/receipt-ocr', { method: 'POST', headers: { host, origin: publicOrigin } });
  assert.equal(media.status, 415);
  assert.equal(JSON.parse(media.body).error, 'UNSUPPORTED_MEDIA_TYPE');
});

test('standalone chat streams fixture text through the browser protocol', async t => {
  const { port } = await launch(t);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: chatBody,
    headers: { ...chatHeaders, 'x-navis-protocol': 'agent-v1' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-navis-protocol'], 'agent-v1');
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  assert.match(response.body, /event: text_delta\ndata:.*128\.4만 원/);
  assert.match(response.body, /event: done\n/);
});

test('standalone live receipt OCR forwards the mounted credentials to the media transport', async t => {
  const secretsDir = await scratch(t);
  const ocrUrl = 'https://fixture.apigw.ntruss.com/custom/v1/1234/invoke-fixture/document/receipt';
  await writeFile(join(secretsDir, 'NCP_CLOVA_OCR_URL'), `${ocrUrl}\n`);
  await writeFile(join(secretsDir, 'NCP_CLOVA_OCR_SECRET'), 'fixture-mounted\n');
  const { port } = await launch(t, { NAVIS_CLOVA_OCR_PROVIDER: 'live', NAVIS_CLOVA_OCR_SECRET: 'fixture-env' }, secretsDir,
    (url, options) => {
      assert.equal(url, ocrUrl);
      assert.equal(new Headers(options.headers).get('x-ocr-secret'), 'fixture-mounted');
      return Response.json({ images: [{ inferResult: 'SUCCESS', receipt: { result: {
        storeInfo: { name: { text: '확인 상점' } },
      } } }] });
    });
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
  const response = await hit(port, '/api/navis/media/receipt-ocr', {
    method: 'POST', body: photo, headers: { ...chatHeaders, 'content-type': 'image/png' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).merchant, { value: '확인 상점', needsReview: true });
});

test('standalone transcription uses mounted speech credentials only after live opt-in', async t => {
  const secretsDir = await scratch(t);
  const invoke = 'https://clovaspeech-gw.ncloud.com/recog/v1/stt';
  const env = { NAVIS_CLOVASPEECH_INVOKE_URL: invoke, NAVIS_CLOVASPEECH_SECRET: 'fixture-environment' };
  const liveFetch = t.mock.fn((url, options) => {
    assert.equal(url, `${invoke}?lang=Kor`);
    assert.equal(new Headers(options.headers).get('X-CLOVASPEECH-API-KEY'), 'fixture-mounted');
    return Response.json({ text: '확인한 문장' });
  });
  const sendSpeech = port => hit(port, '/api/navis/media/transcription', {
    method: 'POST',
    body: Buffer.from('524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000001000200', 'hex'),
    headers: { ...chatHeaders, 'content-type': 'audio/wav' },
  });

  const missing = await launch(t, { ...env, NAVIS_CLOVASPEECH_PROVIDER: 'live' }, secretsDir, liveFetch);
  const unavailable = await sendSpeech(missing.port);
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.body).error, 'UNAVAILABLE');
  assert.equal(liveFetch.mock.callCount(), 0);

  await writeFile(join(secretsDir, 'NCP_CLOVASPEECH_INVOKE_URL'), `${invoke}\n`);
  await writeFile(join(secretsDir, 'NCP_CLOVASPEECH_SECRET'), 'fixture-mounted\n');
  const fake = await launch(t, env, secretsDir, liveFetch);
  const fixture = await sendSpeech(fake.port);
  assert.equal(fixture.status, 200);
  assert.equal(JSON.parse(fixture.body).text, '딸기스무디 메뉴 추가해줘');
  assert.equal(liveFetch.mock.callCount(), 0);

  const live = await launch(t, { ...env, NAVIS_CLOVASPEECH_PROVIDER: 'live' }, secretsDir, liveFetch);
  const recognized = await sendSpeech(live.port);
  assert.equal(recognized.status, 200);
  assert.equal(JSON.parse(recognized.body).text, '확인한 문장');
  assert.equal(liveFetch.mock.callCount(), 1);
});

test('standalone live chat uses the mounted key and defaults to HCX-005', async t => {
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file\n');
  const calls = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-file');
    assert.ok(options.signal instanceof AbortSignal);
    return navisAgentFakeFetch(url, options);
  });
  const { port } = await launch(t, {
    CLOVASTUDIO_API_KEY: 'ignored-env-key', NAVIS_AGENT_PROVIDER: 'live',
  }, secretsDir);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: chatBody,
    headers: { ...chatHeaders, 'x-navis-protocol': 'agent-v1' },
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /event: text_delta\ndata:.*128\.4만 원/);
  assert.match(response.body, /event: done\n/);
  assert.ok(calls.mock.callCount() > 0);
  for (const { arguments: [url] } of calls.mock.calls) {
    assert.equal(url, 'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005');
  }
});

test('standalone live chat honors the bridge base URL and model configuration', async t => {
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file');
  const calls = t.mock.method(globalThis, 'fetch', navisAgentFakeFetch);
  const { port } = await launch(t, {
    NAVIS_AGENT_PROVIDER: 'live', CLOVASTUDIO_BASE_URL: 'https://studio.example', NAVIS_AGENT_MODEL: 'HCX-007',
  }, secretsDir);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: chatBody,
    headers: { ...chatHeaders, 'x-navis-protocol': 'agent-v1' },
  });
  assert.match(response.body, /event: done\n/);
  assert.ok(calls.mock.callCount() > 0);
  for (const { arguments: [url] } of calls.mock.calls) {
    assert.equal(url, 'https://studio.example/v3/chat-completions/HCX-007');
  }
});

test('standalone keeps fixture chat unless both live opt-in and a mounted key are present', async t => {
  const calls = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request'); });
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file');
  for (const { env, dir } of [
    { env: { NAVIS_AGENT_MODE: 'live' }, dir: secretsDir },
    { env: { NAVIS_AGENT_PROVIDER: 'live', CLOVASTUDIO_API_KEY: 'ignored-env-key' } },
  ]) {
    const { port } = await launch(t, env, dir);
    const response = await hit(port, '/api/navis/chat', {
      method: 'POST', body: chatBody,
      headers: { ...chatHeaders, 'x-navis-protocol': 'agent-v1' },
    });
    assert.equal(response.status, 200);
    assert.match(response.body, /event: done\n/);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test('standalone live chat skips the model for a small fact set with explicit direct mode', async t => {
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file\n');
  const calls = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected provider request'); });
  const { port } = await launch(t, { NAVIS_AGENT_PROVIDER: 'live', NAVIS_AGENT_DIRECT: '1' }, secretsDir);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: chatBody,
    headers: { ...chatHeaders, 'x-navis-protocol': 'agent-v1' },
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /event: text_delta\ndata:.*128\.4만 원/);
  assert.match(response.body, /event: done\n/);
  assert.equal(calls.mock.callCount(), 0);
});

test('standalone live opt-in only supplies the key to agent-v1 chat', async t => {
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file');
  const calls = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request'); });
  const { port } = await launch(t, { NAVIS_AGENT_PROVIDER: 'live' }, secretsDir);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: JSON.stringify({ text: '오늘 매출은?', snapshot: [], catalog: [] }), headers: chatHeaders,
  });
  assert.equal(response.status, 503);
  assert.equal(calls.mock.callCount(), 0);
});

test('standalone shutdown is idempotent and closes the listener', async t => {
  const { service, port } = await launch(t);
  await service.ready;
  assert.equal((await hit(port, '/healthz')).status, 200);
  const closing = service.close();
  assert.equal(service.close(), closing);
  await closing;
  await assert.rejects(hit(port, '/readyz'), { code: 'ECONNREFUSED' });
});

test('standalone bridge credentials come from explicitly mounted files', async t => {
  const { readServiceEnv } = await import('./serve.mjs');
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-file\n');
  await writeFile(join(secretsDir, 'NCP_APIGW_KEY'), 'fixture-sens-file\n');
  const env = { CLOVASTUDIO_API_KEY: 'ignored', NCP_APIGW_KEY: 'ignored', NCP_APIGW_KEY_ID: 'also-ignored' };
  assert.equal(readServiceEnv(env, secretsDir).CLOVASTUDIO_API_KEY, 'fixture-file');
  assert.equal(readServiceEnv(env, secretsDir).NCP_APIGW_KEY, 'fixture-sens-file');
  assert.equal(readServiceEnv(env, secretsDir).NCP_APIGW_KEY_ID, undefined);
});

test('the widget provider opt-in does not enable legacy chat transport', async t => {
  const secretsDir = await scratch(t);
  await writeFile(join(secretsDir, 'CLOVASTUDIO_API_KEY'), 'fixture-key\n');
  const { port } = await launch(t, {
    NAVIS_WIDGET_MODE: 'moa', NAVIS_AGENT_MODE: 'fixture', CLOVASTUDIO_BASE_URL: 'http://127.0.0.1:1',
  }, secretsDir);
  const response = await hit(port, '/api/navis/chat', {
    method: 'POST', body: JSON.stringify({ text: '오늘 매출은?', snapshot: [], catalog: [] }),
    headers: { host: new URL(publicOrigin).host, origin: publicOrigin, 'content-type': 'application/json' },
  });
  assert.equal(response.status, 503);
});
