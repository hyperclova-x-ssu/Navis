import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStory, linesNeeded, makeCounter } from '../check-story.mjs';
import { rangeFor } from '../references.mjs';
import { STORE, refs, rules, storyCtx, validStory } from './helpers.mjs';

const rulesOf = list => list.map(v => v.rule);
const mutate = fn => { const s = validStory(); fn(s); return checkStory(s, storyCtx()); };

test('올바른 장면 구성은 위반 0', () => {
  assert.deepEqual(checkStory(validStory(), storyCtx()), []);
});

test('글자 세기(ko, D-83: 이번 작업은 한국어만): 전각 1, 숫자·영문·공백 0.5', () => {
  const count = makeCounter(rules);
  assert.equal(count('휘낭시에', 'ko'), 4);
  assert.equal(count('3개 남음', 'ko'), 4); // 3(.5) 개(1) 공백(.5) 남음(2)
  assert.equal(count('ABC 휘낭시에', 'ko'), 6);
  assert.equal(count(STORE.location, 'ko'), 21);
  // cap 14자 × 2줄: 28자까지, \n으로 나눈 부분마다 줄을 셈
  assert.equal(linesNeeded('가'.repeat(14), 14, s => count(s, 'ko')), 1);
  assert.equal(linesNeeded('가'.repeat(15), 14, s => count(s, 'ko')), 2);
  assert.equal(linesNeeded('가나\n다라\n마', 14, s => count(s, 'ko')), 3);
  assert.deepEqual(rulesOf(mutate(s => { s.texts[0].text = '가'.repeat(29); })), ['text.length']);
  assert.deepEqual(rulesOf(mutate(s => { s.texts[0].text = '가'.repeat(28); })), []);
  assert.deepEqual(rulesOf(mutate(s => { s.texts[0].text = '가나\n다라\n마'; })), ['text.length']);
});

test('장면 수 범위·길이 합·장면당 최소 시간·엔딩 길이', () => {
  const range = rangeFor(refs.refs, rules, 'ref-1', 10);
  assert.deepEqual(range.sceneCount, { min: 3, max: 5 });
  assert.ok(rulesOf(mutate(s => { s.scenes = s.scenes.slice(1); s.scenes[0].start = 0; s.scenes[0].duration = 7.5; s.scenes[1].start = 7.5; })).includes('story.sceneCount'));
  assert.ok(rulesOf(mutate(s => { s.scenes[1].duration = 3; s.scenes[2].start = 7; })).includes('story.duration'));
  assert.ok(rulesOf(mutate(s => { s.scenes[0].duration = 0.5; s.scenes[1].start = 0.5; s.scenes[1].duration = 7; })).includes('story.minScene'));
  assert.ok(rulesOf(mutate(s => { s.scenes[1].duration = 4.5; s.scenes[2].start = 8.5; s.scenes[2].duration = 1.5; })).includes('story.ending'));
  assert.ok(rulesOf(mutate(s => { s.scenes[1].start = 3; })).includes('story.sceneStart'));
});

test('사진 규칙: 고른 사진·외관만, 최대 2번, 이웃 금지, 다 쓰기 전 재사용 금지, 자리 수', () => {
  assert.deepEqual(rulesOf(mutate(s => { s.scenes[0].photoIds = ['fin-09']; })).filter(r => r.startsWith('story.photo')), ['story.photoUnknown']);
  assert.ok(rulesOf(mutate(s => { s.scenes[1].photoIds = ['fin-01']; })).includes('story.photoAdjacent'));
  // 4장면: fin-01이 1·3에서 재사용 — 고른 5장 중 자리 3을 다 쓰기 전이라 위반
  const four = () => {
    const s = validStory();
    s.scenes = [
      { sceneId: 's1', start: 0, duration: 2, photoIds: ['fin-01'], textIds: ['t1'], direction: '' },
      { sceneId: 's2', start: 2, duration: 2, photoIds: ['fin-02'], textIds: ['t2'], direction: '' },
      { sceneId: 's3', start: 4, duration: 3.5, photoIds: ['fin-01'], textIds: [], direction: '' },
      { sceneId: 's4', start: 7.5, duration: 2.5, photoIds: ['store-exterior'], textIds: ['t3', 'store-name', 'store-location'], direction: '' },
    ];
    s.texts.find(t => t.textId === 't3').sceneIds = ['s4'];
    s.texts.find(t => t.textId === 'store-name').sceneIds = ['s4'];
    s.texts.find(t => t.textId === 'store-location').sceneIds = ['s4'];
    return s;
  };
  assert.ok(rulesOf(checkStory(four(), storyCtx())).includes('story.photoReuseEarly'));
  const many = four(); many.scenes[2].photoIds = ['fin-03', 'fin-04'];
  assert.ok(rulesOf(checkStory(many, storyCtx())).includes('story.photoSlots'));
  const triple = four(); triple.scenes[0].photoIds = ['fin-01', 'fin-02', 'fin-03']; triple.scenes[1].photoIds = ['fin-04']; triple.scenes[2].photoIds = ['fin-01'];
  const ctx = storyCtx({ range: { ...rangeFor(refs.refs, rules, 'ref-1', 10), photoSlots: 5 }, selectedPhotoIds: ['fin-01', 'fin-02', 'fin-03', 'fin-04'] });
  assert.deepEqual(rulesOf(checkStory(triple, ctx)).filter(r => r.startsWith('story.photo')), []);
  // 외관은 재사용 예외
  assert.deepEqual(rulesOf(mutate(s => { s.scenes[1].photoIds = ['fin-02', 'store-exterior']; })), []);
});

test('이모지·제어 문자·언어·금지 낱말', () => {
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = '맛있어요 😀'; })).includes('text.emoji'));
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = '맛있어요​'; })).includes('text.control'));
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = '초콜릿 올라\uFFFD 마지막'; })).includes('text.control'), 'U+FFFD');
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = 'Fresh butter'; })).includes('text.language'));
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = '네이버에서 만나요'; })).includes('text.banned'));
  assert.ok(rulesOf(mutate(s => { s.texts[0].text = '코드 ABC1234 입력'; })).includes('text.banned'));
  // 구조는 4개 언어(D-83: 시험은 ko만)
  const en = validStory({ locale: 'en' });
  assert.ok(rulesOf(checkStory(en, storyCtx({ locale: 'en' }))).includes('text.language'));
});

test('엔딩: 가게 이름·위치가 마지막 장면에 카탈로그와 똑같이', () => {
  assert.ok(rulesOf(mutate(s => { s.texts.find(t => t.textId === 'store-name').text = '미학당 카페'; })).includes('ending.mismatch'));
  assert.ok(rulesOf(mutate(s => { s.scenes[2].textIds = ['t3', 'store-name']; s.texts = s.texts.filter(t => t.textId !== 'store-location'); })).includes('ending.missing'));
  assert.ok(rulesOf(mutate(s => { s.scenes[2].textIds = ['t3', 'store-location']; s.scenes[1].textIds.push('store-name'); s.texts.find(t => t.textId === 'store-name').sceneIds = ['s2']; })).includes('ending.missing'));
  assert.ok(rulesOf(mutate(s => { s.ending = {}; })).includes('ending.missing'));
});
