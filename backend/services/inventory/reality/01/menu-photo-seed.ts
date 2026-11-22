import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { seedCatalog } from '../../../../../frontend/src/data/db/generated/catalog.ts';
import { demoIdentity } from '../../../account/identity.ts';
import { inStore } from '../../../account/transaction.ts';

export function menuSeedFileId(storeId: string, menuId: string): string {
  const digest = createHash('sha256').update(JSON.stringify(['menu-photo', storeId, menuId])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function seedCafeMenuPhotos(pool: Pool): Promise<void> {
  const { storeId, userId } = demoIdentity;
  const photos = await Promise.all(seedCatalog.menu.map(async ({ menuId }) => {
    const filename = `cafe-${menuId.slice(2)}-01.jpeg`;
    const bytes = await readFile(new URL(`../../../../../frontend/public/menu-photos/${filename}`, import.meta.url));
    if (bytes.length > 4 * 1024 * 1024 || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) {
      throw new Error(`Invalid café menu photo: ${filename}`);
    }
    return { menuId, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  await inStore(pool, storeId, async client => {
    const { rowCount } = await client.query(
      "SELECT 1 FROM account.store_member WHERE store_id=$1 AND user_id=$2 AND role='owner'", [storeId, userId]);
    if (!rowCount) throw new Error('Seed menu photo owner unavailable');
    for (const { menuId, bytes, sha256 } of photos) {
      await client.query(`
        INSERT INTO account.attachment (store_id, file_id, user_id, idempotency_key, purpose, content_type, size, sha256, state, bytes)
        VALUES ($1,$2,$3,$4,'menu-photo','image/jpeg',$5,$6,'complete',$7)
        ON CONFLICT (store_id, file_id) DO NOTHING
      `, [storeId, menuSeedFileId(storeId, menuId), userId, `menu-photo-seed:${menuId}`, bytes.length, sha256, bytes]);
    }
  });
}
