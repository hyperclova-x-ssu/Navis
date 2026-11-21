// T-087 생성 영상 품질 규칙: 규칙마다 위반 하나를 넣은 픽스처가 잡히는지, 레퍼런스 예시 6개가 새 규칙을 통과하는지.
// SMOKE_REPORT 4절 1(장면-사진 맞춤)·2(글자 겹침)·3(빈 장면·정지)·4(전환 중 겹침).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStory } from '../check-story.mjs';
import { runSceneCheck, staticCheck, evaluateObservations } from '../check-scene.mjs';
import { loadReferences, rangeFor } from '../references.mjs';
import { photoAssets } from '../renderer.mjs';
import { sceneFixPrompt, storyPrompt, PHOTO_META_SCHEMA } from '../prompts.mjs';
import { validateSchema } from '../schema.mjs';
import { CHROME_PATH, SELECTED, STORE, photoSource, rules, sceneHtml, storyCtx, validStory } from './helpers.mjs';

const noChrome = CHROME_PATH ? false : 'Chrome 없음';
const rulesOf = v => [...new Set(v.map(x => x.rule))].sort();

// 예시 사진 10장의 사진 정보(T-086 실측 캐시의 kind·items + menuShown·amount 판단). 시험용 고정 값.
const META = {
  'fin-01': { kind: 'table', menuShown: 'main', amount: 'one' },
  'fin-02': { kind: 'display', menuShown: 'partly', amount: 'many' },
  'fin-03': { kind: 'table', menuShown: 'partly', amount: 'one' },
  'fin-04': { kind: 'display', menuShown: 'main', amount: 'many' },
  'fin-05': { kind: 'display', menuShown: 'main', amount: 'few' },
  'fin-06': { kind: 'note', menuShown: 'no', amount: 'none' },
  'fin-07': { kind: 'inhand', menuShown: 'main', amount: 'one' },
  'fin-08': { kind: 'inhand', menuShown: 'main', amount: 'one' },
  'fin-09': { kind: 'display', menuShown: 'partly', amount: 'many' },
  'fin-10': { kind: 'note', menuShown: 'no', amount: 'none' },
};
const ALL = Object.keys(META);
const MENUS = photoSource.listCatalog().menus;
const photoMenu = Object.fromEntries(ALL.map(id => [id, 'financier']));
const fitCtx = (over = {}) => storyCtx({ photoMeta: META, photoMenu, menus: MENUS, selectedPhotoIds: SELECTED, ...over });
const withText = (scene, text, role = 'cap') => {
  const s = validStory();
  s.texts.find(t => t.textId === (scene === 0 ? 't1' : 't2')).text = text;
  s.texts.find(t => t.textId === (scene === 0 ? 't1' : 't2')).role = role;
  return s;
};

test('사진 정보 스키마에 menuShown·amount가 있다', () => {
  assert.deepEqual(PHOTO_META_SCHEMA.properties.menuShown.enum, ['main', 'partly', 'no']);
  assert.deepEqual(PHOTO_META_SCHEMA.properties.amount.enum, ['none', 'one', 'few', 'many']);
  const ok = { kind: 'inhand', subject: 'x', items: [], flavors: [], people: 'hands', textInImage: '', focus: { x: 0.5, y: 0.5 }, captionHints: [], quality: 'good', menuShown: 'main', amount: 'one' };
  assert.deepEqual(validateSchema(PHOTO_META_SCHEMA, ok), []);
  const { amount, ...missing } = ok; void amount;
  assert.ok(validateSchema(PHOTO_META_SCHEMA, missing).length > 0);
});

test('story.photoFit: 품절 장면에 진열대 가득 사진이면 위반, 손에 든 사진이면 통과', () => {
  const bad = withText(1, '휘낭시에 품절'); bad.scenes[1].photoIds = ['fin-04'];
  const v = checkStory(bad, fitCtx({ selectedPhotoIds: ['fin-01', 'fin-04'] }));
  assert.ok(v.some(x => x.rule === 'story.photoFit' && /fin-04:main\/many/.test(x.actual)), JSON.stringify(v));
  const good = withText(1, '누가 다 사 갔는데'); good.scenes[1].photoIds = ['fin-07'];
  assert.deepEqual(rulesOf(checkStory(good, fitCtx({ selectedPhotoIds: ['fin-01', 'fin-07'] }))), []);
});

test('story.photoFit: 남은 수량 장면은 메뉴가 주인공인 사진(마들렌 진열대·커피 사진이면 위반)', () => {
  for (const photo of ['fin-09', 'fin-03']) {
    const s = withText(1, '휘낭시에 4개 남음'); s.scenes[1].photoIds = [photo];
    const v = checkStory(s, fitCtx({ selectedPhotoIds: ['fin-01', photo] }));
    assert.ok(v.some(x => x.rule === 'story.photoFit' && x.limit.startsWith('count-left')), `${photo} ${JSON.stringify(v)}`);
  }
  const ok = withText(1, '남은 수량 2개'); ok.scenes[1].photoIds = ['fin-04'];
  assert.deepEqual(rulesOf(checkStory(ok, fitCtx({ selectedPhotoIds: ['fin-01', 'fin-04'] }))), []);
});

