import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIntent, classifyMessages, CLASSIFY_SCHEMA } from './classify.mjs';
import { AGENT_PROTOCOL, validateAgentFrame, validateAgentRequest, validateIntentPlan } from '../../shared/navis-agent-schema.mjs';

const widgets = ['ledger|손익|매출,지출,원가,순이익', 'margin|마진|메뉴별 판매 수량,마진율', 'booking|예약|오늘 예약,취소'];
const envelope = (intent = {}) => ({
  runId: 'classify-1', snapshotRevision: 1, locale: 'ko', layer: 'management', businessDate: '2026-11-22',
  intent: { kind: 'classify', text: '저번 달이랑 이번 달 지출 비교해줘', widgets, ...intent },
  slots: [], catalog: [], snapshot: [], searches: [],
});

test('a classify request is a valid agent request that carries only the sentence, the widget list and an optional previous turn', () => {
  assert.equal(validateAgentRequest(envelope()), true);
  assert.equal(validateAgentRequest(envelope({ previous: '오늘 예약 몇 팀이야? → 예약' })), true);
  assert.equal(validateAgentRequest(envelope({ text: '   ' })), false);
  assert.equal(validateAgentRequest(envelope({ text: 'x'.repeat(241) })), false);
  assert.equal(validateAgentRequest(envelope({ widgets: [] })), false);
  assert.equal(validateAgentRequest(envelope({ extra: true })), false);
  assert.equal(validateAgentRequest({ ...envelope(), snapshot: [{ featureId: 'ledger', condition: { kind: 'default' }, facts: [] }] }), true);
});

test('an intent plan accepts bounded reads, a short question or an unsupported mark, and nothing else', () => {
  const read = { featureId: 'ledger', period: 'lastMonth', hints: ['지출'] };
  assert.equal(validateIntentPlan({ kind: 'read', reads: [read, { ...read, period: 'month' }], confidence: 'high' }), true);
  assert.equal(validateIntentPlan({ kind: 'clarify', ask: '어느 기간인가요?' }), true);
  assert.equal(validateIntentPlan({ kind: 'unsupported' }), true);
  assert.equal(validateIntentPlan({ kind: 'read', reads: [], confidence: 'high' }), false);
  assert.equal(validateIntentPlan({ kind: 'read', reads: [read], confidence: 'sure' }), false);
  assert.equal(validateIntentPlan({ kind: 'read', reads: [{ ...read, period: 'someday' }], confidence: 'low' }), false);
  assert.equal(validateIntentPlan({ kind: 'read', reads: Array(5).fill(read), confidence: 'low' }), false);
  assert.equal(validateIntentPlan({ kind: 'read', reads: [read], confidence: 'low', command: 'menu.delete' }), false);
  assert.equal(validateIntentPlan({ kind: 'command', command: 'menu.update' }), false);
  assert.equal(validateAgentFrame('intent_plan', { plan: { kind: 'unsupported' } }), true);
  assert.equal(validateAgentFrame('intent_plan', { plan: { kind: 'write' } }), false);
});

test('the prompt holds the sentence, the widget list and the date, and tells the model it reads and never writes', () => {
  const messages = classifyMessages({ text: '아아 몇 잔 나갔어', widgets, previous: '이번 주 매출 → 손익', businessDate: '2026-11-22' });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /쓰기|바꿔|만들어/u);
  const body = JSON.parse(messages[1].content);
  assert.deepEqual(Object.keys(body).sort(), ['previous', 'text', 'today', 'weekday', 'widgets']);
  assert.equal(body.today, '2026-11-22');
  assert.equal(body.weekday, '일');
  assert.deepEqual(body.widgets[0], { id: 'ledger', name: '손익', holds: '매출,지출,원가,순이익' });
  assert.equal(body.widgets.length, widgets.length);
  assert.equal(CLASSIFY_SCHEMA.type, 'object');
});

function fakeTransport(replies) {
  const calls = [];
  return { calls, available: true, async *complete(options) {
    calls.push(options);
    const reply = replies[calls.length - 1];
    if (reply instanceof Error) throw reply;
    options.onProviderCall?.({ requestId: 'r', promptTokens: 100, completionTokens: 20, totalTokens: 120, latencyMs: 5, outcome: 'success' });
    yield { event: 'result', data: { message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } } };
  } };
}
const input = { text: '저번 달이랑 이번 달 지출 비교해줘', widgets, businessDate: '2026-11-22' };

