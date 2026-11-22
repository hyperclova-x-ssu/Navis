import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadReferences } from '../../../../frontend/server/promo/references.mjs';
import { dbPool } from '../../../packages/db/index.ts';
import { isUuid } from './contracts.ts';
import { configuredPromoMediaStorage, seedPromoFixtureMedia } from './media.ts';

const storeId = process.argv[2];
const storage = configuredPromoMediaStorage();
if (!isUuid(storeId) || !storage) throw new Error('Usage: node seed-media.ts <store UUID> with S3 media enabled');

const musicRoot = new URL('../../../../frontend/server/promo/assets/music/', import.meta.url);
const music = JSON.parse(await readFile(new URL('music.json', musicRoot), 'utf8')) as { file: string }[];
const references = loadReferences();

async function* fixtures() {
  for (const [id, ref] of references.refs) {
    yield { name: `reference/${id}/poster.jpg`, mime: 'image/jpeg', bytes: await readFile(ref.posterPath) };
    yield { name: `reference/${id}/preview.mp4`, mime: 'video/mp4', bytes: await readFile(ref.previewPath) };
  }
  for (const { file } of music) {
    if (file !== basename(file) || !/^[a-z0-9-]+\.m4a$/.test(file)) throw new Error('Invalid fixture music file');
    yield { name: `music/${file}`, mime: 'audio/mp4', bytes: await readFile(new URL(file, musicRoot)) };
  }
}

const database = dbPool('marketing', 'migrate');
try {
  const count = await seedPromoFixtureMedia(database, storage, storeId, fixtures());
  console.info('Promo media seeded', { count });
} finally { await database.end(); }