test('story.photoFit: 메뉴 이름을 말하는 자막은 그 메뉴가 보이는 사진(안내 카드 위 금지), 말풍선·사진 정보 없음은 건너뜀', () => {
  const s = withText(1, '오늘의 휘낭시에'); s.scenes[1].photoIds = ['fin-06'];
  const v = checkStory(s, fitCtx({ selectedPhotoIds: ['fin-01', 'fin-06'] }));
  assert.ok(v.some(x => x.rule === 'story.photoFit' && /names 휘낭시에/.test(x.limit)), JSON.stringify(v));
  const bubble = withText(1, '오늘의 휘낭시에', 'bubble'); bubble.scenes[1].photoIds = ['fin-06'];
  assert.deepEqual(rulesOf(checkStory(bubble, fitCtx({ selectedPhotoIds: ['fin-01', 'fin-06'] }))), []);
  assert.deepEqual(rulesOf(checkStory(s, storyCtx({ selectedPhotoIds: ['fin-01', 'fin-06'] }))), [], '사진 정보가 없으면 맞춤 검사 안 함');
});

test('story.sceneText: 엔딩이 아닌 장면에 글자가 없으면 짧은 장면(1.5초 이하)만 허용', () => {
  const s = validStory(); s.scenes[1].textIds = []; s.texts = s.texts.filter(t => t.textId !== 't2');
  assert.deepEqual(rulesOf(checkStory(s, storyCtx())), ['story.sceneText']);
  const short = validStory();
  short.scenes = [
    { sceneId: 's1', start: 0, duration: 1.5, photoIds: ['store-exterior'], textIds: [], direction: '' },
    { sceneId: 's2', start: 1.5, duration: 6, photoIds: ['fin-01'], textIds: ['t1', 't2'], direction: '' },
    { sceneId: 's3', start: 7.5, duration: 2.5, photoIds: ['store-exterior'], textIds: ['t3', 'store-name', 'store-location'], direction: '' },
  ];
  short.texts.find(t => t.textId === 't1').sceneIds = ['s2'];
  assert.deepEqual(rulesOf(checkStory(short, storyCtx())), []);
});

test('레퍼런스 예시 6개의 장면 구성이 새 글자 규칙(장면-사진 맞춤 포함)을 통과', () => {
  const real = loadReferences();
  for (const id of ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6']) {
    const ref = real.refs.get(id); const story = JSON.parse(ref.exampleStory);
    const ctx = { rules: real.rules, range: rangeFor(real.refs, real.rules, id, story.lengthSec), lengthSec: story.lengthSec, locale: 'ko', referenceId: id, selectedPhotoIds: ALL, store: STORE, photoMeta: META, photoMenu, menus: MENUS };
    const v = checkStory(story, ctx).filter(x => x.rule === 'story.photoFit' || x.rule === 'story.sceneText');
    assert.deepEqual(v, [], id);
  }
});

test('고치기 프롬프트에 위반 위치(시각·상자)가 들어간다, 이야기 프롬프트에 맞춤 규칙이 들어간다', () => {
  const v = [{ t: 2.05, textId: 't1', rule: 'text.overlap', limit: 'x', actual: 'photo fin-07 covers 67% of t1 at 90,1300-990,1383' }];
  const p = sceneFixPrompt({ contract: 'C', photos: [], exterior: { photoId: 'store-exterior' } }, validStory(), '<html>', v);
  assert.ok(p.includes('90,1300-990,1383') && p.includes('text.overlap'));
  assert.match(p, /transition\.text/);
  const real = loadReferences();
  const sp = storyPrompt({ input: { lengthSec: 10, moods: ['warm'], concepts: ['new-item'], memo: '', referenceId: 'ref-1', locale: 'ko' }, rules: real.rules, range: rangeFor(real.refs, real.rules, 'ref-1', 10), ref: real.refs.get('ref-1'), store: STORE, photos: [], exterior: {} });
  assert.match(sp, /menuShown/); assert.match(sp, /amount/); assert.match(sp, /1\.5/);
});

// ---- 실행 검사(격리 Chrome) ----
let assets;
const run = async (html, story = validStory()) => {
  assets ??= await photoAssets(photoSource, [...SELECTED, 'store-exterior']);
  const res = await runSceneCheck({ html, story, rules, store: STORE, lengthSec: 10, assets, fonts: [], browserPath: CHROME_PATH });
  return [...staticCheck(html, { story, rules }), ...res.violations];
};

test('실행: 올바른 코드(컷 전환, 움직임 있음)는 새 규칙 위반 0', { skip: noChrome }, async () => {
  assert.deepEqual(await run(sceneHtml({ fade: 0 })), []);
});

