// 장면 검사기 (ARCHITECTURE 12.9의 1~4, PROMO_TEMPLATES [고정]). 위반은 {t?, sceneId?, textId?, photoId?, rule, limit?, actual?}.
// staticCheck는 순수 함수, runSceneCheck는 격리 Chrome(renderer.mjs)에서 실행 검사.
import { readFile } from 'node:fs/promises';
import { openScene } from './renderer.mjs';

const FORBIDDEN_JS = [
  ['setTimeout', /\bsetTimeout\b/], ['setInterval', /\bsetInterval\b/], ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['requestIdleCallback', /\brequestIdleCallback\b/], ['Date', /\bDate\b/], ['performance.now', /\bperformance\s*\.\s*now\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/], ['fetch', /\bfetch\s*\(/], ['XMLHttpRequest', /\bXMLHttpRequest\b/], ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/], ['sendBeacon', /\bsendBeacon\b/], ['import()', /\bimport\s*\(/], ['eval', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\b|\bFunction\s*\(/], ['Worker', /\b(?:Shared)?Worker\b/], ['ServiceWorker', /\bserviceWorker\b/],
  ['RTCPeerConnection', /RTCPeerConnection/], ['localStorage', /\blocalStorage\b/], ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/], ['document.cookie', /\bdocument\s*\.\s*cookie\b/], ['window.open', /\bwindow\s*\.\s*open\s*\(|(?<![.\w])open\s*\(/],
  ['location', /\blocation\s*(?:\.\s*(?:href|assign|replace|reload|pathname|search|hash)\b|=(?!=))/],
  ['submit', /\.\s*(?:requestSubmit|submit)\s*\(/],
];
const FORBIDDEN_TAGS = [
  ['<iframe>', /<iframe\b/i], ['<video>', /<video\b/i], ['<audio>', /<audio\b/i], ['<object>', /<object\b/i], ['<embed>', /<embed\b/i],
  ['<link>', /<link\b/i], ['<script src>', /<script\b[^>]*\bsrc\s*=/i], ['<base>', /<base\b/i], ['<meta http-equiv>', /<meta\b[^>]*http-equiv/i],
  ['<form>', /<form\b/i], ['<frame>', /<frame\b/i], ['<portal>', /<portal\b/i],
];
const URL_RE = /\b(?:https?|data|blob|file|ftp|wss?|javascript):|url\(\s*['"]?\s*\/\/|\b(?:src|href|srcset|action|poster)\s*=\s*['"]?\s*\/\//gi;
const SVG_NS = /^https?:\/\/www\.w3\.org\//i;

function scriptsOf(html) {
  const parts = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/gi)) parts.push(m[2] ?? m[3] ?? '');
  return parts.join('\n');
}
const stripComments = js => js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

/** 1. 정적 검사: 크기, 금지 API·태그·외부 주소, 모든 장면 id의 data-scene. */
export function staticCheck(html, { story, rules }) {
  const v = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  const max = rules?.maxHtmlBytes ?? 65536;
  if (bytes > max) v.push({ rule: 'static.size', limit: max, actual: bytes });
  const js = stripComments(scriptsOf(html));
  for (const [name, re] of FORBIDDEN_JS) if (re.test(js)) v.push({ rule: 'static.forbidden', limit: 'no forbidden API', actual: name });
  for (const [name, re] of FORBIDDEN_TAGS) if (re.test(html)) v.push({ rule: 'static.forbidden', limit: 'no forbidden tag', actual: name });
  for (const m of html.matchAll(URL_RE)) {
    const near = html.slice(m.index, m.index + 40);
    if (SVG_NS.test(near)) continue;
    v.push({ rule: 'static.url', limit: 'assets/ and font names only', actual: near.replace(/\s+/g, ' ').slice(0, 30) });
    if (v.length > 40) break;
  }
  const declared = new Set([...html.matchAll(/data-scene\s*=\s*["']?([a-z0-9-]+)/gi)].map(m => m[1]));
  for (const s of story?.scenes || []) if (!declared.has(s.sceneId)) v.push({ sceneId: s.sceneId, rule: 'timing.scene', limit: 'data-scene present', actual: 'missing' });
  return v;
}

/** 페이지 안에서 한 시점의 보이는 것을 모은다(렌더러 page.evaluate로 실행). */
function probe(cfg) {
  const stage = document.getElementById('stage');
  if (!stage) return { error: 'no #stage' };
  // elementsFromPoint가 pointer-events:none 요소도 보게 한다(검사 페이지에만, 녹화에는 없음).
  if (!cfg.lite && !document.getElementById('__probe_pe')) { const st = document.createElement('style'); st.id = '__probe_pe'; st.textContent = '#stage, #stage * { pointer-events: auto !important; }'; document.head.appendChild(st); }
  const sr = stage.getBoundingClientRect();
  const opacityOf = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const v = parseFloat(getComputedStyle(e).opacity); o *= Number.isFinite(v) ? v : 1; } return o; };
  const rel = r => ({ x1: r.left - sr.left, y1: r.top - sr.top, x2: r.right - sr.left, y2: r.bottom - sr.top });
  const onStage = r => r.width > 0.5 && r.height > 0.5 && r.right > sr.left && r.left < sr.right && r.bottom > sr.top && r.top < sr.bottom;
  const visible = el => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true) && opacityOf(el) >= cfg.minOpacity;
  const scenes = {};
  for (const el of document.querySelectorAll('[data-scene]')) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, sr.right) - Math.max(r.left, sr.left));
    const h = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
    const score = visible(el) ? (w * h) / (sr.width * sr.height) * opacityOf(el) : 0;
    scenes[el.dataset.scene] = Math.max(scenes[el.dataset.scene] || 0, score);
  }
  const sceneOpacity = {};
  for (const el of document.querySelectorAll('[data-scene]')) sceneOpacity[el.dataset.scene] = Math.max(sceneOpacity[el.dataset.scene] || 0, visible(el) ? opacityOf(el) : 0);
  let current = null; let best = 0;
  for (const [id, s] of Object.entries(scenes)) if (s > best + 1e-6) { best = s; current = id; }
  if (cfg.lite) {
    const ids = [];
    for (const el of document.querySelectorAll('[data-text]')) if (visible(el) && onStage(el.getBoundingClientRect())) ids.push(el.dataset.text);
    return { current, scenes, sceneOpacity, textIds: ids, lite: true };
  }
  const textOf = el => {
    let out = '';
    const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) out += c.data; else if (c.nodeName === 'BR') out += ' '; else if (c.nodeType === 1) walk(c); } };
    walk(el);
    return out.replace(/\s+/g, ' ').trim();
  };
  // 글자 위를 덮는 사진(data-photo): 줄 상자마다 3점을 찍어 맨 위의 보이는 요소가 사진이면 가린 것(화면 전체 층은 뺌).
  const stageArea = sr.width * sr.height;
  const isLayer = el => { const r = el.getBoundingClientRect(); return (r.width * r.height) >= cfg.layerCover * stageArea; };
  const coverOf = (el, lineRects) => {
    let total = 0; let hit = 0; let by = null;
    for (const q of lineRects) {
      for (const fx of [0.2, 0.5, 0.8]) {
        const x = sr.left + q.x1 + (q.x2 - q.x1) * fx; const y = sr.top + (q.y1 + q.y2) / 2;
        total++;
        for (const top of document.elementsFromPoint(x, y)) {
          if (top === stage || !stage.contains(top)) break;
          if (!visible(top) || isLayer(top)) continue;
          if (top === el || el.contains(top) || top.contains(el)) break;
          const photo = top.closest('[data-photo]');
          if (photo && !photo.contains(el)) { hit++; by = photo.dataset.photo; }
          break;
        }
      }
    }
    return total ? { ratio: hit / total, by } : { ratio: 0, by: null };
  };
  const texts = [];
  for (const el of document.querySelectorAll('[data-text]')) {
    if (!visible(el)) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5);
    if (!rects.length || !rects.some(onStage)) continue;
    const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    const tops = [];
    for (const r of rects) {
      const q = rel(r); box.x1 = Math.min(box.x1, q.x1); box.y1 = Math.min(box.y1, q.y1); box.x2 = Math.max(box.x2, q.x2); box.y2 = Math.max(box.y2, q.y2);
      if (!tops.some(t => Math.abs(t - r.bottom) < r.height * 0.5)) tops.push(r.bottom);
    }
    let fontSize = parseFloat(getComputedStyle(el).fontSize);
    for (const d of el.querySelectorAll('*')) if ([...d.childNodes].some(c => c.nodeType === 3 && c.data.trim())) fontSize = Math.min(fontSize, parseFloat(getComputedStyle(d).fontSize));
    const cs = getComputedStyle(el);
    const block = cs.display !== 'inline' && el.clientWidth > 0;
    const overflow = block && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    const nested = !!el.querySelector('[data-text]');
    const lineRects = rects.filter(onStage).map(rel);
    texts.push({ id: el.dataset.text, scene: el.closest('[data-scene]')?.dataset.scene || null, box, lines: tops.length, fontSize, overflow, text: textOf(el), nested, rects: lineRects, cover: coverOf(el, lineRects) });
  }
  const undeclared = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = n.data.trim();
    const parent = n.parentElement;
    if (!value || !parent || parent.closest('[data-text]') || parent.closest('script,style,title,noscript,template')) continue;
    if (!visible(parent)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    if ([...range.getClientRects()].some(onStage)) undeclared.push(value.slice(0, 40));
  }
  const photos = []; let unmarked = 0;
  for (const el of document.querySelectorAll('[data-photo]')) {
    if (!visible(el) || !onStage(el.getBoundingClientRect())) continue;
    photos.push({ id: el.dataset.photo, scene: el.closest('[data-scene]')?.dataset.scene || null });
  }
  for (const img of document.querySelectorAll('img:not([data-photo])')) if (visible(img) && onStage(img.getBoundingClientRect())) unmarked++;
  // 화면 서명(정지 화면 찾기): 보이는 요소의 상자·불투명도·글자. canvas가 보이면 서명을 쓰지 않는다(null).
  const q = v => Math.round(v / cfg.pxStep);
  let sig = ''; let canvas = false;
  const moving = {};
  for (const el of stage.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!onStage(r)) continue;
    if (el.nodeName === 'CANVAS') canvas = true;
    sig += `${q(r.left)},${q(r.top)},${q(r.width)},${q(r.height)},${Math.round(opacityOf(el) * 100)};`;
    if (el.dataset.photo || el.dataset.text) moving[`${el.dataset.photo ? 'p' : 't'}:${el.dataset.photo || el.dataset.text}`] = [r.left - sr.left, r.top - sr.top, r.right - sr.left, r.bottom - sr.top];
  }
  for (const tx of texts) sig += tx.text;
  let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
  return { current, scenes, sceneOpacity, texts, undeclared, photos, unmarked, sig: canvas ? null : h, boxes: moving };
}

