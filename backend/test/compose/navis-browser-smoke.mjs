import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.argv[2] ?? 'http://127.0.0.1:18180';
const browser = { 'sec-fetch-site': 'same-origin' };
const json = { ...browser, origin, 'content-type': 'application/json' };
const condition = { kind: 'default' };
const chatBody = {
  runId: randomUUID(), snapshotRevision: 1, locale: 'ko', layer: 'management', businessDate: '2026-11-21',
  intent: { kind: 'read', featureId: 'ledger', condition }, slots: [], searches: [],
  catalog: [{ id: 'ledger', name: '손익', layer: 'management', conditions: [condition] }],
  snapshot: [{ featureId: 'ledger', condition, facts: [
    { key: 'ledger.revenue', label: '매출', value: 1284000, unit: 'KRW', display: '128.4만 원', date: '2026-11-21' },
  ] }],
};

const hit = (path, init = {}) => fetch(new URL(path, origin), { signal: AbortSignal.timeout(15_000), ...init });
const chat = await hit('/api/navis/chat', {
  method: 'POST', body: JSON.stringify(chatBody), headers: { ...json, 'x-navis-protocol': 'agent-v1' },
});
assert.equal(chat.status, 200);
assert.equal(chat.headers.get('x-navis-protocol'), 'agent-v1');
assert.equal(chat.headers.get('x-navis-agent-mode'), 'fixture');
assert.match(chat.headers.get('content-type') ?? '', /^text\/event-stream/);
const frames = [];
const decoder = new TextDecoder();
let pending = '';
for await (const chunk of chat.body) {
  pending += decoder.decode(chunk, { stream: true });
  const complete = pending.split('\n\n');
  pending = complete.pop();
  frames.push(...complete.filter(frame => frame.startsWith('event: ')));
}
const firstText = frames.findIndex(frame => /^event: text_delta\ndata:.*128\.4만 원/.test(frame));
assert.ok(firstText >= 0);
assert.ok(frames.findIndex(frame => frame.startsWith('event: done\n')) > firstText);
assert.ok(!frames.some(frame => frame.startsWith('event: action_proposal\n')));
console.log('Navis fake chat streamed Korean text and completed through edge and gateway.');

const wrongMethod = await hit('/api/navis/chat', { headers: browser });
assert.equal(wrongMethod.status, 405);
assert.equal((await wrongMethod.json()).code, 'METHOD_NOT_ALLOWED');

const drafts = await hit('/api/navis/widget-drafts', {
  method: 'POST', headers: json, body: JSON.stringify({ widget: 'ai-response', sampleId: 'th-4' }),
});
assert.equal(drafts.status, 200);
assert.ok((await drafts.json()).draftId);
assert.match(drafts.headers.get('set-cookie') ?? '', /^navis_demo_session=/);
const media = await hit('/api/navis/media/receipt-ocr', {
  method: 'POST', headers: { ...browser, origin, 'content-type': 'application/octet-stream' }, body: new Uint8Array([42]),
});
assert.equal(media.status, 415);
assert.equal((await media.json()).error, 'UNSUPPORTED_MEDIA_TYPE');
console.log('Insight-navis served a widget draft and validated a raw media request.');

const promo = await hit('/api/promo/catalog', { headers: browser });
assert.equal(promo.status, 200);
const { photos } = await promo.json();
assert.ok(photos.length > 0);
const photo = await hit(photos[0].url, { method: 'HEAD', headers: browser });
assert.equal(photo.status, 200);
assert.equal(photo.headers.get('content-type'), 'image/jpeg');
assert.ok(Number(photo.headers.get('content-length')) > 0);
console.log('Marketing served the promo catalog and photo headers through edge and gateway.');

const foreign = await hit('/api/navis/chat', {
  method: 'POST', headers: { ...json, origin: 'https://other.invalid' }, body: '{}',
});
assert.equal(foreign.status, 403);
await foreign.body?.cancel();
console.log('The gateway rejected a different browser origin.');
