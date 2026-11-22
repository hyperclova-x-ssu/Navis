import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClovaStudio } from './clova-studio.mjs';

const frame = (event, data) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
const result = { message: { role: 'assistant', content: '안녕' }, finishReason: 'stop' };
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
function response(chunks, onCancel = () => {}, headers = {}) {
  return new Response(new ReadableStream({ start(c) { chunks.forEach(chunk => c.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)); c.close(); }, cancel: onCancel }), { headers: { 'content-type': 'text/event-stream', ...headers } });
}
class Clock {
  time = 0; next = 0; timers = new Map();
  setTimeout = (fn, delay) => { const id = ++this.next; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  tick(ms) { const until = this.time + ms; for (;;) { const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); } this.time = until; }
}
const pump = () => new Promise(resolve => setImmediate(resolve));
const rateLimit = headers => new Response(JSON.stringify({ status: { code: '42901', message: 'private upstream details' } }), { status: 429, headers });

test('AI Filter waits for the final result and meters a refused completion', async () => {
  const seen = [], calls = [], events = [];
  const client = createClovaStudio({ apiKey: 'fake', fetchImpl: async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return response([
      frame('token', { message: { role: 'assistant', content: 'withheld' } }),
      frame('result', { ...result, aiFilter: [{ score: '1', result: 'OK' }],
        usage: { promptTokens: 15, completionTokens: 4, totalTokens: 19 } }),
    ]);
  } });
  await assert.rejects(async () => {
    for await (const event of client.complete({ messages: [], maxTokens: 1024, includeAiFilters: true,
      onProviderCall: call => calls.push(call) })) events.push(event);
  }, { code: 'AI_FILTER' });
  assert.deepEqual(events, []);
  assert.equal(seen[0].includeAiFilters, true);
  assert.deepEqual(calls.map(({ promptTokens, completionTokens, totalTokens, outcome }) =>
    [promptTokens, completionTokens, totalTokens, outcome]), [[15, 4, 19, 'filtered']]);
});

test('AI Filter is requested for structured output and omitted for native function exchanges', async () => {
  const seen = [];
  const client = createClovaStudio({ apiKey: 'fake', model: 'HCX-007', fetchImpl: async (_url, { headers, body }) => {
    seen.push(JSON.parse(body));
    return headers.Accept === 'application/json'
      ? Response.json({ status: { code: '20000' }, result: { ...result, aiFilter: [{ score: '2' }] } })
      : response([frame('result', result)]);
  } });
  const args = { messages: [], maxTokens: 1024, includeAiFilters: true };
  assert.equal((await collect(client.complete({ ...args, responseFormat: { type: 'json', schema: { type: 'object' } } }))).length, 1);
  await collect(client.complete({ ...args, tools: [], toolChoice: 'none' }));
  await collect(client.complete({ ...args, messages: [{ role: 'tool', content: '{}', toolCallId: 'call-1' }] }));
  assert.deepEqual(seen.map(body => body.includeAiFilters), [true, undefined, undefined]);
});

test('Navis token calibration uses four bounded requests and reports only counts', async () => {
  const { calibrateNavisTokens, navisTokenCalibrationPlan } = await import('./dev/navis-token-calibration.mjs');
  const plan = navisTokenCalibrationPlan();
  const seen = [];
  const rows = await calibrateNavisTokens({ apiKey: 'fake', fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    seen.push({ url, request, options });
    const base = { type: 'text', count: 11, text: 'private-response-text' };
    const messages = request.messages.map(({ role, content }) => ({ role, content: Array.isArray(content)
      ? [{ type: 'image_url', count: 29 }, { ...base }] : base }));
    return Response.json({ status: { code: '20000' }, result: {
      messages,
      ...(request.tools && { tools: { count: 37 } }),
      ...(request.responseFormat && { responseFormat: { count: 43 } }),
    } });
  } });
  assert.deepEqual(plan.map(({ mode, model }) => [mode, model]), [
    ['text', 'HCX-005'], ['function_calling', 'HCX-005'], ['structured_output', 'HCX-007'], ['image', 'HCX-005'],
  ]);
  assert.equal(seen.length, 4);
  assert.equal(seen[1].request.toolChoice.function.name, seen[1].request.tools[0].function.name);
  assert.equal(seen[2].request.responseFormat.type, 'json');
  const image = Buffer.from(seen[3].request.messages.at(-1).content[0].dataUri.data.replace(/^data:image\/png;base64,/u, ''), 'base64');
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [16, 16]);
  for (const [index, { url, request, options }] of seen.entries()) {
    assert.equal(url, `https://clovastudio.stream.ntruss.com/v3/api-tools/chat-tokenize/${plan[index].model}`);
    assert.equal(options.redirect, 'error');
    assert.equal(Object.hasOwn(request, 'maxTokens'), false);
  }
  assert.deepEqual(rows.map(row => [row.messageTokens, row.toolTokens, row.schemaTokens, row.tokenizedInputTokens]), [
    [22, 0, 0, 22], [22, 37, 0, 59], [22, 0, 43, 65], [51, 0, 0, 51],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /private-response-text|base64|Bearer/u);
});

