// 글자 검사기 (ARCHITECTURE 12.4, 순수 함수). 장면 구성(story.json)이 레퍼런스·길이·글자 규칙을 지키는지 본다.
// checkStory(story, ctx) → [{path, rule, limit, actual}]
// ctx = { rules(normalizeRules 결과), range(rangeFor 결과), lengthSec, locale, referenceId, selectedPhotoIds[], store{name, location} }

export const SCENE_ID = /^s[0-9]{1,2}$/;
export const TEXT_ID = /^(t[0-9]{1,3}|store-name|store-location)$/;
export const ROLES = ['title', 'cap', 'sub', 'small', 'bubble', 'number', 'label'];
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}]/u;
const CONTROL = /[\p{Cc}\p{Cf}\uFFFD]/u; // \n은 따로 허용. U+FFFD(깨진 글자)도 막는다(T-087)
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/u;
const HAN = /\p{Script=Han}/u;
const SCRIPTS = { Hangul: HANGUL, Han: HAN };
const EPS = 0.011;

export function makeCounter(rules) {
  const ranges = rules.fullWidthRanges?.length ? rules.fullWidthRanges : [[0x1100, 0x11ff], [0x2e80, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x2fa1f]];
  const isFull = cp => ranges.some(([a, b]) => cp >= a && cp <= b);
  return (text, locale) => {
    if (locale === 'en') return [...text].length;
    let w = 0;
    for (const ch of text) w += isFull(ch.codePointAt(0)) ? 1 : 0.5;
    return w;
  };
}

/** \n으로 나눈 각 부분이 ceil(폭/줄당 글자) 줄을 차지한다(빈 부분은 1줄). */
export function linesNeeded(text, perLine, width) {
  return text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(width(part) / perLine - 1e-9)), 0);
}

