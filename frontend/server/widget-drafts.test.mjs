import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './bridge.mjs';
import { sundayHoursSentenceKo } from './fixtures/store-hours.mjs';
import { LATTE_RECIPE } from './fixtures/widget-drafts.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const API = '/api/navis';
const REPLY = '오래 기다리시게 해서 죄송해요.';
const EDIT = '기다리게 해 드려 죄송합니다.';
const SENS = {
  serviceId: 'ncp:sms:kr:demo:fixture',
  accessKey: 'unused-test-access-marker',
  secretKey: 'unused-test-signing-marker',
  senderNumber: '00000000001',
};
const TEST_NUMBER = '00000000002';
const PRIVATE_ALIAS = 'operator-private-alias';
const SSE = content => new Response(`event: result\ndata: ${JSON.stringify({
  message: { content: JSON.stringify(content) }, finishReason: 'stop',
})}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

function manualClock() {
  let time = 1_800_000_000_000;
  const timers = new Set();
  return {
    now: () => time,
    setTimeout(fn, ms) { const timer = { fn, due: time + ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    advance(ms) {
      time += ms;
      for (const timer of timers) {
        if (timer.due <= time) { timers.delete(timer); timer.fn(); }
      }
    },
  };
}

async function host(t, { live = false, ...options } = {}) {
  const modelCalls = []; const sendCalls = []; const fakeCalls = []; const events = [];
  const directory = await mkdtemp(join(tmpdir(), 'navis-widget-ledger-'));
  const ledgerPath = options.ledgerPath ?? join(directory, 'ledger.json');
  const clock = options.clock ?? manualClock();
  const bridge = createBridge({
    apiKey: 'unused-test-model-marker', baseUrl: 'https://fixture.invalid',
    fetchImpl: async (url, init) => {
      modelCalls.push({ url, ...JSON.parse(init.body) });
      return options.modelFetch ? options.modelFetch(url, init) : SSE({ body: REPLY });
    },
    widgets: {
      mode: live ? 'moa' : 'fake', sendEnabled: live ? 'true' : undefined,
      testTargets: `${PRIVATE_ALIAS}=${TEST_NUMBER}`, sens: SENS, ledgerPath, clock,
      fakeSend: async ({ number, body }) => { fakeCalls.push({ number, body }); },
      sensFetch: async (url, init) => {
        sendCalls.push({ url, ...JSON.parse(init.body) });
        return options.sensFetch ? options.sensFetch(url, init) : new Response(null, { status: 202 });
      },
      onStatus: event => events.push(event),
      ...options.widgets,
    },
  });
  const server = createServer(bridge);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    bridge.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}${API}`;
  let cookie;
  async function request(path, body, headers = {}) {
    const post = body !== undefined;
    const res = await fetch(base + path, {
      method: post ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(post ? { 'content-type': 'application/json' } : {}), ...headers },
      body: post ? JSON.stringify(body) : undefined,
    });
    const issued = res.headers.get('set-cookie');
    if (issued) cookie = issued.split(';')[0];
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return {
    modelCalls, sendCalls, fakeCalls, events, ledgerPath, clock, request, cookie: () => cookie, base,
    draft: (sampleId = 'th-4', widget = 'ai-response') => request('/widget-drafts', { widget, sampleId }),
    targets: () => request('/reply-test-targets'),
    send: (draftId, targetId, { key = 'demo-request', ...patch } = {}) => request(
      '/reply-test-send', { draftId, targetId, body: EDIT, confirmed: true, ...patch }, { 'idempotency-key': key },
    ),
  };
}

const code = (response, name, status) => assert.deepEqual([response.status, response.body], [status, { code: name }]);

