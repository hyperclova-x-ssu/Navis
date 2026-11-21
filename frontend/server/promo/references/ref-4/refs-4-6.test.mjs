/* global structuredClone */
// T-085 tests for ref-4~6: the same per-reference tests as T-084's tools/references.test.mjs
// (meta vs PROMO_TEMPLATES, text checker, static + scene checker, 24-char location, determinism, gallery files).
// D-83: Korean only. Run from 04_app: node --test server/promo/references/ref-4/refs-4-6.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkStory, checkTextFits, makeCounter } from '../tools/lib/check-story.mjs';
import { runSceneCheck, staticCheck } from '../tools/lib/check-scene.mjs';
import { openScene } from '../tools/lib/recorder.mjs';
import { findChrome, findFfmpeg, loadCatalog, loadPlaywright, loadReference, loadRules, refDir } from '../tools/lib/env.mjs';

const REFS = ['ref-4', 'ref-5', 'ref-6'];
const rules = loadRules();
const catalog = loadCatalog();
const pw = await loadPlaywright();
const browserSkip = !pw || !findChrome() ? 'playwright-core or Chrome not available' : false;
const ff = findFfmpeg();

// PROMO_TEMPLATES 0.6 (fit), 1 (card, poster scene), 3·7.1 (photo slots), 8 (preview span; ref-5 moved 0.2s
// past the 280ms card swap so the loop does not start mid-transition, same rule as T-084).
const META = {
  'ref-4': { cardAspect: '9:16', posterScene: 's2', moods: ['warm', 'lively'], concepts: ['new-item', 'behind-the-scenes'], slots: [3, 4, 7], preview: [0, 4] },
  'ref-5': { cardAspect: '4:5', posterScene: 's3', moods: ['warm', 'clean'], concepts: ['day-at-shop', 'behind-the-scenes'], slots: [2, 3, 5], preview: [2.7, 7] },
  'ref-6': { cardAspect: '1:1', posterScene: 's2', moods: ['warm', 'elegant'], concepts: ['review-roundup', 'todays-deal'], slots: [2, 3, 6], preview: [3, 7.5] },
};

for (const id of REFS) {
  test(`${id} meta.json equals PROMO_TEMPLATES values`, () => {
    const { meta, story } = loadReference(id);
    const want = META[id];
    assert.equal(meta.id, id);
    assert.equal(meta.nameKey, `promo.ref.${id}.name`);
    assert.equal(typeof meta.version, 'string');
    assert.equal(meta.cardAspect, want.cardAspect);
    assert.equal(meta.posterScene, want.posterScene);
    assert.deepEqual(meta.moods, want.moods);
    assert.deepEqual(meta.concepts, want.concepts);
    assert.deepEqual([meta.previewFrom, meta.previewTo], want.preview);
    const len = meta.previewTo - meta.previewFrom;
    assert.ok(len >= 3 && len <= 5, `preview length ${len}`);
    ['10', '15', '30'].forEach((L, i) => {
      assert.equal(meta.lengths[L].photoSlots.max, want.slots[i], `${L} slots`);
      const sc = meta.lengths[L].sceneCount;
      assert.ok(sc.min <= sc.max && sc.min >= rules.lengths[L].sceneCount.min && sc.max <= rules.lengths[L].sceneCount.max, `${L} scene range`);
    });
    const ps = story.scenes.find((s) => s.sceneId === meta.posterScene);
    assert.ok(meta.posterAt > ps.start && meta.posterAt < ps.start + ps.duration, 'posterAt inside posterScene');
    // previews never include the ending card (PROMO_TEMPLATES 8)
    assert.ok(meta.previewTo <= story.scenes.at(-1).start);
  });

  test(`${id} example-story passes the text checker (ko)`, () => {
    const { meta, story } = loadReference(id);
    assert.equal(story.referenceId, id);
    assert.equal(story.lengthSec, 15);
    assert.equal(story.locale, 'ko');
    assert.deepEqual(checkStory(story, { rules, meta, catalog, selectedPhotoIds: catalog.sources.example }), []);
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

  test(`${id} ending: a 24-character location stays within 2 lines`, { skip: browserSkip }, async () => {
    const long = '가나다라마바사아자차카타파하가나다라마바사아자차';
    const { html, story } = loadReference(id);
    const story2 = structuredClone(story);
    story2.texts.find((t) => t.textId === 'store-location').text = long;
    const r = await runSceneCheck({
      html: html.replace(catalog.store.location, long),
      story: story2,
      rules,
      catalog: { ...catalog, store: { ...catalog.store, location: long } },
      lengthSec: 15,
    });
    assert.deepEqual(r.violations, []);
  });

  test(`${id} same t drawn twice gives the same pixels`, { skip: browserSkip }, async () => {
    const { html, story, meta } = loadReference(id);
    const sc = await openScene({ html, story, catalog, scale: 1 / 3 });
    try {
      await sc.seek(meta.posterAt);
      const a = await sc.shot({ type: 'png' });
      await sc.seek(13.2);
      await sc.seek(meta.posterAt);
      const b = await sc.shot({ type: 'png' });
      assert.ok(a.equals(b));
    } finally {
      await sc.close();
    }
  });

  test(`${id} gallery files: poster 360x640, preview 3~5s silent 360x640 h264 30fps faststart`, { skip: !ff?.ffprobe ? 'ffprobe not available' : false }, () => {
    const probe = (file) =>
      JSON.parse(execFileSync(ff.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
    const dir = refDir(id);
    const poster = probe(path.join(dir, 'poster.jpg'));
    assert.deepEqual([poster.streams[0].width, poster.streams[0].height], [360, 640]);
    const file = path.join(dir, 'preview.mp4');
    assert.ok(existsSync(file));
    const p = probe(file);
    const v = p.streams.filter((s) => s.codec_type === 'video');
    assert.equal(v.length, 1);
    assert.equal(p.streams.filter((s) => s.codec_type === 'audio').length, 0);
    assert.equal(v[0].codec_name, 'h264');
    assert.deepEqual([v[0].width, v[0].height, v[0].r_frame_rate], [360, 640, '30/1']);
    const d = Number(p.format.duration);
    const { meta } = loadReference(id);
    assert.ok(d >= 3 && d <= 5 && Math.abs(d - (meta.previewTo - meta.previewFrom)) < 0.05, `duration ${d}`);
    const head = readFileSync(file).subarray(0, 4096).toString('latin1');
    const moov = head.indexOf('moov');
    const mdat = head.indexOf('mdat');
    assert.ok(moov !== -1 && (mdat === -1 || moov < mdat), 'moov before mdat');
  });
}
