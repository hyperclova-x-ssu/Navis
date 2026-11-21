import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMediaService } from './middleware.mjs';
import { validateMedia } from './validation.mjs';
import { runSmoke } from './smoke.mjs';
import { startPreview } from '../preview.mjs';

const receiptPath = '/api/navis/media/receipt-ocr';
const speechPath = '/api/navis/media/transcription';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4DwYMEAoAU7oL9ZisIGcAAAAASUVORK5CYII=', 'base64');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const stamp = 1_795_212_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function wav(samples = 16_000, metadata = false) {
  const dataOffset = metadata ? 48 : 36;
  const bytes = Buffer.alloc(dataOffset + 8 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  if (metadata) {
    bytes.write('JUNK', 36);
    bytes.writeUInt32LE(3, 40);
  }
  bytes.write('data', dataOffset);
  bytes.writeUInt32LE(samples * 2, dataOffset + 4);
  return bytes;
}

async function serve(t, options = {}) {
  const media = createMediaService(options);
  const downstream = [];
  const server = createServer((req, res) => media(req, res, () => {
    downstream.push(req.url);
    res.writeHead(404).end();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    media.close();
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, downstream, server };
}

function post(origin, path = receiptPath, body = png, type = 'image/png', options = {}) {
  return fetch(origin + path, {
    method: 'POST',
    ...options,
    headers: { 'content-type': type, origin, ...options.headers },
    body,
  });
}

async function checkError(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const json = await response.json();
  assert.match(json.requestId, uuid);
  assert.deepEqual(json, { error, requestId: json.requestId });
}

test('default fake suggestions do not reach chat, ledger or inventory, even if network fetch is unavailable', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('network fetch used by the media service'); });
  const { origin, downstream } = await serve(t);
  const http = (path, type, bytes) => new Promise((resolve, reject) => {
    const req = request(origin + path, { method: 'POST', headers: { origin, 'content-type': type } }, resolve);
    req.on('error', reject);
    req.end(bytes);
  });
  for (const [path, type, bytes] of [[receiptPath, 'image/png', png], [speechPath, 'audio/wav', wav()]]) {
    const res = await http(path, type, bytes);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.match(body.requestId, uuid);
    if (path === receiptPath) {
      assert.deepEqual(Object.keys(body), ['requestId', 'merchant', 'date', 'totalWon', 'items']);
      assert.equal(body.merchant.needsReview, true);
      assert.equal(body.items[0].quantity, null);
      assert.ok(body.totalWon.value > 0);
    } else {
      assert.deepEqual(body, { requestId: body.requestId, text: '딸기스무디 메뉴 추가해줘' });
    }
  }
  assert.deepEqual(downstream, []);
});

test('receipt wire uses multipart V2 and maps only reviewed expense fields', async t => {
  const { origin } = await serve(t, { now: () => stamp, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/document/receipt');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const request = new Request(url, init);
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    const form = await request.formData();
    assert.deepEqual([...form.keys()].sort(), ['file', 'message']);
    const message = JSON.parse(form.get('message'));
    assert.match(message.requestId, uuid);
    assert.deepEqual(message, { version: 'V2', requestId: message.requestId, timestamp: stamp,
      images: [{ format: 'png', name: message.requestId }] });
    const photo = form.get('file');
    assert.equal(photo.type, 'image/png');
    assert.equal(photo.name, `${message.requestId}.png`);
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
    return Response.json({ requestId: 'provider-id', images: [{ inferResult: 'SUCCESS', receipt: { result: {
      storeInfo: { name: { text: ' 예시상점 ', confidenceScore: 0.80 }, tel: { text: 'hidden' } },
      paymentInfo: { date: { formatted: { year: '2026', month: '2', day: '29' } }, cardInfo: { number: 'hidden' } },
      totalPrice: { price: { formatted: { value: '12000' } } },
      subResults: [{ items: [
        { name: { text: '원두', confidenceScore: 0.79 }, count: { text: '2', confidenceScore: 0.9 }, price: { price: { text: '₩ 6,000', confidenceScore: 0.9 } } },
        { name: { text: '우유', confidenceScore: '0.9' }, count: { text: '잡음' }, price: { price: { text: '-1.2' } } },
        { name: { text: ' ' } },
      ] }],
    } } }] });
  } });
  const res = await post(origin);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.match(json.requestId, uuid);
  assert.deepEqual(json, {
    requestId: json.requestId, merchant: { value: '예시상점', needsReview: false },
    date: null, totalWon: { value: 12000, needsReview: true },
    items: [
      { name: { value: '원두', needsReview: true }, quantity: { value: 2, needsReview: false }, amountWon: { value: 6000, needsReview: false } },
      { name: { value: '우유', needsReview: true }, quantity: null, amountWon: null },
    ],
  });
});