const norm = s => String(s).replace(/\s+/g, ' ').trim();
const r2 = n => Math.round(n * 100) / 100;

/** 검사 시점: 0.25초마다 + 장면 경계 ±0.05 + 장면 시간 확인점(±허용치 바로 밖·안) + 엔딩 시점. */
export function samplePoints(story, rules, L) {
  const lastT = L - 1 / 30;
  const set = new Map();
  const add = (t, kind) => { if (t >= 0 && t <= lastT + 1e-9) { const k = r2(t); set.set(k, [...(set.get(k) || []), ...kind]); } };
  for (let t = 0; t < L - 1e-9; t += rules.check.sampleEverySec) add(t, ['grid']);
  const tol = rules.sceneTimingToleranceSec;
  for (const s of story.scenes) {
    for (const off of rules.check.boundaryOffsetsSec) { add(s.start + off, ['grid']); add(s.start + s.duration + off, ['grid']); }
    if (s.duration > 2 * tol + 0.05) { add(s.start + tol + 0.02, [`in:${s.sceneId}`]); add(s.start + s.duration - tol - 0.02, [`in:${s.sceneId}`]); }
    add(s.start - tol - 0.02, [`out:${s.sceneId}`]); add(s.start + s.duration + tol + 0.02, [`out:${s.sceneId}`]);
  }
  // 전환 길이(T-087): 장면 경계마다 ±span을 step 간격으로(가벼운 관찰)
  const tr = rules.transition;
  if (tr) story.scenes.forEach((s, i) => {
    if (i === 0) return;
    const n = Math.round(tr.probeSpanSec / tr.probeStepSec);
    for (let k = -n; k <= n; k++) add(s.start + k * tr.probeStepSec, [`fade:${i}`]);
  });
  add(L - rules.ending.checkBeforeEndSec, ['ending']);
  return [...set.entries()].sort((a, b) => a[0] - b[0]).map(([t, kinds]) => ({ t, kinds }));
}

