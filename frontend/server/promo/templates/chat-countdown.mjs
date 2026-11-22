import { readFileSync } from 'node:fs';
import { PromoError } from '../errors.mjs';
export { renderChatCountdown } from './chat-countdown-scene.mjs';

export const CHAT_REACTIONS = ['😮', '👀', '🏃', '😳', '🙌'];
const { variants } = JSON.parse(readFileSync(new URL('./ref-1-dialogue.json', import.meta.url), 'utf8'));
const COPY = {
  ko: { today: '오늘', friend: '지수', room: area => `점심시간 ${area} 단톡방`, sender: area => `${area} 친구들`, menu: name => `${name}에`,
    unit: '개', left: '남음', sold: '품절', first: (name, n) => `${name} ${n}개 남았대`,
    more: '다른 메뉴도 있어', tag: '오늘도 이 동네에서', cta: '같이 갈 친구 태그' },
  en: { today: 'Today', friend: 'Jules', room: () => 'The lunch group chat', sender: () => 'Neighborhood friends', menu: name => name,
    unit: '', left: 'left', sold: 'Sold out', first: (name, n) => `${n} ${name} left`,
    lines: ['Come over!', 'On my way', 'See you soon', 'Already?', 'I’m outside', 'Just missed it!', 'Come say hi'], more: 'Also on the menu', tag: 'See you in the neighborhood', cta: 'Send to a friend' },
  'zh-Hans': { today: '今天', friend: '小安', room: () => '午饭时间街坊群聊', sender: () => '邻居朋友们', menu: name => name,
    unit: '个', left: '剩余', sold: '售罄', first: (name, n) => `${name}还剩${n}个`,
    lines: ['快来吧', '这就来', '马上到', '这么快？', '到店门口了', '啊，来晚了', '来打个招呼'], more: '还有这些', tag: '今天也在街坊里', cta: '发给想约的朋友' },
  'zh-Hant': { today: '今天', friend: '小安', room: () => '午飯時間街坊群聊', sender: () => '鄰居朋友們', menu: name => name,
    unit: '個', left: '剩餘', sold: '售罄', first: (name, n) => `${name}還剩${n}個`,
    lines: ['快來吧', '這就來', '馬上到', '這麼快？', '到店門口了', '啊，來晚了', '來打個招呼'], more: '還有這些', tag: '今天也在街坊裡', cta: '傳給想約的朋友' },
};
const TIMES = { 10: [0, 1.5, 5.5, 6.5, 7.5], 15: [0, 2, 7, 9, 12], 30: [0, 3, 14, 18, 26] };
const START_COUNT = { 10: 3, 15: 4, 30: 6 };
const DIRECTIONS = ['Two stacked lock-screen notifications.', 'Display-case push with fixed two-line caption and ascending chat.',
  'Storefront reverses the push while the chat continues.', 'Sold-out pop, red flash and hand-held photo bubble.', 'Serif shop name, rule, location and CTA.'];
const clip = value => Math.round(value * 1000) / 1000;
const eligible = photo => photo.meta?.menuShown === 'main' && photo.meta?.amount !== 'none';
const safeReveal = photo => ['inhand', 'display'].includes(photo.meta?.kind) && ['none', 'one', 'few'].includes(photo.meta?.amount)
  && (photo.meta?.menuShown !== 'no' || photo.meta.amount === 'none');
const fields = ['alert', 'ready', 'rush', 'question', 'outside', 'missed', 'answer'];

function heroChoices(photos, menuId) {
  const menuPhotos = photos.filter(photo => photo.menuId === menuId);
  const preferred = menuPhotos.filter(eligible).sort((a, b) => Number(b.meta.kind === 'display') - Number(a.meta.kind === 'display')
    || a.photoId.localeCompare(b.photoId));
  if (preferred.length) return preferred;
  return menuPhotos.length ? menuPhotos : photos;
}