export function checkStory(story, ctx) {
  const { rules, range, lengthSec, locale, referenceId, store } = ctx;
  const v = [];
  const add = (path, rule, limit, actual) => v.push({ path, rule, limit, actual });
  if (!story || typeof story !== 'object' || !Array.isArray(story.scenes) || !Array.isArray(story.texts)) {
    add('$', 'story.schema', 'scenes[] texts[]', 'missing');
    return v;
  }
  const count = makeCounter(rules);
  const selected = new Set(ctx.selectedPhotoIds || []);
  const exterior = rules.photo.exteriorId;

  // 1) 장면 수·시간
  const { sceneCount, minSceneSec, endingSec } = range;
  if (story.scenes.length < sceneCount.min || story.scenes.length > sceneCount.max) add('scenes', 'story.sceneCount', `${sceneCount.min}-${sceneCount.max}`, story.scenes.length);
  const sceneIds = new Set();
  let cursor = 0;
  story.scenes.forEach((s, i) => {
    const p = `scenes[${i}]`;
    if (!s || !SCENE_ID.test(s.sceneId) || sceneIds.has(s.sceneId)) add(`${p}.sceneId`, 'story.schema', 'unique ^s[0-9]{1,2}$', s?.sceneId);
    sceneIds.add(s?.sceneId);
    if (typeof s?.duration !== 'number' || typeof s?.start !== 'number') { add(p, 'story.schema', 'start,duration', 'missing'); return; }
    if (Math.abs(s.start - cursor) > EPS) add(`${p}.start`, 'story.sceneStart', round(cursor), s.start);
    cursor += s.duration;
    const last = i === story.scenes.length - 1;
    const min = i === 0 ? (range.minSceneSecFirst ?? minSceneSec) : minSceneSec;
    if (!last && s.duration < min - EPS) add(`${p}.duration`, 'story.minScene', min, s.duration);
    if (last && endingSec !== null && Math.abs(s.duration - endingSec) > EPS) add(`${p}.duration`, 'story.ending', endingSec, s.duration);
  });
  if (Math.abs(cursor - lengthSec) > EPS) add('scenes', 'story.duration', lengthSec, round(cursor));

  // 2) 사진: 고른 사진·외관만, 최대 사용 수, 이웃 장면 금지, 다 쓰기 전 재사용 금지, 자리 수
  const uses = new Map(); const firstUse = new Map(); let reuseAt = -1;
  story.scenes.forEach((s, i) => {
    const ids = Array.isArray(s?.photoIds) ? s.photoIds : [];
    for (const id of ids) {
      if (id !== exterior && !selected.has(id)) { add(`scenes[${i}].photoIds`, 'story.photoUnknown', 'selected|exterior', id); continue; }
      if (id === exterior && rules.photo.exteriorExempt) continue;
      const n = (uses.get(id) || 0) + 1; uses.set(id, n);
      if (n === 1) firstUse.set(id, i);
      if (n > rules.photo.maxUses) add(`scenes[${i}].photoIds`, 'story.photoReuse', rules.photo.maxUses, `${id}×${n}`);
      if (n === 2 && reuseAt < 0) reuseAt = i;
      if (rules.photo.noAdjacent && i > 0 && (story.scenes[i - 1]?.photoIds || []).includes(id)) add(`scenes[${i}].photoIds`, 'story.photoAdjacent', 'not adjacent', id);
    }
  });
  const distinct = [...uses.keys()];
  if (distinct.length > range.photoSlots) add('scenes', 'story.photoSlots', range.photoSlots, distinct.length);
  if (rules.photo.useAllBeforeReuse && reuseAt >= 0) {
    const usable = Math.min(selected.size, range.photoSlots);
    const before = distinct.filter(id => firstUse.get(id) < reuseAt).length;
    if (before < usable) add(`scenes[${reuseAt}].photoIds`, 'story.photoReuseEarly', usable, before);
  }

  // 3) 글자
  const texts = new Map();
  story.texts.forEach((t, i) => {
    const p = `texts[${i}]`;
    if (!t || !TEXT_ID.test(t.textId) || texts.has(t.textId)) { add(`${p}.textId`, 'story.schema', 'unique textId', t?.textId); return; }
    texts.set(t.textId, t);
    if (!ROLES.includes(t.role) || !rules.roles[t.role]) { add(`${p}.role`, 'story.schema', ROLES.join('|'), t.role); return; }
    if (typeof t.text !== 'string' || !t.text.trim()) { add(`${p}.text`, 'story.schema', 'non-empty', ''); return; }
    const sceneRefs = Array.isArray(t.sceneIds) ? t.sceneIds : [];
    if (!sceneRefs.length || sceneRefs.some(id => !sceneIds.has(id))) add(`${p}.sceneIds`, 'story.textScene', 'known scenes', sceneRefs.join(','));
    for (const sid of sceneRefs) {
      const scene = story.scenes.find(s => s?.sceneId === sid);
      if (scene && !(scene.textIds || []).includes(t.textId)) add(`${p}.sceneIds`, 'story.textScene', `${sid}.textIds has ${t.textId}`, 'missing');
    }
    const fixed = t.textId === 'store-name' || t.textId === 'store-location';
    const role = rules.roles[t.role];
    const per = locale === 'en' ? role.perLine.en : role.perLine.cjk;
    const maxLines = t.textId === 'store-location' ? rules.ending.locationMaxLines : t.textId === 'store-name' ? rules.ending.storeNameMaxLines : role.maxLines;
    const lines = linesNeeded(t.text, per, s => count(s, locale));
    if (lines > maxLines) add(`${p}.text`, 'text.length', `${maxLines}×${per}`, `${lines} lines`);
    if (EMOJI.test(t.text)) add(`${p}.text`, 'text.emoji', 'none', 'emoji');
    if (CONTROL.test(t.text.replaceAll('\n', ''))) add(`${p}.text`, 'text.control', 'none', 'control');
    if (!fixed) {
      const lang = rules.languages[locale] || {};
      for (const name of lang.forbidScripts || []) if (SCRIPTS[name]?.test(t.text)) add(`${p}.text`, 'text.language', `${locale} without ${name}`, name);
      const letters = (t.text.match(/\p{L}/gu) || []).length;
      for (const name of lang.requireScripts || []) if (letters >= 2 && !SCRIPTS[name]?.test(t.text)) add(`${p}.text`, 'text.language', `${locale} needs ${name}`, 'missing');
      const lower = t.text.toLowerCase();
      for (const word of rules.bannedWords) if (lower.includes(word.toLowerCase())) add(`${p}.text`, 'text.banned', 'banned word', word);
      for (const re of rules.bannedPatterns) if (re.test(t.text)) add(`${p}.text`, 'text.banned', re.source, 'match');
    }
  });
  story.scenes.forEach((s, i) => {
    for (const id of s?.textIds || []) if (!texts.has(id)) add(`scenes[${i}].textIds`, 'story.textScene', 'declared text', id);
  });

  // 5) T-087: 장면마다 글자, 장면-사진 맞춤(사진 정보가 있을 때)
  checkSceneFit(story, ctx, texts, add);

  // 4) 엔딩: 마지막 장면에 가게 이름·위치가 카탈로그와 똑같이
  const lastScene = story.scenes[story.scenes.length - 1];
  for (const [id, expected] of [['store-name', store.name], ['store-location', store.location]]) {
    const t = texts.get(id);
    if (!t || !(lastScene?.textIds || []).includes(id)) add(`texts.${id}`, 'ending.missing', 'in last scene', 'missing');
    else if (t.text !== expected) add(`texts.${id}`, 'ending.mismatch', expected, t.text);
  }
  const tagline = story.ending?.taglineTextId;
  if (!tagline || !(lastScene?.textIds || []).includes(tagline)) add('ending.taglineTextId', 'ending.missing', 'tagline in last scene', tagline ?? 'missing');
  if (story.referenceId !== undefined && story.referenceId !== referenceId) add('referenceId', 'story.schema', referenceId, story.referenceId);
  return v;
}

