/* global process, Buffer, document, getComputedStyle, NodeFilter */
// Minimal scene checker for the example code (same rules as ARCHITECTURE 12.9 1~4, rule ids from
// DATA_MODEL 10.16.4). staticCheck is pure; runSceneCheck drives the recorder page.
import { openScene } from './recorder.mjs';

const FORBIDDEN = [
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['requestIdleCallback', /\brequestIdleCallback\b/],
  ['Date', /\bDate\b/],
  ['performance.now', /\bperformance\s*\.\s*now\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['import()', /\bimport\s*\(/],
  ['eval', /\beval\s*\(/],
  ['Function', /\bnew\s+Function\b|\bFunction\s*\(/],
  ['Worker', /\b(Shared)?Worker\b/],
  ['ServiceWorker', /\bserviceWorker\b|\bServiceWorker\b/],
  ['RTCPeerConnection', /\bRTCPeerConnection\b/],
  ['storage', /\b(localStorage|sessionStorage|indexedDB)\b/],
  ['document.cookie', /\bdocument\s*\.\s*cookie\b/],
  ['window.open', /\bwindow\s*\.\s*open\b/],
  ['location', /\blocation\s*(=[^=]|\.\s*(href|assign|replace|reload))/],
  ['<form>', /<form\b/i],
  ['<iframe>', /<iframe\b/i],
  ['<video>', /<video\b/i],
  ['<audio>', /<audio\b/i],
  ['<object>', /<object\b/i],
  ['<embed>', /<embed\b/i],
  ['<link>', /<link\b/i],
  ['<script src>', /<script\b[^>]*\bsrc\s*=/i],
  ['<base>', /<base\b/i],
  ['<meta http-equiv>', /<meta\b[^>]*http-equiv/i],
];
const URLS = [/\b(?:https?|data|blob|file|ftp|wss?):/i, /url\(\s*['"]?\/\//i, /\b(?:src|href)\s*=\s*['"]?\/\//i];

export function staticCheck(html, { story, rules }) {
  const v = [];
  const size = Buffer.byteLength(html, 'utf8');
  if (size > rules.html.maxBytes) v.push({ rule: 'static.size', limit: rules.html.maxBytes, actual: size });
  for (const [name, re] of FORBIDDEN) if (re.test(html)) v.push({ rule: 'static.forbidden', limit: 'none', actual: name });
  for (const re of URLS) {
    const m = re.exec(html);
    if (m) v.push({ rule: 'static.url', limit: 'none', actual: html.slice(m.index, m.index + 40) });
  }
  const have = new Set([...html.matchAll(/data-scene\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  for (const s of story.scenes) if (!have.has(s.sceneId)) v.push({ sceneId: s.sceneId, rule: 'static.forbidden', limit: 'data-scene', actual: 'missing' });
  if (!/id\s*=\s*["']stage["']/.test(html)) v.push({ rule: 'static.forbidden', limit: '#stage', actual: 'missing' });
  return v;
}

export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Runs in the page: snapshot of every visible scene, text and photo at the current seek time.
function pageSample(opMin) {
  const stage = document.getElementById('stage');
  const sr = stage.getBoundingClientRect();
  const effOpacity = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  const shown = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right <= sr.left || r.left >= sr.right || r.bottom <= sr.top || r.top >= sr.bottom) return false;
    return effOpacity(el) > opMin;
  };
  const textOf = (el) => {
    let out = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.data;
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') out += ' ';
          else if (c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') walk(c);
        }
      }
    };
    walk(el);
    return out;
  };
  const ownerScene = (el) => el.closest('[data-scene]')?.getAttribute('data-scene') ?? null;
  const scenes = [...document.querySelectorAll('[data-scene]')].map((el) => ({
    id: el.getAttribute('data-scene'),
    opacity: shown(el) ? effOpacity(el) : 0,
  }));
  const texts = [];
  for (const el of document.querySelectorAll('[data-text]')) {
    if (!shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rr = range.getBoundingClientRect();
    const tops = new Set();
    for (const rc of range.getClientRects()) if (rc.width > 0) tops.add(Math.round(rc.top / 4));
    let minFont = Infinity;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.data.trim()) minFont = Math.min(minFont, parseFloat(getComputedStyle(n.parentElement).fontSize));
    }
    const nested = el.querySelector('[data-text]') != null;
    texts.push({
      id: el.getAttribute('data-text'),
      scene: ownerScene(el),
      text: textOf(el),
      rect: { x0: rr.left - sr.left, y0: rr.top - sr.top, x1: rr.right - sr.left, y1: rr.bottom - sr.top },
      lines: tops.size,
      minFont,
      overflow: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      nested,
    });
  }
  const undeclared = [];
  const tw = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.data.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('[data-text]')) continue;
    if (shown(p)) undeclared.push(n.data.trim().slice(0, 40));
  }
  const photos = [];
  for (const el of document.querySelectorAll('[data-photo]')) {
    if (shown(el)) photos.push({ id: el.getAttribute('data-photo'), scene: ownerScene(el) });
  }
  return { scenes, texts, undeclared, photos };
}

export function sampleTimes(story, L, rules) {
  const ts = new Set();
  const step = rules.check.sampleEverySec;
  for (let t = 0; t < L - 1e-9; t += step) ts.add(+t.toFixed(3));
  for (const s of story.scenes) {
    for (const edge of [s.start, s.start + s.duration]) {
      for (const off of rules.check.boundaryOffsetsSec) {
        const t = +(edge + off).toFixed(3);
        if (t >= 0 && t < L) ts.add(t);
      }
    }
  }
  ts.add(+(L - rules.ending.checkAtFromEndSec).toFixed(3));
  return [...ts].sort((a, b) => a - b);
}

/**
 * Analyse page samples against the story (pure, testable).
 * samples: [{t, scenes, texts, undeclared, photos}]
 */
export function analyseSamples(samples, { story, rules, store, lengthSec }) {
  const v = [];
  const seen = new Set();
  const add = (o) => {
    const key = `${o.rule}|${o.sceneId ?? ''}|${o.textId ?? ''}|${o.photoId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    v.push(o);
  };
  const S = rules.safeRect;
  const texts = new Map(story.texts.map((t) => [t.textId, t]));
  const scenes = new Map(story.scenes.map((s, i) => [s.sceneId, { ...s, index: i }]));
  const dominant = new Map();
  const photoScenes = new Map();
  const exterior = rules.photo.exteriorId;

  for (const smp of samples) {
    const t = smp.t;
    let cur = null;
    for (const s of smp.scenes) if (s.opacity > 0 && (!cur || s.opacity > cur.opacity + 1e-6)) cur = s;
    const curId = cur?.id ?? null;
    if (curId) {
      const d = dominant.get(curId) ?? { first: t, last: t };
      d.first = Math.min(d.first, t);
      d.last = Math.max(d.last, t);
      dominant.set(curId, d);
    }
    for (const u of smp.undeclared) add({ t, sceneId: curId, rule: 'text.undeclared', limit: 'data-text', actual: u });
    for (const x of smp.texts) {
      const owner = x.scene ?? curId;
      const base = { t, sceneId: owner, textId: x.id };
      if (x.nested) add({ ...base, rule: 'text.undeclared', limit: 'no nested data-text', actual: 'nested' });
      if (x.rect.x0 < S.x0 - 0.5 || x.rect.x1 > S.x1 + 0.5 || x.rect.y0 < S.y0 - 0.5 || x.rect.y1 > S.y1 + 0.5) {
        add({ ...base, rule: 'text.safeArea', limit: S, actual: x.rect });
      }
      if (x.minFont < rules.minFontPx - 0.01) add({ ...base, rule: 'text.minSize', limit: rules.minFontPx, actual: x.minFont });
      if (x.overflow) add({ ...base, rule: 'text.overflow', limit: 'fits', actual: 'overflow' });
      const decl = texts.get(x.id);
      if (!decl) {
        add({ ...base, rule: 'text.undeclared', limit: 'story text', actual: norm(x.text) });
        continue;
      }
      if (norm(x.text) !== norm(decl.text)) add({ ...base, rule: x.id.startsWith('store-') ? 'ending.mismatch' : 'text.undeclared', limit: norm(decl.text), actual: norm(x.text) });
      if (owner && !(decl.sceneIds ?? []).includes(owner)) add({ ...base, rule: 'pair.text', limit: decl.sceneIds, actual: owner });
    }
    for (const p of smp.photos) {
      const owner = p.scene ?? curId;
      const sc = scenes.get(owner);
      if (!sc || !(sc.photoIds ?? []).includes(p.id)) add({ t, sceneId: owner, photoId: p.id, rule: 'pair.photo', limit: sc?.photoIds ?? [], actual: p.id });
      if (sc && p.id !== exterior) {
        if (!photoScenes.has(p.id)) photoScenes.set(p.id, new Set());
        photoScenes.get(p.id).add(sc.index);
      }
    }
  }
  const tol = rules.sceneTimingToleranceSec;
  for (const s of story.scenes) {
    const d = dominant.get(s.sceneId);
    const end = s.start + s.duration;
    if (!d) {
      add({ sceneId: s.sceneId, rule: 'timing.scene', limit: [s.start, end], actual: 'never visible' });
      continue;
    }
    if (Math.abs(d.first - s.start) > tol || d.last < end - tol || d.last > end + tol) {
      add({ sceneId: s.sceneId, rule: 'timing.scene', limit: [s.start, end], actual: [d.first, d.last] });
    }
  }
  for (const [id, set] of photoScenes) {
    const idx = [...set].sort((a, b) => a - b);
    if (idx.length > rules.photo.maxUses) add({ photoId: id, rule: 'photo.reuse', limit: rules.photo.maxUses, actual: idx.length });
    for (let k = 1; k < idx.length; k++) if (idx[k] - idx[k - 1] === 1) add({ photoId: id, rule: 'photo.reuse', limit: 'not adjacent', actual: idx });
  }
  const tEnd = +(lengthSec - rules.ending.checkAtFromEndSec).toFixed(3);
  const endSmp = samples.find((s) => Math.abs(s.t - tEnd) < 1e-6);
  for (const [id, want] of [
    ['store-name', store.name],
    ['store-location', store.location],
  ]) {
    const x = endSmp?.texts.find((tt) => tt.id === id);
    if (!x) add({ t: tEnd, textId: id, rule: 'ending.missing', limit: want, actual: null });
    else {
      if (norm(x.text) !== norm(want)) add({ t: tEnd, textId: id, rule: 'ending.mismatch', limit: want, actual: norm(x.text) });
      if (id === 'store-location' && x.lines > rules.ending.locationMaxLines) add({ t: tEnd, textId: id, rule: 'ending.mismatch', limit: `${rules.ending.locationMaxLines} lines`, actual: x.lines });
    }
  }
  return v;
}

/** Full check: static + isolated runtime sampling. Returns {violations, checkMs, samples}. */
export async function runSceneCheck({ html, story, rules, catalog, lengthSec, chromePath }) {
  const started = process.hrtime.bigint();
  const violations = staticCheck(html, { story, rules });
  let sc;
  try {
    sc = await openScene({ html, story, catalog, scale: 0.5, chromePath });
  } catch (e) {
    if (e.code === 'TOOL_MISSING') throw e;
    violations.push({ rule: 'runtime.timeout', limit: '10s load', actual: String(e.message).slice(0, 200) });
    return { violations, checkMs: Number(process.hrtime.bigint() - started) / 1e6, samples: [] };
  }
  const samples = [];
  try {
    if (typeof sc.duration !== 'number' || Math.abs(sc.duration - lengthSec) > rules.durationToleranceSec) {
      violations.push({ rule: 'runtime.duration', limit: lengthSec, actual: sc.duration ?? null });
    }
    for (const t of sampleTimes(story, lengthSec, rules)) {
      const t0 = Date.now();
      await sc.seek(t);
      if (Date.now() - t0 > 500) violations.push({ t, rule: 'runtime.timeout', limit: 500, actual: Date.now() - t0 });
      samples.push({ t, ...(await sc.page.evaluate(pageSample, rules.check.visibleOpacityMin)) });
    }
    violations.push(...analyseSamples(samples, { story, rules, store: catalog.store, lengthSec }));
    for (const f of await sc.forbidden()) violations.push({ rule: 'runtime.forbiddenApi', limit: 'none', actual: f });
    for (const e of sc.records.errors) violations.push({ rule: 'runtime.error', limit: 'none', actual: e });
    for (const e of sc.records.console) violations.push({ rule: 'runtime.error', limit: 'none', actual: e });
    for (const b of sc.records.blocked) violations.push({ rule: 'runtime.blockedRequest', limit: 'allow-list', actual: b });
  } finally {
    await sc.close();
  }
  return { violations, checkMs: Number(process.hrtime.bigint() - started) / 1e6, samples };
}