test('drafts send curated facts only and buffer model output before returning it', async t => {
  const app = await host(t, { live: true });
  code(await app.request('/widget-drafts', { widget: 'ai-response', sampleId: 'th-4', text: 'private-client-marker' }), 'BAD_REQUEST', 400);
  assert.equal(app.modelCalls.length, 0);
  const draft = await app.draft();
  assert.equal(draft.status, 200);
  assert.equal(draft.body.kind, 'reply');
  assert.equal(draft.body.content.body, REPLY);
  assert.ok(draft.body.sourceLabels.length);
  assert.equal(app.modelCalls.length, 1);
  const [{ url, messages, maxTokens }] = app.modelCalls;
  assert.equal(url, 'https://fixture.invalid/v3/chat-completions/HCX-005');
  assert.equal(maxTokens, 120);
  assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
  assert.match(messages[1].content, /주말 오후에 갔는데/);
  for (const privateValue of [TEST_NUMBER, PRIVATE_ALIAS, SENS.accessKey, SENS.secretKey, '박서연', 'private-client-marker']) {
    assert.equal(JSON.stringify(messages).includes(privateValue), false);
  }
  assert.equal(app.sendCalls.length, 0);
});

test('fake mode drafts applications and manuals without CLOVA and simulates an approved reply', async t => {
  const app = await host(t);
  const grant = await app.draft('g-stability', 'grants');
  assert.equal(grant.status, 200);
  assert.equal(grant.body.kind, 'application');
  assert.match(grant.body.content.body, /2026-10-30/);
  assert.match(grant.body.content.body, /확인 필요/);
  const manual = await app.draft('mn-open', 'manuals');
  assert.equal(manual.status, 200);
  assert.equal(manual.body.kind, 'manual');
  assert.equal(manual.body.content.title, '오픈 준비');
  assert.equal(manual.body.content.steps.length, 5);
  app.clock.advance(MINUTE);
  const draft = await app.draft();
  const targets = await app.targets();
  assert.equal(targets.body.mode, 'fake');
  assert.equal(targets.body.targets[0].label, '테스트 번호 1');
  const sent = await app.send(draft.body.draftId, targets.body.targets[0].id);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'simulated');
  assert.ok(sent.body.receiptId);
  assert.deepEqual(app.fakeCalls, [{ number: TEST_NUMBER, body: EDIT }]);
  assert.equal(app.modelCalls.length + app.sendCalls.length, 0);
});

test('CLOVA application and manual drafts resolve only fixture fact references', async t => {
  const app = await host(t, { live: true, modelFetch: (_url, init) => {
    const { maxTokens } = JSON.parse(init.body);
    return maxTokens === 600 ? SSE({ plans: [2] }) : SSE({ title: 'title', steps: [1, 3] });
  } });
  const grant = await app.draft('g-stability', 'grants');
  assert.equal(grant.status, 200);
  assert.match(grant.body.content.body, /경영 상담을 받아/);
  const manual = await app.draft('mn-latte', 'manuals');
  assert.equal(manual.status, 200);
  assert.deepEqual(manual.body.content.steps, [`원두 ${LATTE_RECIPE.beansG} g으로 샷 2잔을 내려요`, '샷 위에 우유를 붓고 거품을 올려요']);
  assert.deepEqual(app.modelCalls.map(call => call.maxTokens), [600, 500]);
  assert.ok(app.modelCalls.every(call => Buffer.byteLength(JSON.stringify(call.messages)) <= 768));
});

test('send rejects off, denied, unconfirmed, invalid, foreign and expired requests without upstream I/O', async t => {
  const off = await host(t, { live: true, widgets: { sendEnabled: 'false' } });
  const draftOff = await off.draft();
  assert.deepEqual((await off.targets()).body, { mode: 'off', targets: [] });
  code(await off.send(draftOff.body.draftId, 'unavailable'), 'SEND_DISABLED', 503);
  const app = await host(t, { live: true });
  const { body: { draftId } } = await app.draft();
  const target = (await app.targets()).body.targets[0].id;
  code(await app.send(draftId, PRIVATE_ALIAS), 'FORBIDDEN', 403);
  code(await app.send(draftId, target, { confirmed: false }), 'BAD_REQUEST', 400);
  for (const body of ['', EDIT + '🙂', '가'.repeat(41), '언제든 환불해 드립니다.']) {
    code(await app.send(draftId, target, { body }), 'INVALID_REPLY', 422);
  }
  const foreign = await app.request('/reply-test-send', { draftId, targetId: target, confirmed: true, body: EDIT }, { cookie: '', 'idempotency-key': 'other' });
  code(foreign, 'NOT_FOUND', 404);
  app.clock.advance(10 * MINUTE);
  code(await app.send(draftId, target), 'NOT_FOUND', 404);
  assert.equal(off.sendCalls.length + app.sendCalls.length, 0);
});