const round = n => Math.round(n * 1000) / 1000;
const getMeta = (metas, id) => (metas instanceof Map ? metas.get(id) : metas?.[id]);

/**
 * 장면 글자·사진 맞춤 (T-087, SMOKE_REPORT 4절 1·3).
 * - story.sceneText: 엔딩이 아닌 장면에 글자가 하나도 없으면 rules.scene.textlessMaxSec 이하의 짧은 장면만 허용.
 * - story.photoFit: ctx.photoMeta(사진 id → 사진 정보)가 있을 때만
 *   품절·다 사 갔다 장면 → 진열대 가득(amount many) 사진 금지 / 남은 수량 장면(외관만 있는 장면 제외) → 메뉴가 주인공(menuShown main)이고 빈 사진이 아닌 것 /
 *   장면 하나에만 나오는 bubble 아닌 글자가 메뉴 이름을 말하면 → 그 메뉴로 등록됐고 메뉴가 보이는(menuShown ≠ no) 사진.
 */
function checkSceneFit(story, ctx, texts, add) {
  const { rules, locale } = ctx;
  const exterior = rules.photo.exteriorId;
  const lastIdx = story.scenes.length - 1;
  const textlessMax = rules.scene?.textlessMaxSec ?? 1.5;
  const fit = rules.photoFit?.[locale] || {};
  const metas = ctx.photoMeta;
  const photoMenu = ctx.photoMenu || {};
  const selected = new Set(ctx.selectedPhotoIds || []);
  const menus = (ctx.menus || []).filter(m => [...selected].some(id => (photoMenu instanceof Map ? photoMenu.get(id) : photoMenu[id]) === m.menuId));
  const menuOf = id => (photoMenu instanceof Map ? photoMenu.get(id) : photoMenu[id]);
  story.scenes.forEach((s, i) => {
    if (!s || i === lastIdx) return;
    const own = (s.textIds || []).map(id => texts.get(id)).filter(t => t && t.textId !== 'store-name' && t.textId !== 'store-location');
    if (!own.length && typeof s.duration === 'number' && s.duration > textlessMax + EPS) add(`scenes[${i}].textIds`, 'story.sceneText', `≥1 text (or ≤ ${textlessMax}s)`, 'no text');
    if (!metas) return;
    const photos = (s.photoIds || []).filter(id => id !== exterior);
    const desc = id => { const m = getMeta(metas, id); return `${id}:${m?.menuShown ?? '?'}/${m?.amount ?? '?'}`; };
    const said = own.map(t => t.text).join('\n');
    if (fit.soldOut?.test(said)) {
      const full = photos.filter(id => getMeta(metas, id)?.amount === 'many');
      if (full.length) add(`scenes[${i}].photoIds`, 'story.photoFit', 'sold-out scene: in-hand, empty or few-item photo (not a full showcase)', full.map(desc).join(','));
    }
    if (photos.length && fit.remaining?.test(said)) { // 외관만 있는 장면(가게 앞에서 'N개 남음')은 허용
      const ok = photos.some(id => { const m = getMeta(metas, id); return m?.menuShown === 'main' && m?.amount !== 'none'; });
      if (!ok) add(`scenes[${i}].photoIds`, 'story.photoFit', 'count-left scene: photo whose main subject is the menu', photos.map(desc).join(','));
    }
    if (!photos.length) return;
    for (const t of own) {
      if (t.role === 'bubble' || (t.sceneIds || []).length !== 1) continue;
      for (const m of menus) {
        const name = m.names?.[locale];
        if (!name || !t.text.includes(name)) continue;
        const ok = photos.some(id => menuOf(id) === m.menuId && getMeta(metas, id)?.menuShown !== 'no');
        if (!ok) add(`scenes[${i}].photoIds`, 'story.photoFit', `${t.textId} names ${name}: photo showing ${name}`, photos.map(desc).join(','));
      }
    }
  });
}