test('short speech wire uses fixed Korean URL and sends the original WAV bytes', async t => {
  const bytes = wav(60 * 16_000, true);
  const { origin } = await serve(t, { fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://clovaspeech-gw.ncloud.com/recog/v1/stt?lang=Kor');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/octet-stream');
    assert.deepEqual(init.body, bytes);
    return Response.json({ text: '  말한 문장  ', quota: 4, internal: 'hidden' });
  } });
  const response = await post(origin, speechPath, bytes, 'audio/wav');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.requestId, uuid);
  assert.deepEqual(body, { requestId: body.requestId, text: '말한 문장' });
});

test('requests reject invalid bytes, mismatched MIME and actual duration and size before recognition', async t => {
  let calls = 0;
  const { origin } = await serve(t, { fetchImpl: () => { calls++; } });
  const invalidWav = wav();
  invalidWav.writeUInt16LE(2, 22);
  const shortRiff = wav();
  shortRiff.writeUInt32LE(100_000, 40);
  const cases = [
    [receiptPath, Buffer.alloc(0), 'image/png', 400, 'BAD_REQUEST'],
    [receiptPath, Buffer.from('png?'), 'image/png', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [receiptPath, png.subarray(0, 32), 'image/png', 400, 'BAD_REQUEST'],
    [receiptPath, png, 'image/jpeg', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [speechPath, png, 'audio/wav', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [speechPath, invalidWav, 'audio/wav', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [speechPath, shortRiff, 'audio/wav', 400, 'BAD_REQUEST'],
    [speechPath, wav(0), 'audio/wav', 400, 'BAD_REQUEST'],
    [speechPath, wav(960_001), 'audio/wav', 413, 'PAYLOAD_TOO_LARGE'],
  ];
  for (const [path, body, type, status, error] of cases) {
    await checkError(await post(origin, path, body, type), status, error);
  }
  assert.equal(calls, 0);
});

test('oversized declared lengths are rejected before the first body byte', async t => {
  const { origin } = await serve(t, { fetchImpl: () => { assert.fail('overflow reached provider'); } });
  for (const [path, type, length] of [[receiptPath, 'image/png', 5_000_001], [speechPath, 'audio/wav', 10_000_001]]) {
    const res = await new Promise((resolve, reject) => {
      const req = request(origin + path, {
        method: 'POST', headers: { origin, 'content-type': type, 'content-length': length },
      }, resolve);
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, 'close');
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).error, 'PAYLOAD_TOO_LARGE');
  }
});

test('chunked uploads are bounded without trusting an advertised length', async t => {
  const { origin } = await serve(t, { fetchImpl: () => { assert.fail('overflow reached provider'); } });
  const megabyte = Buffer.alloc(1_000_000);
  for (const [path, type, maxMb] of [[receiptPath, 'image/png', 5], [speechPath, 'audio/wav', 10]]) {
    const res = await new Promise((resolve, reject) => {
      const req = request(origin + path, { method: 'POST', headers: { origin, 'content-type': type } }, resolve);
      req.on('error', reject);
      for (let i = 0; i < maxMb; i++) req.write(megabyte);
      req.end(Buffer.alloc(1));
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, 'close');
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).error, 'PAYLOAD_TOO_LARGE');
  }
});

test('rejects cross-origin or cross-site uploads and other methods before provider I/O', async t => {
  const { origin, downstream } = await serve(t, { fetchImpl: () => assert.fail('unexpected provider call') });
  await checkError(await post(origin, receiptPath, png, 'image/png', { headers: { origin: 'https://foreign.invalid' } }), 403, 'FORBIDDEN');
  const crossSite = await new Promise((resolve, reject) => {
    const req = request(origin + speechPath, { method: 'POST', headers: { origin, 'sec-fetch-site': 'cross-site' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(crossSite.statusCode, 403);
  crossSite.resume();
  const res = await fetch(origin + speechPath);
  assert.equal(res.headers.get('allow'), 'POST');
  await checkError(res, 405, 'METHOD_NOT_ALLOWED');
  assert.equal((await fetch(origin + '/api/navis/chat')).status, 404);
  assert.deepEqual(downstream, ['/api/navis/chat']);
});

test('recognition failure returns only stable error and request ID', async t => {
  const normal = await serve(t);
  await checkError(await post(normal.origin, receiptPath, tinyPng), 422, 'MEDIA_UNREADABLE');
  const replies = [
    { images: [{ inferResult: 'FAILURE', receipt: { result: { storeInfo: { name: { text: 'should be ignored' } } } } }] },
    { images: [{ inferResult: 'SUCCESS', receipt: { result: { totalPrice: { price: { text: '0' } } } } }] },
    { text: '  ' },
  ];
  const { origin } = await serve(t, { fetchImpl: () => Response.json(replies.shift()) });
  await checkError(await post(origin), 422, 'MEDIA_UNREADABLE');
  await checkError(await post(origin), 422, 'MEDIA_UNREADABLE');
  await checkError(await post(origin, speechPath, wav(), 'audio/wav'), 422, 'MEDIA_UNREADABLE');
});

test('provider status maps to safe errors, preserves valid Retry-After and makes one attempt', async t => {
  let calls = 0;
  const responses = [
    new Response('private provider error', { status: 429, headers: { 'Retry-After': '30' } }),
    new Response('private provider error', { status: 429, headers: { 'Retry-After': 'private' } }),
    new Response('private provider error', { status: 502 }),
    new Response('invalid JSON with private value', { status: 200 }),
  ];
  const { origin } = await serve(t, { fetchImpl: () => { calls++; return responses.shift(); } });
  const res = await post(origin);
  assert.equal(res.headers.get('retry-after'), '30');
  await checkError(res, 429, 'RATE_LIMITED');
  const invalid = await post(origin);
  assert.equal(invalid.headers.get('retry-after'), null);
  await checkError(invalid, 429, 'RATE_LIMITED');
  await checkError(await post(origin), 503, 'UNAVAILABLE');
  await checkError(await post(origin), 503, 'UNAVAILABLE');
  assert.equal(calls, 4);
});

test('local deadline aborts the provider, responds once and releases the lane', async t => {
  const signals = [];
  const { origin } = await serve(t, { timeoutMs: 40, fetchImpl: (_url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise(() => {});
    return Response.json({ text: '다시 시도' });
  } });
  await checkError(await post(origin, speechPath, wav(), 'audio/wav'), 504, 'TIMEOUT');
  assert.equal(signals[0].aborted, true);
  assert.equal((await post(origin, speechPath, wav(), 'audio/wav')).status, 200);
  assert.equal(signals.length, 2);
});

test('busy same-service lane and disconnect abort upstream without falling through', async t => {
  let start, cancel;
  const started = new Promise(resolve => { start = resolve; });
  const cancelled = new Promise(resolve => { cancel = resolve; });
  let calls = 0;
  const { origin, downstream } = await serve(t, { fetchImpl: (_url, { signal }) => {
    if (++calls > 1) return Response.json({ text: '재시도' });
    start();
    signal.addEventListener('abort', cancel, { once: true });
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const first = post(origin, speechPath, wav(), 'audio/wav', { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await started;
  await checkError(await post(origin, speechPath, wav(), 'audio/wav'), 429, 'RATE_LIMITED');
  controller.abort();
  await rejected;
  await cancelled;
  assert.equal((await post(origin, speechPath, wav(), 'audio/wav')).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(downstream, []);
});

test('disconnect during upload releases the lane without starting recognition', async t => {
  let calls = 0;
  const { origin, server } = await serve(t, { fetchImpl: () => { calls++; return Response.json({ text: 'retry' }); } });
  const incoming = once(server, 'request');
  const req = request(origin + speechPath, { method: 'POST', headers: { 'content-type': 'audio/wav', origin } });
  req.on('error', () => {});
  req.write(wav().subarray(0, 50));
  const [upload] = await incoming;
  const closed = new Promise(resolve => upload.once('close', resolve));
  req.destroy();
  await closed;
  assert.equal(calls, 0);
  assert.equal((await post(origin, speechPath, wav(), 'audio/wav')).status, 200);
  assert.equal(calls, 1);
});

test('valid JPEG and RIFF ancillary chunks are accepted', () => {
  // A small JPEG with a baseline frame, scan and end marker.
  const jpeg = Buffer.from('ffd8ffc0000b080002000201011100ffda0008010100003f0042ffd9', 'hex');
  assert.deepEqual(validateMedia('receipt', 'image/jpeg', jpeg), { format: 'jpg', width: 2, height: 2 });
  assert.deepEqual(validateMedia('speech', 'audio/wav', wav(8000, true)), { durationSeconds: 0.5 });
});

test('Node preview mounts both fake routes ahead of the bridge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'storesaas-media-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preview = await startPreview({ root, port: 0 });
  t.after(async () => {
    preview.stop();
    await once(preview, 'close');
  });
  const origin = `http://127.0.0.1:${preview.address().port}`;
  assert.equal((await post(origin)).status, 200);
  assert.equal((await post(origin, speechPath, wav(), 'audio/wav')).status, 200);
});

test('live smoke stays pending without approval or relevant credentials and performs zero attempts', async () => {
  const fetchImpl = () => assert.fail('no call allowed');
  const env = new Proxy({}, { get: () => assert.fail('read credentials before approval') });
  const unapproved = await runSmoke({ service: 'receipt', approved: false, env, fetchImpl });
  assert.equal(unapproved.outcome, 'pending');
  assert.equal(unapproved.reason, 'APPROVAL_REQUIRED');
  assert.equal(unapproved.outboundCalls, 0);
  for (const service of ['receipt', 'speech']) {
    const missing = await runSmoke({ service, approved: true, env: {}, fetchImpl });
    assert.equal(missing.outcome, 'pending');
    assert.equal(missing.reason, 'CREDENTIALS_REQUIRED');
    assert.equal(missing.outboundCalls, 0);
  }
});

test('approved smoke boundary records one simulated attempt per service and only summary metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'storesaas-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = join(root, 'receipt.png');
  const speech = join(root, 'speech.wav');
  await writeFile(receipt, png);
  await writeFile(speech, wav());
  const credentialSentinel = ['fixture', 'credential'].join('-');
  const env = {
    CLOVA_OCR_RECEIPT_INVOKE_URL: 'https://fake.invalid/approved/document/receipt',
    CLOVA_OCR_RECEIPT_SECRET: credentialSentinel,
    CLOVA_SPEECH_SHORT_SECRET: credentialSentinel,
  };
  for (const [service, fixturePath, header, response] of [
    ['receipt', receipt, 'X-OCR-SECRET', Response.json({ images: [{ inferResult: 'SUCCESS', receipt: { result: { storeInfo: { name: { text: 'synthetic' } } } } }] })],
    ['speech', speech, 'X-CLOVASPEECH-API-KEY', Response.json({ text: 'synthetic', quota: 2 })],
  ]) {
    let calls = 0;
    const report = await runSmoke({ service, fixturePath, approved: true, env, fetchImpl: (url, init) => {
      calls++;
      assert.equal(String(url), service === 'receipt' ? env.CLOVA_OCR_RECEIPT_INVOKE_URL : 'https://clovaspeech-gw.ncloud.com/recog/v1/stt?lang=Kor');
      const headers = new Headers(init.headers);
      assert.equal(headers.get(header), credentialSentinel);
      assert.equal(init.redirect, 'error');
      assert.ok(Buffer.isBuffer(init.body));
      assert.equal(headers.get('content-length'), String(init.body.length));
      if (service === 'receipt') assert.match(headers.get('content-type'), /^multipart\/form-data; boundary=/);
      else assert.deepEqual(init.body, wav());
      return response;
    } });
    assert.equal(calls, 1);
    assert.equal(report.outboundCalls, 1);
    assert.equal(report.outcome, 'succeeded');
    assert.match(report.requestId, uuid);
    assert.ok(report.elapsedMs >= 0);
    assert.equal(report.service, service);
    if (service === 'speech') {
      assert.equal(report.durationSeconds, 1);
      assert.equal(report.providerQuota, 2);
      assert.equal(report.estimatedChargeWon, 4);
    } else {
      assert.equal(report.estimatedPhotoUnits, 1);
    }
    assert.doesNotMatch(JSON.stringify(report), /synthetic|fake\.invalid|credential|\.wav|\.png/);
  }
  const skipped = await runSmoke({ service: 'receipt', fixturePath: receipt, approved: true,
    env: { ...env, CLOVA_OCR_RECEIPT_INVOKE_URL: 'http://fake.invalid/document/receipt' }, fetchImpl: () => assert.fail('invalid URL used') });
  assert.equal(skipped.outboundCalls, 0);
  assert.equal(skipped.reason, 'UNAVAILABLE');
  const redirected = await runSmoke({ service: 'speech', fixturePath: speech, approved: true, env,
    fetchImpl: () => Response.redirect('https://fake.invalid/redirect') });
  assert.equal(redirected.outboundCalls, 1);
  assert.equal(redirected.reason, 'UNAVAILABLE');
  const misdirected = await runSmoke({ service: 'speech', fixturePath: speech, approved: true, env,
    fetchImpl: () => new Response(null, { status: 421 }) });
  assert.equal(misdirected.outboundCalls, 1);
  assert.equal(misdirected.reason, 'UNAVAILABLE');
  const emptySpeech = await runSmoke({ service: 'speech', fixturePath: speech, approved: true, env,
    fetchImpl: () => Response.json({ text: ' ', quota: '1.5' }) });
  assert.equal(emptySpeech.outboundCalls, 1);
  assert.equal(emptySpeech.reason, 'MEDIA_UNREADABLE');
  assert.equal(emptySpeech.providerQuota, 1.5);
});