test('caller can reserve budget for each rate limit attempt before starting fetch', async () => {
  const clock = new Clock();
  let fetches = 0, reservations = 0;
  const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => {
    fetches++;
    return rateLimit({ 'retry-after': '1s' });
  } });
  const pending = assert.rejects(collect(client.complete({
    messages: [], maxTokens: 1024,
    onAttempt: () => { if (++reservations === 2) throw Object.assign(new Error('budget'), { code: 'UNAVAILABLE' }); },
  })), { code: 'UNAVAILABLE' });
  await pump();
  assert.equal(reservations, 1);
  clock.tick(1000);
  await pending;
  assert.deepEqual([reservations, fetches], [2, 1]);
});

test('native v3 uses bearer authorization, defaults, explicit tools and token caps without compatibility fields', async () => {
  const seen = [];
  const client = createClovaStudio({ apiKey: 'fake-sentinel', fetchImpl: async (url, options) => { seen.push({ url, ...options }); return response([frame('result', result)]); } });
  const controller = new AbortController();
  const messages = [{ role: 'system', content: 'instruction' }, { role: 'user', content: 'data' }];
  await collect(client.complete({ messages, maxTokens: 300, signal: controller.signal }));
  const tools = [{ type: 'function', function: { name: 'select_panels', parameters: { type: 'object' } } }];
  const toolChoice = { type: 'function', function: { name: 'select_panels' } };
  await collect(client.complete({ messages, tools, toolChoice, maxTokens: 1024, signal: controller.signal }));
  assert.equal(seen[0].url, 'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-005');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers.Authorization, 'Bearer fake-sentinel');
  assert.equal(seen[0].headers.Accept, 'text/event-stream');
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].redirect, 'error');
  assert.deepEqual(JSON.parse(seen[0].body), { messages, maxTokens: 300 });
  assert.deepEqual(JSON.parse(seen[1].body), { messages, maxTokens: 1024, tools, toolChoice });
});

test('decodes UTF-8 byte splits, CRLF boundaries, multiline data, comments and consecutive frames', async () => {
  const raw = ':heartbeat\r\nevent:token\r\ndata:{"message":\r\ndata:{"role":"assistant","content":"안녕"}}\r\n\r\n' + frame('result', result);
  const bytes = new TextEncoder().encode(raw);
  const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
  const client = createClovaStudio({ apiKey: 'fake', baseUrl: 'https://fake.invalid///', model: 'HCX-005', fetchImpl: async () => response(chunks) });
  const events = await collect(client.complete({ messages: [], maxTokens: 300 }));
  assert.deepEqual(events.map(e => e.event), ['token', 'result']);
  assert.equal(events[0].data.message.content, '안녕');
});

test('normalizes network, non-2xx and upstream errors without exposing upstream bodies', async () => {
  for (const fetchImpl of [async () => { throw Error('private upstream detail'); }, async () => new Response('private', { status: 401 }), async () => response([frame('error', { status: { code: '42900', message: 'private' } })])]) {
    const client = createClovaStudio({ apiKey: 'fake', fetchImpl });
    await assert.rejects(collect(client.complete({ messages: [], maxTokens: 300 })), error => error.code === 'UNAVAILABLE' && !error.message.includes('private'));
  }
});

test('provider diagnostics keep HTTP status and only documented numeric error codes', async () => {
  const providerError = code => ({ status: { code, message: 'private upstream detail' } });
  const jsonError = (status, code) => globalThis.Response.json(providerError(code), { status });
  for (const [fetchImpl, httpStatus, providerCode] of [
    [async () => jsonError(401, '40103'), 401, '40103'],
    [async () => jsonError(403, 40300), 403, '40300'],
    [async () => jsonError(429, '42901'), 429, '42901'],
    [async () => jsonError(500, 'private upstream detail'), 500, null],
    [async () => new globalThis.Response('a'.repeat(128 * 1024 + 1), { status: 502 }), 502, null],
    [async () => response([frame('error', providerError('40400'))]), 200, '40400'],
    [async () => { throw Error('private upstream detail'); }, null, null],
  ]) {
    const records = [];
    const client = createClovaStudio({ apiKey: 'fake', fetchImpl });
    await assert.rejects(collect(client.complete({ messages: [], maxTokens: 2048, retryRateLimit: false,
      onProviderCall: record => records.push(record) })), { code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].httpStatus, records[0].providerCode], [httpStatus, providerCode]);
    assert.doesNotMatch(JSON.stringify(records), /private upstream detail/u);
  }
});

