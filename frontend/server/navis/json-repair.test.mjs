import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonLoose } from './json-repair.mjs';

test('valid JSON and fenced JSON parse as they are', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
});

test('up to three missing closing brackets are added in the right order', () => {
  assert.deepEqual(parseJsonLoose('{"outcome":"reply","facts":["f0","f1"]'), { outcome: 'reply', facts: ['f0', 'f1'] });
  assert.deepEqual(parseJsonLoose('{"reads":[{"featureId":"ledger"'), { reads: [{ featureId: 'ledger' }] });
  assert.deepEqual(parseJsonLoose('{"text":"a } and ] inside","n":2'), { text: 'a } and ] inside', n: 2 });
});

test('anything else stays unusable: mismatched brackets, an open string, more than three closers, not JSON', () => {
  for (const bad of ['{"a":[1}', '{"a":"open', '{"a":[[[[1', 'plain words', '', undefined, '{"a":1,}']) assert.equal(parseJsonLoose(bad), undefined, String(bad));
});

import { tidyModelReply } from './json-repair.mjs';
import { validateAgentModelReply } from '../../shared/navis-agent-schema.mjs';

test('a reply with an extra key or too many fact refs is tidied into the reply schema, and bad content stays invalid', () => {
  const many = Array.from({ length: 15 }, (_, index) => `f${index}`);
  const tidy = tidyModelReply({ outcome: 'reply', facts: many, reason: '왜냐하면', answer: '무엇' });
  assert.deepEqual(tidy, { outcome: 'reply', facts: many.slice(0, 12) });
  assert.equal(validateAgentModelReply(tidy), true);
  assert.equal(validateAgentModelReply(tidyModelReply({ outcome: 'clarify', field: 'price', note: 'x' })), true);
  assert.equal(validateAgentModelReply(tidyModelReply({ outcome: 'refused', why: 'x' })), true);
  assert.equal(validateAgentModelReply(tidyModelReply({ outcome: 'reply', facts: ['not-a-ref'] })), false);
  assert.equal(validateAgentModelReply(tidyModelReply({ outcome: 'delete everything' })), false);
  assert.equal(validateAgentModelReply(tidyModelReply({ outcome: 'clarify' })), false);
  assert.equal(tidyModelReply('text'), 'text');
});

test('a JSON object wrapped in prose or a code fence in the middle of the text is found and parsed, text without one is not', () => {
  const object = { kind: 'read', reads: [{ featureId: 'ledger' }] };
  const json = JSON.stringify(object);
  assert.deepEqual(parseJsonLoose(`이전 질문을 이어서 읽겠습니다.\n\n\`\`\`json\n${json}\n\`\`\`\n이렇게 하면 됩니다.`), object);
  assert.deepEqual(parseJsonLoose(`따라서 답변은 다음과 같습니다: ${json} 이상입니다.`), object);
  assert.deepEqual(parseJsonLoose(`설명 {"kind":"read","reads":[{"featureId":"ledger"}]`), object);
  assert.equal(parseJsonLoose('그냥 설명뿐이고 JSON은 없어요.'), undefined);
  assert.equal(parseJsonLoose('집합 {a, b} 을 말하는 글'), undefined);
});
