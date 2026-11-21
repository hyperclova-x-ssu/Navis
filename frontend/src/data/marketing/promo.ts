/**
 * F-50 promo catalog → browser tables (DATA_MODEL 10.16.1·10.16.2, D-80). The seed and `promo.syncCatalog`
 * both build `promo_store` / `promo_menu` / `promo_photo` here, from the same catalog JSON the server's
 * example photo source reads (`promo-catalog.json`, owned by T-080), so there is one photo count.
 */
import catalog from './promo-catalog.json';
import { LOCALES } from './derive';
import type { PromoCatalogInput, PromoLocale, PromoMenuRow, PromoPhotoRow, PromoStoreRow } from './types';

export const PROMO_PHOTO_URL = '/api/promo/photos';
export const PROMO_DEFAULT_SOURCE = 'example';
/** Message keys of the sample menu names (LOCALES 9.4 ‘메뉴 이름(가짜 데이터)’); other menu ids fall back to the Korean catalog name. */
export const PROMO_MENU_NAME: Readonly<Record<string, string>> = { financier: 'data.marketing.promoMenu.financier', croissant: 'data.marketing.promoMenu.croissant', americano: 'data.marketing.promoMenu.americano' };
const ID = /^[a-z0-9-]{1,32}$/;

type CatalogJson = typeof catalog;
const json: CatalogJson = catalog;
const SOURCES = json.sources as Readonly<Record<string, readonly string[]>>;

/** The catalog of one source (`example` 10 · `example-7` · `example-4`) in the API-20 response shape. */
export function catalogForSource(sourceId: string = PROMO_DEFAULT_SOURCE): PromoCatalogInput {
  const source = SOURCES[sourceId] ? sourceId : PROMO_DEFAULT_SOURCE;
  const allowed = new Set(SOURCES[source]);
  const { store, menus: sourceMenus, photos } = source === 'cafe' ? json.sourceCatalogs.cafe : json;
  const menus = sourceMenus.map((m) => ({ menuId: m.menuId, names: m.names as Readonly<Record<PromoLocale, string>>, photoIds: m.photoIds.filter((id) => allowed.has(id)) }));
  const photoIds = new Set(menus.flatMap((m) => m.photoIds));
  return {
    sourceId: source,
    store: { ...store, exteriorUrl: `${PROMO_PHOTO_URL}/${store.exteriorPhotoId}` },
    menus,
    photos: photos.filter((p) => photoIds.has(p.photoId)).map((p) => ({ photoId: p.photoId, menuId: p.menuId, url: `${PROMO_PHOTO_URL}/${p.photoId}`, width: p.width, height: p.height })),
  };
}

export interface PromoTables { readonly promoStore: readonly PromoStoreRow[]; readonly promoMenu: readonly PromoMenuRow[]; readonly promoPhoto: readonly PromoPhotoRow[] }

/** Tables from a catalog; the exterior photo and photos outside every menu list are not selectable (AC-326). */
export function promoTablesFromCatalog(c: PromoCatalogInput): PromoTables {
  const menuOf = new Map<string, string>();
  for (const m of c.menus) for (const id of m.photoIds) menuOf.set(id, m.menuId);
  const photos = c.photos.filter((p) => menuOf.get(p.photoId) === p.menuId);
  return {
    promoStore: [{ ...c.store, sourceId: c.sourceId }],
    promoMenu: c.menus.map((m, order) => ({ menuId: m.menuId, names: m.names, order })),
    promoPhoto: photos.map((p, order) => ({ photoId: p.photoId, menuId: p.menuId as string, url: p.url, width: p.width, height: p.height, order })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isDim = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** Shape check of an API-20 response (`promo.syncCatalog`): a bad catalog never reaches the tables. */
export function isCatalogInput(v: unknown): v is PromoCatalogInput {
  if (!isObj(v) || !isStr(v.sourceId) || !isObj(v.store) || !Array.isArray(v.menus) || !Array.isArray(v.photos)) return false;
  const s = v.store;
  if (!isStr(s.name) || !isStr(s.location) || !isStr(s.exteriorPhotoId) || !isStr(s.exteriorUrl)) return false;
  const menuIds = new Set<string>();
  for (const m of v.menus) {
    if (!isObj(m) || !isStr(m.menuId) || !isObj(m.names) || !Array.isArray(m.photoIds) || menuIds.has(m.menuId)) return false;
    if (!LOCALES.every((l) => isStr((m.names as Record<string, unknown>)[l])) || !m.photoIds.every((id) => typeof id === 'string' && ID.test(id))) return false;
    menuIds.add(m.menuId);
  }
  const photoIds = new Set<string>();
  for (const p of v.photos) {
    if (!isObj(p) || typeof p.photoId !== 'string' || !ID.test(p.photoId) || photoIds.has(p.photoId) || !isStr(p.url) || !isDim(p.width) || !isDim(p.height)) return false;
    if (p.menuId !== null && !(typeof p.menuId === 'string' && menuIds.has(p.menuId))) return false;
    photoIds.add(p.photoId);
  }
  return v.menus.every((m) => (m as { photoIds: string[] }).photoIds.every((id) => photoIds.has(id)));
}
