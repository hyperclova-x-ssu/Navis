import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { sha256 } from './contracts.ts';

const contentTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const maxPhotoBytes = 4 * 1024 * 1024;
export type PhotoSource = 'menu-primary' | 'menu-bundle' | 'promo-bundle' | 'owner-upload';
export type PhotoUpload = { bytes: Buffer; contentType: string; width: number; height: number };
export type Photo = { photoId: string; menuId: string | null; sha256: string; width: number; height: number };
type PhotoAsset = Photo & { objectKey: string; contentType: string; bytes: number; source: PhotoSource };
export type PhotoCursor = { other: boolean; id: string };

export const photoPath = '/internal/v1/marketing/stores/:storeId/marketing/photos';
export const photoContentUrl = (storeId: string, photoId: string) => `/api/v1/stores/${storeId}/marketing/photos/${photoId}/content`;

const columns = 'id AS "photoId", menu_id AS "menuId", sha256, width, height';

export function describePhoto(storeId: string, photo: PhotoUpload & { menuId: string | null; source: PhotoSource; photoId?: string }): PhotoAsset {
  if (!contentTypes.has(photo.contentType) || !photo.bytes.length || photo.bytes.length > maxPhotoBytes
    || ![photo.width, photo.height].every(size => Number.isInteger(size) && size >= 1 && size <= 16384)) {
    throw new Error('Invalid photo content');
  }
  const digest = sha256(photo.bytes);
  return {
    photoId: photo.photoId ?? randomUUID(), menuId: photo.menuId, sha256: digest, objectKey: `photos/${storeId}/${digest}`,
    contentType: photo.contentType, bytes: photo.bytes.length, width: photo.width, height: photo.height, source: photo.source,
  };
}

export async function storePhoto(storage: Pick<ObjectStorage, 'put'>, storeId: string, upload: PhotoUpload, menuId: string | null) {
  const asset = describePhoto(storeId, { ...upload, menuId, source: 'owner-upload' });
  await storage.put(asset.objectKey, upload.bytes, asset.contentType);
  return asset;
}

export async function insertPhoto(db: PoolClient, storeId: string, asset: PhotoAsset): Promise<string> {
  const { rows: [inserted] } = await db.query<{ id: string }>(`
    INSERT INTO marketing.photo_asset (id, store_id, menu_id, object_key, sha256, content_type, bytes, width, height, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (store_id, sha256) DO NOTHING RETURNING id`,
  [asset.photoId, storeId, asset.menuId, asset.objectKey, asset.sha256, asset.contentType, asset.bytes, asset.width, asset.height, asset.source]);
  if (inserted) return inserted.id;
  const { rows: [existing] } = await db.query<{ id: string }>(
    'SELECT id FROM marketing.photo_asset WHERE store_id=$1 AND sha256=$2', [storeId, asset.sha256]);
  if (!existing) throw new Error('Photo insert lost its matching catalog row');
  return existing.id;
}

export async function readPhotoCatalog(db: PoolClient, storeId: string, cursor: PhotoCursor | null, limit: number) {
  const { rows } = await db.query<Photo & { other: boolean }>(`
    SELECT ${columns}, (source <> 'menu-primary') AS other FROM marketing.photo_asset
    WHERE store_id=$1 AND ($2::boolean IS NULL OR ((source <> 'menu-primary'), id) > ($2::boolean, $3::uuid))
    ORDER BY (source <> 'menu-primary'), id LIMIT $4`, [storeId, cursor?.other ?? null, cursor?.id ?? null, limit]);
  return rows;
}

export async function readPhoto(db: PoolClient, storeId: string, photoId: string) {
  const { rows: [asset] } = await db.query<Pick<PhotoAsset, 'objectKey' | 'contentType' | 'bytes' | 'sha256'>>(`
    SELECT object_key AS "objectKey", content_type AS "contentType", bytes, sha256 FROM marketing.photo_asset
    WHERE store_id=$1 AND id=$2`, [storeId, photoId]);
  return asset;
}

export async function readPromoPhotoAliases(db: PoolClient, storeId: string, uploadIds: readonly string[] = []) {
  const { rows } = await db.query<{ legacyId: string; photoId: string; sha256: string; width: number; height: number }>(`
    SELECT legacy_id AS "legacyId", photo_id AS "photoId", sha256, width, height
    FROM marketing.photo_asset_alias aliases JOIN marketing.photo_asset assets
      ON (assets.store_id, assets.id) = (aliases.store_id, aliases.photo_id)
    WHERE aliases.store_id=$1
    UNION ALL
    SELECT id::text, id, sha256, width, height FROM marketing.photo_asset WHERE store_id=$1 AND id=ANY($2::uuid[])`,
  [storeId, uploadIds]);
  return new Map(rows.map(asset => [asset.legacyId, asset]));
}
