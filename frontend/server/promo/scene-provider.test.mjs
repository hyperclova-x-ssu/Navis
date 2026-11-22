// PROMO-NEXT (D-327 Q7): the scene stage provider is a config choice and Claude is the default.
// Every provider here is a fake: a fake `claude` process, a fake CLOVA fetch, and no key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './config.mjs';
import { PromoError } from './errors.mjs';
import { createClaudeApiRunner, createClaudeCliRunner, promoClaudeApiModel } from './scene-provider.mjs';
import { createPromoService } from './service.mjs';
import { PHOTO_META_SCHEMA, SCENE_SCHEMA } from './prompts.mjs';
import { loadPlanningTemplates } from './templates/runtime.mjs';
import { loadReferences } from './references.mjs';
import { INPUT, PHOTO_META, fakeSpawn, refs, resultLine, sceneHtml, validStory } from './test/helpers.mjs';

const reply = output => globalThis.Response.json({
  status: { code: '20000' },
  result: { message: { role: 'assistant', content: JSON.stringify(output) }, finishReason: 'stop', usage: { promptTokens: 90, completionTokens: 24, totalTokens: 114 } },
});
const isSceneSchema = args => Boolean(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.html);
const offer = `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } })}\n`;

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'navis-scene-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Runs one whole job on fakes and reports which provider served each stage. */
async function runJob(t, { env = {}, tools = { claude: '/fake/claude', browser: '/fake/chrome', ffmpeg: {} },
  claudeReply, apiFetch, pipeline, planReply, input = INPUT, references = refs } = {}) {
  const dir = await tempDir(t);
  const claude = [];
  const naver = [];
  const { scenes, texts, ending } = validStory();
  const service = createPromoService({
    config: { dir }, references,
    env: { NAVIS_PROMO_PHOTO_SOURCE: 'example', CLOVASTUDIO_API_KEY: 'testing-key', ...env },
    tools, pipeline,
    spawnProcess: fakeSpawn((_input, args) => claudeReply?.(args) ?? ({ stdout: resultLine(isSceneSchema(args) ? { html: sceneHtml() } : PHOTO_META) }), claude),
    fetchImpl: async (url, request) => {
      if (url === 'https://api.anthropic.com/v1/messages') {
        assert.ok(apiFetch, 'unexpected paid provider call');
        return apiFetch(request);
      }
      const model = url.split('/').at(-1);
      const body = JSON.parse(request.body);
      if (body.responseFormat?.schema.properties?.variantId) {
        naver.push({ model, stage: 'story' });
        return reply(planReply ?? { variantId: 'warm-10', feature: '', price: '', limitedOffer: '' });
      }
      const stage = model === 'HCX-005' ? 'look' : body.responseFormat.schema.required[0] === 'html' ? 'scenes' : 'story';
      naver.push({ model, stage });
      if (stage === 'look') return reply(PHOTO_META);
      return stage === 'scenes' ? reply({ html: sceneHtml() }) : reply({ scenes, texts, ending });
    },
    checkScene: async () => ({ violations: [] }),
    renderVideo: async ({ outFile }) => { await writeFile(outFile, ''); },
    checkVideo: async () => ({ info: { durationSec: 10, width: 720, height: 1280, sizeBytes: 0 }, violations: [] }),
  });
  try {
    await service.ready;
    const { job } = await service.store.create({ input, idempotencyKey: `scene-${Math.random().toString(16).slice(2)}` });
    await job.promise;
    return { job, claude, naver, sceneCalls: claude.filter(call => isSceneSchema(call.args)) };
  } finally {
    await service.close();
  }
}

