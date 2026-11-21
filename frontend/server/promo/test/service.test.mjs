import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPromoService } from '../service.mjs';
import { createClaudeRunner } from '../claude-runner.mjs';
import { PromoError } from '../errors.mjs';
import { PHOTO_META_SCHEMA, STORY_SCHEMA } from '../prompts.mjs';
import { INPUT, PHOTO_META, fakeSpawn, refs, resultLine, validStory, photoSource } from './helpers.mjs';

const TOOLS = { claude: '/fake/claude', browser: '/fake/chrome', ffmpeg: { ffmpeg: 'f', ffprobe: 'p', h264: 'libx264' } };
const GOOD_HTML = '<!doctype html><div id="stage"><div data-scene="s1"></div><div data-scene="s2"></div><div data-scene="s3"></div></div>';
const PRIVATE_HOST = 'demo.tailnet.invalid:5443';
const PRIVATE_ORIGIN = `https://${PRIVATE_HOST}`;
const privateOptions = { allowedOrigins: new Map([[PRIVATE_ORIGIN, new Set([PRIVATE_HOST, 'demo.tailnet.invalid'])]]) };

/** 가짜 실행기: 스키마로 호출 종류를 가린다. over[kind]가 있으면 그것을 쓴다. */
function fakeRunner(over = {}) {
  const calls = [];
  return {
    calls,
    async run(req) {
      const kind = req.schema === PHOTO_META_SCHEMA ? 'look' : req.schema === STORY_SCHEMA ? 'story' : /failed the automatic check/.test(req.prompt) ? 'fix' : 'code';
      calls.push({ kind, prompt: req.prompt, images: req.images?.length ?? 0 });
      const custom = over[kind];
      if (custom) return custom(req, calls.filter(c => c.kind === kind).length);
      const output = kind === 'look' ? PHOTO_META : kind === 'story' ? (({ scenes, texts, ending }) => ({ scenes, texts, ending }))(validStory()) : { html: kind === 'fix' ? `${GOOD_HTML}<!--fixed-->` : GOOD_HTML };
      return { output, usage: { calls: 1, inputTokens: 10, outputTokens: 5 }, durationMs: 1 };
    },
  };
}

async function host(deps = {}) {
  const dir = deps.dir || await mkdtemp(join(tmpdir(), 'navis-promo-test-'));
  const runner = deps.runner || fakeRunner();
  const seenChecks = [];
  const svc = createPromoService({
    config: { dir, fault: null, ...deps.config }, references: refs, tools: TOOLS, runner, estimateBasePath: join(dir, 'none.json'),
    checkScene: deps.checkScene || (async a => { seenChecks.push(a); return { violations: [], checkMs: 1 }; }),
    renderVideo: deps.renderVideo || (async a => { await writeFile(a.outFile, Buffer.alloc(3000, 7)); return { file: a.outFile }; }),
    checkVideo: deps.checkVideo || (async () => ({ info: { durationSec: 10, width: 720, height: 1280, sizeBytes: 3000 }, violations: [] })),
    ...deps.extra,
    env: { NAVIS_PROMO_HCX_PILOT: 'false', ...(deps.env ?? { NAVIS_PROMO_PHOTO_SOURCE: 'example', ...deps.extra?.env }) },
  });
  const server = createServer((req, res) => svc(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, svc, dir, runner, seenChecks,
    post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    get: (path, headers = {}) => fetch(base + path, { headers }),
    async waitDone(jobId) {
      let j;
      for (const end = Date.now() + 20000; Date.now() < end;) {
        j = await (await fetch(`${base}/api/promo/jobs/${jobId}`)).json();
        if (j.status === 'done' || j.status === 'failed') return j;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error(`job did not settle: ${JSON.stringify(j)}`);
    },
    async close({ keep = false } = {}) { await svc.close(); await new Promise(r => server.close(r)); if (!keep) await rm(dir, { recursive: true, force: true }); },
  };
}

let keySeq = 0;
const key = () => `key-${String(++keySeq).padStart(4, '0')}`;
const make = (app, input = INPUT, k = key()) => app.post('/api/promo/jobs', { idempotencyKey: k, input });

function privateRequest(app, path, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(app.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: PRIVATE_HOST, 'sec-fetch-site': 'same-origin', ...headers },
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject).end(body);
  });
}

