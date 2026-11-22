import type { PosReadSnapshot } from '../contracts/pos';
import type { DataSnapshot } from '../data/db/types';
import { menuPhotoContent, menuPhotoFileId } from '../data/reality/01/menu-dto';
import { selectPosCatalog } from './domain/cart';

export function selectPosMenu(read: PosReadSnapshot, category: string) {
  const catalog = selectPosCatalog(read, { category });
  const inventory = (read.data.source as DataSnapshot | undefined)?.tables?.menuItem;
  const menus = new Map(inventory?.map(item => [item.menuId, item]));
  return { ...catalog, items: catalog.items.map(item => {
    const menu = menus.get(item.menuId);
    return { ...item, photoFileId: menu && menuPhotoFileId(menu), photoContent: menu && menuPhotoContent(menu) };
  }) };
}
