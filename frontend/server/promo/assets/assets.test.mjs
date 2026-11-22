import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PHOTO_META_SCHEMA } from '../prompts.mjs';
import { validateSchema } from '../schema.mjs';
import { chatCountdownSlotRequest, planChatCountdown } from '../templates/chat-countdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/data/marketing/promo-catalog.json'), 'utf8'));
const music = JSON.parse(fs.readFileSync(path.join(here, 'music/music.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const jpegSize = (f) => {
  const b = fs.readFileSync(f);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error('no SOF');
};

test('카탈로그 스키마', () => {
  assert.equal(catalog.version, 1);
  assert.equal(catalog.store.name, '미학당');
  assert.equal(catalog.store.exteriorPhotoId, 'store-exterior');
  assert.deepEqual(catalog.menus.map((m) => m.menuId), ['financier', 'croissant', 'americano']);
  for (const m of catalog.menus) assert.deepEqual(Object.keys(m.names).sort(), ['en', 'ko', 'zh-Hans', 'zh-Hant']);
  for (const p of catalog.photos) assert.match(p.photoId, /^[a-z0-9-]{1,32}$/);
  assert.equal(catalog.photos.length, 11);
});

test('사진 id ↔ 파일 존재·크기 일치', () => {
  for (const p of catalog.photos) {
    const f = path.join(here, 'photos', p.file);
    assert.ok(fs.existsSync(f), p.file);
    const s = jpegSize(f);
    assert.deepEqual([s.width, s.height], [p.width, p.height], p.photoId);
  }
  const ext = catalog.photos.find((p) => p.photoId === 'store-exterior');
  assert.equal(ext.menuId, null);
  assert.deepEqual([ext.width, ext.height], [830, 536]);
});

test('사진 파일이 원본과 바이트 같음', () => {
  const ref = path.resolve(root, '../00_blueprint/references/promo-video');
  if (!fs.existsSync(ref)) return;
  for (const p of catalog.photos) {
    const orig = p.photoId === 'store-exterior' ? path.join(ref, 'storefront.jpeg') : path.join(ref, 'dataset-financier', p.file);
    assert.equal(sha(path.join(here, 'photos', p.file)), sha(orig), p.file);
  }
});

test('출처 묶음 10·7·4, 다른 메뉴 0장', () => {
  const fin = catalog.menus.find((m) => m.menuId === 'financier');
  assert.equal(fin.photoIds.length, 10);
  assert.deepEqual(fin.photoIds, catalog.photos.filter((p) => p.menuId === 'financier').map((p) => p.photoId));
  assert.deepEqual(['example', 'example-7', 'example-4'].map((k) => catalog.sources[k].length), [10, 7, 4]);
  assert.deepEqual(catalog.sources['example-7'], fin.photoIds.slice(0, 7));
  assert.deepEqual(catalog.sources['example-4'], fin.photoIds.slice(0, 4));
  const byId = Object.fromEntries(catalog.photos.map((p) => [p.photoId, p]));
  for (const source of ['example', 'example-7', 'example-4']) {
    for (const id of catalog.sources[source]) assert.equal(byId[id].menuId, 'financier');
  }
  for (const m of catalog.menus.filter((x) => x.menuId !== 'financier')) assert.equal(m.photoIds.length, 0);
});

test('카페 사진 목록의 메뉴·JPEG 규격·sha256이 일치한다', () => {
  const cafe = catalog.sourceCatalogs?.cafe;
  assert.ok(cafe, 'cafe photo catalog');
  const content = JSON.parse(fs.readFileSync(path.join(root, '../db/seed/ansungjalbu/content.json'), 'utf8'));
  assert.equal(cafe.store.name, content.store.name);
  assert.equal(cafe.store.location, content.store.area);
  assert.equal(cafe.photos.length, 180);
  assert.equal(new Set(cafe.photos.map(p => p.photoId)).size, cafe.photos.length);
  assert.deepEqual(cafe.photos.filter(p => p.menuId === null).map(p => p.photoId),
    [cafe.store.exteriorPhotoId, 'cafe-interior-01', 'cafe-interior-02']);
  assert.deepEqual(catalog.sources.cafe, cafe.photos.filter(p => p.menuId !== null).map(p => p.photoId));
  assert.deepEqual(cafe.menus.map(menu => menu.menuId), content.menu.map(menu => menu.id));
  for (const menu of cafe.menus) {
    assert.equal(menu.names.ko, content.menu.find(row => row.id === menu.menuId)?.name);
    assert.deepEqual(Object.keys(menu.names).sort(), ['en', 'ko', 'zh-Hans', 'zh-Hant']);
    assert.deepEqual(menu.photoIds, cafe.photos.filter(p => p.menuId === menu.menuId).map(p => p.photoId));
    assert.ok(menu.photoIds.length >= 5, menu.menuId);
  }
  const checksums = fs.readFileSync(path.join(here, 'SHA256.md'), 'utf8');
  for (const p of cafe.photos) {
    assert.match(p.photoId, /^[a-z0-9-]{1,32}$/);
    const file = path.join(here, 'photos', p.file);
    const publicName = path.basename(p.file);
    if (p.file.startsWith('d409/')) {
      assert.equal(p.photoId.replace('-d409-', '-'), path.parse(publicName).name);
      assert.deepEqual([p.width, p.height], [1180, 1180], p.file);
      assert.equal(sha(file), sha(path.join(root, 'public/menu-photos', publicName)), p.file);
    } else if (p.menuId === 'm-strawberry-cake') {
      assert.equal(p.file, `${p.photoId}.jpeg`);
      assert.equal(Math.max(p.width, p.height), 1280);
      assert.ok(fs.statSync(file).size < 300_000, p.file);
      assert.equal(sha(file), sha(path.join(root, 'public/menu-photos', p.file)), p.file);
    } else if (p.menuId === 'm-chestnut-latte') {
      assert.equal(p.file, `${p.photoId}.jpeg`);
      assert.deepEqual([p.width, p.height], [1180, 1180], p.file);
      assert.ok(fs.statSync(file).size < 650_000, p.file);
      assert.equal(sha(file), sha(path.join(root, 'public/menu-photos', p.file)), p.file);
    } else if (p.width === 1180 && p.height === 1180) {
      assert.equal(p.file, `${p.photoId}.jpeg`);
      assert.match(p.file, /-01\.jpeg$/);
      assert.equal(sha(file), sha(path.join(root, 'public/menu-photos', p.file)), p.file);
    } else {
      assert.equal(p.file, `${p.photoId}.jpeg`);
      assert.ok(fs.statSync(file).size < 300_000, p.file);
      assert.equal(Math.max(p.width, p.height), 1280, p.file);
    }
    assert.deepEqual(jpegSize(file), { width: p.width, height: p.height }, p.file);
    assert.ok(checksums.includes(`| \`${p.file}\` | \`${sha(file)}\` |`), p.file);
  }
});

test('D-409 adds a cover and four new selectable shots per menu in its batch', () => {
  const cafe = catalog.sourceCatalogs.cafe;
  const newPhotos = cafe.photos.filter(photo => photo.file.startsWith('d409/'));
  assert.equal(newPhotos.length, 92);
  for (const menu of cafe.menus.filter(menu => !['m-chestnut-latte', 'm-strawberry-cake'].includes(menu.menuId))) {
    const slug = menu.menuId.slice(2);
    assert.ok(menu.photoIds.includes(`cafe-${slug}-01`), menu.menuId);
    const shots = newPhotos.filter(photo => photo.menuId === menu.menuId).map(photo => {
      assert.ok(menu.photoIds.includes(photo.photoId), photo.photoId);
      return photo.file;
    });
    assert.deepEqual(shots, [2, 3, 4, 5].map(n => `d409/cafe-${slug}-0${n}.jpeg`));
  }
});

test('the strawberry cake metadata matches the ten catalog bytes and the ref-1 display and in-hand roles', () => {
  const cafe = catalog.sourceCatalogs.cafe;
  const cake = cafe.menus.find(menu => menu.menuId === 'm-strawberry-cake');
  const files = cake.photoIds.map(id => `${id}.jpeg`);
  assert.deepEqual(files, Array.from({ length: 10 }, (_, i) => `cafe-strawberry-cake-${String(i + 1).padStart(2, '0')}.jpeg`));
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, '../backend/services/marketing/promo/strawberry-cake-photo-analysis.json'), 'utf8'));
  assert.equal(snapshot.model, 'claude-opus-5-5');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.rows.length, 10);
  const photos = files.map(file => {
    const row = snapshot.rows.find(row => row.sha256 === sha(path.join(here, 'photos', file)));
    assert.ok(row, file);
    assert.deepEqual(validateSchema(PHOTO_META_SCHEMA, row.metadata), []);
    assert.equal(row.metadata.menuShown, 'main', file);
    return row.metadata;
  });
  assert.deepEqual(photos.slice(0, 7).map(({ kind, amount }) => [kind, amount]), [
    ['closeup', 'one'], ['display', 'many'], ['display', 'many'], ['display', 'one'], ['display', 'few'], ['inhand', 'one'], ['inhand', 'one'],
  ]);
  const input = { referenceId: 'ref-1', lengthSec: 30, locale: 'ko', menuIds: [cake.menuId], moods: [], concepts: [] };
  const ctx = { input, photos: photos.map((meta, i) => ({ photoId: cake.photoIds[i], menuId: cake.menuId, menuName: cake.names.ko, meta })),
    exterior: { photoId: cafe.store.exteriorPhotoId }, store: cafe.store };
  const { variantId, heroPhotoId } = chatCountdownSlotRequest(ctx).schema.properties;
  const story = planChatCountdown(ctx, { variantId: variantId.enum[0], heroPhotoId: heroPhotoId.enum[0] });
  assert.deepEqual(story.chatCountdown.numbers.map(([n]) => n), [6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(story.scenes[1].photoIds, [cake.photoIds[1]]);
  assert.deepEqual(story.scenes[3].photoIds, [cake.photoIds[3], cake.photoIds[5]]);
});

