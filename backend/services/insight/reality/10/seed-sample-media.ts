import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPool } from '../../../../packages/db/index.ts';
import { createObjectStorage } from '../../../../packages/object-storage/index.ts';
import { cctvSampleTypes, seedCctvSampleMedia } from '../../cctv.ts';
import { isUuid } from '../../scope.ts';

const storeId = process.argv[2];
const root = process.argv[3] ?? fileURLToPath(new URL('../../../../../frontend/public/cnn/', import.meta.url));
const storage = process.env.NAVIS_OBJECT_STORAGE_MEDIA_ENABLED === '1' && createObjectStorage();
if (!isUuid(storeId) || !isAbsolute(root) || !storage) {
  throw new Error('Usage: node seed-sample-media.ts <store UUID> [absolute public/cnn directory] with S3 media enabled');
}

const assets = Object.keys(cctvSampleTypes) as (keyof typeof cctvSampleTypes)[];
const database = dbPool('insight', 'migrate');
try {
  for (const asset of assets) await seedCctvSampleMedia(database, storage, storeId, asset, await readFile(join(root, asset)));
  console.info('CCTV sample media seeded', { count: assets.length });
} finally { await database.end(); }
