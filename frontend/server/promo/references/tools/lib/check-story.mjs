// Minimal text checker for example stories (same rules as ARCHITECTURE 12.4 / T-082 check-story.mjs).
// Pure function: checkStory(story, ctx) -> violations [{path, rule, limit, actual}].

const SCENE_ID = /^s[0-9]{1,2}$/;
const TEXT_ID = /^(t[0-9]{1,3}|store-name|store-location)$/;
const ROLES = new Set(['title', 'cap', 'sub', 'small', 'bubble', 'number', 'label']);
const EMOJI = /\p{Extended_Pictographic}/u;
// eslint-disable-next-line no-control-regex -- deliberately matches control characters
const CONTROL = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'u');
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/u;
const HAN = /\p{Script=Han}/u;

function parseRanges(list) {
  return list.map((r) => r.split('-').map((h) => parseInt(h, 16)));
}

export function makeCounter(rules) {
  const ranges = parseRanges(rules.counting.fullWidthRanges);
  const full = rules.counting.cjkFullWidth;
  const other = rules.counting.cjkOther;
  const isFull = (cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
  const cjkWidth = (s) => {
    let w = 0;
    for (const ch of s) w += isFull(ch.codePointAt(0)) ? full : other;
    return w;
  };
  const enWidth = (s) => [...s].length;
  return (text, locale) => (rules.counting.enLocales.includes(locale) ? enWidth(text) : cjkWidth(text));
}

export function lineCount(text, perLine, width) {
  return text.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(width(part) / perLine)), 0);
}

export function checkTextFits(text, role, locale, rules, count = makeCounter(rules)) {
  const r = rules.roles[role];
  const per = rules.counting.enLocales.includes(locale) ? r.perLine.en : r.perLine.cjk;
  const lines = lineCount(text, per, (s) => count(s, locale));
  return { lines, maxLines: r.maxLines, ok: lines <= r.maxLines, perLine: per };
}

/**
 * @param story story.json (DATA_MODEL 10.16.4)
 * @param ctx {rules, meta, catalog, selectedPhotoIds}
 */