test('configured private origin serves same-origin catalog and media and accepts jobs', async () => {
  const app = await host({ extra: privateOptions });
  try {
    const catalog = await privateRequest(app, '/api/promo/catalog');
    assert.equal(catalog.status, 200);
    assert.equal(JSON.parse(catalog.bytes).photos.length, 10);

    const accepted = await privateRequest(app, '/api/promo/jobs', {
      headers: { origin: PRIVATE_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: key(), input: INPUT }),
    });
    assert.equal(accepted.status, 202);
    const job = await app.waitDone(JSON.parse(accepted.bytes).jobId);
    assert.equal(job.status, 'done');

    const previewPath = '/api/promo/references/ref-1/preview.mp4';
    for (const [path, type] of [
      ['/api/promo/photos/fin-01', 'image/jpeg'],
      ['/api/promo/references/ref-1/poster.jpg', 'image/jpeg'],
      [previewPath, 'video/mp4'],
      [job.result.fileUrl, 'video/mp4'],
    ]) {
      const media = await privateRequest(app, path);
      assert.equal(media.status, 200, path);
      assert.equal(media.headers['content-type'], type);
      assert.ok(media.bytes.length > 0, path);
    }
    for (const [path, size] of [[previewPath, 5000], [job.result.fileUrl, 3000]]) {
      const part = await privateRequest(app, path, { headers: { range: 'bytes=100-199' } });
      assert.equal(part.status, 206, path);
      assert.equal(part.headers['content-range'], `bytes 100-199/${size}`);
      assert.equal(part.bytes.length, 100);
    }
  } finally { await app.close(); }
});

test('private promo rejects unconfigured hosts, foreign origins, cross-site metadata and non-loopback sockets', async () => {
  const app = await host({ extra: privateOptions });
  try {
    for (const headers of [
      { host: 'unconfigured.tailnet.invalid:5443' },
      { host: 'demo.tailnet.invalid:4443', origin: PRIVATE_ORIGIN },
      { origin: 'https://foreign.invalid' },
      { 'sec-fetch-site': 'cross-site', origin: PRIVATE_ORIGIN },
      { 'sec-fetch-site': 'none' },
    ]) {
      const denied = await privateRequest(app, '/api/promo/catalog', { headers });
      assert.equal(denied.status, 403, JSON.stringify(headers));
      assert.deepEqual(JSON.parse(denied.bytes), { code: 'FORBIDDEN' });
    }
    for (const origin of [undefined, 'https://foreign.invalid', `http://${PRIVATE_HOST}`]) {
      const denied = await privateRequest(app, '/api/promo/jobs', {
        headers: { 'content-type': 'application/json', ...(origin && { origin }) },
        body: JSON.stringify({ idempotencyKey: key(), input: INPUT }),
      });
      assert.equal(denied.status, 403, String(origin));
      assert.deepEqual(JSON.parse(denied.bytes), { code: 'FORBIDDEN' });
    }
    for (const address of ['localAddress', 'remoteAddress']) {
      const req = {
        url: '/api/promo/catalog', method: 'GET',
        headers: { host: PRIVATE_HOST, origin: PRIVATE_ORIGIN },
        socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', [address]: '100.64.0.2' },
      };
      let status;
      await app.svc(req, { writeHead: code => { status = code; }, end() {} });
      assert.equal(status, 403, address);
    }
    assert.equal(app.runner.calls.length, 0);
  } finally { await app.close(); }
});

