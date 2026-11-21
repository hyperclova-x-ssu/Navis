// 장면 검사기: 위반 하나씩 넣은 작은 HTML 픽스처로 rule 20개가 각각 잡히는지.
// 실제 Chrome·ffmpeg가 필요한 시험은 없으면 건너뛴다(건너뛴 수는 node --test의 skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture } from '../config.mjs';
import { runSceneCheck, staticCheck, evaluateObservations, samplePoints } from '../check-scene.mjs';
import { photoAssets, INIT_SCRIPT, CSP } from '../renderer.mjs';
import { checkVideo, flashViolations, recordVideo } from '../recorder.mjs';
import { CHROME_PATH, FFMPEG, SELECTED, STORE, photoSource, rules, sceneHtml, validStory } from './helpers.mjs';

const story = validStory();
const noChrome = CHROME_PATH ? false : 'Chrome 없음';
const noFfmpeg = CHROME_PATH && FFMPEG ? false : 'Chrome 또는 ffmpeg 없음';
let assets;
const run = async (html, extra = {}) => {
  assets ??= await photoAssets(photoSource, [...SELECTED, 'store-exterior']);
  const res = await runSceneCheck({ html, story, rules, store: STORE, lengthSec: 10, assets, fonts: [], browserPath: CHROME_PATH, ...extra });
  return res.violations;
};
const rulesOf = v => [...new Set(v.map(x => x.rule))].sort();