/** 관찰 목록을 규칙과 비교한다(순수 함수, 테스트에서 가짜 관찰로도 쓴다). */
export function evaluateObservations(observations, { story, rules, store }) {
  const v = [];
  const seen = new Set();
  const push = item => { const key = `${item.rule}|${item.sceneId}|${item.textId}|${item.photoId}|${item.actual}`; if (!seen.has(key)) { seen.add(key); v.push(item); } };
  const texts = new Map(story.texts.map(t => [t.textId, t]));
  const scenes = new Map(story.scenes.map(s => [s.sceneId, s]));
  const order = story.scenes.map(s => s.sceneId);
  const { x1, x2, y1, y2 } = rules.safeBox;
  const shownText = new Map(); const shownPhoto = new Map(); const photoScenes = new Map();
  for (const { t, kinds, obs } of observations) {
    if (obs.error) { push({ t, rule: 'runtime.error', actual: obs.error }); continue; }
    if (obs.lite) continue;
    const owner = el => el.scene || obs.current;
    // 글자·사진 규칙은 12.9의 검사 시점(0.25초 격자·장면 경계 ±0.05·엔딩)에서만, 장면 시간 확인점은 시간 규칙만 본다.
    const full = kinds.includes('grid') || kinds.includes('ending');
    for (const tx of full ? obs.texts : []) {
      const sceneId = owner(tx);
      if (tx.box.x1 < x1 - 0.5 || tx.box.x2 > x2 + 0.5 || tx.box.y1 < y1 - 0.5 || tx.box.y2 > y2 + 0.5) push({ t, sceneId, textId: tx.id, rule: 'text.safeArea', limit: `${x1}-${x2},${y1}-${y2}`, actual: `${Math.round(tx.box.x1)},${Math.round(tx.box.y1)}-${Math.round(tx.box.x2)},${Math.round(tx.box.y2)}` });
      if (tx.fontSize < rules.minFontPx - 0.01) push({ t, sceneId, textId: tx.id, rule: 'text.minSize', limit: rules.minFontPx, actual: tx.fontSize });
      if (tx.overflow) push({ t, sceneId, textId: tx.id, rule: 'text.overflow', limit: 'no overflow', actual: 'overflow' });
      const decl = texts.get(tx.id);
      if (!decl || tx.nested) push({ t, sceneId, textId: tx.id, rule: 'text.undeclared', limit: 'declared text', actual: tx.nested ? 'nested data-text' : 'unknown id' });
      else if (norm(decl.text) !== tx.text) push({ t, sceneId, textId: tx.id, rule: 'text.undeclared', limit: norm(decl.text), actual: tx.text.slice(0, 60) });
      if (decl && sceneId) {
        if (!(scenes.get(sceneId)?.textIds || []).includes(tx.id)) push({ t, sceneId, textId: tx.id, rule: 'pair.text', limit: `text of ${(decl.sceneIds || []).join(',')}`, actual: `shown in ${sceneId}` });
        else shownText.set(`${sceneId}|${tx.id}`, true);
      }
    }
    for (const value of full ? obs.undeclared : []) push({ t, sceneId: obs.current, rule: 'text.undeclared', limit: 'inside data-text', actual: value });
    for (const ph of full ? obs.photos : []) {
      const sceneId = owner(ph);
      if (sceneId && !(scenes.get(sceneId)?.photoIds || []).includes(ph.id)) push({ t, sceneId, photoId: ph.id, rule: 'pair.photo', limit: (scenes.get(sceneId)?.photoIds || []).join(','), actual: ph.id });
      else if (sceneId) shownPhoto.set(`${sceneId}|${ph.id}`, true);
      if (sceneId && ph.id !== rules.photo.exteriorId) photoScenes.set(ph.id, new Set([...(photoScenes.get(ph.id) || []), sceneId]));
    }
    if (full && obs.unmarked) push({ t, sceneId: obs.current, rule: 'pair.photo', limit: 'data-photo on every img', actual: 'unmarked img' });
    for (const kind of kinds) {
      const [what, sceneId] = kind.split(':');
      if (what === 'in' && obs.current !== sceneId) push({ t, sceneId, rule: 'timing.scene', limit: `${scenes.get(sceneId).start}+${scenes.get(sceneId).duration}±${rules.sceneTimingToleranceSec}`, actual: `current ${obs.current}` });
      if (what === 'out' && obs.current === sceneId) push({ t, sceneId, rule: 'timing.scene', limit: `${scenes.get(sceneId).start}+${scenes.get(sceneId).duration}±${rules.sceneTimingToleranceSec}`, actual: 'visible outside its time' });
      if (what === 'ending') {
        for (const [id, expected] of [['store-name', store.name], ['store-location', store.location]]) {
          const tx = obs.texts.find(x => x.id === id);
          if (!tx) push({ t, textId: id, rule: 'ending.missing', limit: 'visible', actual: 'missing' });
          else if (tx.text !== norm(expected)) push({ t, textId: id, rule: 'ending.mismatch', limit: expected, actual: tx.text.slice(0, 60) });
          else if (id === 'store-location' && tx.lines > rules.ending.locationMaxLines) push({ t, textId: id, rule: 'ending.mismatch', limit: `${rules.ending.locationMaxLines} lines`, actual: `${tx.lines} lines` });
        }
      }
    }
  }
  evaluateT087(observations, { story, rules, push, order });
  for (const s of story.scenes) {
    for (const id of s.textIds || []) if (!shownText.has(`${s.sceneId}|${id}`)) push({ sceneId: s.sceneId, textId: id, rule: 'pair.text', limit: 'shown in scene', actual: 'never visible' });
    for (const id of s.photoIds || []) if (!shownPhoto.has(`${s.sceneId}|${id}`)) push({ sceneId: s.sceneId, photoId: id, rule: 'pair.photo', limit: 'shown in scene', actual: 'never visible' });
  }
  for (const [id, set] of photoScenes) {
    if (set.size > rules.photo.maxUses) push({ photoId: id, rule: 'photo.reuse', limit: rules.photo.maxUses, actual: set.size });
    const idx = [...set].map(s => order.indexOf(s)).sort((a, b) => a - b);
    if (rules.photo.noAdjacent && idx.some((n, i) => i > 0 && n - idx[i - 1] === 1)) push({ photoId: id, rule: 'photo.reuse', limit: 'not adjacent', actual: [...set].join(',') });
  }
  return v;
}

