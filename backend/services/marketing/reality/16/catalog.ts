import type { PromoCatalogInput } from '../../../../../frontend/src/data/marketing/types.ts';
import { loadReferences } from '../../../../../frontend/server/promo/references.mjs';
import type { FileBinding } from '../../promo/contracts.ts';
import { type Asset, type Owner } from './state.ts';
import type { PromoRealityOptions } from './routes.ts';

type Venue = Pick<PromoCatalogInput, 'sourceId' | 'store' | 'menus'>;
type Photo = PromoCatalogInput['photos'][number];
export type AccountPhoto = {
  photoId: string;
  fileId: string;
  menuId: string | null;
  width: number;
  height: number;
  binding: FileBinding;
};
export type PromoAccountCatalog = {
  /**
   * Return only rights-approved ready Account photos for this owner/store. Upload photoIds are
   * the hyphen-free marketing asset UUIDs. Resolve worker-readable bindings in Account storage.
   */
  photos(owner: Owner, uploads: readonly Asset[]): Promise<readonly AccountPhoto[]>;
  verifyUpload: PromoRealityOptions['verifyUpload'];
};

export function createPromoCatalog(account: PromoAccountCatalog, venueForOwner: (owner: Owner) => Promise<Venue | null>):
  Pick<PromoRealityOptions, 'catalogForOwner' | 'verifyUpload' | 'references'> {
  return {
    references: loadReferences(),
    verifyUpload: account.verifyUpload,
    async catalogForOwner(owner, uploads) {
      const venue = await venueForOwner(owner);
      if (!venue) return null;
      const photos = await account.photos(owner, uploads);
      const photoUrl = (fileId: string) => `/api/v1/stores/${owner.storeId}/files/${fileId}/content`;
      const byMenu = new Map<string, string[]>();
      const rows: Photo[] = [];
      const bindings: Record<string, FileBinding> = Object.create(null);
      for (const photo of photos) {
        if (!/^[a-z0-9-]{1,32}$/.test(photo.photoId) || Object.hasOwn(bindings, photo.photoId)) continue;
        bindings[photo.photoId] = { ...photo.binding, sourceFileId: photo.fileId };
        const { photoId, menuId, width, height } = photo;
        rows.push({ photoId, menuId, width, height, url: photoUrl(photo.fileId) });
        if (menuId !== null) {
          const menuPhotos = byMenu.get(menuId) ?? [];
          menuPhotos.push(photoId);
          byMenu.set(menuId, menuPhotos);
        }
      }
      const exterior = rows.find(photo => photo.photoId === venue.store.exteriorPhotoId && photo.menuId === null);
      return {
        catalog: {
          sourceId: venue.sourceId,
          store: { ...venue.store, exteriorUrl: exterior?.url ?? '' },
          menus: venue.menus.map(menu => ({ ...menu, photoIds: byMenu.get(menu.menuId) ?? [] })),
          photos: rows,
        },
        exterior: exterior ? { width: exterior.width, height: exterior.height } : { width: 0, height: 0 },
        photos: bindings,
      };
    },
  };
}