test('the chestnut latte catalog contains the original and five new photos in order', () => {
  const menu = catalog.sourceCatalogs.cafe.menus.find(menu => menu.menuId === 'm-chestnut-latte');
  assert.deepEqual(menu.photoIds, [
    'cafe-chestnut-latte-01', 'cafe-chestnut-latte-02', 'cafe-chestnut-latte-03',
    'cafe-chestnut-latte-04', 'cafe-chestnut-latte-05', 'cafe-chestnut-latte-06',
  ]);
});

test('D-439 photos have the ref-1 roles and identical bytes in the public and server catalogs', () => {
  const cafe = catalog.sourceCatalogs.cafe;
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, '../backend/services/marketing/promo/ref1-photos-photo-analysis.json'), 'utf8'));
  assert.equal(snapshot.model, 'claude-opus-5-5');
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.rows.length, 16);
  for (const [slug, start] of [['saltbread', 7], ['bagel-plain', 6], ['basque-cake', 6], ['cookie-choco', 6]]) {
    const menu = cafe.menus.find(menu => menu.menuId === `m-${slug}`);
    const ids = Array.from({ length: 4 }, (_, index) => `cafe-${slug}-${String(start + index).padStart(2, '0')}`);
    assert.deepEqual(menu.photoIds.slice(-4), ids);
    const photos = ids.map(photoId => {
      const file = `${photoId}.jpeg`;
      const hash = sha(path.join(here, 'photos', file));
      assert.equal(hash, sha(path.join(root, 'public/menu-photos', file)), photoId);
      const row = snapshot.rows.find(row => row.sha256 === hash);
      assert.ok(row, photoId);
      assert.deepEqual(validateSchema(PHOTO_META_SCHEMA, row.metadata), []);
      assert.equal(row.metadata.menuShown, 'main', photoId);
      return { photoId, menuId: menu.menuId, menuName: menu.names.ko, meta: row.metadata };
    });
    assert.deepEqual(photos.map(({ meta }) => [meta.kind, meta.amount]), [
      ['display', 'many'], ['display', 'one'], ['inhand', 'one'], ['other', slug === 'cookie-choco' ? 'few' : 'one'],
    ]);
    const ctx = {
      input: { referenceId: 'ref-1', lengthSec: 30, locale: 'ko', menuIds: [menu.menuId], moods: [], concepts: [] },
      photos,
      exterior: { photoId: cafe.store.exteriorPhotoId }, store: cafe.store,
    };
    const { variantId, heroPhotoId } = chatCountdownSlotRequest(ctx).schema.properties;
    const story = planChatCountdown(ctx, { variantId: variantId.enum[0], heroPhotoId: heroPhotoId.enum[0] });
    assert.deepEqual(story.chatCountdown.numbers.map(([number]) => number), [6, 5, 4, 3, 2, 1, 0]);
    assert.deepEqual(story.scenes[1].photoIds, [ids[0]]);
    assert.deepEqual(story.scenes[3].photoIds, [ids[1], ids[2]]);
  }
});

test('music.json 3곡·CC0·sha256·길이', () => {
  assert.equal(music.length, 3);
  const moods = music.flatMap((m) => m.moods);
  for (const k of ['활기찬', '따뜻한', '고급스러운', '깔끔한']) assert.ok(moods.includes(k), k);
  for (const m of music) {
    assert.equal(m.license, 'CC0-1.0');
    assert.match(m.sourceUrl, /^https:\/\//);
    assert.ok(m.durationSec >= 32);
    const f = path.join(here, 'music', m.file);
    assert.equal(sha(f), m.sha256);
    const pr = cp.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', f], { encoding: 'utf8' });
    if (pr.error) continue;
    const j = JSON.parse(pr.stdout);
    assert.equal(j.streams[0].codec_name, 'aac');
    assert.ok(Number(j.format.duration) >= 32);
  }
  const src = fs.readFileSync(path.join(here, 'SOURCES.md'), 'utf8');
  for (const m of music) assert.ok(src.includes(m.sourceUrl) && src.includes(m.sha256));
});