test('config: Claude is the default scene provider; only the three known names are accepted', () => {
  assert.equal(readConfig({}).sceneProvider, 'claude');
  assert.equal(readConfig({ NAVIS_PROMO_SCENE_PROVIDER: 'naver' }).sceneProvider, 'naver');
  assert.equal(readConfig({ NAVIS_PROMO_SCENE_PROVIDER: 'claude-api' }).sceneProvider, 'claude-api');
  assert.equal(readConfig({ NAVIS_PROMO_SCENE_PROVIDER: 'gpt' }).sceneProvider, 'claude');
  assert.equal(readConfig({ NAVIS_PROMO_SCENE_PROVIDER: '' }).sceneProvider, 'claude');
  assert.equal(readConfig({ NAVIS_PROMO_HCX_PILOT: 'true' }).sceneProvider, 'claude');
  assert.equal(readConfig({}).claudeApiApproved, false);
  assert.equal(readConfig({ NAVIS_PROMO_CLAUDE_API_APPROVED: 'yes' }).claudeApiApproved, false);
  assert.equal(readConfig({ NAVIS_PROMO_CLAUDE_API_APPROVED: 'true' }).claudeApiApproved, true);
});

test('with no provider settings, photo look and story use NAVER and scene HTML uses the Claude CLI', async t => {
  const { job, claude, naver, sceneCalls } = await runJob(t);
  assert.equal(job.status, 'done', job.failReason);
  assert.deepEqual(naver.map(call => [call.model, call.stage]), [...Array.from({ length: 5 }, () => ['HCX-005', 'look']), ['HCX-007', 'story']]);
  assert.equal(claude.length, 1, 'only the scene stage reaches the CLI');
  assert.equal(sceneCalls.length, 1);
  assert.equal(job.usage.calls, 5 + 1 + 1, 'job usage counts every provider call');
});

test('NAVIS_PROMO_HCX_PILOT=false sends photo look to the Claude CLI and keeps story on HCX-007', async t => {
  const { job, claude, naver, sceneCalls } = await runJob(t, { env: { NAVIS_PROMO_HCX_PILOT: 'false' } });
  assert.equal(job.status, 'done', job.failReason);
  assert.deepEqual(naver, [{ stage: 'story', model: 'HCX-007' }]);
  assert.equal(claude.length, 6);
  assert.equal(sceneCalls.length, 1);
});

test('NAVIS_PROMO_SCENE_PROVIDER=naver keeps the old NAVER scene pilot and needs no Claude tool', async t => {
  const { job, claude, naver } = await runJob(t, {
    env: { NAVIS_PROMO_SCENE_PROVIDER: 'naver' },
    tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} },
  });
  assert.equal(job.status, 'done', job.failReason);
  assert.equal(claude.length, 0);
  assert.deepEqual(naver.map(call => call.stage), [...Array.from({ length: 5 }, () => 'look'), 'story', 'scenes']);
});

test('the default needs the Claude CLI even when look runs on NAVER', async t => {
  const { job, claude, naver } = await runJob(t, { tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} } });
  assert.equal(job.status, 'failed');
  assert.equal(job.failReason, 'TOOL_MISSING');
  assert.equal(claude.length + naver.length, 0, 'no provider is called before the tool check');
});

test('opting out of HCX photo look requires the Claude CLI even with NAVER scenes', async t => {
  const { job, claude, naver } = await runJob(t, {
    env: { NAVIS_PROMO_HCX_PILOT: 'false', NAVIS_PROMO_SCENE_PROVIDER: 'naver' },
    tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} },
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.failReason, 'TOOL_MISSING');
  assert.equal(claude.length + naver.length, 0, 'no provider is called before the tool check');
});

test('without the approval flag the Claude API scene stage calls nothing paid', async t => {
  const { job, claude, naver } = await runJob(t, {
    env: { NAVIS_PROMO_HCX_PILOT: 'true', NAVIS_PROMO_SCENE_PROVIDER: 'claude-api', ANTHROPIC_API_KEY: 'must-never-be-used' },
    tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} },
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.stage, 'scenes');
  assert.equal(job.failReason, 'AI_UNAVAILABLE');
  assert.equal(claude.length, 0);
  assert.deepEqual(naver.map(call => call.stage), [...Array.from({ length: 5 }, () => 'look'), 'story']);
});

