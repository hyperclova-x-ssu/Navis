import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startPreview } from '../preview.mjs';
import { PromoError } from './errors.mjs';
import { INPUT, PHOTO_META, STORE, fakeSpawn, photoSource, refs, resultLine, validStory } from './test/helpers.mjs';

test('widget job persists the HCX plan from a fake provider before rendering', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'navis-promo-widget-'));
  const { scenes, texts, ending } = validStory();
  texts[0].text = '휘낭시에';
  texts[1].text = '휘낭시에 한 컷';
  texts[2].text = '들러 보세요';
  const raw = { scenes, texts, ending };
  const requests = [];
  const cliRequests = [];
  let reachedScenes = false;
  const app = await startPreview({
    root: dir, port: 0,
    promoOptions: {
      config: { dir }, env: { CLOVASTUDIO_API_KEY: 'fake' }, references: refs, photoSource,
      tools: { claude: '/fake/claude', browser: '/fake/browser', ffmpeg: {} },
      spawnProcess: fakeSpawn(() => ({ stdout: resultLine({ html: '<div id="stage"></div>' }) }), cliRequests),
      fetchImpl: async (url, request) => {
        requests.push({ url, body: JSON.parse(request.body) });
        const output = url.endsWith('/HCX-005') ? PHOTO_META : raw;
        return globalThis.Response.json({ status: { code: '20000' }, result: {
          message: { role: 'assistant', content: JSON.stringify(output) }, finishReason: 'stop',
          usage: { promptTokens: 1800, completionTokens: 320 },
        } });
      },
      checkScene: async () => { reachedScenes = true; throw new PromoError('RENDER_FAILED'); },
      renderVideo: async () => assert.fail('This check must stop before video generation'),
    },
  });
  t.after(async () => {
    const closed = once(app, 'close');
    app.stop();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const accepted = await globalThis.fetch(`${origin}/api/promo/jobs`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: 'promo-hcx-widget', input: { ...INPUT, concepts: ['todays-deal'], memo: '가격은 지어내지 않기' } }),
  });
  assert.equal(accepted.status, 202);
  const { jobId } = await accepted.json();
  const deadline = Date.now() + 3000;
  let job;
  do {
    job = await (await globalThis.fetch(`${origin}/api/promo/jobs/${jobId}`)).json();
    if (job.status === 'failed') break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(job.stage, 'scenes');
  assert.equal(job.failReason, 'RENDER_FAILED');
  assert.equal(reachedScenes, true);
  assert.equal(cliRequests.length, 1);
  assert.equal(requests.length, INPUT.photoIds.length + 1);
  for (const { url, body } of requests.slice(0, INPUT.photoIds.length)) {
    assert.match(url, /\/HCX-005$/);
    assert.equal(body.messages[0].content[0].type, 'image_url');
  }
  const storyRequest = requests.at(-1);
  assert.match(storyRequest.url, /\/HCX-007$/);
  const prompt = storyRequest.body.messages[0].content;
  for (const fact of [STORE.name, STORE.location, '휘낭시에', INPUT.photoIds[0], '가격은 지어내지 않기']) assert.ok(prompt.includes(fact));
  assert.match(prompt, /Use only the supplied store facts/);
  assert.doesNotMatch(prompt, /limited today, come early|fake brief ref-1|golden crust/);
  const saved = JSON.parse(await readFile(join(dir, 'jobs', jobId, 'story.json'), 'utf8'));
  assert.deepEqual({ scenes: saved.scenes, texts: saved.texts, ending: saved.ending }, raw);
});
