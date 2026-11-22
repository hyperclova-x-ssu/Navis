import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { PromoError } from '../../../../frontend/server/promo/errors.mjs';
import { photoMetaPrompt, PHOTO_META_SCHEMA } from '../../../../frontend/server/promo/prompts.mjs';
import { validateSchema } from '../../../../frontend/server/promo/schema.mjs';
import { analysisKey, model, schemaVersion } from '../../../services/marketing/promo/photo-analysis-store.ts';
import { inStore } from '../../../services/marketing/transaction.ts';
import type { ModelRequest, PromoProvider, Received } from './providers.ts';

type Image = { bytes: Buffer; mediaType: string };
type Source = { sha256: string; fileId: string; resourceId: string; menuName: string };
type Code = 'AI_TIMEOUT' | 'AI_BAD_OUTPUT' | 'AI_UNAVAILABLE';
type State = { state: 'queued' | 'running' | 'ready' | 'failed'; metadata: object | null; failCode: Code | null };
const keyWhere = 'store_id = $1 AND image_sha256 = $2 AND schema_version = $3 AND model = $4';
const stateColumns = 'state, metadata, fail_code AS "failCode"';
const neutralMeta = {
  kind: 'other', subject: '', items: [], flavors: [], people: 'none', textInImage: '',
  focus: { x: 0.5, y: 0.5 }, captionHints: [], quality: 'good', menuShown: 'no', amount: 'none',
};

export function createPhotoAnalysis({ database, load, invoke, meter, analysisModel = model, preferredModels = [], examples = [] }: {
  database: Pool;
  analysisModel?: string;
  preferredModels?: readonly string[];
  examples?: object[];
  load(storeId: string, source: Source, signal: AbortSignal): Promise<Image>;
  invoke(attemptId: string, request: ModelRequest): ReturnType<PromoProvider['invoke']>;
  meter?(storeId: string, attemptId: string, result: Received): Promise<void>;
}) {
  async function get(storeId: string, { bytes, mediaType }: Image, menuName: string, signal: AbortSignal) {
    const { sha256 } = analysisKey(bytes);
    const key = [storeId, sha256, schemaVersion, analysisModel];
    const claimId = randomUUID();
    signal.throwIfAborted();
    const claimed = await inStore(database, storeId, async db => {
      const inserted = await db.query(`
        INSERT INTO marketing.promo_photo_analysis
          (store_id, image_sha256, schema_version, model, menu_name, state, claim_id, started_at)
        VALUES ($1, $2, $3, $4, $5, 'running', $6, clock_timestamp()) ON CONFLICT DO NOTHING`,
      [...key, menuName, claimId]);
      if (inserted.rowCount) return true;
      const started = await db.query(`
        UPDATE marketing.promo_photo_analysis SET state = 'running', claim_id = $5, started_at = clock_timestamp()
        WHERE ${keyWhere} AND state = 'queued'`, [...key, claimId]);
      return Boolean(started.rowCount);
    });
    if (claimed) {
      let result;
      try {
        result = await invoke(claimId, { prompt: photoMetaPrompt(menuName, examples), schema: PHOTO_META_SCHEMA,
          images: [{ bytes, mediaType, lookKey: sha256 }], timeoutMs: 60_000, signal });
      } catch {
        result = { state: 'unknown' } as const;
      }
      const received = result.state === 'received' ? result : null;
      const data = received && !received.error && !validateSchema(PHOTO_META_SCHEMA, received.output).length
        ? received.output : null;
      const code = result.state === 'unknown' ? 'AI_TIMEOUT'
        : !received || received.error === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE' : 'AI_BAD_OUTPUT';
      const settled = await inStore(database, storeId, db => db.query(`
        UPDATE marketing.promo_photo_analysis SET state = $6, metadata = $7, fail_code = $8
        WHERE ${keyWhere} AND claim_id = $5 AND state = 'running'`,
      [...key, claimId, data ? 'ready' : 'failed', data, data ? null : code]));
      if (received && meter) await meter(storeId, claimId, received);
      if (!settled.rowCount) throw new PromoError('AI_TIMEOUT', undefined);
      if (!data) throw new PromoError(code, undefined);
      return data;
    }
    for (;;) {
      signal.throwIfAborted();
      const row = await inStore(database, storeId, async db => {
        await db.query(`
          UPDATE marketing.promo_photo_analysis SET state = 'failed', fail_code = 'AI_TIMEOUT'
          WHERE ${keyWhere} AND state = 'running' AND started_at < clock_timestamp() - interval '5 minutes'`, key);
        return (await db.query<State>(`SELECT ${stateColumns} FROM marketing.promo_photo_analysis WHERE ${keyWhere}`, key)).rows[0];
      });
      if (row.state === 'ready') return row.metadata;
      if (row.state === 'failed') throw new PromoError(row.failCode, undefined);
      await delay(200, undefined, { signal });
    }
  }

  async function resolve(storeId: string, image: Image, menuName: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const { sha256 } = analysisKey(image.bytes);
    const found = await inStore(database, storeId, db => db.query<State & { model: string; fileId: string | null }>(`
      SELECT ${stateColumns}, model, file_id AS "fileId" FROM marketing.promo_photo_analysis
      WHERE store_id = $1 AND image_sha256 = $2 AND schema_version = $3
        AND (model = $4 AND file_id IS NOT NULL OR model = ANY($5::text[]) AND file_id IS NULL AND state = 'ready')`,
    [storeId, sha256, schemaVersion, analysisModel, preferredModels]));
    const upload = found.rows.find(row => row.model === analysisModel && row.fileId !== null);
    if (upload) {
      try { return await get(storeId, image, menuName, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PromoError)) throw error;
        return structuredClone(neutralMeta);
      }
    }
    for (const preferredModel of preferredModels) {
      const seeded = found.rows.find(row => row.model === preferredModel)?.metadata;
      if (seeded && !validateSchema(PHOTO_META_SCHEMA, seeded).length) return seeded;
    }
    return structuredClone(neutralMeta);
  }

  async function runNext(storeId: string, signal: AbortSignal) {
    const { rows: [source] } = await inStore(database, storeId, db => db.query<Source>(`
      SELECT image_sha256 AS sha256, file_id AS "fileId", resource_id AS "resourceId", menu_name AS "menuName"
      FROM marketing.promo_photo_analysis WHERE store_id = $1 AND schema_version = $2 AND model = $3 AND state = 'queued'
      ORDER BY created_at, image_sha256 LIMIT 1`, [storeId, schemaVersion, analysisModel]));
    if (!source) return false;
    const image = await load(storeId, source, signal);
    if (analysisKey(image.bytes).sha256 !== source.sha256) throw new PromoError('AI_BAD_OUTPUT', undefined);
    try { await get(storeId, image, source.menuName, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof PromoError)) throw error;
    }
    return true;
  }

  return { get, resolve, runNext };
}
