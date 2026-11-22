import assert from 'node:assert/strict';
import test from 'node:test';
import { composeAnswer, composeMessages, COMPOSE_MAX_TOKENS } from './compose.mjs';

const lines = ['오늘 매출 48.1만 원', '비교 기간 대비 -33.6%'];
const input = { text: '오늘 매출 어때?', lines, businessDate: '2026-11-22' };

function fakeTransport(replies) {
  const calls = [];
  return { calls, available: true, async *complete(options) {
    calls.push(options);
    const reply = replies[calls.length - 1];
    if (reply instanceof Error) throw reply;
    options.onProviderCall?.({ requestId: 'r', promptTokens: 300, completionTokens: 60, totalTokens: 360, latencyMs: 5, outcome: 'success' });
    yield { event: 'result', data: { message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) } } };
  } };
}

test('the prompt holds the question, the numbered fact lines and the rules, and no tools', () => {
  const messages = composeMessages({ ...input, previous: '이번 주 매출' });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /그대로 복사/u);
  assert.match(messages[0].content, /아라비아 숫자/u);
  const body = JSON.parse(messages[1].content.split('\n')[0]);
  assert.deepEqual(Object.keys(body).sort(), ['lines', 'previous', 'question']);
  assert.deepEqual(body.lines, ['0. 오늘 매출 48.1만 원', '1. 비교 기간 대비 -33.6%']);
});

test('an answer whose numbers all come from the used lines is returned with the lines it used', async () => {
  const transport = fakeTransport([{ text: '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.', used: [0, 1] }]);
  assert.deepEqual(await composeAnswer({ transport, input }), { text: '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.', used: [0, 1] });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].jsonResponse, true);
  assert.equal(transport.calls[0].tools, undefined);
  assert.ok(transport.calls[0].maxTokens <= COMPOSE_MAX_TOKENS);
});

test('a number the lines do not hold drops its sentence; nothing left, a bad shape or a failed call gives no answer', async () => {
  const mixed = await composeAnswer({ transport: fakeTransport([{ text: '오늘 매출은 48.1만 원이에요. 어제보다 12만 원 적어요.', used: [0] }]), input });
  assert.equal(mixed, null);
  assert.equal(await composeAnswer({ transport: fakeTransport([{ text: '어제보다 12만 원 적어요. 오늘 매출은 48.1만 원이에요.', used: [0] }]), input }), null);
  for (const reply of [{ text: '오늘 매출은 50만 원이에요.', used: [0] }, { text: 7 }, { used: [0] }, new Error('provider down')]) {
    assert.equal(await composeAnswer({ transport: fakeTransport([reply]), input }), null, JSON.stringify(reply));
  }
  assert.equal(await composeAnswer({ transport: { available: false, async *complete() {} }, input }), null);
});

test('a reply in prose with the JSON inside, or one missing its last brace, is still read', async () => {
  const json = '{"text":"오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.","used":[0,1]}';
  assert.deepEqual((await composeAnswer({ transport: fakeTransport([`다음과 같이 답해요.\n\`\`\`json\n${json}\n\`\`\``]), input })).used, [0, 1]);
  assert.deepEqual((await composeAnswer({ transport: fakeTransport([json.slice(0, -1)]), input })).used, [0, 1]);
});

test('the diagnostics callback gets counts only, never the question or the lines', async () => {
  const seen = [];
  await composeAnswer({ transport: fakeTransport([{ text: '오늘 매출은 48.1만 원이에요.', used: [0] }]), input, onProviderCall: call => seen.push(call) });
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen).includes('매출'), false);
});

test('a plain prose reply with no JSON is used as the answer, but only after the same guard, and a refusal-like reply is not', async () => {
  assert.deepEqual(await composeAnswer({ transport: fakeTransport(['오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.']), input }),
    { text: '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.', used: [] });
  assert.equal(await composeAnswer({ transport: fakeTransport(['오늘 매출은 50만 원이에요.']), input }), null);
  assert.equal(await composeAnswer({ transport: fakeTransport(['그 자료는 읽지 못했어요.']), input }), null);
  assert.equal(await composeAnswer({ transport: fakeTransport(['{"text": 이건 깨진 JSON']), input }), null);
});

test('the prompt tells the model to keep the facts\' own period words and ends with the output format', () => {
  const [system, user] = composeMessages(input);
  assert.match(system.content, /기간.*그대로/u);
  assert.match(user.content, /JSON/u);
});
