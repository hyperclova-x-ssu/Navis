import assert from 'node:assert/strict';
import test from 'node:test';
import { createTalkTalkDraft, validateDraft } from './talktalk.mjs';

const hours = '일요일 영업시간은 10:00~20:30입니다.';
const menu = '아메리카노 가격은 3,500원입니다.';
const address = '매장 주소는 서울 동작구 상도로 369입니다.';
const facts = [hours, menu, address];

test('a reply may use supported sentences and polite framing', () => {
  assert.equal(validateDraft(JSON.stringify({ reply: `안녕하세요!\n${hours}\n감사합니다.` }), facts), `안녕하세요!\n${hours}\n감사합니다.`);
});

test('accepts the address and thanks in one model line and returns the canonical fact on its own line', () => {
  const reply = '안녕하세요, 문의하신 주소는 서울 동작구 상도로 369입니다. 감사합니다.';
  assert.equal(validateDraft(JSON.stringify({ reply }), facts), `안녕하세요.\n${address}\n감사합니다.`);
  assert.equal(validateDraft(JSON.stringify({ reply: '주소는 서울 동작구 상도로 369입니다. 감사합니다.' }), facts),
    `${address}\n감사합니다.`);
});

test('accepts harmless number formatting and keeps the stored fact wording for direct inquiries and reviews', () => {
  const reply = '안녕하세요. 참고로 아메리카노 가격은 3500원입니다. 문의해 주셔서 감사합니다.';
  assert.equal(validateDraft(JSON.stringify({ reply }), facts), `안녕하세요.\n${menu}\n문의해 주셔서 감사합니다.`);
});

test('made-up figures, swapped figures and unsupported claims are discarded', () => {
  for (const reply of ['일요일 영업시간은 10:00~21:00입니다.', '일요일 영업시간은 20:30~10:00입니다.',
    '주차 가능합니다.', '두 분 예약 가능합니다.', '안녕하세요!\n감사합니다.', `${menu}\n오늘은 무료로 드립니다.`,
    '문의하신 주소는 서울 강남구 상도로 369입니다. 감사합니다.',
    '문의하신 주소는 서울 동작구 상도로 370입니다. 감사합니다.',
    '주소는 서울 동작구 상도로 369입니다. 2층으로 오세요.',
    '아메리카노 가격은 3,500원입니다. 카드 결제만 가능합니다.']) {
    assert.equal(validateDraft(JSON.stringify({ reply }), facts), null, reply);
  }
});

test('one provider completion sees only the inquiry and facts and returns a validated preview', async () => {
  const requests = [];
  const draft = createTalkTalkDraft({ async *complete(request) {
    requests.push(request);
    request.onProviderCall({ promptTokens: 32, completionTokens: 12, totalTokens: 44 });
    yield { event: 'result', data: { finishReason: 'stop', message: { content: JSON.stringify({ reply: hours }) } } };
  } }, () => {});
  assert.equal(await draft({ inquiry: '일요일에도 여나요?', facts }), hours);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), { inquiry: '일요일에도 여나요?', facts });
  assert.equal(requests[0].messages[0].role, 'system');
  assert.match(requests[0].messages[0].content, /첫 줄은.*안녕하세요/);
  assert.match(requests[0].messages[0].content, /마지막 줄은.*감사합니다/);
});