test('confirmed SENS send is reserved durably, retries replay its receipt, and all visible metadata is private', async t => {
  const app = await host(t, { live: true, sensFetch: async () => new Response(
    JSON.stringify({ echoed: [TEST_NUMBER, SENS.accessKey, SENS.secretKey, EDIT] }),
    { status: 202 },
  ) });
  const { body: { draftId } } = await app.draft();
  const targets = (await app.targets()).body;
  const target = targets.targets[0].id;
  const first = await app.send(draftId, target);
  assert.equal(first.status, 202);
  assert.equal(first.body.status, 'accepted');
  assert.ok(first.body.receiptId);
  const retry = await app.send(draftId, target);
  assert.deepEqual([retry.status, retry.body], [202, first.body]);
  code(await app.send(draftId, target, { body: REPLY }), 'CONFLICT', 409);
  const regenerated = await app.draft();
  code(await app.send(regenerated.body.draftId, target, { key: 'new-request' }), 'CONFLICT', 409);
  assert.equal(app.sendCalls.length, 1);
  assert.deepEqual(app.sendCalls[0].messages, [{ to: TEST_NUMBER }]);
  assert.equal(app.sendCalls[0].content, EDIT);
  const ledger = await readFile(app.ledgerPath, 'utf8');
  const visible = JSON.stringify([targets, first.body, app.events, ledger]);
  for (const value of [TEST_NUMBER, SENS.senderNumber, PRIVATE_ALIAS, SENS.secretKey, SENS.accessKey, EDIT]) {
    assert.equal(visible.includes(value), false);
  }
  assert.match(ledger, new RegExp(first.body.receiptId));
  const restarted = await host(t, { live: true, ledgerPath: app.ledgerPath, clock: app.clock });
  const replay = await restarted.request('/reply-test-send', { draftId, targetId: target, body: EDIT, confirmed: true }, { cookie: app.cookie(), 'idempotency-key': 'demo-request' });
  assert.deepEqual([replay.status, replay.body], [202, first.body]);
  assert.equal(restarted.sendCalls.length, 0);
});

test('one provider attempt, in-flight conflict, and SEND_UNKNOWN stays reserved after restart', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const app = await host(t, { live: true, sensFetch: () => { started(); return new Promise(() => {}); } });
  const { body: { draftId } } = await app.draft();
  const targetId = (await app.targets()).body.targets[0].id;
  const sending = app.send(draftId, targetId);
  await began;
  code(await app.send(draftId, targetId), 'CONFLICT', 409);
  app.clock.advance(15_000);
  code(await sending, 'SEND_UNKNOWN', 504);
  code(await app.send(draftId, targetId), 'SEND_UNKNOWN', 504);
  code(await app.send(draftId, targetId, { key: 'another-key' }), 'CONFLICT', 409);
  const restarted = await host(t, { live: true, ledgerPath: app.ledgerPath, clock: app.clock });
  const replay = await restarted.request('/reply-test-send', { draftId, targetId, body: EDIT, confirmed: true }, { cookie: app.cookie(), 'idempotency-key': 'demo-request' });
  code(replay, 'SEND_UNKNOWN', 504);
  assert.equal(app.sendCalls.length, 1);
  assert.equal(restarted.sendCalls.length, 0);
});

