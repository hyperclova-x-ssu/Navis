import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { PHOTO_META } from '../../../../frontend/server/promo/test/helpers.mjs';
import { loadPhotoExamples } from '../../../../frontend/server/promo/templates/runtime.mjs';
import * as photoAnalysis from '../../../workers/marketing-worker/promo/photo-analysis.ts';
import * as backfill from '../../../workers/marketing-worker/promo/photo-backfill.ts';
import { CAFE_PHOTO_ANALYSIS_MODEL, CLAUDE_API_MODEL } from '../../../../frontend/server/promo/scene-provider.mjs';
import { createExamplePhotoSource } from '../../../../frontend/server/promo/photo-source.mjs';
import { inStore } from '../transaction.ts';
import { analysisKey, queuePhotoAnalysis, schemaVersion } from './photo-analysis-store.ts';

const url = process.env.NAVIS_B16_TEST_DB_URL;

it.runIf(Boolean(url))('imports seed rows by known photo hash without overwriting existing metadata or invoking a provider', async () => {
  const database = new pg.Pool({ connectionString: url });
  const store = randomUUID();
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const [{ photoId }] = [...source.listCatalog().photos.values()];
  const image = await source.readPhoto(photoId);
  if (!image) throw new Error('Expected a bundled photo');
  const row = { ...analysisKey(image.bytes), metadata: PHOTO_META };
  const bundle = { storeId: store, model: CAFE_PHOTO_ANALYSIS_MODEL, schemaVersion, rows: [row] };
  try {
    await expect(backfill.importCafePhotoSeed(database, store, { ...bundle,
      rows: [row, { ...row, sha256: 'a'.repeat(64) }] })).rejects.toThrow('Invalid promo photo snapshot row');
    expect(await backfill.exportCafePhotoSeed(database, store)).toEqual({ ...bundle, rows: [] });
    expect(await backfill.importCafePhotoSeed(database, store, bundle)).toBe(1);
    expect(await backfill.importCafePhotoSeed(database, store, { ...bundle,
      rows: [{ ...row, metadata: { ...row.metadata, subject: 'Different' } }] })).toBe(0);
    expect(await backfill.exportCafePhotoSeed(database, store)).toEqual(bundle);
    const opus = { ...bundle, model: CLAUDE_API_MODEL, rows: [{ ...row, metadata: { ...row.metadata, subject: 'Opus analysis' } }] };
    expect(await backfill.importCafePhotoSeed(database, store, opus)).toBe(1);
    const invoke = vi.fn();
    const cache = photoAnalysis.createPhotoAnalysis({ database, load: vi.fn(), invoke, preferredModels: backfill.cafePhotoSeedModels });
    expect(await cache.resolve(store, image, 'Latte', AbortSignal.timeout(8000))).toEqual(opus.rows[0].metadata);
    expect(invoke).not.toHaveBeenCalled();
    await expect(backfill.importCafePhotoSeed(database, store, { ...bundle, model: 'unapproved' })).rejects.toThrow('Invalid promo photo snapshot');
  } finally { await database.end(); }
});

it.runIf(Boolean(url))('reuses Claude seed metadata, gives only the upload to HCX, and uses neutral defaults on bad HCX output', async () => {
  const database = new pg.Pool({ connectionString: url, max: 4 });
  const store = randomUUID();
  const image = (value: string) => ({ bytes: Buffer.from(value), mediaType: 'image/jpeg' });
  const seeds = image('preanalyzed seed');
  const upload = image('new owner photo');
  const signal = AbortSignal.timeout(8_000);
  const claude = vi.fn(async () => ({ state: 'received' as const, output: PHOTO_META, usage: null }));
  const examples = loadPhotoExamples();
  const hcx = vi.fn(async (_id: string, _request: { prompt: string; schema: object }) =>
    ({ state: 'received' as const, output: {}, usage: null }));
  const load = vi.fn(async () => upload);
  try {
    await photoAnalysis.createPhotoAnalysis({ database, load, invoke: claude, analysisModel: 'claude-seed' }).get(store, seeds, 'Latte', signal);
    await inStore(database, store, db => queuePhotoAnalysis(db, store, { ...analysisKey(upload.bytes),
      fileId: randomUUID(), resourceId: 'cafe-latte-01', menuName: 'Latte' }));
    const cache = photoAnalysis.createPhotoAnalysis({ database, load, invoke: hcx, preferredModels: [CLAUDE_API_MODEL, 'claude-seed'], examples });
    expect(await cache.resolve(store, seeds, 'Latte', signal)).toEqual(PHOTO_META);
    expect(await cache.runNext(store, signal)).toBe(true);
    expect(await cache.resolve(store, upload, 'Latte', signal)).toMatchObject({ kind: 'other', items: [], captionHints: [] });
    expect(await cache.resolve(store, image('missing seed'), 'Latte', signal)).toMatchObject({ kind: 'other', items: [] });
    expect(claude).toHaveBeenCalledTimes(1);
    expect(hcx).toHaveBeenCalledTimes(1);
    const [, request] = hcx.mock.calls[0];
    expect(request.prompt).toContain('Valid example outputs');
    for (const example of examples) expect(request.prompt).toContain(example.subject);
    expect(request.schema).toMatchObject({ additionalProperties: false });
    expect(await cache.runNext(store, signal)).toBe(false);
  } finally { await database.end(); }
});

it.runIf(Boolean(url))('queues owner photos and shares one paid claim across callers without sharing across stores', async () => {
  const database = new pg.Pool({ connectionString: url, max: 4 });
  const store = randomUUID(), other = randomUUID();
  const source = { bytes: Buffer.from('same photo bytes'), mediaType: 'image/jpeg' };
  const load = vi.fn(async () => source);
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const invoke = vi.fn(async () => {
    await wait;
    return { state: 'received' as const, output: PHOTO_META, usage: null };
  });
  const cache = photoAnalysis.createPhotoAnalysis({ database, load, invoke });
  const signal = AbortSignal.timeout(8_000);
  try {
    const photo = { ...analysisKey(source.bytes), fileId: randomUUID(), resourceId: 'cafe-latte-01', menuName: 'Latte' };
    await inStore(database, store, db => queuePhotoAnalysis(db, store, photo));
    expect(await database.query('SELECT 1 FROM marketing.promo_photo_analysis')).toMatchObject({ rowCount: 0 });
    const queued = cache.runNext(store, signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const same = cache.get(store, source, 'Latte', signal);
    finish();
    expect(await queued).toBe(true);
    expect(await same).toEqual(PHOTO_META);
    expect(await cache.get(store, source, 'Latte', signal)).toEqual(PHOTO_META);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await cache.get(other, source, 'Latte', signal)).toEqual(PHOTO_META);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(await cache.runNext(store, signal)).toBe(false);
  } finally {
    finish();
    await database.end();
  }
});
