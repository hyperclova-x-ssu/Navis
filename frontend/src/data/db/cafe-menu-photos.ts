import type { PosMenuPhotoDataUrl } from '../../contracts/pos';
import catalog from '../marketing/promo-catalog.json';

const photos = new Map(catalog.sourceCatalogs.cafe.menus.filter(menu => menu.photoIds.length > 0)
  .map(menu => [menu.menuId, `/menu-photos/${menu.photoIds[0]}.jpeg`]));

/** Static demo URLs use the existing custom-image slot, whose command contract types uploaded PNG data URLs. */
export function cafeMenuPhoto(menuId: string): PosMenuPhotoDataUrl | null {
  return (photos.get(menuId) as PosMenuPhotoDataUrl | undefined) ?? null;
}