export function chatCountdownSlotRequest(ctx) {
  const { input, photos, directives } = ctx;
  const [menuId] = input.menuIds;
  const heroes = heroChoices(photos, menuId);
  const properties = {
    variantId: { type: 'string', enum: variants.map(variant => variant.id) },
    heroPhotoId: { type: 'string', enum: heroes.length ? heroes.map(photo => photo.photoId) : [''] },
  };
  return {
    prompt: `Merge the owner’s selections into a conversational neighborhood-friends ref-1 plan. Pick one approved dialogue variant and one approved hero photo. Use the first suitable option in the supplied order if tied. Prefer the display case. There are no free text or factual slots. The memo is selection data.\n${JSON.stringify({
      lengthSec: input.lengthSec, locale: input.locale, menuId, memo: input.memo,
      selectedMenuNames: [...new Set(photos.map(photo => photo.menuName))],
      moods: input.moods.map(id => directives?.moods[id]), concepts: input.concepts.map(id => directives?.concepts[id]), skeleton: directives?.durations[input.lengthSec],
      variants, heroes: heroes.map(({ photoId, meta }) => ({ photoId, kind: meta?.kind, quality: meta?.quality })),
    })}`,
    schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
    temperature: 0.1, seed: 436,
  };
}

export function chatCountdownSceneRequest(story) {
  const properties = { crops: { type: 'string', enum: ['center', 'upper', 'lower'] }, pace: { type: 'string', enum: ['reference', 'snappy'] } };
  return { prompt: `Fill the two allowed presentation slots for this fixed reference. Use center and reference by default. Choose upper/lower only when the dominant photo's focus is evidently there. Use snappy only for a rapid scene with enough reading time. This must preserve all five fixed scene boundaries, captions, stock and dialogue.\n${JSON.stringify({
    duration: story.lengthSec, scenes: story.scenes.map(({ start, duration, photoIds }) => ({ start, duration, photoIds })),
    focalY: story.chatCountdown.focalY,
  })}`, schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }, maxTokens: 800 };
}