test('API-20 카탈로그·사진, API-27 레퍼런스·포스터, API-21 예상 표', async () => {
  const app = await host();
  try {
    const cat = await (await app.get('/api/promo/catalog')).json();
    assert.equal(cat.sourceId, 'example'); assert.equal(cat.photos.length, 10); assert.equal(cat.store.exteriorUrl, '/api/promo/photos/store-exterior');
    assert.deepEqual(cat.menus.map(m => m.photoIds.length), [10, 0, 0]);
    const photo = await app.get('/api/promo/photos/fin-01');
    assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/jpeg'); assert.equal(photo.headers.get('cache-control'), 'max-age=3600');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), (await photoSource.readPhoto('fin-01')).bytes);
    assert.equal((await app.get('/api/promo/photos/store-exterior')).status, 200);
    for (const bad of ['FIN-01', 'fin_01', 'x'.repeat(33), 'fin-99']) assert.equal((await app.get(`/api/promo/photos/${bad}`)).status, 404);
    const list = await (await app.get('/api/promo/references')).json();
    assert.deepEqual(list.references.map(r => r.id), ['ref-1', 'ref-2']);
    assert.deepEqual(list.references[0].preview, { durationSec: 4, width: 360, height: 640, fps: 30, hasAudio: false });
    assert.equal(list.references[0].posterUrl, '/api/promo/references/ref-1/poster.jpg');
    assert.equal((await app.get('/api/promo/references/ref-1/poster.jpg')).headers.get('content-type'), 'image/jpeg');
    const preview = await app.get('/api/promo/references/ref-1/preview.mp4', { range: 'bytes=0-9' });
    assert.equal(preview.status, 206); assert.equal(preview.headers.get('content-range'), 'bytes 0-9/5000');
    assert.equal((await app.get('/api/promo/references/ref-2/poster.jpg')).status, 404);
    assert.equal((await app.get('/api/promo/references/ref-9/poster.jpg')).status, 404);
    const est = await (await app.get('/api/promo/estimate-model')).json();
    assert.deepEqual(Object.keys(est.table), ['10', '15', '30']); assert.equal(est.table['15'].length, 11);
    assert.deepEqual(est.available, { claude: true, browser: true, ffmpeg: true });
    assert.equal(est.table['15'][5].seconds, 153);
  } finally { await app.close(); }
});

test('출처 바꾸기: example-7·example-4', async () => {
  for (const [source, n] of [['example-7', 7], ['example-4', 4]]) {
    const app = await host({ config: { photoSource: source }, extra: { photoSource: (await import('../photo-source.mjs')).createExamplePhotoSource({ sourceId: source }) } });
    try {
      const cat = await (await app.get('/api/promo/catalog')).json();
      assert.equal(cat.photos.length, n);
      assert.equal((await app.get('/api/promo/photos/fin-09')).status, 404);
      const est = await (await app.get('/api/promo/estimate-model')).json();
      assert.equal(est.table['10'].length, n + 1);
    } finally { await app.close(); }
  }
});

test('API-20 defaults to the cafe storefront and six photos per best-selling menu', async () => {
  const app = await host({ env: {} });
  try {
    const cat = await (await app.get('/api/promo/catalog')).json();
    assert.equal(cat.sourceId, 'cafe');
    assert.equal(cat.store.name, '안숭잘부 카페');
    assert.equal(cat.store.exteriorUrl, '/api/promo/photos/cafe-storefront');
    assert.equal(cat.menus.length, 24);
    assert.deepEqual(Object.fromEntries(cat.menus.filter(m => m.photoIds.length).map(m => [m.menuId, m.photoIds.length])), {
      'm-americano': 6, 'm-cafe-latte': 6, 'm-vanilla-latte': 6,
      'm-saltbread': 6, 'm-dolce-latte': 6, 'm-deep-choco': 6,
    });
    assert.equal(cat.photos.length, 36);
    assert.ok(cat.photos.every(p => p.menuId));
    for (const url of [cat.store.exteriorUrl, cat.photos[0].url, '/api/promo/photos/cafe-interior-01', '/api/promo/photos/cafe-interior-02']) {
      const res = await app.get(url);
      assert.equal(res.status, 200, url);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
    }
    assert.equal((await app.get('/api/promo/photos/fin-01')).status, 404);
  } finally { await app.close(); }
});

