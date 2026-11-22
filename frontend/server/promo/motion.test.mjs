import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import * as recorder from './recorder.mjs';
import { listReferences, loadReferences } from './references.mjs';
import * as motion from './check-motion.mjs';
import { createPipeline } from './pipeline.mjs';
import { loadPlanningTemplates } from './templates/runtime.mjs';
import { planChatCountdown } from './templates/chat-countdown.mjs';

const dark = Buffer.alloc(30, 20);
const light = Buffer.alloc(30, 156);

test('ref-1 starts at the duration default, prefers a full display, and uses an in-hand photo at sold out', () => {
  const { rules } = loadReferences();
  const input = { referenceId: 'ref-1', lengthSec: 10, locale: 'ko', menuIds: ['cake'] };
  const photos = [
    { photoId: 'display-full', kind: 'display', amount: 'many' },
    { photoId: 'inhand', kind: 'inhand', amount: 'one' },
    { photoId: 'closeup', kind: 'closeup', amount: 'one' },
  ].map(({ photoId, kind, amount }) => ({ photoId, menuId: 'cake', menuName: '딸기 케이크', meta: { kind, amount, menuShown: 'main' } }));
  const ctx = { input, photos, exterior: { photoId: 'exterior' }, store: { name: '안숭잘부 카페', location: '상도동' }, rules };
  const story = planChatCountdown(ctx, { variantId: 'meet-after-class', heroPhotoId: 'display-full' });
  assert.deepEqual(story.chatCountdown.numbers.map(([quantity]) => quantity), [3, 2, 1, 0]);
  assert.deepEqual(story.scenes[1].photoIds, ['display-full']);
  assert.deepEqual(story.scenes[3].photoIds, ['inhand']);
});

test('detects a held stretch over 1.5 seconds including the closing scene', () => {
  const stable = [light, ...Array(17).fill(dark)];
  const results = recorder.detectStaticFrames(stable, { fps: 8, lengthSec: 2.25 });
  assert.deepEqual(results.map(({ t, end, rule }) => ({ t, end, rule })), [
    { t: 0.125, end: 2.25, rule: 'video.still' },
  ]);
  assert.deepEqual(recorder.detectStaticFrames(Array(12).fill(dark), { fps: 8, lengthSec: 1.5 }), []);
});

test('accepts visible movement while ignoring video compression noise', () => {
  const noise = Array.from({ length: 16 }, (_, i) => Buffer.alloc(30, 20 + (i % 5)));
  assert.ok(recorder.detectStaticFrames(noise, { fps: 8, lengthSec: 2 }).length);
  const motion = Array.from({ length: 24 }, (_, i) => i % 4 < 2 ? dark : light);
  assert.deepEqual(recorder.detectStaticFrames(motion, { fps: 8, lengthSec: 3 }), []);
});

test('keeps the six original references and appends all twelve consensus styles', () => {
  const { references } = listReferences(loadReferences());
  assert.deepEqual(references.map(item => item.id), Array.from({ length: 18 }, (_, i) => `ref-${i + 1}`));
  const { refs } = loadReferences();
  assert.match(refs.get('ref-1').brief, /단톡방 대화 \+ 남은 수량 카운트다운/);
  assert.equal(refs.get('ref-1').meta.motion, undefined);
  assert.equal(refs.get('ref-7').meta.motion.key, 'beat-cut');
  assert.equal(refs.get('ref-13').meta.motion.key, 'timeline');
  assert.equal(refs.get('ref-18').meta.motion.key, 'moody-night');
  assert.ok(references.every(item => item.preview.durationSec >= 3 && item.preview.durationSec <= 5));
});

