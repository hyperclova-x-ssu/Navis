import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createExamplePhotoSource } from '../../../frontend/server/promo/photo-source.mjs';
import { promoSeedFileId } from '../contracts/promo-photos.ts';
import { demoIdentity } from '../../services/account/identity.ts';
import { inStore } from '../../services/account/transaction.ts';

export async function seedCafePromoPhotos(pool: Pool, ownerId: string = demoIdentity.userId) {
  const storeId = demoIdentity.storeId;
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const photos = source.listPhotoIds();
  await inStore(pool, storeId, async client => {
    const { rowCount } = await client.query(
      "SELECT 1 FROM account.store_member WHERE store_id=$1 AND user_id=$2 AND role='owner'", [storeId, ownerId]);
    if (!rowCount) throw new Error('Seed promo photo owner unavailable');
    for (const photoId of photos) {
      const photo = await source.readPhoto(photoId);
      if (!photo || photo.bytes.length > 4 * 1024 * 1024) throw new Error('Seed promo photo unavailable');
      await client.query(`
        INSERT INTO account.attachment (store_id, file_id, user_id, idempotency_key, purpose, content_type, size, sha256, state, bytes)
        VALUES ($1,$2,$3,$4,'promo-photo',$5,$6,$7,'complete',$8)
        ON CONFLICT (store_id, file_id) DO NOTHING`,
      [storeId, promoSeedFileId(storeId, photoId), ownerId, `promo-seed:${photoId}`, photo.mediaType,
        photo.bytes.length, createHash('sha256').update(photo.bytes).digest('hex'), photo.bytes]);
    }
  });
}
