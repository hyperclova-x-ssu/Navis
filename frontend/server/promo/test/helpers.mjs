// 시험 도우미: 가짜 레퍼런스·장면 구성·장면 HTML·가짜 실행기.
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { loadReferences, rangeFor } from '../references.mjs';
import { createExamplePhotoSource } from '../photo-source.mjs';

export const FIXTURE_REFS = fileURLToPath(new URL('./fixtures/references/', import.meta.url));
export const refs = loadReferences(FIXTURE_REFS);
export const rules = refs.rules;
export const photoSource = createExamplePhotoSource();
export const STORE = { name: '미학당', location: '숭실대입구역 3번 출구 · 빨간 벽돌, 초록 문' };
export const SELECTED = ['fin-01', 'fin-02', 'fin-03', 'fin-04', 'fin-05'];

export const INPUT = Object.freeze({ menuIds: ['financier'], photoIds: SELECTED, moods: ['warm'], concepts: ['new-item'], memo: '', referenceId: 'ref-1', lengthSec: 10, locale: 'ko' });

export function validStory(over = {}) {
  return {
    referenceId: 'ref-1', lengthSec: 10, locale: 'ko', promptVersion: 'p1',
    scenes: [
      { sceneId: 's1', start: 0, duration: 4, photoIds: ['fin-01'], textIds: ['t1'], direction: 'slow zoom' },
      { sceneId: 's2', start: 4, duration: 3.5, photoIds: ['fin-02'], textIds: ['t2'], direction: 'pan' },
      { sceneId: 's3', start: 7.5, duration: 2.5, photoIds: ['store-exterior'], textIds: ['t3', 'store-name', 'store-location'], direction: 'ending' },
    ],
    texts: [
      { textId: 't1', role: 'cap', text: '겉은 바삭한 휘낭시에', sceneIds: ['s1'] },
      { textId: 't2', role: 'cap', text: '버터 향 가득', sceneIds: ['s2'] },
      { textId: 't3', role: 'sub', text: '오늘 구운 맛 그대로', sceneIds: ['s3'] },
      { textId: 'store-name', role: 'title', text: STORE.name, sceneIds: ['s3'] },
      { textId: 'store-location', role: 'sub', text: STORE.location, sceneIds: ['s3'] },
    ],
    ending: { taglineTextId: 't3' },
    ...over,
  };
}

export const storyCtx = (over = {}) => ({ rules, range: rangeFor(refs.refs, rules, 'ref-1', 10), lengthSec: 10, locale: 'ko', referenceId: 'ref-1', selectedPhotoIds: SELECTED, store: STORE, ...over });