const area = r => Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
const inter = (a, b) => area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) });
const boxText = b => `${Math.round(b.x1)},${Math.round(b.y1)}-${Math.round(b.x2)},${Math.round(b.y2)}`;

/**
 * T-087 규칙 (SMOKE_REPORT 4절 2~4):
 * - text.overlap: 보이는 글자끼리 줄 상자가 rules.overlap.maxRatio 이상 겹치거나, 사진(data-photo)이 글자를 그만큼 가림
 * - transition.text: 장면이 겹치지 않는(sceneIds 교집합 없음) 글자 둘이 동시에 보임 = 전환 중 두 장면 글자가 함께 보임
 * - transition.length: 이웃 두 장면이 함께 보이며 한쪽이 반투명한 시간이 rules.transition.maxSec 초과
 * - scene.still: 화면 서명이 rules.still.maxSec 이상 그대로(마지막 장면 제외)
 * - scene.empty: 장면 시간 동안 글자가 한 번도 안 보이고 움직임도 rules.scene.minMotionPx 미만
 */
export function evaluateT087(observations, { story, rules, push, order = story.scenes.map(s => s.sceneId) }) {
  const decl = new Map(story.texts.map(t => [t.textId, new Set(t.sceneIds || [])]));
  const ov = rules.overlap; const tr = rules.transition; const st = rules.still; const sc = rules.scene;
  const sorted = [...observations].filter(o => !o.obs.error).sort((a, b) => a.t - b.t);
  const last = order[order.length - 1];
  const once = new Set(); const first = key => (once.has(key) ? false : (once.add(key), true));
  for (const { t, obs } of sorted) {
    // 전환 중 글자는 한 장면 것만
    const ids = obs.lite ? obs.textIds : obs.texts.map(x => x.id);
    const known = [...new Set(ids)].filter(id => decl.has(id));
    for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) {
      const a = decl.get(known[i]); const b = decl.get(known[j]);
      if (![...a].some(x => b.has(x)) && first(`x|${known[i]}|${known[j]}`)) push({ t, sceneId: obs.current, textId: known[i], rule: 'transition.text', limit: 'texts of one scene at a time', actual: `${known[i]}(${[...a].join(',')}) with ${known[j]}(${[...b].join(',')})` });
    }
    if (obs.lite || !ov) continue;
    for (let i = 0; i < obs.texts.length; i++) {
      const a = obs.texts[i];
      if (a.cover?.ratio >= ov.maxRatio - 1e-9 && first(`c|${a.id}|${a.cover.by}`)) push({ t, sceneId: a.scene || obs.current, textId: a.id, rule: 'text.overlap', limit: `photo covers < ${Math.round(ov.maxRatio * 100)}% of text`, actual: `photo ${a.cover.by} covers ${Math.round(a.cover.ratio * 100)}% of ${a.id} at ${boxText(a.box)}` });
      for (let j = i + 1; j < obs.texts.length; j++) {
        const b = obs.texts[j];
        if (a.id === b.id || !a.rects?.length || !b.rects?.length) continue;
        let both = 0; for (const ra of a.rects) for (const rb of b.rects) both += inter(ra, rb);
        const small = Math.min(a.rects.reduce((n, r) => n + area(r), 0), b.rects.reduce((n, r) => n + area(r), 0));
        if (small > 0 && both / small >= ov.maxRatio - 1e-9 && first(`o|${a.id}|${b.id}`)) push({ t, sceneId: a.scene || obs.current, textId: a.id, rule: 'text.overlap', limit: `text boxes overlap < ${Math.round(ov.maxRatio * 100)}%`, actual: `${a.id} at ${boxText(a.box)} overlaps ${b.id} at ${boxText(b.box)} by ${Math.round((both / small) * 100)}%` });
      }
    }
  }
  // 전환 길이
  if (tr) {
    for (let i = 1; i < order.length; i++) {
      const A = order[i - 1]; const B = order[i];
      const pts = sorted.filter(o => o.kinds?.includes(`fade:${i}`));
      let run = []; let worst = [];
      for (const o of pts) {
        const oa = o.obs.sceneOpacity?.[A] ?? 0; const ob = o.obs.sceneOpacity?.[B] ?? 0;
        const minO = rules.check.visibleOpacityMin;
        const mixing = oa >= minO && ob >= minO && (oa < tr.fullOpacity || ob < tr.fullOpacity);
        if (mixing) { run.push(o.t); if (run.length > worst.length) worst = [...run]; } else run = [];
      }
      if (worst.length) {
        const dur = worst[worst.length - 1] - worst[0] + tr.probeStepSec;
        if (dur > tr.maxSec + 1e-6) push({ t: worst[0], sceneId: B, rule: 'transition.length', limit: `cross-fade ≤ ${tr.maxSec}s`, actual: `${A}→${B} both visible ${dur.toFixed(2)}s (${worst[0]}–${worst[worst.length - 1]}s)` });
      }
    }
  }
  const full = sorted.filter(o => !o.obs.lite && (o.kinds?.includes('grid') || o.kinds?.includes('ending')));
  // 정지 화면
  if (st) {
    let start = null; let prev = null;
    const flush = end => {
      if (start && end && end.t - start.t >= st.maxSec - 1e-6) push({ t: start.t, sceneId: start.obs.current, rule: 'scene.still', limit: `screen changes within ${st.maxSec}s`, actual: `no change ${start.t}–${end.t}s` });
    };
    for (const o of full) {
      const skip = o.obs.sig == null || (st.skipLastScene && o.obs.current === last);
      if (!skip && prev && o.obs.sig === prev.obs.sig) { prev = o; continue; }
      flush(prev); start = skip ? null : o; prev = skip ? null : o;
    }
    flush(prev);
  }
  // 빈 장면
  if (sc) {
    for (const id of order) {
      if (id === last) continue;
      const mine = full.filter(o => o.obs.current === id);
      if (!mine.length) continue;
      const hasText = mine.some(o => o.obs.texts.length > 0);
      let motion = 0; const base = {};
      for (const o of mine) for (const [k, b] of Object.entries(o.obs.boxes || {})) {
        if (!base[k]) { base[k] = b; continue; }
        motion = Math.max(motion, ...b.map((v, n) => Math.abs(v - base[k][n])));
      }
      if (!hasText && motion < sc.minMotionPx) push({ sceneId: id, rule: 'scene.empty', limit: `≥1 visible text or motion ≥ ${sc.minMotionPx}px`, actual: `no text, motion ${Math.round(motion)}px` });
    }
  }
}