export function checkStory(story, ctx) {
  const { rules, meta, catalog } = ctx;
  const v = [];
  const add = (path, rule, limit, actual) => v.push({ path, rule, limit, actual });
  const L = String(story.lengthSec);
  const lenRules = rules.lengths[L];
  if (!lenRules) {
    add('lengthSec', 'schema', '10|15|30', story.lengthSec);
    return v;
  }
  if (!Array.isArray(story.scenes) || !Array.isArray(story.texts)) {
    add('', 'schema', 'scenes[] texts[]', 'missing');
    return v;
  }
  const exterior = rules.photo.exteriorId;
  const selected = new Set(ctx.selectedPhotoIds ?? []);
  const count = makeCounter(rules);

  // scenes
  // meta.json's per-reference range wins over the general range (ref-1 keeps its fixed 5-part order at 30s).
  const sc = meta.lengths[L]?.sceneCount ?? lenRules.sceneCount;
  const { min, max } = sc;
  if (story.scenes.length < min || story.scenes.length > max) add('scenes', 'scene.count', `${min}-${max}`, story.scenes.length);
  const minSec = rules.minSceneSecByRef[story.referenceId] ?? lenRules.minSceneSec;
  let cursor = 0;
  let total = 0;
  const sceneIds = new Set();
  story.scenes.forEach((s, i) => {
    const p = `scenes[${i}]`;
    if (!SCENE_ID.test(s.sceneId)) add(`${p}.sceneId`, 'schema', SCENE_ID.source, s.sceneId);
    if (sceneIds.has(s.sceneId)) add(`${p}.sceneId`, 'schema', 'unique', s.sceneId);
    sceneIds.add(s.sceneId);
    if (Math.abs(s.start - cursor) > 1e-6) add(`${p}.start`, 'scene.start', cursor, s.start);
    cursor = s.start + s.duration;
    total += s.duration;
    const isEnding = i === story.scenes.length - 1;
    const skipFirst = i === 0 && (rules.minSceneSecByRefSkipFirst ?? []).includes(story.referenceId);
    const need = skipFirst ? lenRules.minSceneSec : minSec;
    if (!isEnding && s.duration < need - 1e-6) add(`${p}.duration`, 'scene.minDuration', need, s.duration);
    if (isEnding && Math.abs(s.duration - lenRules.endingSec) > 1e-6) add(`${p}.duration`, 'scene.endingDuration', lenRules.endingSec, s.duration);
    if (typeof s.direction === 'string' && s.direction.length > 200) add(`${p}.direction`, 'schema', 200, s.direction.length);
  });
  if (Math.abs(total - story.lengthSec) > 1e-6) add('scenes', 'scene.totalDuration', story.lengthSec, total);

  // photos
  const known = new Set(catalog.photos.map((p) => p.photoId));
  const uses = new Map();
  story.scenes.forEach((s, i) => {
    for (const id of s.photoIds ?? []) {
      if (!known.has(id) || (id !== exterior && selected.size > 0 && !selected.has(id))) {
        add(`scenes[${i}].photoIds`, 'photo.notSelected', 'selected|store-exterior', id);
      }
      if (id === exterior) continue;
      if (!uses.has(id)) uses.set(id, []);
      uses.get(id).push(i);
    }
  });
  for (const [id, idx] of uses) {
    if (idx.length > rules.photo.maxUses) add(`photo:${id}`, 'photo.reuse', rules.photo.maxUses, idx.length);
    for (let k = 1; k < idx.length; k++) {
      if (rules.photo.noAdjacent && idx[k] - idx[k - 1] === 1) add(`photo:${id}`, 'photo.adjacent', 'not adjacent', `${idx[k - 1]},${idx[k]}`);
    }
  }
  const slots = meta.lengths[L]?.photoSlots?.max;
  if (slots != null && uses.size > slots) add('scenes', 'photo.slots', slots, uses.size);
  if (rules.photo.useAllBeforeReuse && selected.size > 0) {
    const order = [];
    story.scenes.forEach((s) => (s.photoIds ?? []).forEach((id) => id !== exterior && order.push(id)));
    const seen = new Set();
    const usable = Math.min(selected.size, slots ?? selected.size);
    for (const id of order) {
      if (seen.has(id) && seen.size < usable) add(`photo:${id}`, 'photo.reuseBeforeAll', usable, seen.size);
      seen.add(id);
    }
  }

  // texts
  const textIds = new Set();
  story.texts.forEach((t, i) => {
    const p = `texts[${i}]`;
    if (!TEXT_ID.test(t.textId)) add(`${p}.textId`, 'schema', TEXT_ID.source, t.textId);
    if (textIds.has(t.textId)) add(`${p}.textId`, 'schema', 'unique', t.textId);
    textIds.add(t.textId);
    if (!ROLES.has(t.role)) {
      add(`${p}.role`, 'schema', [...ROLES].join('|'), t.role);
      return;
    }
    if (typeof t.text !== 'string' || t.text.trim() === '') add(`${p}.text`, 'schema', 'non-empty', t.text);
    for (const sid of t.sceneIds ?? []) if (!sceneIds.has(sid)) add(`${p}.sceneIds`, 'schema', 'known scene', sid);
    if (t.textId === 'store-name' || t.textId === 'store-location') return;
    const fit = checkTextFits(t.text, t.role, story.locale, rules, count);
    if (!fit.ok) add(`${p}.text`, 'text.length', `${fit.maxLines}x${fit.perLine}`, fit.lines);
    if (rules.forbidEmoji && EMOJI.test(t.text)) add(`${p}.text`, 'text.emoji', 'none', t.text);
    if (rules.forbidControlChars && CONTROL.test(t.text)) add(`${p}.text`, 'text.control', 'none', t.text);
    const lang = rules.languages[story.locale] ?? {};
    for (const s of lang.forbidScripts ?? []) {
      if ((s === 'Hangul' && HANGUL.test(t.text)) || (s === 'Han' && HAN.test(t.text))) add(`${p}.text`, 'text.language', `no ${s}`, t.text);
    }
    const low = t.text.toLowerCase();
    for (const w of rules.bannedWords) if (low.includes(w.toLowerCase())) add(`${p}.text`, 'text.banned', w, t.text);
    for (const re of rules.bannedPatterns) if (new RegExp(re, 'u').test(t.text)) add(`${p}.text`, 'text.banned', re, t.text);
  });
  const ko = rules.languages[story.locale]?.requireScripts ?? [];
  if (ko.includes('Hangul') && !story.texts.some((t) => !t.textId.startsWith('store-') && HANGUL.test(t.text))) {
    add('texts', 'text.language', 'Hangul', 'none');
  }
  story.scenes.forEach((s, i) => {
    for (const tid of s.textIds ?? []) if (!textIds.has(tid)) add(`scenes[${i}].textIds`, 'schema', 'known text', tid);
  });

  // ending
  const ending = story.scenes[story.scenes.length - 1];
  const byId = new Map(story.texts.map((t) => [t.textId, t]));
  for (const [id, want] of [
    ['store-name', catalog.store.name],
    ['store-location', catalog.store.location],
  ]) {
    const t = byId.get(id);
    if (!t) add(`texts:${id}`, 'ending.missing', want, null);
    else {
      if (t.text !== want) add(`texts:${id}`, 'ending.mismatch', want, t.text);
      if (ending && !(t.sceneIds ?? []).includes(ending.sceneId)) add(`texts:${id}`, 'ending.missing', ending.sceneId, t.sceneIds);
    }
  }
  if (!story.ending || !byId.has(story.ending.taglineTextId)) add('ending.taglineTextId', 'ending.missing', 'text id', story.ending?.taglineTextId);
  if (story.ending?.ctaTextId && !byId.has(story.ending.ctaTextId)) add('ending.ctaTextId', 'ending.missing', 'text id', story.ending.ctaTextId);
  return v;
}
