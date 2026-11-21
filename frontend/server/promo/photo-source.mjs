// PhotoSource 예시 어댑터 (ARCHITECTURE 12.2). 카탈로그 JSON 하나가 브라우저 시드와 서버의 원본.
// 실제 리뷰 사진 API가 생기면 같은 { id, listCatalog, readPhoto } 모양의 새 어댑터를 붙인다.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHOTO_ID = /^[a-z0-9-]{1,32}$/;
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_CATALOG_PATH = join(appRoot, 'src/data/marketing/promo-catalog.json');
export const DEFAULT_PHOTOS_DIR = fileURLToPath(new URL('./assets/photos/', import.meta.url));

export function createExamplePhotoSource({ catalogPath = DEFAULT_CATALOG_PATH, photosDir = DEFAULT_PHOTOS_DIR, sourceId = 'example', catalog } = {}) {
  const raw = catalog ?? JSON.parse(readFileSync(catalogPath, 'utf8'));
  const allowed = raw.sources?.[sourceId];
  if (!Array.isArray(allowed)) throw new Error(`unknown photo source ${sourceId}`);
  const { store, menus: sourceMenus, photos: sourcePhotos } = raw.sourceCatalogs?.[sourceId] ?? raw;
  const allowSet = new Set(allowed);
  const exteriorId = store.exteriorPhotoId;
  const byId = new Map(sourcePhotos.map(p => [p.photoId, p]));
  const menus = sourceMenus.map(m => ({ menuId: m.menuId, names: { ...m.names }, photoIds: m.photoIds.filter(id => allowSet.has(id)) }));
  // 사진 순서는 카탈로그 순서, 거르지 않음(AC-328). 가게 사진은 메뉴 선택에서 제외한다.
  const photos = sourcePhotos.filter(p => p.menuId !== null && allowSet.has(p.photoId))
    .map(p => ({ photoId: p.photoId, menuId: p.menuId, url: `/api/promo/photos/${p.photoId}`, width: p.width, height: p.height }));
  const listing = Object.freeze({
    sourceId,
    store: { name: store.name, location: store.location, exteriorPhotoId: exteriorId, exteriorUrl: `/api/promo/photos/${exteriorId}` },
    menus,
    photos,
  });
  const storePhotoIds = sourcePhotos.filter(p => p.menuId === null).map(p => p.photoId);
  const readable = new Set([...photos.map(p => p.photoId), ...storePhotoIds]);
  return {
    id: sourceId,
    listCatalog: () => structuredClone(listing),
    listPhotoIds: () => [...readable],
    /** 사진 크기(장면 구성·코드 프롬프트용). 외관 포함. */
    photoInfo(photoId) {
      if (!readable.has(photoId)) return null;
      const p = byId.get(photoId);
      return { photoId, menuId: p.menuId ?? null, width: p.width, height: p.height };
    },
    async readPhoto(photoId) {
      if (typeof photoId !== 'string' || !PHOTO_ID.test(photoId) || !readable.has(photoId)) return null;
      const p = byId.get(photoId);
      return { bytes: await readFile(join(photosDir, p.file)), mediaType: 'image/jpeg' };
    },
  };
}