test('정적: 올바른 코드는 0, static.size·static.forbidden·static.url·data-scene 누락', () => {
  assert.deepEqual(staticCheck(sceneHtml(), { story, rules }), []);
  assert.deepEqual(rulesOf(staticCheck(sceneHtml({ tail: `<!--${'x'.repeat(70000)}-->` }), { story, rules })), ['static.size']);
  for (const script of ['setTimeout(() => {}, 1)', 'requestAnimationFrame(() => {})', 'const d = new Date()', 'Math.random()', "fetch('x')", 'localStorage.x = 1', 'location.href = "x"', 'new Function("1")']) {
    assert.deepEqual(rulesOf(staticCheck(sceneHtml({ script }), { story, rules })), ['static.forbidden'], script);
  }
  for (const tail of ['<iframe></iframe>', '<video></video>', '<link rel="x">', '<script src="a.js"></script>', '<form></form>']) {
    assert.ok(rulesOf(staticCheck(sceneHtml({ tail }), { story, rules })).includes('static.forbidden'), tail);
  }
  assert.deepEqual(rulesOf(staticCheck(sceneHtml({ s1PhotoSrc: 'https://example.com/a.jpg' }), { story, rules })), ['static.url']);
  assert.deepEqual(rulesOf(staticCheck(sceneHtml({ head: '<style>#stage{background:url(data:image/png;base64,AAA)}</style>' }), { story, rules })), ['static.url']);
  assert.deepEqual(staticCheck(sceneHtml({ tail: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>' }), { story, rules }), []);
  const missing = staticCheck(sceneHtml().replace('data-scene="s2"', 'data-x="s2"'), { story, rules });
  assert.deepEqual(missing.map(v => [v.rule, v.sceneId]), [['timing.scene', 's2']]);
});

test('격리 설정: CSP와 기록 스크립트', () => {
  assert.match(CSP, /connect-src 'none'/); assert.match(CSP, /script-src 'unsafe-inline'/); assert.doesNotMatch(CSP, /unsafe-eval/);
  for (const name of ['setTimeout', 'requestAnimationFrame', 'fetch', 'Math', 'localStorage', 'Date']) assert.ok(INIT_SCRIPT.includes(name));
});

test('검사 시점: 0.25초 격자 + 장면 경계 ±0.05 + 엔딩 L−1', () => {
  const points = samplePoints(story, rules, 10);
  const ts = points.map(p => p.t);
  for (const t of [0, 0.25, 3.95, 4.05, 7.45, 7.55, 9]) assert.ok(ts.includes(t), String(t));
  assert.ok(points.find(p => p.t === 9).kinds.includes('ending'));
  assert.ok(ts.every(t => t < 10));
});

test('짝 맞춤 규칙(가짜 관찰): 초코 자막이 다른 장면 사진 위', () => {
  const obs = (current, texts, photos) => ({ current, texts, photos, undeclared: [], unmarked: 0, scenes: {} });
  const box = { x1: 100, y1: 1300, x2: 900, y2: 1400 };
  const v = evaluateObservations([{ t: 1, kinds: ['grid'], obs: obs('s1', [{ id: 't2', scene: null, box, lines: 1, fontSize: 64, overflow: false, text: '버터 향 가득' }], [{ id: 'fin-01', scene: 's1' }]) }], { story, rules, store: STORE });
  assert.ok(v.some(x => x.rule === 'pair.text' && x.textId === 't2' && x.actual === 'shown in s1'));
});

test('실행: 올바른 코드는 위반 0', { skip: noChrome }, async () => {
  assert.deepEqual(await run(sceneHtml()), []);
});

const RUNTIME_CASES = [
  ['runtime.error', { script: "throw new Error('boom')" }],
  ['runtime.forbiddenApi', { script: "window['set' + 'Timeout'](() => {}, 1)" }],
  ['runtime.blockedRequest', { s1Photo: 'fin-09' }],
  ['runtime.duration', { duration: 9 }],
  ['text.safeArea', { t1Style: 'top:1700px' }],
  ['text.minSize', { t1Style: 'font-size:30px' }],
  ['text.overflow', { t1Style: 'width:200px;white-space:nowrap;overflow:hidden' }],
  ['text.undeclared', { s1Extra: '<div class="tx" style="top:400px">비밀 문구</div>' }],
  ['pair.photo', { s2Photo: 'fin-03' }],
  ['pair.text', { t2Scene: 's1' }],
  ['timing.scene', { timings: [['s1', 0, 5], ['s2', 5, 7.5], ['s3', 7.5, 10]] }],
  ['photo.reuse', { s2Extra: '<img class="ph" data-photo="fin-01" src="assets/photos/fin-01.jpg" style="opacity:.9">' }],
  ['ending.missing', { storeName: null }],
  ['ending.mismatch', { storeLocation: '숭실대입구역 3번 출구' }],
];
for (const [rule, parts] of RUNTIME_CASES) {
  test(`실행: ${rule} 위반 하나를 잡는다`, { skip: noChrome }, async () => {
    const v = await run(sceneHtml(parts));
    assert.ok(v.some(x => x.rule === rule), `${rule} not in ${JSON.stringify(v.slice(0, 6))}`);
  });
}

test('실행: 외부 주소는 정적(static.url)과 실행(CSP 오류) 둘 다에서 잡힘', { skip: noChrome }, async () => {
  const html = sceneHtml({ s1PhotoSrc: 'https://example.com/a.jpg' });
  assert.ok(staticCheck(html, { story, rules }).some(v => v.rule === 'static.url'));
  const v = await run(html);
  assert.ok(v.some(x => x.rule === 'runtime.error' || x.rule === 'runtime.blockedRequest'));
});

test('실행: 무한 반복은 시간 초과(runtime.timeout)로 끊는다', { skip: noChrome }, async () => {
  const started = Date.now();
  const v = await run(sceneHtml({ script: 'for (;;) {}' }), { opTimeoutMs: 2000 });
  assert.ok(v.some(x => x.rule === 'runtime.timeout'), JSON.stringify(v));
  assert.ok(Date.now() - started < 15000);
});

test('실행: __onFrame 안의 무한 반복도 시간 초과', { skip: noChrome }, async () => {
  const v = await run(sceneHtml({ script: 'window.__onFrame = t => { if (t > 1) for (;;) {} };' }), { opTimeoutMs: 3000 });
  assert.ok(v.some(x => x.rule === 'runtime.timeout'), JSON.stringify(v.slice(0, 4)));
});

test('번쩍임: 1초 안 큰 밝기 변화가 3번을 넘으면 video.flash', () => {
  const steady = Array.from({ length: 90 }, () => 100);
  assert.deepEqual(flashViolations(steady, rules.flash), []);
  const blink = steady.map((v, i) => (i >= 30 && i < 60 && Math.floor(i / 4) % 2 ? 230 : v));
  assert.equal(flashViolations(blink, rules.flash)[0].rule, 'video.flash');
  const three = steady.map((v, i) => (i >= 10 && i < 13 ? 230 : i >= 40 && i < 43 ? 230 : v));
  assert.deepEqual(flashViolations(three, rules.flash), [], '천천히 두 번 깜빡임은 통과');
  const fade = steady.map((v, i) => Math.max(0, 100 - i * 5));
  assert.deepEqual(flashViolations(fade, rules.flash), [], '어두워짐은 번쩍임이 아님');
});

test('녹화 뒤 확인: video.duration(ffprobe)과 실제 녹화 1편', { skip: noFfmpeg, timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navis-rec-'));
  try {
    const short = join(dir, 'short.mp4');
    await capture(FFMPEG.ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=720x1280:r=30:d=1', '-f', 'lavfi', '-i', 'anullsrc', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', short]);
    assert.ok((await checkVideo({ ffmpeg: FFMPEG, file: short, lengthSec: 2, rules })).violations.some(v => v.rule === 'video.duration'));
    assets ??= await photoAssets(photoSource, [...SELECTED, 'store-exterior']);
    const out = join(dir, 'final.mp4');
    const music = new URL('../assets/music/warm-cozy-acoustic.m4a', import.meta.url).pathname;
    await recordVideo({ html: sceneHtml(), lengthSec: 10, assets, fonts: [], browserPath: CHROME_PATH, ffmpeg: FFMPEG, outFile: out, audio: { file: music }, fadeOutSec: 0.6 });
    const { info, violations } = await checkVideo({ ffmpeg: FFMPEG, file: out, lengthSec: 10, rules });
    assert.deepEqual(violations, []);
    assert.equal(info.width, 720); assert.equal(info.height, 1280); assert.equal(info.videoCodec, 'h264'); assert.equal(info.audioCodec, 'aac'); assert.equal(info.pixFmt, 'yuv420p');
    assert.ok(Math.abs(info.durationSec - 10) <= 0.1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
