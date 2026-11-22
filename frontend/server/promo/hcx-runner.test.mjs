import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClovaStudio } from '../clova-studio.mjs';
import { createHcxRunner } from './hcx-runner.mjs';
import { PHOTO_META_SCHEMA, SCENE_SCHEMA, STORY_SCHEMA } from './prompts.mjs';
import { PHOTO_META } from './test/helpers.mjs';

const messages = [{ role: 'user', content: 'Plan with the supplied store and menu facts.' }];
const responseFormat = { type: 'json', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } };
const plan = {
  scenes: [{ sceneId: 's1', start: 0, duration: 10, photoIds: ['menu-01'], textIds: ['t1'], direction: 'Cut' }],
  texts: [{ textId: 't1', role: 'title', text: '휘낭시에', sceneIds: ['s1'] }],
  ending: { taglineTextId: 't1' },
};

function completion(content, finishReason = 'stop') {
  return {
    message: { role: 'assistant', content }, finishReason,
    usage: { promptTokens: 90, completionTokens: 24 },
  };
}

function fakeClient(result, seen = []) {
  return createClovaStudio({ apiKey: 'fake', fetchImpl: async (url, request) => {
    seen.push({ url, accept: request.headers.Accept, body: JSON.parse(request.body) });
    return globalThis.Response.json({ status: { code: '20000' }, result });
  } });
}

test('structured completions use the per-call model and native v3 JSON request', async () => {
  const seen = [];
  const result = completion('{"title":"휘낭시에"}');
  const transport = fakeClient(result, seen);
  const events = [];
  for await (const event of transport.complete({ model: 'HCX-007', messages, maxTokens: 100, responseFormat })) events.push(event);
  assert.deepEqual(events, [{ event: 'result', data: result }]);
  assert.deepEqual(seen, [{
    url: 'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-007', accept: 'application/json',
    body: { messages, maxCompletionTokens: 100, thinking: { effort: 'none' }, responseFormat },
  }]);
});

test('promo runner maps the story schema and returns the validated plan and usage', async () => {
  const seen = [];
  const runner = createHcxRunner({ transport: fakeClient(completion(JSON.stringify(plan)), seen) });
  const result = await runner.run({ prompt: messages[0].content, schema: STORY_SCHEMA, timeoutMs: 1000 });
  assert.deepEqual(result.output, plan);
  assert.deepEqual(result.usage, { calls: 1, inputTokens: 90, outputTokens: 24 });
  const [request] = seen;
  assert.equal(request.url.split('/').at(-1), 'HCX-007');
  assert.deepEqual(request.body.messages, messages);
  const { type, schema } = request.body.responseFormat;
  assert.equal(type, 'json');
  assert.deepEqual(schema.required, STORY_SCHEMA.required);
  assert.deepEqual(schema.properties.scenes.items.properties.sceneId, { type: 'string' });
  assert.deepEqual(schema.properties.scenes.items.properties.duration, { type: 'number', minimum: 0 });
  assert.deepEqual(schema.properties.texts.items.properties.role, STORY_SCHEMA.properties.texts.items.properties.role);
  assert.equal(schema.properties.scenes.maxItems, 20);
  assert.deepEqual(schema.properties.ending.required, ['taglineTextId']);
  assert.doesNotMatch(JSON.stringify(schema), /"(?:pattern|additionalProperties|minLength|maxLength)"/);
});

test('promo runner forwards optional structured-output sampling controls', async () => {
  const seen = [];
  const runner = createHcxRunner({ transport: fakeClient(completion(JSON.stringify(plan)), seen) });
  await runner.run({ prompt: messages[0].content, schema: STORY_SCHEMA, temperature: 0.1, seed: 436 });
  assert.equal(seen[0].body.temperature, 0.1);
  assert.equal(seen[0].body.seed, 436);
});

test('promo runner rejects malformed, truncated and off-schema model replies', async () => {
  const offSchema = change => {
    const output = globalThis.structuredClone(plan);
    change(output);
    return completion(JSON.stringify(output));
  };
  const replies = [
    completion('```json\n{}\n```'),
    completion(JSON.stringify(plan), 'length'),
    offSchema(output => { output.scenes[0].sceneId = 'scene1'; }),
    offSchema(output => { output.scenes[0].direction = 'x'.repeat(201); }),
    offSchema(output => { output.texts[0].text = ''; }),
    offSchema(output => { output.ending.extra = 'invented'; }),
    offSchema(output => { Object.defineProperty(output.ending, '__proto__', { value: 'unexpected', enumerable: true }); }),
  ];
  for (const reply of replies) {
    const runner = createHcxRunner({ transport: fakeClient(reply), retries: 0 });
    await assert.rejects(runner.run({ prompt: messages[0].content, schema: STORY_SCHEMA, timeoutMs: 1000 }), {
      code: 'AI_BAD_OUTPUT', usage: { calls: 1, inputTokens: 90, outputTokens: 24 },
    });
  }
});

