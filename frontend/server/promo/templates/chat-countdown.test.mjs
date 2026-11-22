import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStory } from '../check-story.mjs';
import { staticCheck } from '../check-scene.mjs';
import { loadReferences, rangeFor } from '../references.mjs';
import { chatCountdownSlotRequest, planChatCountdown, renderChatCountdown } from './chat-countdown.mjs';

const refData = loadReferences();
const ref = refData.refs.get('ref-1');
const photo = (photoId, kind, amount) => ({ photoId, menuId: 'm-strawberry-cake', menuName: '딸기 케이크', meta: { kind, amount, menuShown: 'main' } });
const photos = [photo('cake-1', 'display', 'many'), photo('cake-2', 'inhand', 'one')];
const store = { name: '안숭잘부 카페', location: '서울 동작구 상도동 999-12' };

test('counts down the first selected drink even with missing photo analysis and legacy stock for another menu', () => {
  const coffee = { photoId: 'coffee-1', menuId: 'm-americano', menuName: '아메리카노' };
  const selected = [coffee, ...photos];
  const input = { referenceId: 'ref-1', locale: 'ko', lengthSec: 10, menuIds: [coffee.menuId, photos[0].menuId], moods: [], concepts: [] };
  const ctx = { input, photos: selected, store, rules: refData.rules, exterior: { photoId: 'store-exterior' } };
  assert.deepEqual(chatCountdownSlotRequest(ctx).schema.properties.heroPhotoId.enum, [coffee.photoId]);
  const story = planChatCountdown({ ...ctx, countdownStock: { menuId: photos[0].menuId, remaining: 2 } },
    { variantId: 'meet-after-class', heroPhotoId: coffee.photoId });
  assert.deepEqual(story.chatCountdown.numbers.map(([n]) => n), [3, 2, 1, 0]);
  assert.deepEqual(story.scenes[1].photoIds, [coffee.photoId]);
  assert.deepEqual(story.scenes[3].photoIds, ['cake-1']);
  assert.ok(story.texts.some(text => text.text === '아메리카노에'));
  const html = renderChatCountdown(story, ref.exampleHtml, { crops: 'center', pace: 'reference' });
  assert.match(html, /data-countdown="0"[^>]*>품절/);
  assert.deepEqual(staticCheck(html, { story, rules: ctx.rules }), []);
  assert.deepEqual(checkStory(story, { rules: ctx.rules, range: { ...rangeFor(refData.refs, ctx.rules, 'ref-1', 10), photoSlots: 4 }, ...input, store,
    selectedPhotoIds: selected.map(p => p.photoId), photoMeta: new Map(selected.map(p => [p.photoId, p.meta])) }), []);

  const withoutDrinkPhoto = { ...ctx, photos, catalog: { menus: [{ menuId: coffee.menuId, names: { ko: '아메리카노' } }], store } };
  assert.deepEqual(chatCountdownSlotRequest(withoutDrinkPhoto).schema.properties.heroPhotoId.enum, ['cake-1', 'cake-2']);
  const borrowed = planChatCountdown(withoutDrinkPhoto, { variantId: 'meet-after-class', heroPhotoId: 'cake-1' });
  assert.deepEqual(borrowed.scenes[1].photoIds, ['cake-1']);
  assert.deepEqual(borrowed.scenes[3].photoIds, ['cake-2']);
  assert.ok(borrowed.texts.some(text => text.text === '아메리카노에'));
});

test('uses fixed 3/4/6 starting numbers and the fixed two-line ref-1 caption', () => {
  for (const [lengthSec, initial] of [[10, 3], [15, 4], [30, 6]]) {
    const ctx = { input: { referenceId: 'ref-1', locale: 'ko', lengthSec, menuIds: ['m-strawberry-cake'] },
      photos, store, rules: refData.rules, exterior: { photoId: 'store-exterior' } };
    const story = planChatCountdown(ctx, { variantId: 'meet-after-class', heroPhotoId: 'cake-1' });
    assert.deepEqual(story.chatCountdown.numbers.map(([value]) => value), Array.from({ length: initial + 1 }, (_, i) => initial - i));
    const text = id => story.texts.find(entry => entry.textId === id).text;
    assert.equal(text(story.chatCountdown.room), '점심시간 상도동 단톡방');
    assert.equal(text(story.chatCountdown.menu), '딸기 케이크에');
    assert.match(text(story.chatCountdown.notifications[0]), new RegExp(`${initial}개`));
    assert.deepEqual(checkStory(story, { rules: ctx.rules, range: rangeFor(refData.refs, ctx.rules, 'ref-1', lengthSec), ...ctx.input, store,
      selectedPhotoIds: photos.map(p => p.photoId), photoMeta: new Map(photos.map(p => [p.photoId, p.meta])) }), []);
    const html = renderChatCountdown(story, ref.exampleHtml, { crops: 'center', pace: 'reference' });
    assert.match(html, /class="cap2"/);
    assert.match(html, /class="pbub"/);
    assert.equal([...html.matchAll(/\bdata-reaction=/g)].length, 5);
    assert.deepEqual(staticCheck(html, { story, rules: ctx.rules }), []);
  }
});