test('runs fresh planning, scene code and rendering for each ref-1 job with the same mixed-menu selection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'promo-countdown-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const references = loadReferences();
  const names = ['유자차', '소금빵', '말차 라떼'];
  const photos = ['tea-1', 'tea-2', 'bread-1', 'bread-2', 'latte-1'];
  const menus = names.map((name, i) => ({ menuId: `menu-${i}`, names: { ko: name } }));
  const ids = new Map(photos.map((id, i) => [id, menus[Math.floor(i / 2)].menuId]));
  const stages = [];
  const pipeline = createPipeline({ references, templates: loadPlanningTemplates(), music: [], cacheDir: dir,
    storyRunner: { run: async ({ schema, prompt }) => {
      stages.push('HCX-007');
      assert.match(prompt, /소금빵/);
      return { output: { variantId: schema.properties.variantId.enum[0], heroPhotoId: 'tea-1' } };
    } },
    sceneRunner: { run: async ({ schema, prompt }) => {
      stages.push('Claude');
      assert.match(prompt, /two allowed presentation slots/);
      assert.deepEqual(schema.properties.crops.enum, ['center', 'upper', 'lower']);
      return { output: { crops: 'lower', pace: 'reference' } };
    } },
    photoSource: { listCatalog: () => ({ store: { name: '미학당', location: '서울 동작구 상도동 999-12 (숭실대 정문 앞 골목, 가상 주소)', exteriorPhotoId: 'store-exterior' }, menus }),
      photoInfo: id => ({ width: 1080, height: 1920, menuId: ids.get(id) }),
      readPhoto: async () => ({ mime: 'image/jpeg', bytes: Buffer.alloc(1) }) },
    checkScene: async ({ html, store }) => {
      assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
      assert.match(html, /data-countdown="0"[^>]*>품절/);
      assert.equal(store.location, '숭실대 정문 앞 골목');
      assert.doesNotMatch(html, /가상 주소/);
      for (const id of ['tea-1', 'bread-1', 'latte-1']) assert.ok(html.includes(`data-photo="${id}"`));
      return { violations: [] };
    }, renderVideo: async ({ html }) => { stages.push('render'); assert.match(html, /\?56:50/); },
    checkVideo: async () => ({ info: { durationSec: 10 }, violations: [] }) });
  const input = { referenceId: 'ref-1', locale: 'ko', lengthSec: 10, menuIds: menus.map(m => m.menuId),
    photoIds: photos, moods: ['lively'], concepts: ['new-item'] };
  const metas = photos.map((photoId, i) => ({ photoId, menuShown: 'main', quality: 'good', kind: i === 1 ? 'inhand' : 'display', amount: i === 1 ? 'one' : 'many' }));
  for (const id of ['first', 'second']) {
    const job = { dir: await mkdtemp(join(dir, `${id}-`)), input, checks: [], fixCount: 0 };
    const plan = await pipeline.story(job, { metas });
    assert.equal(plan.story.scenes.length, 5);
    assert.equal(plan.story.texts.find(text => text.textId === 'store-location').text, '숭실대 정문 앞 골목');
    assert.equal(plan.story.texts.find(text => text.textId === plan.story.chatCountdown.room).text, '점심시간 상도동 단톡방');
    assert.ok(plan.story.scenes[2].photoIds.includes('store-exterior'));
    assert.deepEqual(plan.story.scenes[3].photoIds, ['tea-2']);
    const scene = await pipeline.scenes(job, { story: plan });
    await pipeline.merge(job, { story: plan, scene });
    assert.deepEqual(job.checks.map(check => check.passed), [true]);
  }
  assert.deepEqual(stages, ['HCX-007', 'Claude', 'render', 'HCX-007', 'Claude', 'render']);
});

test('consensus plans represent different selected menus before taking another photo from the hero menu', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'promo-mixed-plan-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const references = loadReferences();
  const menus = ['유자차', '소금빵', '말차 라떼'].map((name, i) => ({ menuId: `menu-${i}`, names: { ko: name } }));
  const photos = ['tea-1', 'tea-2', 'tea-3', 'tea-4', 'tea-5', 'bread-1', 'latte-1'];
  const ids = new Map(photos.map((id, i) => [id, menus[i < 5 ? 0 : i - 4].menuId]));
  const pipeline = createPipeline({ references, templates: loadPlanningTemplates(), music: [], cacheDir: dir, runner: { run: async ({ schema }) => ({
    output: { variantId: schema.properties.variantId.enum[0], heroPhotoId: 'tea-1', feature: '', price: '', limitedOffer: '',
      hook: 'pull-out', order: 'hero-first', copyAngle: 'menu-name' },
  }) }, photoSource: { listCatalog: () => ({ store: { name: '미학당', location: '숭실대입구역', exteriorPhotoId: 'store-exterior' }, menus }),
    photoInfo: id => ({ width: 1080, height: 1920, menuId: ids.get(id) }) } });
  const job = { dir, input: { referenceId: 'ref-18', locale: 'ko', lengthSec: 10, menuIds: menus.map(m => m.menuId),
    photoIds: photos, moods: ['warm'], concepts: ['new-item'] } };
  const metas = photos.map((photoId, i) => ({ photoId, menuShown: 'main', quality: i < 5 ? 'good' : 'fair', kind: 'detail', amount: 'one' }));
  const { story } = await pipeline.story(job, { metas });
  const picturedMenus = new Set(story.scenes.flatMap(scene => scene.photoIds).map(id => ids.get(id)).filter(Boolean));
  assert.deepEqual(picturedMenus, new Set(menus.map(menu => menu.menuId)));
});

test('rejects uniform pacing and repeated moves even when there is a different color each shot', () => {
  const scenes = Array.from({ length: 4 }, (_, i) => ({ sceneId: `s${i + 1}`, start: i * 2.5, duration: 2.5,
    motion: { move: 'pan', direction: 'left', editBeats: [] }, textIds: [] }));
  const rules = motion.checkMotionPlan({ lengthSec: 10, creative: { energy: 'fast' }, scenes, texts: [] }).map(v => v.rule);
  for (const rule of ['motion.moveVariety', 'motion.cutCount', 'motion.rhythmVariance']) assert.ok(rules.includes(rule));
});