test('Claude API requires both approval and a key', async () => {
  const fetchImpl = () => assert.fail('unexpected network call');
  const request = { prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 };
  const refused = createClaudeApiRunner({ apiKey: 'test-key', fetchImpl });
  await assert.rejects(refused.run(request), err => err instanceof PromoError && err.code === 'AI_UNAVAILABLE' && err.detail === 'CLAUDE_API_NOT_APPROVED');
  const approved = createClaudeApiRunner({ approved: true, fetchImpl });
  await assert.rejects(approved.run(request), err => err instanceof PromoError && err.code === 'AI_UNAVAILABLE' && err.detail === 'CLAUDE_API_KEY_MISSING');
});

test('the configured video model overrides the legacy API-only setting', () => {
  assert.equal(promoClaudeApiModel({}), 'claude-opus-5-5');
  assert.equal(promoClaudeApiModel({ NAVIS_PROMO_CLAUDE_MODEL: 'claude-sonnet-5-5',
    NAVIS_PROMO_CLAUDE_API_MODEL: 'claude-opus-5' }), 'claude-sonnet-5-5');
});

test('offline authoring can send a single photo to Claude vision with a small output limit', async () => {
  const runner = createClaudeApiRunner({
    apiKey: 'test-key', approved: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.max_tokens, 1024);
      assert.deepEqual(body.messages[0].content, [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
        { type: 'text', text: 'photo metadata' },
      ]);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(PHOTO_META) }],
        stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 10 } });
    },
  });
  const result = await runner.run({ prompt: 'photo metadata', schema: PHOTO_META_SCHEMA, maxTokens: 1024,
    images: [{ mediaType: 'image/jpeg', bytes: Buffer.from([255, 216, 255]) }] });
  assert.deepEqual(result.output, PHOTO_META);
});

test('approved Claude API handles only scenes without the CLI and meters the Messages response', async t => {
  const dir = await tempDir(t);
  const apiKeyFile = join(dir, 'api-key');
  await writeFile(apiKeyFile, 'fake-mounted-key\n');
  let calls = 0;
  const { job, claude, naver } = await runJob(t, {
    env: { NAVIS_PROMO_SCENE_PROVIDER: 'claude-api', NAVIS_PROMO_CLAUDE_API_APPROVED: 'true', ANTHROPIC_API_KEY_FILE: apiKeyFile },
    tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} },
    apiFetch: async request => {
      calls++;
      assert.equal(request.headers['x-api-key'], 'fake-mounted-key');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'claude-opus-5-5');
      assert.deepEqual(body.output_config.format.schema, {
        type: 'object', additionalProperties: false, required: ['html'], properties: { html: { type: 'string' } },
      });
      return Response.json({
        content: [{ type: 'text', text: JSON.stringify({ html: sceneHtml() }) }], stop_reason: 'end_turn',
        usage: { input_tokens: 121, output_tokens: 55 },
      });
    },
  });
  assert.equal(job.status, 'done', job.failReason);
  assert.equal(claude.length, 0);
  assert.equal(calls, 1);
  assert.deepEqual(naver.map(call => call.model), [...Array(5).fill('HCX-005'), 'HCX-007']);
  assert.deepEqual(job.usage, { calls: 7, inputTokens: 661, outputTokens: 199 });
});

