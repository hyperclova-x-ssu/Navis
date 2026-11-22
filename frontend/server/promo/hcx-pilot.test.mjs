import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClovaStudio } from '../clova-studio.mjs';
import { readConfig } from './config.mjs';
import { createExamplePhotoSource } from './photo-source.mjs';
import { photoMetaInput } from './pipeline.mjs';
import { createPromoService } from './service.mjs';
import { loadReferences } from './references.mjs';
import { INPUT, PHOTO_META, fakeSpawn, refs, resultLine, sceneHtml, validStory } from './test/helpers.mjs';

const reply = output => globalThis.Response.json({
  status: { code: '20000' },
  result: { message: { role: 'assistant', content: JSON.stringify(output) }, finishReason: 'stop',
    usage: { promptTokens: 90, completionTokens: 24, totalTokens: 114 } },
});

// A reply whose text is exactly `content` (not JSON-encoded), for fenced or chatty model answers.
const rawReply = content => globalThis.Response.json({
  status: { code: '20000' },
  result: { message: { role: 'assistant', content }, finishReason: 'stop', usage: { promptTokens: 90, completionTokens: 24, totalTokens: 114 } },
});

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'navis-hcx-pilot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the standalone live pilot requires explicit opt-in', () => {
  assert.equal(readConfig({}).hcxPilot, false);
  assert.equal(readConfig({ NAVIS_PROMO_HCX_PILOT: 'false' }).hcxPilot, false);
  assert.equal(readConfig({ NAVIS_PROMO_HCX_PILOT: 'true' }).hcxPilot, true);
});

test('service photo look defaults to NAVER and any configured value other than true disables it', () => {
  assert.equal(readConfig({}).hcxLookEnabled, true);
  assert.equal(readConfig({ NAVIS_PROMO_HCX_PILOT: 'true' }).hcxLookEnabled, true);
  for (const value of ['false', 'False', '0', 'off', 'no', '', 'typo', 'true ']) {
    const config = readConfig({ NAVIS_PROMO_HCX_PILOT: value });
    assert.equal(config.hcxLookEnabled, false, JSON.stringify(value));
    assert.equal(config.hcxPilot, false, JSON.stringify(value));
  }
});

test('switching from Claude photo look to HCX uses a separate photo cache', async t => {
  const dir = await tempDir(t);
  const claude = [];
  const models = [];
  const { scenes, texts, ending } = validStory();
  async function run(flag) {
    const service = createPromoService({
      config: { dir }, references: refs,
      env: { NAVIS_PROMO_HCX_PILOT: flag, NAVIS_PROMO_SCENE_PROVIDER: flag === 'true' ? 'naver' : '', NAVIS_PROMO_PHOTO_SOURCE: 'example', CLOVASTUDIO_API_KEY: 'testing-key' },
      tools: { claude: flag === 'true' ? null : '/fake/claude', browser: '/fake/chrome', ffmpeg: {} },
      spawnProcess: fakeSpawn((_input, args) => ({ stdout: resultLine(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.html ? { html: sceneHtml() } : PHOTO_META) }), claude),
      fetchImpl: async (url, request) => {
        const model = url.split('/').at(-1);
        const body = JSON.parse(request.body);
        models.push([model, body.responseFormat?.schema.required[0]]);
        if (model === 'HCX-005') return reply(PHOTO_META);
        if (body.responseFormat.schema.required[0] === 'html') return reply({ html: sceneHtml() });
        return reply({ scenes, texts, ending });
      },
      checkScene: async () => ({ violations: [] }),
      renderVideo: async ({ outFile }) => { await writeFile(outFile, ''); },
      checkVideo: async () => ({ info: { durationSec: 10, width: 720, height: 1280, sizeBytes: 0 }, violations: [] }),
    });
    try {
      await service.ready;
      const { job } = await service.store.create({ input: INPUT, idempotencyKey: `flag-${flag}` });
      await job.promise;
      assert.equal(job.status, 'done', job.failReason);
    } finally {
      await service.close();
    }
  }
  await run('false');
  assert.equal(claude.length, 6);
  assert.deepEqual(models, [['HCX-007', 'scenes']]);
  await run('true');
  assert.equal(claude.length, 6);
  assert.deepEqual(models.slice(1), [
    ...Array.from({ length: 5 }, () => ['HCX-005', undefined]),
    ['HCX-007', 'scenes'], ['HCX-007', 'html'],
  ]);
});