/** 계약을 지키는 10초 장면 HTML. parts로 조각을 바꿔 위반을 하나씩 넣는다. */
export function sceneHtml(parts = {}) {
  const p = {
    duration: 10,
    timings: [['s1', 0, 4], ['s2', 4, 7.5], ['s3', 7.5, 10]],
    t1Style: '', s1Extra: '', s2Photo: 'fin-02', t2Scene: 's2', storeName: STORE.name, storeLocation: STORE.location,
    s1Photo: 'fin-01', s1PhotoSrc: null, s2Extra: '', script: '', head: '', tail: '',
    fade: 0, still: false,
    ...parts,
  };
  const t2 = '<div class="tx" data-text="t2">버터 향 가득</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}#stage{position:relative;width:1080px;height:1920px;overflow:hidden;background:#333;font-family:"Navis Sans",sans-serif}
.sc{position:absolute;left:0;top:0;width:1080px;height:1920px;opacity:0}
.ph{position:absolute;left:0;top:0;width:1080px;height:1920px;object-fit:cover;${p.still ? '' : 'animation:kb 10s linear both'}}
@keyframes kb{from{transform:scale(1)}to{transform:scale(1.1)}}
.tx{position:absolute;left:90px;width:900px;top:1300px;color:#fff;font-size:64px;line-height:1.3;background:rgba(0,0,0,.55)}
.end{position:absolute;left:90px;width:900px;color:#fff;background:rgba(0,0,0,.55)}
</style>${p.head}</head><body><div id="stage">
<div class="sc" data-scene="s1"><img class="ph" data-photo="${p.s1Photo}" src="${p.s1PhotoSrc ?? `assets/photos/${p.s1Photo}.jpg`}"><div class="tx" data-text="t1" style="${p.t1Style}">겉은 바삭한 휘낭시에</div>${p.s1Extra}${p.t2Scene === 's1' ? t2 : ''}</div>
<div class="sc" data-scene="s2"><img class="ph" data-photo="${p.s2Photo}" src="assets/photos/${p.s2Photo}.jpg">${p.t2Scene === 's2' ? t2 : ''}${p.s2Extra}</div>
<div class="sc" data-scene="s3"><img class="ph" data-photo="store-exterior" src="assets/photos/store-exterior.jpg">
<div class="end" data-text="t3" style="top:700px;font-size:48px">오늘 구운 맛 그대로</div>
${p.storeName === null ? '' : `<div class="end" data-text="store-name" style="top:900px;font-size:88px;font-family:'Navis Serif',serif">${p.storeName}</div>`}
<div class="end" data-text="store-location" style="top:1100px;font-size:48px;line-height:1.3">${p.storeLocation}</div></div>
</div><script>
window.__duration = ${p.duration};
const L = 10000;
const F = ${p.fade} / 2;
const o = x => Math.max(0, Math.min(1, x / 10));
for (const [id, a, b] of ${JSON.stringify(p.timings)}) {
  const el = document.querySelector('[data-scene="' + id + '"]');
  const end = b >= 10 ? 1 : 0;
  el.animate([{ opacity: a <= 0 ? 1 : 0, offset: 0 }, { opacity: a <= 0 ? 1 : 0, offset: o(a - F) }, { opacity: 1, offset: o(a + F) }, { opacity: 1, offset: o(b - F) }, { opacity: end, offset: o(b + F) }, { opacity: end, offset: 1 }], { duration: L, fill: 'both' });
}
${p.script}
</script>${p.tail}</body></html>`;
}

export const CHROME_PATH = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(f => existsSync(f)) || process.env.NAVIS_CHROME_PATH || null;
export const FFMPEG = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(d => ({ ffmpeg: `${d}/ffmpeg`, ffprobe: `${d}/ffprobe`, h264: 'libx264' })).find(f => existsSync(f.ffmpeg) && existsSync(f.ffprobe)) || null;

/** 가짜 자식 프로세스. handler(stdinText, args) → {stdout, code, delayMs, hang} */
export function fakeSpawn(handler, seen = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '';
    let killed = false;
    child.kill = () => { if (!killed) { killed = true; child.stdout.end(); setImmediate(() => child.emit('close', null)); } };
    child.stdin = new Writable({ write(chunk, _enc, cb) { input += chunk; cb(); }, final(cb) {
      cb();
      seen.push({ command, args, options, input });
      Promise.resolve(handler(input, args, seen.length)).then(res => {
        if (res?.throw) { child.emit('error', res.throw); child.emit('close', -2); return; }
        if (res?.hang) return;
        setTimeout(() => { if (killed) return; child.stdout.end(res?.stdout ?? ''); child.emit('close', res?.code ?? 0); }, res?.delayMs ?? 0);
      });
    } });
    return child;
  };
}

export const resultLine = (structured, extra = {}) => `${JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'] })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, structured_output: structured, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 }, ...extra })}\n`;

export const PHOTO_META = { kind: 'closeup', subject: 'A financier on a plate', items: ['financier'], flavors: ['butter'], people: 'none', textInImage: '', focus: { x: 0.5, y: 0.5 }, captionHints: ['golden crust'], quality: 'good', menuShown: 'main', amount: 'one' };