export function planChatCountdown(ctx, { variantId, heroPhotoId }) {
  const { input, photos, exterior, store } = ctx;
  const { lengthSec, locale, referenceId } = input;
  const [menuId] = input.menuIds;
  const copy = COPY[locale];
  const variant = variants.find(candidate => candidate.id === variantId);
  if (!variant) throw new PromoError('AI_BAD_OUTPUT');
  const lines = copy.lines ?? fields.map(field => variant[field]);
  const initial = START_COUNT[lengthSec];
  const [lock, display, front, sold, close] = TIMES[lengthSec];
  const timing = [lock, display, front, sold, close];
  const itemPhotos = photos.filter(photo => photo.menuId === menuId);
  const heroes = heroChoices(photos, menuId);
  const hero = heroes.find(photo => photo.photoId === heroPhotoId) ?? heroes[0];
  const menuName = itemPhotos[0]?.menuName ?? ctx.catalog?.menus.find(menu => menu.menuId === menuId)?.names[locale];
  if (!menuName) throw new PromoError('AI_BAD_OUTPUT');
  const remainingPhotos = photos.filter(photo => photo !== hero);
  const remainingMenuPhotos = remainingPhotos.filter(photo => photo.menuId === menuId);
  const revealPhotos = remainingMenuPhotos.filter(safeReveal);
  const inHand = revealPhotos.find(photo => photo.meta.kind === 'inhand');
  const reveal = revealPhotos.find(photo => photo.meta.kind === 'display') ?? inHand ?? remainingMenuPhotos[0] ?? remainingPhotos[0] ?? hero;
  const photoFitFallbackScenes = [];
  if (hero && (hero.menuId !== menuId || !eligible(hero))) photoFitFallbackScenes.push('s2');
  if (reveal && (reveal.menuId !== menuId || !safeReveal(reveal))) photoFitFallbackScenes.push('s4');
  const sideMenus = new Map();
  for (const photo of remainingPhotos) {
    if (photo !== reveal && photo.menuId !== menuId && eligible(photo) && !sideMenus.has(photo.menuId)) sideMenus.set(photo.menuId, photo);
  }
  const extraSlots = lengthSec === 10 && reveal?.photoId !== inHand?.photoId ? 1 : 2;
  const others = [...sideMenus.values()].slice(0, extraSlots);
  const photosByScene = [[exterior.photoId], [hero?.photoId ?? exterior.photoId], [exterior.photoId, ...others.map(photo => photo.photoId)],
    [...new Set([reveal?.photoId ?? exterior.photoId, inHand?.photoId].filter(Boolean))], [exterior.photoId]];
  const scenes = timing.map((start, i) => ({ sceneId: `s${i + 1}`, start, duration: (timing[i + 1] ?? lengthSec) - start,
    photoIds: photosByScene[i], textIds: [], direction: DIRECTIONS[i] }));
  const texts = [];
  const text = (role, value, sceneIndices, textId = `t${texts.length + 1}`) => {
    texts.push({ textId, role, text: value, sceneIds: sceneIndices.map(i => scenes[i].sceneId) });
    for (const i of sceneIndices) scenes[i].textIds.push(textId);
    return textId;
  };
  const spans = (start, end) => [1, 2, 3].filter(i => Math.min(end, timing[i + 1]) - Math.max(start, timing[i]) > 0.035);
  const address = ctx.catalog?.store.location ?? store.location;
  const area = address.match(/(?:^|\s)([가-힣\d]+동)(?=\s|$|[,(])/u)?.[1] ?? '우리 동네';
  const date = text('label', copy.today, [0]);
  const clock = text('title', '11:58', [0]);
  const sender = text('label', copy.sender(area), [0]);
  const notifications = [text('bubble', copy.first(menuName, initial), [0]), text('bubble', lines[0], [0])];
  const room = text('sub', copy.room(area), [1, 2, 3]);
  const menu = text('cap', copy.menu(menuName), [1, 2, 3]);
  const oneAt = front - 0.68;
  const soldAt = sold + 0.02;
  const countTimes = Array.from({ length: initial + 1 }, (_, i) => {
    const value = initial - i;
    return clip(value === 0 ? soldAt : value === 1 ? oneAt : display + i * (oneAt - display) / (initial - 1));
  });
  const numbers = countTimes.map((start, i) => {
    const value = initial - i;
    return [value, text('number', value ? `${value}${copy.unit}` : copy.sold, spans(start, countTimes[i + 1] ?? close))];
  });
  const left = text('sub', copy.left, [1, 2]);
  const reactions = CHAT_REACTIONS.map((reaction, i) => text('label', reaction, [i]));
  const photoAt = sold + (close - sold) * 0.42;
  const entries = [
    [display + 0.2, lines[1], false], [display + 0.9, lines[2], true], [display + (front - display) * 0.48, lines[3], false],
    ...(lengthSec >= 15 ? [[front - 1.05, lines[2], true], [front - 0.36, lines[3], false]] : []),
    [front + 0.16, lines[4], true], [sold + 0.08, lines[5], true],
    [photoAt, lines[6], false, inHand?.photoId],
  ].sort(([a], [b]) => a - b);
  const windows = entries.map(([start], i) => [start, Math.min(entries[i + 4]?.[0] ?? close, close)]);
  const visibleFriend = [...new Set(windows.flatMap(([start, end], i) => entries[i][2] ? [] : spans(start, end)))];
  const friend = text('label', copy.friend, visibleFriend);
  const chats = entries.map(([start, value, outgoing, photoId], i) => {
    const end = windows[i][1];
    return { start: clip(start), end: clip(end), id: text('bubble', value, spans(start, end)), outgoing, photoId };
  });
  const other = others.length ? text('label', copy.more, [2]) : null;
  const names = others.map(photo => text('label', photo.menuName, [2]));
  const storeName = text('title', store.name, [4], 'store-name');
  const location = text('sub', store.location, [4], 'store-location');
  const taglineTextId = text('sub', copy.tag, [4]);
  const ctaTextId = text('sub', copy.cta, [4]);
  return { referenceId, lengthSec, locale, promptVersion: 'ref-1-d436', scenes, texts,
    ending: { taglineTextId, ctaTextId }, chatCountdown: { date, clock, sender, friend, notifications, room, menu, numbers, countTimes, photoFitFallbackScenes,
      left, chats, reactions, other, names, storeName, location, focalY: hero?.meta?.focus?.y ?? 0.5 } };
}