test('pilot counts failed and retried requests, reserves each reference, and never makes call 51', async t => {
  const { inputFingerprint, runPilot } = await import('./dev/hcx-pilot.mjs');
  const dir = await tempDir(t);
  const outDir = join(dir, 'result');
  const baselinePath = join(dir, 'claude.jsonl');
  const cafe = createExamplePhotoSource({ sourceId: 'cafe' });
  const { request } = await photoMetaInput(cafe, 'cafe-storefront', 'sonnet');
  const inputSha256 = inputFingerprint(request);
  await writeFile(baselinePath, JSON.stringify({ stage: 'look', inputSha256, output: PHOTO_META, latencyMs: 1200 }));
  const references = loadReferences();
  const models = [];
  let lookCalls = 0;
  const transport = createClovaStudio({ apiKey: 'secret-fake-value', fetchImpl: async (url, request) => {
    const model = url.split('/').at(-1);
    models.push(model);
    if (model === 'HCX-005') {
      lookCalls++;
      // HCX-005 needs a data URL with the image part first (the first pilot sent bare base64: 39/39 HTTP 400).
      const [image, text] = JSON.parse(request.body).messages[0].content;
      assert.deepEqual([image.type, text.type], ['image_url', 'text']);
      assert.match(image.dataUri.data, /^data:image\/jpeg;base64,\/9j\//);
      if (lookCalls === 3) return globalThis.Response.json({ status: { code: '42901' } }, { status: 429 });
      return reply(lookCalls === 1 ? { ...PHOTO_META, extra: true } : PHOTO_META);
    }
    const prompt = JSON.parse(request.body).messages[0].content;
    const repair = prompt.includes('failed the automatic check');
    const [, id] = /"referenceId":"(ref-[1-6])"/.exec(prompt);
    return reply({ html: repair ? references.refs.get(id).exampleHtml : '<!doctype html><html></html>' });
  } });
  const report = await runPilot({
    outDir, transport, references, baselinePath, checkBrowser: async () => ({ violations: [] }),
    captureScreens: async () => {},
  });
  assert.equal(models.length, 50);
  assert.equal(lookCalls, 40);
  assert.equal(report.calls, 50);
  assert.equal(report.capReached, true);
  assert.equal(report.tokens.missingCalls, 1);
  assert.deepEqual(report.caps, { look: 40, scenes: 10, total: 50 });
  assert.deepEqual([report.stages.look.calls, report.stages.look.capReached, report.stages.scenes.calls, report.stages.scenes.capReached], [40, true, 10, true]);
  assert.equal(report.stages.look.tokens.total + report.stages.scenes.tokens.total, report.tokens.total);
  assert.equal(report.cases.filter(row => row.stage === 'look').length, 39);
  assert.equal(report.cases.filter(row => row.stage === 'scenes').length, 6);
  assert.deepEqual(report.cases.filter(row => row.claude).map(row => [row.id, row.claude.latencyMs]), [['cafe-storefront', 1200]]);
  const log = await readFile(join(outDir, 'calls.jsonl'), 'utf8');
  assert.doesNotMatch(log, /secret-fake-value|Describe only|<!doctype/i);
  const calls = log.trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 50);
  assert.deepEqual(calls.slice(0, 2).map(row => [row.outcome, row.retries, row.tokens.total]), [
    ['AI_BAD_OUTPUT', 0, 114], ['success', 1, 114],
  ]);
  assert.deepEqual([calls[2].httpStatus, calls[2].providerCode, calls[2].tokens.total], [429, '42901', null]);
  assert.ok(calls.some(row => row.repair === 1 && row.check.static === 'pass'));
  assert.match(await readFile(join(outDir, 'parity.md'), 'utf8'), /Claude.*unavailable/i);
});

