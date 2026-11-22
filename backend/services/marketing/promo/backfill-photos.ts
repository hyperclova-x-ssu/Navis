import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Pool } from 'pg';
import { validateMedia } from '../../../../frontend/server/media/validation.mjs';
import { DEFAULT_CATALOG_PATH, DEFAULT_PHOTOS_DIR } from '../../../../frontend/server/promo/photo-source.mjs';
import { dbPool } from '../../../packages/db/index.ts';
import { createObjectStorage, type ObjectStorage } from '../../../packages/object-storage/index.ts';
import { inStore } from '../transaction.ts';
import { representativePhotoId, bundledMenuPhotos } from './bundled-photos.ts';
import { isUuid } from './contracts.ts';
import { describePhoto, insertPhoto, readPromoPhotoAliases, type PhotoSource } from './photo-assets.ts';

export const menuPhotosDir = fileURLToPath(new URL('../../../../frontend/public/menu-photos/', import.meta.url));
type LegacyPhoto = { photoId: string; menuId: string | null; file: string };
type LegacyCatalog = { photos: LegacyPhoto[]; sourceCatalogs: Record<string, { photos: LegacyPhoto[] }> };

async function photoFiles(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await photoFiles(path));
    if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) paths.push(path);
  }
  return paths.sort();
}

function menuIdFromFile(path: string) {
  const name = /^cafe-(.+)-\d+\.jpe?g$/i.exec(basename(path))?.[1];
  return name ? `m-${name}` : null;
}

export async function backfillPhotos(pool: Pool, storage: Pick<ObjectStorage, 'put'>, storeId: string, {
  menuDir = menuPhotosDir, promoDir = DEFAULT_PHOTOS_DIR, catalogPath = DEFAULT_CATALOG_PATH,
} = {}) {
  if (!isUuid(storeId)) throw new Error('A valid --store-id is required');
  const legacyCatalog: LegacyCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const legacyByPath = new Map<string, LegacyPhoto[]>();
  for (const photo of [...legacyCatalog.photos, ...Object.values(legacyCatalog.sourceCatalogs).flatMap(catalog => catalog.photos)]) {
    const rows = legacyByPath.get(photo.file) ?? [];
    rows.push(photo);
    legacyByPath.set(photo.file, rows);
  }
  const menuIds = new Map(bundledMenuPhotos.map(photo => [photo.legacyMenuId, photo.menuId]));
  const primary = new Map(bundledMenuPhotos.map(photo => [join(menuDir, photo.file), photo]));
  const [menu, promo] = await Promise.all([photoFiles(menuDir), photoFiles(promoDir)]);
  const candidates = [...menu.filter(path => primary.has(path)), ...menu.filter(path => !primary.has(path)), ...promo];
  const objectIds = await inStore(pool, storeId, async db => {
    const result = await db.query<{ id: string; sha256: string }>('SELECT id, sha256 FROM marketing.photo_asset WHERE store_id=$1', [storeId]);
    return new Map(result.rows.map(row => [row.sha256, row.id]));
  });
  const promoPaths = new Set(promo);
  const aliases = new Map<string, string>();
  const hashes = new Set<string>();
  let uploaded = 0;
  for (const path of candidates) {
    const representative = primary.get(path);
    const promoPath = promoPaths.has(path);
    const legacy = promoPath ? legacyByPath.get(relative(promoDir, path)) ?? [] : [];
    const knownMenu = representative?.legacyMenuId ?? (legacy.length ? legacy[0].menuId : menuIdFromFile(path));
    const menuId = knownMenu && (menuIds.get(knownMenu) ?? knownMenu);
    const source: PhotoSource = representative ? 'menu-primary' : promoPath ? 'promo-bundle' : 'menu-bundle';
    const bytes = await readFile(path);
    const contentType = 'image/jpeg';
    const dimensions = validateMedia('receipt', contentType, bytes);
    if (!('width' in dimensions)) throw new Error('Bundled photo has no image dimensions');
    const asset = describePhoto(storeId, { bytes, contentType, ...dimensions, menuId, source,
      photoId: representative && representativePhotoId(storeId, representative.legacyMenuId) });
    if (representative && representative.sha256 !== asset.sha256) throw new Error('Bundled menu photo hash changed');
    hashes.add(asset.sha256);
    let photoId = objectIds.get(asset.sha256);
    if (!photoId) {
      await storage.put(asset.objectKey, bytes, contentType);
      photoId = await inStore(pool, storeId, db => insertPhoto(db, storeId, asset));
      objectIds.set(asset.sha256, photoId);
      uploaded++;
    }
    if (representative && photoId !== asset.photoId) throw new Error('Menu representative already has a different catalog identity');
    for (const photo of legacy) aliases.set(photo.photoId, photoId);
  }
  if (aliases.size !== [...legacyByPath.values()].flat().length) throw new Error('Bundled promo photo file is missing');
  await inStore(pool, storeId, async db => {
    await db.query(`INSERT INTO marketing.photo_asset_alias (store_id, legacy_id, photo_id)
      SELECT $1, legacy_id, photo_id FROM unnest($2::text[], $3::uuid[]) AS alias (legacy_id, photo_id)
      ON CONFLICT (store_id, legacy_id) DO NOTHING`, [storeId, [...aliases.keys()], [...aliases.values()]]);
    const recorded = await readPromoPhotoAliases(db, storeId);
    for (const [legacyId, photoId] of aliases) {
      if (recorded.get(legacyId)?.photoId !== photoId) throw new Error('Bundled promo photo alias already points at different content');
    }
  });
  return { files: candidates.length, unique: hashes.size, uploaded, aliases: aliases.size };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    'store-id': { type: 'string' }, 'menu-photo-dir': { type: 'string' }, 'promo-photo-dir': { type: 'string' },
  } });
  const storeId = values['store-id'];
  if (!isUuid(storeId)) {
    throw new Error('Usage: node services/marketing/promo/backfill-photos.ts --store-id <uuid> [--menu-photo-dir <dir>] [--promo-photo-dir <dir>]');
  }
  const storage = createObjectStorage();
  if (!storage) throw new Error('Photo backfill requires NAVIS_OBJECT_STORAGE_MODE=s3');
  const pool = dbPool('marketing');
  try {
    console.info(JSON.stringify(await backfillPhotos(pool, storage, storeId, {
      menuDir: values['menu-photo-dir'] ? resolve(values['menu-photo-dir']) : undefined,
      promoDir: values['promo-photo-dir'] ? resolve(values['promo-photo-dir']) : undefined,
    })));
  } finally {
    await pool.end();
  }
}
