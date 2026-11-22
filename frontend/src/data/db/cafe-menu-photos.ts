import type { PosMenuPhotoDataUrl } from '../../contracts/pos';
import { seedCatalog } from './generated/catalog';

const photos = new Map<string, string>(seedCatalog.menu.map(({ menuId }) =>
  [menuId, `/menu-photos/cafe-${menuId.slice(2)}-01.jpeg`],
));

/** Static demo URLs use the existing custom-image slot, whose command contract types uploaded PNG data URLs. */
export function cafeMenuPhoto(menuId: string): PosMenuPhotoDataUrl | null {
  return (photos.get(menuId) as PosMenuPhotoDataUrl | undefined) ?? null;
}
