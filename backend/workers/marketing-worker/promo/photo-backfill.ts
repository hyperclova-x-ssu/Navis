import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createExamplePhotoSource } from '../../../../frontend/server/promo/photo-source.mjs';
import { PHOTO_META_SCHEMA } from '../../../../frontend/server/promo/prompts.mjs';
import { CAFE_PHOTO_ANALYSIS_MODEL, CLAUDE_API_MODEL } from '../../../../frontend/server/promo/scene-provider.mjs';
import { validateSchema } from '../../../../frontend/server/promo/schema.mjs';
import { analysisKey, schemaVersion } from '../../../services/marketing/promo/photo-analysis-store.ts';
import { inStore } from '../../../services/marketing/transaction.ts';
import type { createPhotoAnalysis } from './photo-analysis.ts';

type SnapshotRow = { sha256: string; metadata: object };
type Snapshot = { storeId: string; model: string; schemaVersion: number; rows: SnapshotRow[] };
export const cafePhotoSeedModels: readonly string[] = [CLAUDE_API_MODEL, CAFE_PHOTO_ANALYSIS_MODEL];

export async function exportCafePhotoSeed(database: Pool, storeId: string): Promise<Snapshot> {
  const { rows } = await inStore(database, storeId, db => db.query<SnapshotRow>(`
    SELECT image_sha256 AS sha256, metadata FROM marketing.promo_photo_analysis
    WHERE store_id = $1 AND schema_version = $2 AND model = $3 AND state = 'ready' AND file_id IS NULL
    ORDER BY image_sha256`, [storeId, schemaVersion, CAFE_PHOTO_ANALYSIS_MODEL]));
  return { storeId, model: CAFE_PHOTO_ANALYSIS_MODEL, schemaVersion, rows };
}

/** Install verified rows from a scoped offline run without opening a provider connection. */
export async function importCafePhotoSeed(database: Pool, storeId: string, snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid promo photo snapshot');
  const { storeId: snapshotStore, model, schemaVersion: version, rows } = snapshot as Partial<Snapshot>;
  if (snapshotStore !== storeId || typeof model !== 'string' || !cafePhotoSeedModels.includes(model)
      || version !== schemaVersion || !Array.isArray(rows)) {
    throw new Error('Invalid promo photo snapshot');
  }
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const catalog = source.listCatalog();
  if (rows.length > catalog.photos.length) throw new Error('Invalid promo photo snapshot');
  const menuNames = new Map<string, string>(catalog.menus.map((menu: { menuId: string; names: { en: string } }) =>
    [menu.menuId, menu.names.en]));
  const hashes = new Map<string, string>();
  for (const { photoId, menuId } of catalog.photos.values()) {
    const photo = await source.readPhoto(photoId);
    if (photo) hashes.set(analysisKey(photo.bytes).sha256, menuNames.get(menuId) ?? '');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || !hashes.has(row.sha256) || seen.has(row.sha256) || validateSchema(PHOTO_META_SCHEMA, row.metadata).length) {
      throw new Error('Invalid promo photo snapshot row');
    }
    seen.add(row.sha256);
  }
  return inStore(database, storeId, async db => {
    let inserted = 0;
    for (const { sha256, metadata } of rows) {
      const result = await db.query(`INSERT INTO marketing.promo_photo_analysis
        (store_id, image_sha256, schema_version, model, menu_name, state, claim_id, started_at, metadata)
        VALUES ($1, $2, $3, $4, $5, 'ready', $6, clock_timestamp(), $7) ON CONFLICT DO NOTHING`,
      [storeId, sha256, schemaVersion, model, hashes.get(sha256), randomUUID(), metadata]);
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  });
}

/** The same bundle Account uses for its café seed. The saved byte hashes survive reseeds and restarts. */
export async function analyzeCafePhotoSeed(analysis: ReturnType<typeof createPhotoAnalysis>, storeId: string, signal: AbortSignal) {
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const catalog = source.listCatalog();
  const menus = new Map<string, string>(catalog.menus.map((menu: { menuId: string; names: { en: string } }) =>
    [menu.menuId, menu.names.en]));
  let ready = 0;
  let failed = 0;
  const photos = catalog.photos.values();
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (const { photoId, menuId } of photos) {
      signal.throwIfAborted();
      try {
        const photo = await source.readPhoto(photoId);
        if (!photo) throw new Error('Missing cafe photo');
        await analysis.get(storeId, photo, menus.get(menuId) ?? '', signal);
        ready++;
      } catch {
        signal.throwIfAborted();
        failed++;
      }
    }
  }));
  return { ready, failed };
}