test('promo runner prohibits image inputs and propagates cancellation without retry', async () => {
  const seen = [];
  const transport = fakeClient(completion(JSON.stringify(plan)), seen);
  const runner = createHcxRunner({ transport });
  const input = { prompt: messages[0].content, schema: STORY_SCHEMA, timeoutMs: 1000 };
  await assert.rejects(runner.run({ ...input, images: [{ bytes: new Uint8Array(1) }] }), { code: 'AI_BAD_OUTPUT' });
  await assert.rejects(runner.run({ ...input, signal: globalThis.AbortSignal.abort() }), { code: 'AI_TIMEOUT' });
  assert.equal(seen.length, 0);
});

test('look uses one HCX-005 image with local schema validation and counts rejected output', async () => {
  const seen = [];
  const calls = [];
  const request = {
    prompt: 'Describe this photo.', images: [{ bytes: Buffer.from([1, 2, 3]), mediaType: 'image/jpeg' }],
    schema: PHOTO_META_SCHEMA, timeoutMs: 1000,
  };
  const runner = createHcxRunner({
    stage: 'look', retries: 0, onCall: row => calls.push(row),
    transport: fakeClient(completion(JSON.stringify({ ...PHOTO_META, focus: { x: 2, y: 0.5 } })), seen),
  });
  await assert.rejects(runner.run(request), { code: 'AI_BAD_OUTPUT', usage: { calls: 1, inputTokens: 90, outputTokens: 24 } });
  assert.match(seen[0].url, /HCX-005$/);
  assert.equal(seen[0].accept, 'application/json');
  assert.equal(seen[0].body.responseFormat, undefined);
  // HCX-005 rejects bare base64 with HTTP 400 / 40001 (PROMO-PILOT call 1-39); it needs a data URL, image part first.
  assert.deepEqual(seen[0].body.messages[0].content[0], { type: 'image_url', dataUri: { data: 'data:image/jpeg;base64,AQID' } });
  assert.equal(seen[0].body.messages[0].content[1].type, 'text');
  assert.match(seen[0].body.messages[0].content[1].text, /JSON object/);
  assert.equal(calls[0].schemaValid, false);
  const valid = createHcxRunner({ stage: 'look', transport: fakeClient(completion(JSON.stringify(PHOTO_META))) });
  assert.deepEqual((await valid.run(request)).output, PHOTO_META);
});

test('look labels each photo by its own bytes and refuses a photo whose type is unknown', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  const gif = Buffer.from('GIF89a\x01\x00', 'latin1');
  const seen = [];
  const transport = fakeClient(completion(JSON.stringify(PHOTO_META)), seen);
  const send = (bytes, mediaType) => createHcxRunner({ stage: 'look', transport }).run({
    prompt: 'Describe this photo.', images: [{ bytes, mediaType }], schema: PHOTO_META_SCHEMA, timeoutMs: 1000,
  });
  // The label is only a fallback: a PNG that is labelled image/jpeg is sent as image/png.
  await send(png, 'image/jpeg');
  await send(jpeg, undefined);
  await send(webp, 'image/jpeg');
  await send(gif, 'image/jpeg');
  assert.deepEqual(seen.map(row => {
    const [image, text] = row.body.messages[0].content;
    return [image.type, text.type, image.dataUri.data.slice(0, image.dataUri.data.indexOf(','))];
  }), [
    ['image_url', 'text', 'data:image/png;base64'], ['image_url', 'text', 'data:image/jpeg;base64'],
    ['image_url', 'text', 'data:image/webp;base64'], ['image_url', 'text', 'data:image/gif;base64'],
  ]);
  assert.equal(Buffer.from(seen[0].body.messages[0].content[0].dataUri.data.split(',')[1], 'base64').equals(png), true);
  // Unknown bytes need a supported label; otherwise nothing is sent (no counted NAVER call).
  const before = seen.length;
  await assert.rejects(send(Buffer.from([1, 2, 3]), 'application/pdf'), { code: 'AI_BAD_OUTPUT' });
  await assert.rejects(send(Buffer.from([1, 2, 3]), 'image/jpeg;base64,'), { code: 'AI_BAD_OUTPUT' });
  await assert.rejects(send(Buffer.from([1, 2, 3]), undefined), { code: 'AI_BAD_OUTPUT' });
  assert.equal(seen.length, before);
});

