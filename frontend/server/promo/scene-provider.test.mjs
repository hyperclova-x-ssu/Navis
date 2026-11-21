// PROMO-NEXT (D-327 Q7): the scene stage provider is a config choice and Claude is the default.
// Every provider here is a fake: a fake `claude` process, a fake CLOVA fetch, and no key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './config.mjs';
import { PromoError } from './errors.mjs';
import { createClaudeApiRunner, createClaudeCliRunner } from './scene-provider.mjs';
import { createPromoService } from './service.mjs';
import { SCENE_SCHEMA } from './prompts.mjs';
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
async function runJob(t, { env = {}, tools = { claude: '/fake/claude', browser: '/fake/chrome', ffmpeg: {} }, claudeReply } = {}) {
  const dir = await tempDir(t);
  const claude = [];
  const naver = [];
  const { scenes, texts, ending } = validStory();
  const service = createPromoService({
    config: { dir }, references: refs,
    env: { NAVIS_PROMO_PHOTO_SOURCE: 'example', CLOVASTUDIO_API_KEY: 'testing-key', ...env },
    tools,
    spawnProcess: fakeSpawn((_input, args) => claudeReply?.(args) ?? ({ stdout: resultLine(isSceneSchema(args) ? { html: sceneHtml() } : PHOTO_META) }), claude),
    fetchImpl: async (url, request) => {
      const model = url.split('/').at(-1);
      const body = JSON.parse(request.body);
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
    const { job } = await service.store.create({ input: INPUT, idempotencyKey: `scene-${Math.random().toString(16).slice(2)}` });
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

test('claude-api is a stub: without the approval flag it fails the scene stage and calls nothing paid', async t => {
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

test('claude-api stays a stub even with the flag: no key is read and no network call is made', async t => {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetched.push(args); throw new Error('no network in this test'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const request = { prompt: 'p', schema: SCENE_SCHEMA, timeoutMs: 1000 };
  const refused = createClaudeApiRunner({ approved: readConfig({}).claudeApiApproved });
  await assert.rejects(refused.run(request), err => err instanceof PromoError && err.code === 'AI_UNAVAILABLE' && err.detail === 'CLAUDE_API_NOT_APPROVED');
  const approved = createClaudeApiRunner({ approved: readConfig({ NAVIS_PROMO_CLAUDE_API_APPROVED: 'true' }).claudeApiApproved });
  await assert.rejects(approved.run(request), err => err instanceof PromoError && err.code === 'AI_UNAVAILABLE' && err.detail === 'CLAUDE_API_NOT_IMPLEMENTED');
  assert.equal(fetched.length, 0);
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