test('each stage keeps to its own cap: look 40 (39 photos + 1 spare), scenes 10, total 50', async t => {
  const { runPilot } = await import('./dev/hcx-pilot.mjs');
  const references = loadReferences();
  async function run(name, handler) {
    const dir = await tempDir(t);
    const seen = { look: 0, scenes: 0 };
    const transport = createClovaStudio({ apiKey: 'secret-fake-value', fetchImpl: async (url, request) => {
      const look = url.split('/').at(-1) === 'HCX-005';
      seen[look ? 'look' : 'scenes']++;
      return handler(look, JSON.parse(request.body));
    } });
    const report = await runPilot({ outDir: join(dir, name), transport, references, checkBrowser: async () => ({ violations: [] }), captureScreens: async () => {} });
    return { report, seen, dir };
  }
  // Every photo answer is off-schema: each of the 39 photos still gets its first call, and only one retry fits.
  const bad = await run('bad', look => look ? reply({ ...PHOTO_META, extra: true }) : reply({ html: '<!doctype html><html></html>' }));
  assert.deepEqual(bad.seen, { look: 40, scenes: 10 });
  assert.deepEqual([bad.report.calls, bad.report.stages.look.calls, bad.report.stages.scenes.calls], [50, 40, 10]);
  assert.equal(bad.report.cases.filter(row => row.stage === 'look').length, 39);
  assert.equal(bad.report.cases.filter(row => row.stage === 'scenes').length, 6);
  // Every photo and every scene input made its own first call; only the spare look call and the repairs were shared.
  const log = (await readFile(join(bad.dir, 'bad', 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 50);
  assert.equal(new Set(log.filter(row => row.stage === 'look').map(row => row.id)).size, 39);
  assert.equal(new Set(log.filter(row => row.stage === 'scenes').map(row => row.id)).size, 6);
  assert.equal(log.filter(row => row.stage === 'look' && row.retries === 1).length, 1);
  // Everything passes first time: 39 + 6 calls, well under the caps, and nothing is retried.
  const good = await run('good', (look, body) => look ? reply(PHOTO_META)
    : reply({ html: references.refs.get(/"referenceId":"(ref-[1-6])"/.exec(body.messages[0].content)[1]).exampleHtml }));
  assert.deepEqual([good.report.calls, good.report.stages.look.calls, good.report.stages.scenes.calls, good.report.capReached], [45, 39, 6, false]);
  assert.deepEqual([good.report.stages.look.capReached, good.report.stages.scenes.capReached], [false, false]);
});

// PROMO-NEXT (D-327 Q8): a look-only run with a small call cap, to read why HCX-005 replies fail and to verify the fix.
test('look-only run: the named photos, a hard call cap, no scene call, and the cap is recorded', async t => {
  const { runPilot } = await import('./dev/hcx-pilot.mjs');
  const photoIds = ['cafe-americano-01', 'cafe-saltbread-03', 'cafe-storefront'];
  const urls = [];
  async function run(name, maxCalls, handler) {
    const dir = await tempDir(t);
    const transport = createClovaStudio({ apiKey: 'secret-fake-value', fetchImpl: async (url, request) => { urls.push(url.split('/').at(-1)); return handler(JSON.parse(request.body)); } });
    const report = await runPilot({ outDir: join(dir, name), transport, stages: ['look'], photoIds, maxCalls, checkBrowser: async () => ({ violations: [] }), captureScreens: async () => {} });
    return { report, calls: (await readFile(join(dir, name, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
  }
  // Cap = photos: one call each, a bad reply is not retried, and its own outcome is kept (not "budget exhausted").
  const tight = await run('tight', 3, () => rawReply('```json\n{}\n```'));
  assert.deepEqual(urls, ['HCX-005', 'HCX-005', 'HCX-005']);
  assert.deepEqual([tight.report.calls, tight.report.cap, tight.report.capReached], [3, 3, true]);
  assert.deepEqual(tight.report.caps, { look: 3, scenes: 0, total: 3 });
  assert.deepEqual([tight.report.stages.look.calls, tight.report.stages.scenes.calls, tight.report.stages.scenes.capReached], [3, 0, false]);
  assert.deepEqual(tight.report.cases.map(row => [row.id, row.stage, row.outcome]), photoIds.map(id => [id, 'look', 'AI_BAD_OUTPUT']));
  assert.deepEqual(tight.calls.map(row => [row.id, row.retries, row.failure]), photoIds.map(id => [id, 0, 'schema:$.kind: required,$.subject: required,$.items: required,$.flavors: required,$.people: required']));
  assert.ok(tight.calls.every(row => row.parse === 'fenced'), 'the fence was unwrapped, the schema then rejected the empty object');
  // One spare call: a retry fits once, and never a fourth.
  urls.length = 0;
  const spare = await run('spare', 4, () => reply({ ...PHOTO_META, extra: true }));
  assert.equal(urls.length, 4);
  assert.deepEqual(spare.calls.map(row => [row.id, row.retries]), [['cafe-americano-01', 0], ['cafe-americano-01', 1], ['cafe-saltbread-03', 0], ['cafe-storefront', 0]]);
  // All three pass at the cap, including a fenced reply with overlong strings.
  urls.length = 0;
  const longLabel = 'A cup of iced latte with a layer of milk and espresso';
  const overlong = { ...PHOTO_META, items: [longLabel, longLabel], flavors: [longLabel], captionHints: ['x'.repeat(61)] };
  const good = await run('good', 3, () => urls.length === 1
    ? rawReply(`\`\`\`json\n${JSON.stringify(overlong)}\n\`\`\``)
    : reply(PHOTO_META));
  assert.deepEqual([good.report.calls, good.report.capReached, good.report.cases.map(row => row.schemaValid)], [3, true, [true, true, true]]);
  assert.deepEqual(good.calls.map(row => [row.retries, row.parse, row.itemsTrimmed, row.flavorsTrimmed, row.hintsDropped]), [
    [0, 'fenced', 2, 1, 1], [0, 'json', 0, 0, 0], [0, 'json', 0, 0, 0],
  ]);
  assert.equal(JSON.stringify(good.calls).includes(longLabel), false);
});

test('look-only options are validated before any call', async t => {
  const { parsePilotFlags, runPilot } = await import('./dev/hcx-pilot.mjs');
  assert.deepEqual(parsePilotFlags([]), {});
  assert.deepEqual(parsePilotFlags(['--stage=look', '--photos=cafe-americano-01,cafe-storefront', '--max-calls=3']), { stages: ['look'], photoIds: ['cafe-americano-01', 'cafe-storefront'], maxCalls: 3 });
  for (const bad of [['--stage=merge'], ['--max-calls=0'], ['--max-calls=51'], ['--max-calls=x'], ['--photos='], ['--verbose'], ['--stage=scenes', '--photos=cafe-storefront'], ['--photos=cafe-storefront']]) {
    assert.throws(() => parsePilotFlags(bad), { message: 'PILOT_USAGE' }, bad.join(' '));
  }
  let called = 0;
  const transport = createClovaStudio({ apiKey: 'secret-fake-value', fetchImpl: async () => { called++; return reply(PHOTO_META); } });
  const base = { transport, stages: ['look'], checkBrowser: async () => ({ violations: [] }), captureScreens: async () => {} };
  const attempt = async (name, extra) => runPilot({ ...base, outDir: join(await tempDir(t), name), ...extra });
  await assert.rejects(attempt('unknown', { photoIds: ['cafe-nope-01'], maxCalls: 1 }), { message: 'PILOT_USAGE' });
  await assert.rejects(attempt('dup', { photoIds: ['cafe-storefront', 'cafe-storefront'], maxCalls: 2 }), { message: 'PILOT_USAGE' });
  await assert.rejects(attempt('few', { photoIds: ['cafe-storefront', 'cafe-interior-01'], maxCalls: 1 }), { message: 'PILOT_USAGE' });
  assert.equal(called, 0);
});