test('scene generation uses the HCX-007 schema and allows more output than story generation', async () => {
  const seen = [];
  const html = '<!doctype html><html></html>';
  const runner = createHcxRunner({ stage: 'scenes', transport: fakeClient(completion(JSON.stringify({ html })), seen) });
  const result = await runner.run({ prompt: 'Generate the example.', schema: SCENE_SCHEMA, timeoutMs: 1000 });
  assert.deepEqual(result.output, { html });
  assert.match(seen[0].url, /HCX-007$/);
  assert.deepEqual(seen[0].body.responseFormat.schema.required, ['html']);
  assert.ok(seen[0].body.maxCompletionTokens > 2048);
  assert.deepEqual(seen[0].body.thinking, { effort: 'none' });
});

test('look accepts one markdown fence around the JSON and records that it did', async () => {
  const request = { prompt: 'Describe this photo.', images: [{ bytes: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' }], schema: PHOTO_META_SCHEMA, timeoutMs: 1000 };
  const body = JSON.stringify(PHOTO_META);
  for (const text of [`\`\`\`json\n${body}\n\`\`\``, `\`\`\`\n${body}\n\`\`\``, `\`\`\`JSON\r\n${body}\r\n\`\`\`\n`, `  \`\`\`json\n${JSON.stringify(PHOTO_META, null, 2)}\`\`\``]) {
    const rows = [];
    const runner = createHcxRunner({ stage: 'look', retries: 0, onCall: row => rows.push(row), transport: fakeClient(completion(text)) });
    const result = await runner.run(request);
    assert.deepEqual(result.output, PHOTO_META, JSON.stringify(text.slice(0, 12)));
    assert.deepEqual(result.usage, { calls: 1, inputTokens: 90, outputTokens: 24 });
    assert.deepEqual([rows[0].outcome, rows[0].schemaValid, rows[0].failure, rows[0].parse], ['success', true, null, 'fenced']);
  }
  const plain = [];
  await createHcxRunner({ stage: 'look', onCall: row => plain.push(row), transport: fakeClient(completion(body)) }).run(request);
  assert.equal(plain[0].parse, 'json');
  // Only the look stage unwraps: story and scenes use structured outputs and keep the strict parse.
  const strict = createHcxRunner({ stage: 'scenes', retries: 0, transport: fakeClient(completion(`\`\`\`json\n{"html":"<p>x</p>"}\n\`\`\``)) });
  await assert.rejects(strict.run({ prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 }), { code: 'AI_BAD_OUTPUT' });
});

test('look drops caption ideas longer than the schema allows instead of failing the photo, and counts them', async () => {
  const request = { prompt: 'Describe this photo.', images: [{ bytes: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' }], schema: PHOTO_META_SCHEMA, timeoutMs: 1000 };
  const exact = 'a'.repeat(60);
  const tooLong = 'b'.repeat(61);
  const hangul = '가'.repeat(60);
  const rows = [];
  const text = `\`\`\`json\n${JSON.stringify({ ...PHOTO_META, captionHints: ['golden crust', tooLong, exact, tooLong, hangul] })}\n\`\`\``;
  const runner = createHcxRunner({ stage: 'look', retries: 0, onCall: row => rows.push(row), transport: fakeClient(completion(text)) });
  const result = await runner.run(request);
  assert.deepEqual(result.output, { ...PHOTO_META, captionHints: ['golden crust', exact, hangul] });
  assert.deepEqual([rows[0].outcome, rows[0].schemaValid, rows[0].failure, rows[0].parse, rows[0].hintsDropped], ['success', true, null, 'fenced', 2]);
  const clean = [];
  await createHcxRunner({ stage: 'look', onCall: row => clean.push(row), transport: fakeClient(completion(JSON.stringify(PHOTO_META))) }).run(request);
  assert.equal(clean[0].hintsDropped, 0);
  // All other constraints still fail the photo, even if dropping a long string could hide the error.
  const failureOf = async changed => {
    const failed = [];
    await assert.rejects(createHcxRunner({ stage: 'look', retries: 0, onCall: row => failed.push(row), transport: fakeClient(completion(JSON.stringify({ ...PHOTO_META, ...changed }))) }).run(request), { code: 'AI_BAD_OUTPUT' });
    return failed[0].failure;
  };
  assert.equal(await failureOf({ subject: 'd'.repeat(121) }), 'schema:$.subject: maxLength');
  assert.equal(await failureOf({ captionHints: ['a', 'b', 'c', 'd', 'e'] }), 'schema:$.captionHints: maxItems');
  assert.equal(await failureOf({ captionHints: [7] }), 'schema:$.captionHints[0]: type');
  for (const [field, maxItems] of [['items', 8], ['flavors', 6]]) {
    const long = 'c'.repeat(41);
    assert.ok((await failureOf({ [field]: [...Array(maxItems).fill('a'), long] })).startsWith(`schema:$.${field}: maxItems`));
    assert.equal(await failureOf({ [field]: [7, long] }), `schema:$.${field}[0]: type`);
    assert.equal(await failureOf({ [field]: long }), `schema:$.${field}: type`);
  }
});

test('look drops item and flavor strings over 40 characters and counts them by field', async () => {
  const request = { prompt: 'Describe this photo.', images: [{ bytes: Buffer.from([0xff, 0xd8, 0xff]) }], schema: PHOTO_META_SCHEMA, timeoutMs: 1000 };
  const exact = `${'가'.repeat(39)}🍵`;
  const tooLong = `${exact}a`;
  const rows = [];
  const response = { ...PHOTO_META, items: [tooLong, 'cup', exact, tooLong], flavors: [tooLong] };
  const runner = createHcxRunner({ stage: 'look', retries: 0, onCall: row => rows.push(row), transport: fakeClient(completion(JSON.stringify(response))) });
  const result = await runner.run(request);
  assert.deepEqual(result.output, { ...PHOTO_META, items: ['cup', exact], flavors: [] });
  assert.deepEqual([rows[0].schemaValid, rows[0].failure, rows[0].itemsTrimmed, rows[0].flavorsTrimmed], [true, null, 2, 1]);
  assert.equal(JSON.stringify(rows[0]).includes(tooLong), false);
});

test('a rejected look reply is logged by kind only, never by content', async () => {
  const request = { prompt: 'Describe this photo.', images: [{ bytes: Buffer.from([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' }], schema: PHOTO_META_SCHEMA, timeoutMs: 1000 };
  const failureOf = async reply => {
    const rows = [];
    const runner = createHcxRunner({ stage: 'look', retries: 0, onCall: row => rows.push(row), transport: fakeClient(reply) });
    await assert.rejects(runner.run(request), { code: 'AI_BAD_OUTPUT' });
    return rows[0].failure;
  };
  const secret = 'SECRET-DESCRIPTION';
  // A reply that is not strict JSON is also tried leniently (outermost braces) and the verdict is appended: `>ok`, `>schema:<paths>` or `>none`.
  // One markdown fence around the whole reply is unwrapped first (HCX-005 does this despite the prompt: PROMO-NEXT 3/3 `json:fenced>ok`).
  assert.equal(await failureOf(completion(`\`\`\`json\n{"subject":"${secret}"}\n\`\`\``)), 'schema:$.kind: required,$.items: required,$.flavors: required,$.people: required,$.textInImage: required');
  assert.equal(await failureOf(completion(`\`\`\`json\n{"subject":"${secret}"\n\`\`\``)), 'json:fenced>none');
  assert.equal(await failureOf(completion(`\`\`\`json\n${JSON.stringify(PHOTO_META)}`)), 'json:fenced>ok', 'an unclosed fence is still not accepted');
  assert.equal(await failureOf(completion(`\`\`\`json\n${JSON.stringify(PHOTO_META)}\n\`\`\`\nHope this helps!`)), 'json:fenced>ok', 'text after the fence is not accepted');
  assert.equal(await failureOf(completion(`Here is ${secret}: {}`)), 'json:prefix>schema:$.kind: required,$.subject: required,$.items: required,$.flavors: required,$.people: required');
  assert.equal(await failureOf(completion(`Here you go: ${JSON.stringify({ ...PHOTO_META, kind: 'plate' })} Enjoy!`)), 'json:prefix>schema:$.kind: enum');
  assert.equal(await failureOf(completion(`{"subject":"${secret}"`)), 'json:syntax>none');
  assert.equal(await failureOf(completion('no object here')), 'json:prefix>none');
  assert.equal(await failureOf(completion(JSON.stringify(PHOTO_META), 'length')), 'finish:length');
  assert.equal(await failureOf(completion(JSON.stringify(PHOTO_META), 'Bad Value!')), 'finish:other');
  assert.equal(await failureOf(completion(JSON.stringify({ ...PHOTO_META, focus: { x: 2, y: 0.5 }, kind: 'other-kind', [secret]: 1 }))), 'schema:$.kind: enum,$.focus.x: maximum,$: additional');
  for (const text of [`{"subject":"${secret}"`, `Here is ${secret}: {}`, `\`\`\`json\n{"subject":"${secret}"}\n\`\`\``]) assert.doesNotMatch(await failureOf(completion(text)), /SECRET/);
  const ok = [];
  await createHcxRunner({ stage: 'look', onCall: row => ok.push(row), transport: fakeClient(completion(JSON.stringify(PHOTO_META))) }).run(request);
  assert.equal(ok[0].failure, null);
});
