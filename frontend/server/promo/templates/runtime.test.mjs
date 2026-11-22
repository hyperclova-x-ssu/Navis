import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadReferences, rangeFor } from '../references.mjs';
import { checkStory } from '../check-story.mjs';
import * as runtime from './runtime.mjs';
import { createExamplePhotoSource } from '../photo-source.mjs';

test('runtime fill cannot invent prices, offers, copy, or gallery template slots', async () => {
  const ref = 'ref-5';
  const loaded = loadReferences();
  const template = JSON.parse(await readFile(new URL('ref-5.json', import.meta.url), 'utf8'));
  const input = { referenceId: ref, lengthSec: 10, locale: 'ko', moods: ['warm'] };
  const context = {
    input, rules: loaded.rules, range: rangeFor(loaded.refs, loaded.rules, ref, input.lengthSec),
    store: { name: '안숭잘부 카페', location: '서울 동작구' },
    photos: [{ photoId: 'latte-01', menuName: '보늬밤 라떼', meta: { kind: 'closeup', menuShown: 'main', quality: 'good' } },
      { photoId: 'latte-02', menuName: '보늬밤 라떼', meta: { kind: 'inhand', menuShown: 'main', quality: 'good' } }],
    exterior: { photoId: 'store-exterior' },
  };
  const choices = runtime.templateChoices(template, context);
  assert.ok(choices.variants.length >= 2);
  assert.equal(choices.facts.price, '');
  assert.equal(choices.facts.limitedOffer, '');
  const fill = { variantId: choices.variants[0].id, feature: choices.features[0], price: '', limitedOffer: '' };
  assert.throws(() => runtime.fillTemplate(template, context, { ...fill, price: '100원' }), { code: 'AI_BAD_OUTPUT' });
  assert.throws(() => runtime.fillTemplate(template, context, { ...fill, feature: '맛집 1위' }), { code: 'AI_BAD_OUTPUT' });
  const { story } = runtime.fillTemplate(template, context, fill);
  assert.equal(story.scenes.at(-1).start + story.scenes.at(-1).duration, 10);
  assert.deepEqual(checkStory(story, { ...context, ...input, selectedPhotoIds: ['latte-01', 'latte-02'] }), []);
  assert.match(JSON.stringify(story.texts), /보늬밤 라떼/);
  assert.doesNotMatch(JSON.stringify(story.texts), /100원|맛집 1위/);
});

test('planning uses the selected authored directions and duration with the selected photos', () => {
  const loaded = loadReferences();
  const { references, directives } = runtime.loadPlanningTemplates();
  const template = references.get('ref-5');
  const input = { referenceId: 'ref-5', lengthSec: 15, locale: 'ko', moods: ['warm'], concepts: ['day-at-shop'], memo: '매장 한 컷' };
  const ctx = { input, directives, store: { name: '안숭잘부 카페', location: '서울 동작구' },
    exterior: { photoId: 'store-exterior' }, rules: loaded.rules, range: rangeFor(loaded.refs, loaded.rules, 'ref-5', 15),
    photos: [{ photoId: 'latte-01', menuName: '보늬밤 라떼', meta: { kind: 'other' } }] };
  const request = runtime.templateSlotRequest(template, ctx);
  for (const value of ['day-at-shop', '장 한 컷', '15', '보늬밤 라떼', '서울 동작구', 'ctaPlacement', 'latte-01']) {
    assert.ok(request.prompt.includes(value), value);
  }
  const { story } = runtime.fillTemplate(template, ctx, {
    variantId: request.schema.properties.variantId.enum[0], feature: '', price: '', limitedOffer: '',
  });
  assert.equal(story.scenes.at(-1).duration, 3);
  assert.ok(story.scenes.some(scene => scene.photoIds.includes('latte-01')));
  assert.equal(story.scenes.at(-1).start + story.scenes.at(-1).duration, 15);
  assert.deepEqual(checkStory(story, { ...ctx, ...input, selectedPhotoIds: ['latte-01'] }), []);
});

test('template captions support all four widget locales with the Korean store name preserved on the end card', () => {
  const loaded = loadReferences();
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const { store, menus } = source.listCatalog();
  store.location = store.location.split(' (')[0];
  loaded.rules.photo.exteriorId = store.exteriorPhotoId;
  const menu = menus.find(item => item.menuId === 'm-chestnut-latte');
  const templates = runtime.loadTemplates();
  for (const [referenceId, template] of templates) {
    for (const variant of template.variants) {
      for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant']) {
        const { lengthSec } = variant;
        const input = { referenceId, lengthSec, locale };
        const photos = menu.photoIds.map(photoId => ({ photoId, menuName: menu.names[locale], meta: { kind: 'closeup' } }));
        const ctx = { input, photos, store, exterior: { photoId: store.exteriorPhotoId },
          rules: loaded.rules, range: rangeFor(loaded.refs, loaded.rules, referenceId, lengthSec) };
        const { story } = runtime.fillTemplate(template, ctx, { variantId: variant.id, feature: '', price: '', limitedOffer: '' });
        const check = checkStory(story, { ...ctx, ...input, selectedPhotoIds: menu.photoIds });
        assert.deepEqual(check, [], `${referenceId}/${variant.id}/${locale}`);
      }
    }
  }
});