test('rejects malformed JSON, UTF-8, incomplete frames, non-SSE and bounded output', async () => {
  for (const res of [response(['event:token\ndata:no-json\n\n']), response([Uint8Array.of(0xff)]), response(['event:result\ndata:{}']), new Response('{}'), response([' '.repeat(128 * 1024 + 1)])]) {
    const client = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => res });
    await assert.rejects(collect(client.complete({ messages: [], maxTokens: 300 })), { code: 'INVALID_OUTPUT' });
  }
});

test('missing or invalid configuration makes zero upstream calls', async () => {
  let calls = 0;
  for (const config of [{ apiKey: '' }, { apiKey: '  ' }, { apiKey: 'fake', baseUrl: 'not a url' }]) {
    const client = createClovaStudio({ ...config, fetchImpl: async () => { calls++; } });
    assert.equal(client.available, false);
    await assert.rejects(collect(client.complete({ messages: [], maxTokens: 300 })), { code: 'UNAVAILABLE' });
  }
  assert.equal(calls, 0);
});

test('abort cancels a pending reader and settles even when fetch ignores its signal', async () => {
  let cancelled = 0;
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const pending = collect(client.complete({ messages: [], maxTokens: 300, signal: controller.signal }));
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 1);
  const second = new AbortController();
  const stuck = createClovaStudio({ apiKey: 'fake', fetchImpl: () => new Promise(() => {}) });
  const waiting = collect(stuck.complete({ messages: [], maxTokens: 300, signal: second.signal }));
  second.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('HTTP 42901 retries once after the greater request/token reset and keeps request configuration', async () => {
  const clock = new Clock(); const calls = [];
  const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return calls.length === 1 ? rateLimit({ 'x-ratelimit-reset-requests': '1500ms', 'x-ratelimit-reset-tokens': '2s' }) : response([frame('result', result)]); } });
  const controller = new AbortController();
  const pending = collect(client.complete({ messages: [{ role: 'user', content: 'fake question' }], maxTokens: 2048, signal: controller.signal }));
  await pump(); assert.equal(calls.length, 1); assert.equal(clock.timers.size, 1);
  clock.tick(1999); await pump(); assert.equal(calls.length, 1);
  clock.tick(1); const events = await pending;
  assert.deepEqual(events, [{ event: 'result', data: result }]); assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body); assert.deepEqual(calls[0].headers, calls[1].headers); assert.equal(calls[1].signal, controller.signal);
  assert.equal(clock.timers.size, 0);
});

test('SSE 42901 uses response reset headers before retrying once', async () => {
  const clock = new Clock(); let calls = 0;
  const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => ++calls === 1 ? response([frame('error', { status: { code: '42901', message: 'private' } })], undefined, { 'x-ratelimit-reset-tokens': '0.5s' }) : response([frame('result', result)]) });
  const pending = collect(client.complete({ messages: [], maxTokens: 1024 })); await pump();
  clock.tick(499); await pump(); assert.equal(calls, 1);
  clock.tick(1); assert.equal((await pending).at(-1).event, 'result'); assert.equal(calls, 2); assert.equal(clock.timers.size, 0);
});

test('missing or malformed reset uses two seconds and a second 42901 becomes fixed UNAVAILABLE', async () => {
  for (const headers of [{}, { 'x-ratelimit-reset-tokens': 'invalid' }]) {
    const clock = new Clock(); let calls = 0;
    const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => { calls++; return rateLimit(headers); } });
    const pending = collect(client.complete({ messages: [], maxTokens: 2048 }));
    const checked = assert.rejects(pending, error => error.code === 'UNAVAILABLE' && error.message === 'UNAVAILABLE');
    await pump(); clock.tick(1999); await pump(); assert.equal(calls, 1);
    clock.tick(1); await checked; assert.equal(calls, 2); assert.equal(clock.timers.size, 0);
  }
});

test('only 42901 retries and oversized HTTP error bodies remain bounded', async () => {
  for (const res of [new Response(JSON.stringify({ status: { code: '42900' } }), { status: 429 }), new Response('not JSON', { status: 429 }), new Response('a'.repeat(128 * 1024 + 1), { status: 429 })]) {
    const clock = new Clock(); let calls = 0;
    const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => { calls++; return res; } });
    await assert.rejects(collect(client.complete({ messages: [], maxTokens: 2048 })), error => ['UNAVAILABLE', 'INVALID_OUTPUT'].includes(error.code));
    assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
  }
});