test('실행: text.overlap — 사진 썸네일이 자막을 가림(위치가 actual에)', { skip: noChrome }, async () => {
  const v = await run(sceneHtml({ s1Extra: '<img data-photo="fin-01" src="assets/photos/fin-01.jpg" style="position:absolute;left:100px;top:1250px;width:500px;height:300px;z-index:5;object-fit:cover">' }));
  const hit = v.find(x => x.rule === 'text.overlap');
  assert.ok(hit, JSON.stringify(v.slice(0, 5)));
  assert.match(hit.actual, /photo fin-01 covers \d+% of t1 at \d+,\d+-\d+,\d+/);
});

test('실행: text.overlap — 자막끼리 겹침', { skip: noChrome }, async () => {
  const story = validStory();
  story.texts.push({ textId: 't4', role: 'cap', text: '오늘 구움', sceneIds: ['s1'] });
  story.scenes[0].textIds.push('t4');
  const v = await run(sceneHtml({ s1Extra: '<div class="tx" data-text="t4" style="top:1320px">오늘 구움</div>' }), story);
  assert.ok(v.some(x => x.rule === 'text.overlap' && /t1 .* overlaps t4|t4 .* overlaps t1/.test(x.actual)), JSON.stringify(v.slice(0, 5)));
});

test('실행: transition.text — 크로스페이드 중 두 장면 자막이 함께 보임', { skip: noChrome }, async () => {
  const v = await run(sceneHtml({ fade: 0.3 }));
  assert.ok(v.some(x => x.rule === 'transition.text' && /t1\(s1\) with t2\(s2\)/.test(x.actual)), JSON.stringify(v.slice(0, 5)));
  assert.ok(!v.some(x => x.rule === 'transition.length'), '0.3초 전환은 길이 위반 아님');
});

test('실행: transition.length — 0.4초를 넘는 크로스페이드', { skip: noChrome }, async () => {
  const v = await run(sceneHtml({ fade: 0.8 }));
  assert.ok(v.some(x => x.rule === 'transition.length' && /s1→s2/.test(x.actual)), JSON.stringify(v.slice(0, 5)));
});

test('실행: scene.still — 1.5초 넘게 같은 화면(마지막 장면은 제외)', { skip: noChrome }, async () => {
  const v = await run(sceneHtml({ still: true }));
  const still = v.filter(x => x.rule === 'scene.still');
  assert.ok(still.length >= 2, JSON.stringify(v.slice(0, 5)));
  assert.ok(still.every(x => x.sceneId !== 's3'));
});

test('실행: scene.empty — 글자도 움직임도 없는 장면', { skip: noChrome }, async () => {
  const story = validStory();
  story.scenes[1].textIds = []; story.texts = story.texts.filter(t => t.textId !== 't2');
  const v = await run(sceneHtml({ still: true, t2Scene: 'none' }), story);
  assert.ok(v.some(x => x.rule === 'scene.empty' && x.sceneId === 's2'), JSON.stringify(v.slice(0, 6)));
});

test('가짜 관찰: 바깥(장면 밖) 고정 자막은 여러 장면에 걸쳐 있어 transition.text가 아님', () => {
  const story = validStory();
  story.texts.push({ textId: 't9', role: 'sub', text: '고정', sceneIds: ['s1', 's2'] });
  const obs = (current, ids) => ({ current, scenes: {}, sceneOpacity: {}, texts: ids.map(id => ({ id, scene: null, box: { x1: 100, y1: 200 + ids.indexOf(id) * 200, x2: 900, y2: 300 + ids.indexOf(id) * 200 }, rects: [], lines: 1, fontSize: 64, overflow: false, text: story.texts.find(t => t.textId === id).text, cover: { ratio: 0 } })), undeclared: [], photos: [], unmarked: 0, sig: Math.random(), boxes: {} });
  const v = evaluateObservations([{ t: 3.95, kinds: ['grid'], obs: obs('s1', ['t1', 't9']) }, { t: 4.05, kinds: ['grid'], obs: obs('s2', ['t2', 't9']) }], { story, rules, store: STORE });
  assert.ok(!v.some(x => x.rule === 'transition.text'));
});

test('레퍼런스 예시 6개의 코드가 새 장면 규칙을 통과(서버 검사기)', { skip: noChrome, timeout: 120000 }, async () => {
  const real = loadReferences();
  const cat = photoSource.listCatalog();
  for (const id of ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6']) {
    const ref = real.refs.get(id); const story = JSON.parse(ref.exampleStory);
    const a = await photoAssets(photoSource, [...new Set(story.scenes.flatMap(s => s.photoIds))]);
    const res = await runSceneCheck({ html: ref.exampleHtml, story, rules: real.rules, store: { name: cat.store.name, location: cat.store.location }, lengthSec: story.lengthSec, assets: a, fonts: real.fonts, browserPath: CHROME_PATH });
    assert.deepEqual([...staticCheck(ref.exampleHtml, { story, rules: real.rules }), ...res.violations], [], id);
  }
});
