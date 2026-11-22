import type { PosReadSnapshot } from '../contracts/pos';
import type { DataSnapshot } from '../data/db/types';
import { menuPhotoFileId } from '../data/reality/01/menu-dto';
import { selectPosCatalog } from './domain/cart';

export function selectPosMenu(read: PosReadSnapshot, category: string) {
  const catalog = selectPosCatalog(read, { category });
  const inventory = (read.data.source as DataSnapshot | undefined)?.tables?.menuItem;
  if (!inventory) return { ...catalog, items: catalog.items.map(item => ({ ...item, photoFileId: undefined })) };
  const photos = new Map(inventory.map(item => [item.menuId, menuPhotoFileId(item)]));
  return { ...catalog, items: catalog.items.map(item => ({ ...item, photoFileId: photos.get(item.menuId) })) };
}
