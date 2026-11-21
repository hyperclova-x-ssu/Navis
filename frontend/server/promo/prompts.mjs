// 프롬프트 조립 (ARCHITECTURE 12.4). 원문은 server/promo/prompts/. 메모는 따옴표로 감싼 데이터 필드로만 넣는다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ROLES } from './check-story.mjs';

export const PROMPT_VERSION = 'p3';
export const META_SCHEMA_VERSION = 2;
const dir = fileURLToPath(new URL('./prompts/', import.meta.url));
const read = name => readFileSync(join(dir, name), 'utf8');
const templates = {
  photoMeta: read('photo-meta.md'), story: read('story.md'), storyRewrite: read('story-rewrite.md'),
  sceneCode: read('scene-code.md'), sceneFix: read('scene-fix.md'),
};
export const CONCEPTS = ['review-roundup', 'behind-the-scenes', 'todays-deal', 'new-item', 'day-at-shop'];
const conceptText = Object.fromEntries(CONCEPTS.map(id => [id, read(`concept-${id}.md`).trim()]));
export const MOODS_FILE = JSON.parse(read('moods.json'));
export const MOODS = MOODS_FILE.order;
const LOCALE_NAMES = { ko: 'Korean (한국어)', en: 'English', 'zh-Hans': 'Simplified Chinese (简体中文)', 'zh-Hant': 'Traditional Chinese (繁體中文)' };
// Motion and layout from the reference briefs, without their sample copy.
const STORY_STYLES = {
  'ref-1': 'Stack rounded cards over the exterior, push slowly into a menu photo, cut back to the exterior, show a detail, then fade into the closing card.',
  'ref-2': 'Open with a closeup, then use rounded photo cards on a light background with short caption bubbles sliding up.',
  'ref-3': 'Open on the exterior, then slowly pan full-bleed photos in alternating directions, with a short caption near the bottom.',
  'ref-4': 'Use full-bleed detail shots, quick cuts, a bold opening caption, and a dark closing card.',
  'ref-5': 'Slide photo cards across soft backgrounds and fill the next dot on a vertical timeline at each cut.',
  'ref-6': 'Drop tilted instant-photo cards onto a cream background. Place the caption in the lower margin of each card.',
};

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? String(vars[key]) : ''));
const json = v => JSON.stringify(v);

export const PHOTO_META_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'subject', 'items', 'flavors', 'people', 'textInImage', 'focus', 'captionHints', 'quality', 'menuShown', 'amount'],
  properties: {
    kind: { type: 'string', enum: ['display', 'closeup', 'inhand', 'table', 'note', 'other'] },
    subject: { type: 'string', maxLength: 120 },
    items: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 40 } },
    flavors: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
    people: { type: 'string', enum: ['none', 'hands', 'staff', 'customer'] },
    textInImage: { type: 'string', maxLength: 120 },
    focus: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } } },
    captionHints: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 60 } },
    quality: { type: 'string', enum: ['good', 'dark', 'blurry'] },
    menuShown: { type: 'string', enum: ['main', 'partly', 'no'] },
    amount: { type: 'string', enum: ['none', 'one', 'few', 'many'] },
  },
};

export const STORY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scenes', 'texts', 'ending'],
  properties: {
    scenes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['sceneId', 'start', 'duration', 'photoIds', 'textIds', 'direction'], properties: {
      sceneId: { type: 'string', pattern: '^s[0-9]{1,2}$' }, start: { type: 'number', minimum: 0 }, duration: { type: 'number', minimum: 0 },
      photoIds: { type: 'array', maxItems: 4, items: { type: 'string', pattern: '^[a-z0-9-]{1,32}$' } },
      textIds: { type: 'array', maxItems: 40, items: { type: 'string', pattern: '^(t[0-9]{1,3}|store-name|store-location)$' } },
      direction: { type: 'string', maxLength: 200 },
    } } },
    texts: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', additionalProperties: false, required: ['textId', 'role', 'text', 'sceneIds'], properties: {
      textId: { type: 'string', pattern: '^(t[0-9]{1,3}|store-name|store-location)$' }, role: { type: 'string', enum: ROLES },
      text: { type: 'string', minLength: 1, maxLength: 200 }, sceneIds: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^s[0-9]{1,2}$' } },
    } } },
    ending: { type: 'object', additionalProperties: false, required: ['taglineTextId'], properties: { taglineTextId: { type: 'string' }, ctaTextId: { type: 'string' } } },
  },
};