test('API-22 입력 검증 표: 모든 400', async () => {
  const app = await host();
  try {
    const cases = [
      [{ ...INPUT, photoIds: INPUT.photoIds.slice(0, 4) }, 'photoIds'],
      [{ ...INPUT, photoIds: ['fin-01', 'fin-01', 'fin-02', 'fin-03', 'fin-04'] }, 'photoIds'],
      [{ ...INPUT, photoIds: [...INPUT.photoIds.slice(0, 4), 'fin-99'] }, 'photoIds'],
      [{ ...INPUT, photoIds: [...INPUT.photoIds.slice(0, 4), 'store-exterior'] }, 'photoIds'],
      [{ ...INPUT, menuIds: ['croissant'] }, 'photoIds'],
      [{ ...INPUT, menuIds: [] }, 'menuIds'],
      [{ ...INPUT, menuIds: ['pizza'] }, 'menuIds'],
      [{ ...INPUT, menuIds: ['financier', 'financier'] }, 'menuIds'],
      [{ ...INPUT, moods: [] }, 'moods'],
      [{ ...INPUT, moods: ['angry'] }, 'moods'],
      [{ ...INPUT, moods: ['warm', 'warm'] }, 'moods'],
      [{ ...INPUT, concepts: [] }, 'concepts'],
      [{ ...INPUT, concepts: ['ad'] }, 'concepts'],
      [{ ...INPUT, memo: '가'.repeat(101) }, 'memo'],
      [{ ...INPUT, memo: '줄\n바꿈' }, 'memo'],
      [{ ...INPUT, memo: 5 }, 'memo'],
      [{ ...INPUT, referenceId: 'ref-7' }, 'referenceId'],
      [{ ...INPUT, referenceId: 'ref-3' }, 'referenceId'],
      [{ ...INPUT, lengthSec: 20 }, 'lengthSec'],
      [{ ...INPUT, lengthSec: '15' }, 'lengthSec'],
      [{ ...INPUT, locale: 'ja' }, 'locale'],
      [{ ...INPUT, storeName: 'x' }, 'storeName'],
    ];
    for (const [input, field] of cases) {
      const res = await make(app, input);
      assert.equal(res.status, 400, field);
      assert.deepEqual(await res.json(), { code: 'BAD_REQUEST', field }, JSON.stringify(input));
    }
    for (const k of ['short', 'x'.repeat(65), 'bad key!']) assert.deepEqual(await (await make(app, INPUT, k)).json(), { code: 'BAD_REQUEST', field: 'idempotencyKey' });
    assert.deepEqual(await (await app.post('/api/promo/jobs', { idempotencyKey: key() })).json(), { code: 'BAD_REQUEST', field: 'input' });
    assert.deepEqual(await (await app.post('/api/promo/jobs', '{oops')).json(), { code: 'BAD_REQUEST', field: 'body' });
    assert.equal((await make(app, { ...INPUT, memo: '가'.repeat(100) })).status, 202);
  } finally { await app.close(); }
});

