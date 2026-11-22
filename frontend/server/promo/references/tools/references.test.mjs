/* global structuredClone */
// T-084 tests: rules/meta constants vs PROMO_TEMPLATES, example stories (text checker), example code
// (static + isolated scene checker, ko only per D-83), checker sanity, determinism, gallery files.
// Run from frontend: node --test server/promo/references/tools/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkStory, checkTextFits, makeCounter } from './lib/check-story.mjs';
import { runSceneCheck, staticCheck } from './lib/check-scene.mjs';
import { openScene } from './lib/recorder.mjs';
import { findChrome, findFfmpeg, loadCatalog, loadPlaywright, loadReference, loadRules, refDir } from './lib/env.mjs';

const REFS = ['ref-1', 'ref-2', 'ref-3'];
const rules = loadRules();
const catalog = loadCatalog();
const pw = await loadPlaywright();
const chrome = findChrome();
const browserSkip = !pw || !chrome ? 'playwright-core or Chrome not available' : false;
const ff = findFfmpeg();

// PROMO_TEMPLATES 0.1·0.3·0.5·3·6 tables copied as constants.
test('rules.json equals PROMO_TEMPLATES [fixed] values', () => {
  assert.deepEqual(rules.frame, { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual(rules.safe, { left: 60, right: 60, top: 120, bottom: 300 });
  assert.deepEqual(rules.safeRect, { x0: 60, x1: 1020, y0: 120, y1: 1620 });
  assert.equal(rules.minFontPx, 36);
  const table = { title: [88, 10, 19, 2], cap: [64, 14, 27, 2], sub: [48, 18, 36, 2], small: [36, 24, 48, 2], bubble: [40, 16, 30, 2] };
  for (const [role, [px, cjk, en, lines]] of Object.entries(table)) {
    assert.deepEqual(rules.roles[role], { fontPx: px, perLine: { cjk, en }, maxLines: lines }, role);
  }
  for (const r of Object.values(rules.roles)) assert.ok(r.fontPx >= rules.minFontPx);
  assert.deepEqual(rules.lengths['10'], { sceneCount: { min: 3, max: 6 }, minSceneSec: 1, endingSec: 2.5 });
  assert.deepEqual(rules.lengths['15'], { sceneCount: { min: 4, max: 8 }, minSceneSec: 1, endingSec: 3 });
  assert.deepEqual(rules.lengths['30'], { sceneCount: { min: 6, max: 14 }, minSceneSec: 1, endingSec: 4 });
  assert.deepEqual(rules.minSceneSecByRef, { 'ref-3': 2.5 });
  assert.equal(rules.photo.maxUses, 2);
  assert.equal(rules.photo.noAdjacent, true);
  assert.equal(rules.ending.locationMaxLines, 2);
  assert.equal(rules.ending.longestLocationChars, 24);
  assert.equal(rules.fadeOutSec, 0.6);
  assert.equal(rules.flash.maxPerSec, 3);
  assert.equal(rules.html.maxBytes, 65536);
  for (const w of ['네이버', 'naver', '카카오', 'instagram', 'youtube']) assert.ok(rules.bannedWords.includes(w), w);
});

// PROMO_TEMPLATES 0.6·1·3·7.1·8 tables copied as constants. Preview windows are the 8절 spans moved just inside
// the scene (past the cross-fade) so the loop point does not land mid-transition (8절 loop rule).
const META = {
  'ref-1': { cardAspect: '9:16', moods: ['lively', 'warm'], concepts: ['new-item', 'todays-deal'], slots: [2, 3, 5], preview: [2.1, 6.9] },
  'ref-2': { cardAspect: '1:1', moods: ['warm', 'clean'], concepts: ['review-roundup', 'new-item'], slots: [3, 4, 7], preview: [2.7, 7] },
  'ref-3': { cardAspect: '4:5', moods: ['elegant', 'clean'], concepts: ['new-item', 'day-at-shop'], slots: [2, 3, 5], preview: [1.8, 5.7] },
};
for (const id of REFS) {
  test(`${id} meta.json equals PROMO_TEMPLATES values`, () => {
    const { meta, story } = loadReference(id);
    const want = META[id];
    assert.equal(meta.id, id);
    assert.equal(meta.nameKey, `promo.ref.${id}.name`);
    assert.equal(typeof meta.version, 'string');
    assert.equal(meta.cardAspect, want.cardAspect);
    assert.equal(meta.posterScene, 's2');
    assert.deepEqual(meta.moods, want.moods);
    assert.deepEqual(meta.concepts, want.concepts);
    assert.deepEqual([meta.previewFrom, meta.previewTo], want.preview);
    const len = meta.previewTo - meta.previewFrom;
    assert.ok(len >= 3 && len <= 5, `preview length ${len}`);
    ['10', '15', '30'].forEach((L, i) => {
      assert.equal(meta.lengths[L].photoSlots.max, want.slots[i], `${L} slots`);
      const sc = meta.lengths[L].sceneCount;
      assert.ok(sc.min <= sc.max, `${L} scene range`);
      // ref-1 is the user's fixed 5-part format (PROMO_TEMPLATES 2.1·3: 5/5/5); others stay inside the general range
      if (id === 'ref-1') assert.deepEqual(sc, { min: 5, max: 5 });
      else assert.ok(sc.min >= rules.lengths[L].sceneCount.min && sc.max <= rules.lengths[L].sceneCount.max, `${L} scene range`);
    });
    // poster time is inside the poster scene and before the ending
    const s2 = story.scenes.find((s) => s.sceneId === meta.posterScene);
    assert.ok(meta.posterAt > s2.start && meta.posterAt < s2.start + s2.duration);
  });

  test(`${id} example-story passes the text checker (ko)`, () => {
    const { meta, story } = loadReference(id);
    assert.equal(story.referenceId, id);
    assert.equal(story.lengthSec, 15);
    assert.equal(story.locale, 'ko');
    const v = checkStory(story, { rules, meta, catalog, selectedPhotoIds: catalog.sources.example });
    assert.deepEqual(v, []);
    // every caption within its role limit (D-83: ko only)
    const count = makeCounter(rules);
    for (const t of story.texts) {
      if (t.textId.startsWith('store-')) continue;
      assert.ok(checkTextFits(t.text, t.role, 'ko', rules, count).ok, `${t.textId} ${t.text}`);
    }
  });

  test(`${id} example.html passes the static check`, () => {
    const { html, story } = loadReference(id);
    assert.deepEqual(staticCheck(html, { story, rules }), []);
  });

  test(`${id} example.html passes the scene checker with 0 violations`, { skip: browserSkip }, async () => {
    const { html, story } = loadReference(id);
    const r = await runSceneCheck({ html, story, rules, catalog, lengthSec: 15 });
    assert.deepEqual(r.violations, []);
    assert.ok(r.samples.length >= 60);
  });
}

test('text checker: counting and a few rules', () => {
  const count = makeCounter(rules);
  assert.equal(count('휘낭시에 4개', 'ko'), 4 + 0.5 + 0.5 + 1);
  assert.equal(count('Financier', 'en'), 9);
  // the longest location (24 full-width chars) takes exactly 2 sub lines
  assert.deepEqual(checkTextFits('가'.repeat(24), 'sub', 'ko', rules).lines, 2);
  assert.equal(checkTextFits('가'.repeat(37), 'sub', 'ko', rules).ok, false);
  const { meta, story } = loadReference('ref-2');
  const bad = structuredClone(story);
  bad.texts[1].text = '네이버 리뷰 최고 😀';
  bad.scenes[2].photoIds = ['fin-04'];
  const rulesHit = new Set(checkStory(bad, { rules, meta, catalog, selectedPhotoIds: catalog.sources.example }).map((x) => x.rule));
  for (const r of ['text.banned', 'text.emoji', 'photo.adjacent']) assert.ok(rulesHit.has(r), r);
});

test('ending: a 24-character location stays within 2 lines in every example', { skip: browserSkip }, async () => {
  const long = '가나다라마바사아자차카타파하가나다라마바사아자차';
  assert.equal([...long].length, 24);
  for (const id of REFS) {
    const { html, story } = loadReference(id);
    const html2 = html.replace(catalog.store.location, long);
    const story2 = structuredClone(story);
    story2.texts.find((t) => t.textId === 'store-location').text = long;
    const cat2 = { ...catalog, store: { ...catalog.store, location: long } };
    const r = await runSceneCheck({ html: html2, story: story2, rules, catalog: cat2, lengthSec: 15 });
    assert.deepEqual(r.violations, [], id);
  }
});

test('scene checker catches injected violations', { skip: browserSkip }, async () => {
  const { html, story } = loadReference('ref-3');
  const bad = html
    .replace('.cap { position: absolute; left: 60px; width: 960px; top: 1478px;', '.cap { position: absolute; left: 60px; width: 960px; top: 1700px;')
    .replace('<b>휘낭시에</b> 세 가지 맛', '<b>피스타치오</b> 세 가지 맛')
    .replace('var L = 15;', 'var L = 15; setTimeout(function () {}, 1);')
    .replace('data-photo="fin-03" src="assets/photos/fin-03.jpg"', 'data-photo="fin-06" src="assets/photos/fin-06.jpg"');
  const r = await runSceneCheck({ html: bad, story, rules, catalog, lengthSec: 15 });
  const hit = new Set(r.violations.map((x) => x.rule));
  for (const rule of ['static.forbidden', 'text.safeArea', 'text.undeclared', 'runtime.forbiddenApi', 'pair.photo', 'runtime.blockedRequest']) {
    assert.ok(hit.has(rule), `${rule} in ${[...hit].join(',')}`);
  }
});

test('same t drawn twice gives the same pixels', { skip: browserSkip }, async () => {
  for (const id of REFS) {
    const { html, story, meta } = loadReference(id);
    const sc = await openScene({ html, story, catalog, scale: 1 / 3 });
    try {
      await sc.seek(meta.posterAt);
      const a = await sc.shot({ type: 'png' });
      await sc.seek(13.2);
      await sc.seek(meta.posterAt);
      const b = await sc.shot({ type: 'png' });
      assert.ok(a.equals(b), `${id} pixels differ`);
    } finally {
      await sc.close();
    }
  }
});

function probe(file) {
  const out = execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

for (const id of REFS) {
  test(`${id} gallery files: poster 360x640, preview 3~5s silent 360x640 h264 30fps faststart`, { skip: !ff?.ffprobe ? 'ffprobe not available' : false }, async () => {
    const dir = refDir(id);
    const poster = probe(path.join(dir, 'poster.jpg'));
    assert.equal(poster.streams[0].width, 360);
    assert.equal(poster.streams[0].height, 640);
    const file = path.join(dir, 'preview.mp4');
    assert.ok(existsSync(file));
    const p = probe(file);
    const v = p.streams.filter((s) => s.codec_type === 'video');
    assert.equal(v.length, 1);
    assert.equal(p.streams.filter((s) => s.codec_type === 'audio').length, 0, 'no audio');
    assert.equal(v[0].codec_name, 'h264');
    assert.equal(v[0].width, 360);
    assert.equal(v[0].height, 640);
    assert.equal(v[0].r_frame_rate, '30/1');
    const d = Number(p.format.duration);
    const { meta } = loadReference(id);
    assert.ok(d >= 3 && d <= 5, `duration ${d}`);
    assert.ok(Math.abs(d - (meta.previewTo - meta.previewFrom)) < 0.05, `duration ${d}`);
    // faststart: moov atom before mdat
    const { readFileSync } = await import('node:fs');
    const head = readFileSync(file).subarray(0, 4096).toString('latin1');
    assert.ok(head.indexOf('moov') !== -1 && head.indexOf('moov') < (head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat')), 'moov before mdat');
  });
}
