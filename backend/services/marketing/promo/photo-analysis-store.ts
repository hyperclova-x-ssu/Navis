import type { PoolClient } from 'pg';
import { HCX_PHOTO_MODEL } from '../../../../frontend/server/promo/hcx-runner.mjs';
import { META_SCHEMA_VERSION } from '../../../../frontend/server/promo/prompts.mjs';
import { sha256 } from './contracts.ts';

export const model = HCX_PHOTO_MODEL;
export const schemaVersion = META_SCHEMA_VERSION;
export const analysisKey = (bytes: Buffer) => ({ sha256: sha256(bytes) });

export async function queuePhotoAnalysis(db: PoolClient, storeId: string, photo: {
  sha256: string; fileId: string; resourceId: string; menuName: string;
}) {
  await db.query(`
    INSERT INTO marketing.promo_photo_analysis
      (store_id, image_sha256, schema_version, model, file_id, resource_id, menu_name, state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') ON CONFLICT DO NOTHING`,
  [storeId, photo.sha256, schemaVersion, model, photo.fileId, photo.resourceId, photo.menuName]);
}