test('Claude API activation still requires approval and a separate provider key', async t => {
  const { job, claude, naver } = await runJob(t, {
    env: { NAVIS_PROMO_SCENE_PROVIDER: 'claude-api', NAVIS_PROMO_CLAUDE_API_APPROVED: 'true' },
    tools: { claude: null, browser: '/fake/chrome', ffmpeg: {} },
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.failReason, 'AI_UNAVAILABLE');
  assert.equal(claude.length, 0);
  assert.deepEqual(naver.map(call => call.model), [...Array(5).fill('HCX-005'), 'HCX-007']);
  assert.equal(job.usage.calls, 6);
});

test('invalid HCX slots fail the live job before scene code or rendering', async t => {
  const { job, naver, claude } = await runJob(t, {
    env: { NAVIS_PROMO_SCENE_PROVIDER: 'claude-api', NAVIS_PROMO_CLAUDE_API_APPROVED: 'true', ANTHROPIC_API_KEY: 'fake' },
    input: { ...INPUT, referenceId: 'ref-7' }, references: loadReferences(),
    pipeline: { templates: loadPlanningTemplates(), readPhotoMeta: async () => PHOTO_META },
    planReply: { variantId: 'warm-10', feature: 'unknown fabricated fact', price: '₩100', limitedOffer: '' },
    apiFetch: async () => assert.fail('Claude should only receive a validated live plan'),
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.stage, 'story');
  assert.equal(job.failReason, 'AI_BAD_OUTPUT');
  assert.equal(claude.length, 0);
  assert.deepEqual(naver, [{ model: 'HCX-007', stage: 'story' }]);
});

test('the CLI path never passes an API key or gateway to the child (signed-in plan only)', async () => {
  const seen = [];
  const runner = createClaudeCliRunner({
    command: '/fake/claude', model: 'sonnet', spawnProcess: fakeSpawn(() => ({ stdout: resultLine({ html: sceneHtml() }) }), seen),
    env: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gateway', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'login', CLAUDE_CONFIG_DIR: '/c' },
  });
  const res = await runner.run({ prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 });
  assert.match(res.output.html, /^<!doctype html>/i);
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH']);
});

test('a paid-credits offer from the CLI ends the call, discards its answer and blocks every later call', async () => {
  const seen = [];
  let n = 0;
  const runner = createClaudeCliRunner({
    command: '/fake/claude', model: 'sonnet',
    spawnProcess: fakeSpawn(() => ({ stdout: (++n === 1 ? offer : '') + resultLine({ html: sceneHtml() }) }), seen),
  });
  const request = { prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 };
  await assert.rejects(runner.run(request), err => err.code === 'AI_UNAVAILABLE' && err.usage.calls === 1);
  assert.equal(runner.creditsOffered, true);
  await assert.rejects(runner.run(request), { code: 'AI_UNAVAILABLE' });
  assert.equal(seen.length, 1, 'the second call never starts a process');
});

test('a credits offer inside generated HTML is not an offer', async () => {
  const runner = createClaudeCliRunner({
    command: '/fake/claude', model: 'sonnet',
    spawnProcess: fakeSpawn(() => ({ stdout: resultLine({ html: '<p>switch to usage credits</p>' }) })),
  });
  const res = await runner.run({ prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 });
  assert.equal(res.output.html, '<p>switch to usage credits</p>');
  assert.equal(runner.creditsOffered, false);
});

test('through the service a credits offer fails the job as AI_UNAVAILABLE and the next job starts no process', async t => {
  const dir = await tempDir(t);
  const claude = [];
  const { scenes, texts, ending } = validStory();
  const service = createPromoService({
    config: { dir }, references: refs,
    env: { NAVIS_PROMO_PHOTO_SOURCE: 'example', CLOVASTUDIO_API_KEY: 'testing-key' },
    tools: { claude: '/fake/claude', browser: '/fake/chrome', ffmpeg: {} },
    spawnProcess: fakeSpawn((_input, args) => ({ stdout: offer + resultLine(isSceneSchema(args) ? { html: sceneHtml() } : PHOTO_META) }), claude),
    fetchImpl: async url => reply(url.endsWith('/HCX-005') ? PHOTO_META : { scenes, texts, ending }),
    checkScene: async () => ({ violations: [] }),
  });
  try {
    await service.ready;
    const first = (await service.store.create({ input: INPUT, idempotencyKey: 'credits-one-key' })).job;
    await first.promise;
    assert.equal(first.stage, 'scenes');
    assert.equal(first.failReason, 'AI_UNAVAILABLE');
    const spawned = claude.length;
    const second = (await service.store.create({ input: INPUT, idempotencyKey: 'credits-two-key' })).job;
    await second.promise;
    assert.equal(second.failReason, 'AI_UNAVAILABLE');
    assert.equal(claude.length, spawned);
  } finally {
    await service.close();
  }
});