test('per-server generation and send rate caps report Retry-After', async t => {
  const app = await host(t);
  const dayStart = app.clock.now();
  const targets = (await app.targets()).body.targets;
  const drafts = [];
  for (const id of ['th-1', 'th-2', 'th-3']) drafts.push((await app.draft(id)).body.draftId);
  const limited = await app.draft();
  code(limited, 'RATE_LIMITED', 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  const first = await app.send(drafts[0], targets[0].id, { body: '불편을 드려 죄송합니다.' });
  assert.equal(first.status, 200);
  const second = await app.send(drafts[1], targets[0].id, { key: 'parking', body: '건물 뒤에 2대까지 주차할 수 있어요.' });
  code(second, 'RATE_LIMITED', 429);
  assert.equal(second.headers.get('retry-after'), '60');
  app.clock.advance(MINUTE);
  assert.equal((await app.send(drafts[1], targets[0].id, { key: 'parking', body: '건물 뒤에 2대까지 주차할 수 있어요.' })).status, 200);
  app.clock.advance(MINUTE);
  assert.equal((await app.send(drafts[2], targets[0].id, { key: 'hours', body: sundayHoursSentenceKo() })).status, 200);
  const fourth = await app.draft();
  const daily = await app.send(fourth.body.draftId, targets[0].id, { key: 'review' });
  code(daily, 'RATE_LIMITED', 429);
  assert.equal(daily.headers.get('retry-after'), String((DAY - (app.clock.now() - dayStart)) / 1000));
  for (let n = 4; n < 20; n++) {
    app.clock.advance(MINUTE);
    assert.equal((await app.draft()).status, 200);
  }
  code(await app.draft(), 'RATE_LIMITED', 429);
});

test('generation times out, limits concurrent work, and does not retry provider rate errors', async t => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const app = await host(t, { live: true, modelFetch: () => { started(); return new Promise(() => {}); } });
  const generation = app.draft();
  await began;
  code(await app.draft(), 'RATE_LIMITED', 429);
  app.clock.advance(15_000);
  code(await generation, 'TIMEOUT', 504);
  assert.equal(app.modelCalls.length, 1);
  const limited = await host(t, { live: true, modelFetch: () => new Response(JSON.stringify({ status: { code: '42901' } }), { status: 429 }) });
  code(await limited.draft(), 'UNAVAILABLE', 503);
  assert.equal(limited.modelCalls.length, 1);
});

test('unexpected provider text and definite SMS rejection return fixed errors', async t => {
  const bad = await host(t, { live: true, modelFetch: () => SSE({ body: SENS.secretKey }) });
  code(await bad.draft(), 'INVALID_OUTPUT', 502);
  const rejected = await host(t, { live: true, sensFetch: () => new Response(SENS.secretKey, { status: 403 }) });
  const { body: { draftId } } = await rejected.draft();
  const target = (await rejected.targets()).body.targets[0].id;
  code(await rejected.send(draftId, target), 'SEND_FAILED', 502);
  code(await rejected.send(draftId, target), 'SEND_FAILED', 502);
  assert.equal(rejected.sendCalls.length, 1);
});

test('widget routes share bridge access checks, JSON requirements, and the 2 KiB cap', async t => {
  const app = await host(t);
  code(await app.request('/reply-test-targets', undefined, { origin: 'https://outside.invalid' }), 'FORBIDDEN', 403);
  // Node fetch supplies Host from the URL. Send the explicit wire header.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(`${app.base}/reply-test-targets`, { headers: { host: 'outside.invalid' } }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject).end();
  });
  code(wrongHost, 'FORBIDDEN', 403);
  code(await app.request('/widget-drafts'), 'METHOD_NOT_ALLOWED', 405);
  code(await app.request('/widget-drafts', {}, { 'content-type': 'text/plain' }), 'BAD_REQUEST', 400);
  code(await app.draft('x'.repeat(2048)), 'PAYLOAD_TOO_LARGE', 413);
  code(await app.draft('missing'), 'NOT_FOUND', 404);
  assert.deepEqual((await app.draft('th-empty')).body, { status: 'empty' });
});
