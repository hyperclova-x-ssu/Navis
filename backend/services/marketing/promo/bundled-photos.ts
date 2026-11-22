import { readFileSync } from 'node:fs';
import type { Photo } from './photo-assets.ts';
import { sha256 } from './contracts.ts';

type Representative = Omit<Photo, 'photoId' | 'menuId'> & { menuId: string; legacyMenuId: string; file: string };

export const bundledMenuPhotos: readonly Representative[] = JSON.parse(
  readFileSync(new URL('./bundled-menu-photos.json', import.meta.url), 'utf8'),
);

export function representativePhotoId(storeId: string, legacyMenuId: string) {
  const digest = sha256(JSON.stringify(['menu-photo', storeId, legacyMenuId]));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function bundledPhotoList(storeId: string) {
  return bundledMenuPhotos.map(({ legacyMenuId, file, ...photo }) => ({
    ...photo, photoId: representativePhotoId(storeId, legacyMenuId), contentUrl: `/menu-photos/${file}`,
  }));
}