test('abort during retry delay clears its timer and prevents a later second request', async () => {
  const clock = new Clock(); let calls = 0; const controller = new AbortController();
  const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => { calls++; return rateLimit({ 'x-ratelimit-reset-tokens': '2s' }); } });
  const pending = collect(client.complete({ messages: [], maxTokens: 2048, signal: controller.signal }));
  await pump(); assert.equal(clock.timers.size, 1); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(clock.timers.size, 0);
  clock.tick(5000); await pump(); assert.equal(calls, 1);
});

test('42901 after a forwarded text or tool token is not retried', async () => {
  for (const message of [{ role: 'assistant', content: '받은 글' }, { role: 'assistant', content: '', toolCalls: [{ function: { partialJson: '{' } }] }]) {
    const clock = new Clock(); let calls = 0; const events = [];
    const client = createClovaStudio({ apiKey: 'fake', clock, fetchImpl: async () => { calls++; return response([frame('token', { message }), frame('error', { status: { code: '42901' } })]); } });
    await assert.rejects(async () => { for await (const event of client.complete({ messages: [], maxTokens: 2048 })) events.push(event); }, { code: 'UNAVAILABLE' });
    assert.deepEqual(events, [{ event: 'token', data: { message } }]);
    assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
  }
});

// CLOVA Studio documents 40009 as "Unsupported function"; it showed up now and then on requests that normally work (gate stack, HTTP 200
// with an error event), so one immediate retry is made before any text is emitted. A second 40009 stays UNAVAILABLE.
test('an SSE 40009 before any text is retried once right away and a second 40009 stays UNAVAILABLE', async () => {
  let calls = 0;
  const unsupported = () => response([frame('error', { status: { code: '40009', message: 'private' } })]);
  const client = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => ++calls === 1 ? unsupported() : response([frame('result', result)]) });
  assert.deepEqual(await collect(client.complete({ messages: [], maxTokens: 64 })), [{ event: 'result', data: result }]);
  assert.equal(calls, 2);
  calls = 0;
  const failing = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => { calls++; return unsupported(); } });
  await assert.rejects(collect(failing.complete({ messages: [], maxTokens: 64 })), error => error.code === 'UNAVAILABLE');
  assert.equal(calls, 2);
});

test('a JSON-mode 40009 is retried once, and a different 4xx code is not', async () => {
  let calls = 0;
  const body = code => JSON.stringify({ status: { code, message: 'private' } });
  const jsonMode = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => ++calls === 1
    ? new Response(body('40009'), { headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ status: { code: '20000' }, result }), { headers: { 'content-type': 'application/json' } }) });
  assert.equal((await collect(jsonMode.complete({ messages: [], maxTokens: 64, jsonResponse: true }))).at(-1).event, 'result');
  assert.equal(calls, 2);
  calls = 0;
  const other = createClovaStudio({ apiKey: 'fake', fetchImpl: async () => { calls++; return new Response(body('40001'), { status: 400, headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(collect(other.complete({ messages: [], maxTokens: 64, jsonResponse: true, onProviderCall() {} })), error => error.code === 'UNAVAILABLE');
  assert.equal(calls, 1);
});

// A side request (classify, compose) has a short budget: it waits for a rate-limit reset only when the reset fits, and never longer.
test('a numeric retryRateLimit retries a 42901 only when the reset fits inside that many milliseconds', async () => {
  const fits = new Clock(); let calls = 0;
  const client = createClovaStudio({ apiKey: 'fake', clock: fits, fetchImpl: async () => ++calls === 1 ? rateLimit({ 'x-ratelimit-reset-requests': '1s' }) : response([frame('result', { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: {} })]) });
  const pending = collect(client.complete({ messages: [], maxTokens: 64, retryRateLimit: 3000 })); await pump();
  assert.equal(calls, 1); fits.tick(1000); assert.equal((await pending).at(-1).event, 'result'); assert.equal(calls, 2);
  const tooLong = new Clock(); let longCalls = 0;
  const slow = createClovaStudio({ apiKey: 'fake', clock: tooLong, fetchImpl: async () => { longCalls++; return rateLimit({ 'x-ratelimit-reset-requests': '10s' }); } });
  await assert.rejects(collect(slow.complete({ messages: [], maxTokens: 64, retryRateLimit: 3000 })), error => error.code === 'UNAVAILABLE');
  assert.equal(longCalls, 1); assert.equal(tooLong.timers.size, 0);
});