test('공통 보안: Origin 403, Content-Type 415, 16KB 413, Host 403, 경로 정규식·인코딩 404', async () => {
  const app = await host();
  try {
    assert.equal((await app.post('/api/promo/jobs', { idempotencyKey: key(), input: INPUT }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`${app.base}/api/promo/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const ct = await app.post('/api/promo/jobs', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(ct.status, 415); assert.deepEqual(await ct.json(), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    const big = await app.post('/api/promo/jobs', JSON.stringify({ idempotencyKey: key(), input: { ...INPUT, memo: 'x'.repeat(17000) } }));
    assert.equal(big.status, 413); assert.deepEqual(await big.json(), { code: 'PAYLOAD_TOO_LARGE' });
    const port = new URL(app.base).port;
    const raw = (path, headers = {}) => new Promise(resolve => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path, headers }, res => { res.resume(); resolve(res.statusCode); });
        req.end();
      });
    });
    assert.equal(await raw('/api/promo/catalog', { host: `localhost:${port}` }), 403);
    assert.equal(await raw('/api/promo/jobs/../catalog'), 404);
    for (const p of ['/api/promo/jobs/pj-XYZ', '/api/promo/jobs/pj-0123456789ab0', '/api/promo/%63atalog', '/api/promo/jobs/pj-000000000000/video.mp4']) assert.equal((await app.get(p)).status, 404, p);
    assert.equal((await app.post('/api/promo/catalog', {})).status, 404);
  } finally { await app.close(); }
});

test('한 번만 키·BUSY·단계 순서(앞으로만)·완료 결과·Range 206·다운로드 이름', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const stagesSeen = [];
  const runner = fakeRunner({ story: async () => { await gate; return { output: (({ scenes, texts, ending }) => ({ scenes, texts, ending }))(validStory()), usage: { calls: 1, inputTokens: 1, outputTokens: 1 } }; } });
  const app = await host({ runner });
  try {
    const k = key();
    const first = await make(app, INPUT, k);
    assert.equal(first.status, 202);
    const a = await first.json();
    assert.match(a.jobId, /^pj-[0-9a-f]{12}$/);
    assert.deepEqual({ ...a, startedAt: 0 }, { jobId: a.jobId, status: 'queued', stage: 'look', stageState: 'active', lookCount: 5, startedAt: 0 });
    const again = await make(app, INPUT, k);
    assert.equal(again.status, 202); assert.equal((await again.json()).jobId, a.jobId);
    const busy = await make(app, INPUT);
    assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { code: 'BUSY', activeJobId: a.jobId });
    for (let i = 0; i < 100; i++) { const j = await (await app.get(`/api/promo/jobs/${a.jobId}`)).json(); stagesSeen.push(j.stage); if (j.stage === 'story') break; await new Promise(r => setTimeout(r, 5)); }
    assert.equal(stagesSeen.at(-1), 'story');
    release();
    const done = await app.waitDone(a.jobId);
    assert.equal(done.status, 'done'); assert.equal(done.stage, 'merge'); assert.equal(done.stageState, 'done'); assert.equal(done.failReason, null);
    assert.deepEqual(done.result, { durationSec: 10, width: 720, height: 1280, fps: 30, sizeBytes: 3000, fileUrl: `/api/promo/jobs/${a.jobId}/video.mp4`, music: { trackId: 'warm-cozy-acoustic', title: 'Cozy Puzzle In-Game 3', artist: 'MintoDog', license: 'CC0-1.0' }, fixCount: 0 });
    const order = ['look', 'story', 'scenes', 'merge'];
    stagesSeen.reduce((prev, s) => { assert.ok(order.indexOf(s) >= order.indexOf(prev)); return s; }, 'look');
    const full = await app.get(done.result.fileUrl);
    assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal((await full.arrayBuffer()).byteLength, 3000);
    const part = await app.get(done.result.fileUrl, { range: 'bytes=100-199' });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 100-199/3000'); assert.equal((await part.arrayBuffer()).byteLength, 100);
    const tail = await app.get(done.result.fileUrl, { range: 'bytes=-10' });
    assert.equal(tail.headers.get('content-range'), 'bytes 2990-2999/3000');
    assert.equal((await app.get(done.result.fileUrl, { range: 'bytes=5000-' })).status, 416);
    const dl = await app.get(`${done.result.fileUrl}?download=1`);
    const d = new Date(); const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    assert.equal(dl.headers.get('content-disposition'), `attachment; filename="navis-promo-${a.jobId}.mp4"; filename*=UTF-8''${encodeURIComponent(`미학당-${ymd}-1.mp4`)}`);
    // 같은 키는 끝난 뒤에도 같은 작업
    assert.equal((await (await make(app, INPUT, k)).json()).jobId, a.jobId);
    // 저장 폴더: input·story·scene·checks·final·job, stats
    const files = await readdir(join(app.dir, 'jobs', a.jobId));
    for (const f of ['input.json', 'story.json', 'scene.html', 'scene.v0.html', 'checks.json', 'final.mp4', 'job.json']) assert.ok(files.includes(f), f);
    const job = JSON.parse(await readFile(join(app.dir, 'jobs', a.jobId, 'job.json'), 'utf8'));
    assert.equal(job.usage.calls, 7); assert.equal(job.model, 'sonnet'); assert.equal(job.promptVersion, 'p3');
    const story = JSON.parse(await readFile(join(app.dir, 'jobs', a.jobId, 'story.json'), 'utf8'));
    assert.equal(story.musicTrackId, 'warm-cozy-acoustic'); assert.equal(story.locale, 'ko');
    const stats = JSON.parse(await readFile(join(app.dir, 'stats.json'), 'utf8'));
    assert.equal(stats.length, 1); assert.equal(stats[0].photoCount, 5);
    assert.equal((await (await app.get('/api/promo/estimate-model')).json()).basis, 'average');
  } finally { await app.close(); }
});

async function failWith(deps, expectStage) {
  const app = await host(deps);
  try {
    const { jobId } = await (await make(app)).json();
    const j = await app.waitDone(jobId);
    assert.equal(j.status, 'failed'); assert.equal(j.stageState, 'failed');
    if (expectStage) assert.equal(j.stage, expectStage);
    return { j, app };
  } finally { await app.close(); }
}
const throwing = code => async () => { throw new PromoError(code); };

test('실패 코드 경로(가짜 실행기·브라우저·인코더)', async () => {
  assert.equal((await failWith({ runner: fakeRunner({ look: throwing('AI_UNAVAILABLE') }) }, 'look')).j.failReason, 'AI_UNAVAILABLE');
  let lookCalls = 0;
  assert.equal((await failWith({ runner: fakeRunner({ look: async () => { lookCalls++; throw new PromoError('AI_TIMEOUT'); } }) }, 'look')).j.failReason, 'AI_TIMEOUT');
  assert.equal(lookCalls, 4, '동시 2 × (1 + 재시도 1), 실패 뒤 새 사진은 부르지 않음');
  assert.equal((await failWith({ runner: fakeRunner({ story: throwing('AI_BAD_OUTPUT') }) }, 'story')).j.failReason, 'AI_BAD_OUTPUT');
  assert.equal((await failWith({ checkScene: throwing('RENDER_FAILED') }, 'scenes')).j.failReason, 'RENDER_FAILED');
  assert.equal((await failWith({ renderVideo: throwing('RENDER_FAILED') }, 'merge')).j.failReason, 'RENDER_FAILED');
  assert.equal((await failWith({ renderVideo: throwing('ENCODE_FAILED') }, 'merge')).j.failReason, 'ENCODE_FAILED');
  assert.equal((await failWith({ extra: { tools: { claude: null, browser: '/c', ffmpeg: {} } } }, 'look')).j.failReason, 'TOOL_MISSING');
  const est = await host({ extra: { tools: { claude: null, browser: null, ffmpeg: null } } });
  try { assert.deepEqual((await (await est.get('/api/promo/estimate-model')).json()).available, { claude: false, browser: false, ffmpeg: false }); } finally { await est.close(); }
});

test('다시 쓰기 2회 뒤 CAPTION_TOO_LONG, 다시 쓰기 프롬프트에 위반 목록', async () => {
  const runner = fakeRunner({ story: async () => {
    const s = validStory(); s.texts[0].text = '가'.repeat(40);
    return { output: { scenes: s.scenes, texts: s.texts, ending: s.ending }, usage: { calls: 1, inputTokens: 1, outputTokens: 1 } };
  } });
  const { j } = await failWith({ runner }, 'story');
  assert.equal(j.failReason, 'CAPTION_TOO_LONG');
  const storyCalls = runner.calls.filter(c => c.kind === 'story');
  assert.equal(storyCalls.length, 3);
  assert.ok(!/## Rewrite/.test(storyCalls[0].prompt));
  assert.match(storyCalls[1].prompt, /text\.length/);
  // 한 번 다시 쓰면 통과
  let n = 0;
  const once = fakeRunner({ story: async () => {
    const s = validStory(); if (++n === 1) s.texts[0].text = '가'.repeat(40);
    return { output: { scenes: s.scenes, texts: s.texts, ending: s.ending }, usage: { calls: 1, inputTokens: 1, outputTokens: 1 } };
  } });
  const app = await host({ runner: once });
  try {
    const { jobId } = await (await make(app)).json();
    assert.equal((await app.waitDone(jobId)).status, 'done');
    assert.equal(JSON.parse(await readFile(join(app.dir, 'jobs', jobId, 'job.json'), 'utf8')).storyRewriteCount, 1);
  } finally { await app.close(); }
});

test('고치기 2회 뒤 CODE_CHECK_FAILED, 고치기 프롬프트에 위반 목록과 앞 코드, 버전·검사 기록', async () => {
  const violation = { t: 1.25, sceneId: 's1', textId: 't1', rule: 'text.safeArea', limit: '60-1020,120-1620', actual: '40,1300-940,1380' };
  const runner = fakeRunner();
  const app = await host({ runner, checkScene: async () => ({ violations: [violation], checkMs: 1 }) });
  try {
    const { jobId } = await (await make(app)).json();
    const j = await app.waitDone(jobId);
    assert.equal(j.failReason, 'CODE_CHECK_FAILED'); assert.equal(j.stage, 'scenes');
    const fixes = runner.calls.filter(c => c.kind === 'fix');
    assert.equal(fixes.length, 2);
    assert.ok(fixes[0].prompt.includes(JSON.stringify(violation)));
    assert.ok(fixes[0].prompt.includes(GOOD_HTML));
    const dir = join(app.dir, 'jobs', jobId);
    const files = await readdir(dir);
    for (const f of ['scene.v0.html', 'scene.v1.html', 'scene.v2.html', 'checks.json']) assert.ok(files.includes(f), f);
    assert.ok(!files.includes('scene.html'));
    const checks = JSON.parse(await readFile(join(dir, 'checks.json'), 'utf8'));
    assert.deepEqual(checks.map(c => [c.version, c.passed]), [[0, false], [1, false], [2, false]]);
    const job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
    assert.equal(job.fixCount, 2); assert.deepEqual(job.checkSummary, { stage: 'scenes', rules: { 'text.safeArea': 1 } });
  } finally { await app.close(); }
});

test('정적 검사 위반도 고치기로 가고, merge 번쩍임 위반은 scenes 고치기로 돌아감(같은 최대 2번)', async () => {
  const runner = fakeRunner({ code: async () => ({ output: { html: '<!doctype html><script>setTimeout(()=>{},1)</script><div id="stage"><div data-scene="s1"></div><div data-scene="s2"></div><div data-scene="s3"></div></div>' }, usage: { calls: 1, inputTokens: 1, outputTokens: 1 } }) });
  let videoChecks = 0;
  const app = await host({ runner, checkVideo: async () => ({ info: { durationSec: 10, width: 720, height: 1280, sizeBytes: 3000 }, violations: ++videoChecks === 1 ? [{ t: 2, rule: 'video.flash', limit: '≤ 3/s', actual: '5/s' }] : [] }) });
  try {
    const { jobId } = await (await make(app)).json();
    const j = await app.waitDone(jobId);
    assert.equal(j.status, 'done'); assert.equal(j.result.fixCount, 2);
    const fixes = runner.calls.filter(c => c.kind === 'fix');
    assert.match(fixes[0].prompt, /static\.forbidden/);
    assert.match(fixes[1].prompt, /video\.flash/);
  } finally { await app.close(); }
});

test('NAVIS_PROMO_FAULT 4단계가 실제 실패 코드를 낸다(Claude 호출 없음)', async () => {
  const expect = { look: 'AI_UNAVAILABLE', story: 'CAPTION_TOO_LONG', scenes: 'CODE_CHECK_FAILED', merge: 'ENCODE_FAILED' };
  for (const [stage, code] of Object.entries(expect)) {
    const runner = fakeRunner();
    const app = await host({ runner, extra: { env: { NAVIS_PROMO_FAULT: stage } }, config: { fault: stage } });
    try {
      const { jobId } = await (await make(app)).json();
      const j = await app.waitDone(jobId);
      assert.equal(j.stage, stage); assert.equal(j.failReason, code);
      if (stage === 'look') assert.equal(runner.calls.length, 0);
    } finally { await app.close(); }
  }
});

test('다시 만들기(API-24): 같은 입력, retryOf, 캐시로 look 호출 없음, failed가 아니면 400', async () => {
  let fail = true;
  const runner = fakeRunner({ story: async () => { if (fail) throw new PromoError('AI_BAD_OUTPUT'); const s = validStory(); return { output: { scenes: s.scenes, texts: s.texts, ending: s.ending }, usage: { calls: 1, inputTokens: 1, outputTokens: 1 } }; } });
  const app = await host({ runner });
  try {
    const { jobId } = await (await make(app)).json();
    assert.equal((await app.waitDone(jobId)).failReason, 'AI_BAD_OUTPUT');
    assert.equal(runner.calls.filter(c => c.kind === 'look').length, 5);
    fail = false;
    const k = key();
    const r = await app.post(`/api/promo/jobs/${jobId}/retry`, { idempotencyKey: k });
    assert.equal(r.status, 202);
    const retry = await r.json();
    assert.equal(retry.retryOf, jobId); assert.notEqual(retry.jobId, jobId);
    assert.equal((await (await app.post(`/api/promo/jobs/${jobId}/retry`, { idempotencyKey: k })).json()).jobId, retry.jobId);
    const done = await app.waitDone(retry.jobId);
    assert.equal(done.status, 'done');
    assert.equal(runner.calls.filter(c => c.kind === 'look').length, 5, '두 번째는 캐시');
    const input = JSON.parse(await readFile(join(app.dir, 'jobs', retry.jobId, 'input.json'), 'utf8'));
    assert.deepEqual(input, { ...INPUT });
    assert.deepEqual(await (await app.post(`/api/promo/jobs/${retry.jobId}/retry`, { idempotencyKey: key() })).json(), { code: 'BAD_REQUEST', field: 'status' });
    assert.equal((await app.post('/api/promo/jobs/pj-000000000000/retry', { idempotencyKey: key() })).status, 404);
  } finally { await app.close(); }
});

test('캐시: 같은 사진 두 번째는 호출 없음, 고르지 않은 사진은 읽지 않음·보내지 않음', async () => {
  const reads = [];
  const { createExamplePhotoSource } = await import('../photo-source.mjs');
  const real = createExamplePhotoSource();
  const spy = { ...real, readPhoto: async id => { reads.push(id); return real.readPhoto(id); } };
  const runner = fakeRunner();
  const app = await host({ runner, extra: { photoSource: spy } });
  try {
    const { jobId } = await (await make(app)).json();
    await app.waitDone(jobId);
    const looks = runner.calls.filter(c => c.kind === 'look');
    assert.equal(looks.length, 5); assert.ok(looks.every(c => c.images === 1));
    assert.ok(runner.calls.filter(c => c.kind !== 'look').every(c => c.images === 0));
    assert.deepEqual([...new Set(reads)].sort(), [...INPUT.photoIds, 'store-exterior'].sort());
    assert.ok(!reads.some(id => ['fin-06', 'fin-07', 'fin-08', 'fin-09', 'fin-10'].includes(id)));
    const { jobId: second } = await (await make(app, { ...INPUT, moods: ['lively'] })).json();
    await app.waitDone(second);
    assert.equal(runner.calls.filter(c => c.kind === 'look').length, 5);
    const story = JSON.parse(await readFile(join(app.dir, 'jobs', second, 'story.json'), 'utf8'));
    assert.equal(story.musicTrackId, 'upbeat-joyfully');
  } finally { await app.close(); }
});

test('서버 재시작: running으로 남은 작업은 CANCELLED_BY_RESTART, 24시간 지난 폴더 삭제', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navis-promo-restart-'));
  const runner = fakeRunner({ story: ({ signal }) => new Promise((_, reject) => {
    const abort = () => reject(new PromoError('AI_TIMEOUT'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }) });
  const first = await host({ dir, runner });
  const { jobId } = await (await make(first)).json();
  for (let i = 0; i < 100; i++) { if ((await (await first.get(`/api/promo/jobs/${jobId}`)).json()).stage === 'story') break; await new Promise(r => setTimeout(r, 5)); }
  await first.close({ keep: true });
  const stale = join(dir, 'jobs', 'pj-aaaaaaaaaaaa');
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, 'job.json'), JSON.stringify({ jobId: 'pj-aaaaaaaaaaaa', status: 'done', startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:01:00Z' }));
  const second = await host({ dir });
  try {
    const j = await (await second.get(`/api/promo/jobs/${jobId}`)).json();
    assert.equal(j.status, 'failed'); assert.equal(j.failReason, 'CANCELLED_BY_RESTART'); assert.equal(j.stage, 'story');
    assert.ok(!(await readdir(join(dir, 'jobs'))).includes('pj-aaaaaaaaaaaa'));
    assert.equal((await make(second)).status, 202, '재시작 뒤에는 BUSY가 아님');
  } finally { await second.close(); }
});

test('완료 작업은 최근 10개만 남긴다', async () => {
  const app = await host({ extra: { keepDone: 2 } });
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) { const { jobId } = await (await make(app)).json(); await app.waitDone(jobId); ids.push(jobId); }
    await app.svc.store.idle();
    assert.equal((await app.get(`/api/promo/jobs/${ids[0]}`)).status, 404);
    assert.deepEqual((await readdir(join(app.dir, 'jobs'))).sort(), ids.slice(1).sort());
  } finally { await app.close(); }
});

test('실제 실행기(가짜 claude 프로세스)로 끝까지: 사용량 합산·사진 stdin', async () => {
  const seen = [];
  const story = (({ scenes, texts, ending }) => ({ scenes, texts, ending }))(validStory());
  const spawnProcess = fakeSpawn((input, args) => {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    const out = schema.required.includes('kind') ? PHOTO_META : schema.required.includes('scenes') ? story : { html: GOOD_HTML };
    return { stdout: resultLine(out) };
  }, seen);
  const runner = createClaudeRunner({ command: '/fake/claude', spawnProcess, env: { PATH: '/bin', HOME: '/h' } });
  const app = await host({ runner });
  try {
    const { jobId } = await (await make(app)).json();
    assert.equal((await app.waitDone(jobId)).status, 'done');
    assert.equal(seen.length, 7);
    assert.equal(seen.filter(s => s.input.includes('"type":"image"')).length, 5);
    const job = JSON.parse(await readFile(join(app.dir, 'jobs', jobId, 'job.json'), 'utf8'));
    assert.deepEqual(job.usage, { calls: 7, inputTokens: 770, outputTokens: 350 });
  } finally { await app.close(); }
});