test('a valid plan comes back once, limited to the widgets the browser listed', async () => {
  const plan = { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: 'lastMonth', hints: ['지출'] }, { featureId: 'ledger', period: 'month', hints: ['지출'] }] };
  const transport = fakeTransport([plan]);
  assert.deepEqual(await classifyIntent({ transport, input }), plan);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].jsonResponse, true);
  assert.equal(transport.calls[0].responseFormat, undefined);
  assert.ok(transport.calls[0].maxTokens <= 400);
});

test('an invalid, unlisted, write-like or failed answer yields no plan, never a guess', async () => {
  const unknownWidget = { kind: 'read', confidence: 'high', reads: [{ featureId: 'secret-widget', period: 'today', hints: [] }] };
  const writeLike = { kind: 'command', command: 'menu.delete' };
  for (const reply of [unknownWidget, writeLike, 'not json at all', '{"kind":"read"}', new Error('upstream failed')]) {
    assert.equal(await classifyIntent({ transport: fakeTransport([reply]), input }), null, JSON.stringify(reply));
  }
  assert.equal(await classifyIntent({ transport: { available: false, async *complete() {} }, input }), null);
});

test('provider diagnostics carry counts only, never the sentence', async () => {
  const seen = [];
  const plan = { kind: 'unsupported' };
  await classifyIntent({ transport: fakeTransport([plan]), input, onProviderCall: call => seen.push(call) });
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen).includes('지출'), false);
});

test('a reply that stops one closing brace early is repaired, and a list of periods becomes one read per period', async () => {
  const half = '{"kind":"read","confidence":"high","reads":[{"featureId":"ledger","period":["lastMonth","month"],"hints":["지출"]},{"featureId":"margin","period":"week","hints":[]}]';
  const plan = await classifyIntent({ transport: fakeTransport([half]), input });
  assert.deepEqual(plan, { kind: 'read', confidence: 'high', reads: [
    { featureId: 'ledger', period: 'lastMonth', hints: ['지출'] }, { featureId: 'ledger', period: 'month', hints: ['지출'] },
    { featureId: 'margin', period: 'week', hints: [] }] });
  const clipped = '{"kind":"clarify","ask":"어느 기간인가요?"';
  assert.deepEqual(await classifyIntent({ transport: fakeTransport([clipped]), input }), { kind: 'clarify', ask: '어느 기간인가요?' });
  // Repair only closes brackets: text that is not JSON, or that would need more than three closers, stays unusable.
  assert.equal(await classifyIntent({ transport: fakeTransport(['{"kind":"read","reads":[[[[[[']), input }), null);
});

test('a plan never grows past four reads after periods are expanded', async () => {
  const wide = { kind: 'read', confidence: 'high', reads: [{ featureId: 'ledger', period: ['today', 'yesterday', 'week'], hints: [] }, { featureId: 'margin', period: ['today', 'week'], hints: [] }] };
  assert.equal(await classifyIntent({ transport: fakeTransport([wide]), input }), null);
});

test('a feature id that carries the entry name after a bar is read as the id before it', async () => {
  const copied = { kind: 'read', confidence: 'high', reads: [{ featureId: 'margin|마진', period: 'week', hints: ['아메리카노'] }] };
  assert.deepEqual((await classifyIntent({ transport: fakeTransport([copied]), input })).reads[0].featureId, 'margin');
});

test('a period written in the model\'s own words is mapped to the fixed list and an unknown one reads as default', async () => {
  const wording = { kind: 'read', confidence: 'high', reads: [
    { featureId: 'booking', period: 'this_month', hints: ['부가세'] }, { featureId: 'ledger', period: 'Last-Week', hints: [] },
    { featureId: 'margin', period: '지난달', hints: [] }, { featureId: 'ledger', period: 'sometime in spring', hints: [] }] };
  const plan = await classifyIntent({ transport: fakeTransport([wording]), input });
  assert.deepEqual(plan.reads.map(read => read.period), ['month', 'lastWeek', 'lastMonth', 'default']);
});