export const SCENE_SCHEMA = { type: 'object', additionalProperties: false, required: ['html'], properties: { html: { type: 'string', minLength: 1, maxLength: 70000 } } };

/** 사진이 등록된 메뉴 이름(영어)을 데이터로 넣는다. 메뉴가 주인공인지(menuShown)만 그 이름으로 판단한다. */
export function photoMetaPrompt(menuName = '') { return fill(templates.photoMeta, { menuJson: json(menuName || 'unknown') }); }

const roleLimits = (rules, locale) => ROLES.filter(r => rules.roles[r]).map(r => `${r} ${locale === 'en' ? rules.roles[r].perLine.en : rules.roles[r].perLine.cjk}×${rules.roles[r].maxLines}`).join(', ');
const roleSizes = rules => ROLES.filter(r => rules.roles[r]).map(r => `${r} ${rules.roles[r].fontPx}px`).join(', ');

/** ctx: {input, rules, range, store, photos[{photoId, menuName, width, height, meta}], exterior} */
export function storyPrompt(ctx, rewrite) {
  const { input, rules, range, store } = ctx;
  const moods = MOODS.filter(m => input.moods.includes(m)).map(m => MOODS_FILE.moods[m]).join(' / ');
  const concepts = CONCEPTS.filter(c => input.concepts.includes(c)).map(c => `- ${conceptText[c]}`).join('\n');
  let text = fill(templates.story, {
    lengthSec: input.lengthSec, sceneMin: range.sceneCount.min, sceneMax: range.sceneCount.max, minSceneSec: range.minSceneSec, minSceneSecFirst: range.minSceneSecFirst ?? range.minSceneSec, endingSec: range.endingSec,
    exteriorId: rules.photo.exteriorId, photoSlots: range.photoSlots, maxUses: rules.photo.maxUses,
    localeName: LOCALE_NAMES[input.locale], locale: input.locale, roleLimits: roleLimits(rules, input.locale),
    storeNameJson: json(store.name), storeLocationJson: json(store.location), referenceId: input.referenceId,
    referenceStyle: STORY_STYLES[input.referenceId], moods, concepts, memoJson: json(input.memo),
    photosJson: json(ctx.photos.map(p => ({
      id: p.photoId, menu: p.menuName, width: p.width, height: p.height,
      observations: { kind: p.meta?.kind, amount: p.meta?.amount, menuShown: p.meta?.menuShown },
    }))),
    exteriorJson: json(ctx.exterior),
    textlessMaxSec: rules.scene?.textlessMaxSec ?? 1.5, transitionMaxSec: rules.transition?.maxSec ?? 0.4,
  });
  if (rewrite) text += fill(templates.storyRewrite, { violationsJson: json(rewrite.violations), previousJson: json(rewrite.previous) });
  return text;
}

const photoList = ctx => json([...ctx.photos, ctx.exterior].map(p => ({ id: p.photoId, width: p.width, height: p.height, focus: p.meta?.focus ?? { x: 0.5, y: 0.5 } })));

export function sceneCodePrompt(ctx, story) {
  const { rules, ref, contract } = ctx;
  return fill(templates.sceneCode, {
    contract, referenceId: ref.id, brief: ref.brief, exampleHtml: ref.exampleHtml, exampleStory: ref.exampleStory,
    safeX1: rules.safeBox.x1, safeX2: rules.safeBox.x2, safeY1: rules.safeBox.y1, safeY2: rules.safeBox.y2, minFontPx: rules.minFontPx,
    roleSizes: roleSizes(rules), storyJson: json(story), photosJson: photoList(ctx), lengthSec: story.lengthSec,
  });
}

export function sceneFixPrompt(ctx, story, previousHtml, violations) {
  return fill(templates.sceneFix, {
    violationsJson: json(violations.slice(0, 60)), contract: ctx.contract, storyJson: json(story), photosJson: photoList(ctx), previousHtml,
    transitionMaxSec: ctx.rules?.transition?.maxSec ?? 0.4,
  });
}