/**
 * 2~4. 실행 검사(격리 Chrome).
 * @param {{html, story, rules, store, lengthSec, assets:Map, fonts, browserPath, opTimeoutMs?, totalTimeoutMs?, frameTimeoutMs?, chromium?}} a
 * @returns {Promise<{violations:Array, checkMs:number}>} 브라우저를 띄우지 못하면 PromoError('RENDER_FAILED')
 */
export async function runSceneCheck(a) {
  const started = Date.now();
  const { story, rules, lengthSec: L } = a;
  const v = [];
  const opened = await openScene({ html: a.html, assets: a.assets, fonts: a.fonts || [], browserPath: a.browserPath, scale: 1, opTimeoutMs: a.opTimeoutMs ?? 10000, chromium: a.chromium, readFont: a.readFont || readFile });
  if (!opened.ok) {
    v.push({ rule: opened.code === 'TIMEOUT' ? 'runtime.timeout' : 'runtime.error', limit: `load ≤ ${(a.opTimeoutMs ?? 10000) / 1000}s`, actual: opened.code === 'TIMEOUT' ? 'load timeout' : 'page did not load' });
    for (const e of opened.log.errors.slice(0, 5)) v.push({ rule: 'runtime.error', actual: e });
    return { violations: v, checkMs: Date.now() - started };
  }
  const deadline = started + (a.totalTimeoutMs ?? 30000);
  const frameMs = a.frameTimeoutMs ?? 500;
  try {
    let duration;
    try { duration = await opened.evaluate(() => window.__duration, undefined, 2000); } catch { duration = undefined; }
    if (typeof duration !== 'number' || Math.abs(duration - L) > rules.durationToleranceSec) v.push({ rule: 'runtime.duration', limit: L, actual: duration ?? 'missing' });
    const stageSize = await opened.evaluate(() => { const s = document.getElementById('stage'); if (!s) return null; const r = s.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }, undefined, 2000).catch(() => null);
    if (!stageSize || stageSize[2] !== 1080 || stageSize[3] !== 1920 || stageSize[0] !== 0 || stageSize[1] !== 0) v.push({ rule: 'runtime.error', limit: '#stage 1080×1920 at 0,0', actual: stageSize ? stageSize.join(',') : 'no #stage' });
    const observations = [];
    for (const point of samplePoints(story, rules, L)) {
      if (Date.now() > deadline) { v.push({ t: point.t, rule: 'runtime.timeout', limit: `check ≤ ${(a.totalTimeoutMs ?? 30000) / 1000}s`, actual: 'check too slow' }); break; }
      const t0 = Date.now();
      try { await opened.seek(point.t, Math.max(frameMs * 4, 2000)); } catch (err) {
        v.push({ t: point.t, rule: err?.code === 'TIMEOUT' ? 'runtime.timeout' : 'runtime.error', limit: `frame ≤ ${frameMs}ms`, actual: err?.code === 'TIMEOUT' ? 'frame did not finish' : String(err?.message || err).slice(0, 120) });
        break;
      }
      const seekMs = Date.now() - t0;
      if (seekMs > frameMs) v.push({ t: point.t, rule: 'runtime.timeout', limit: `frame ≤ ${frameMs}ms`, actual: `${seekMs}ms` });
      let obs;
      const lite = point.kinds.every(k => k.startsWith('fade:'));
      try { obs = await opened.evaluate(probe, { minOpacity: rules.check.visibleOpacityMin, lite, layerCover: rules.overlap?.layerCover ?? 0.9, pxStep: rules.still?.pxStep ?? 0.5 }, 5000); } catch (err) {
        v.push({ t: point.t, rule: err?.code === 'TIMEOUT' ? 'runtime.timeout' : 'runtime.error', actual: 'probe failed' });
        break;
      }
      observations.push({ t: point.t, kinds: point.kinds, obs });
    }
    v.push(...evaluateObservations(observations, a));
    const forbidden = [...new Set(await opened.forbidden())];
    for (const name of forbidden) v.push({ rule: 'runtime.forbiddenApi', limit: 'not called', actual: name });
    for (const e of [...new Set(opened.log.errors)].slice(0, 10)) v.push({ rule: 'runtime.error', limit: 'no errors', actual: e });
    for (const b of [...new Set(opened.log.blocked)].slice(0, 10)) v.push({ rule: 'runtime.blockedRequest', limit: 'allow-list only', actual: b });
  } finally {
    await opened.close();
  }
  return { violations: v, checkMs: Date.now() - started };
}
