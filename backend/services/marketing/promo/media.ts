import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createObjectStorage, type ObjectStorage } from '../../../packages/object-storage/index.ts';
import { inStore } from '../transaction.ts';
import { isUuid, sha256, type ArtifactPurpose, type FileScope, type PromoArtifacts } from './contracts.ts';

type MediaRow = { object_key: string; sha256: string; bytes: number; content_type: string };
type StoredPurpose = Exclude<ArtifactPurpose, 'promo_input'> | 'promo_poster' | 'promo_scene';
type ArtifactRow = MediaRow & { file_id: string; ready: boolean; purpose: StoredPurpose };
const columns = 'object_key, sha256, bytes, content_type';
const maxMediaBytes = 16 * 1024 * 1024;
const fixtureName = /^(reference\/ref-[0-9]+\/(poster\.jpg|preview\.mp4)|music\/[a-z0-9-]+\.m4a)$/;

export function configuredPromoMediaStorage(env: NodeJS.ProcessEnv = process.env) {
  return env.NAVIS_OBJECT_STORAGE_MEDIA_ENABLED === '1' ? createObjectStorage(env) : undefined;
}

export function byteRange(header: string, size: number) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!range || (!range[1] && !range[2])) return null;
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  return Number.isSafeInteger(start) && start <= end && start < size ? { start, end } : null;
}

export function createPromoMedia(pool: Pool, storage: ObjectStorage) {
  async function findArtifact(scope: FileScope, fileId: string, existingDb?: PoolClient) {
    if (!isUuid(scope.resourceId) || !isUuid(fileId)) return;
    const query = (db: PoolClient) => db.query<ArtifactRow>(`
      SELECT file_id, ready, purpose, ${columns} FROM marketing.promo_job_media
      WHERE store_id = $1 AND job_id = $2 AND file_id = $3`, [scope.storeId, scope.resourceId, fileId]);
    const { rows } = existingDb ? await query(existingDb) : await inStore(pool, scope.storeId, query);
    return rows[0];
  }

  async function open(row: MediaRow, signal?: AbortSignal, range?: { start: number; end: number }) {
    const response = range
      ? await storage.getRange?.(row.object_key, `bytes=${range.start}-${range.end}`, signal)
      : await storage.get(row.object_key, signal);
    const length = range ? range.end - range.start + 1 : row.bytes;
    if (!response || response.contentType !== row.content_type || response.contentLength !== length
        || (range && (!('contentRange' in response) || response.contentRange !== `bytes ${range.start}-${range.end}/${row.bytes}`))) {
      response?.body.destroy();
      throw new Error('Promo object unavailable');
    }
    return response.body;
  }

  async function read(row: MediaRow, signal?: AbortSignal) {
    const stream = await open(row, signal);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > row.bytes) throw new Error('Promo object exceeds its recorded size');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    if (size !== row.bytes || sha256(bytes) !== row.sha256) throw new Error('Promo object checksum mismatch');
    return { bytes, mime: row.content_type };
  }

  async function readArtifact(scope: FileScope, fileId: string, signal?: AbortSignal, db?: PoolClient) {
    const row = await findArtifact(scope, fileId, db);
    if (!row) return;
    if (!row.ready) throw new Error('Promo object upload pending');
    return read(row, signal);
  }

  async function putArtifact(scope: FileScope, identity: string, purpose: StoredPurpose, mime: string, bytes: Buffer, signal?: AbortSignal) {
    const { storeId, resourceId: jobId } = scope;
    if (!isUuid(storeId) || !isUuid(jobId) || !/^[A-Za-z0-9_-]{1,128}$/.test(identity)
        || !bytes.length || bytes.length > maxMediaBytes) throw new Error('Invalid promo artifact');
    const id = randomUUID();
    const checksum = sha256(bytes);
    const objectKey = `stores/${storeId}/promo/jobs/${jobId}/${id}`;
    const row = await inStore(pool, storeId, async db => {
      const { rows: [saved] } = await db.query<ArtifactRow>(`
        INSERT INTO marketing.promo_job_media
          (store_id, job_id, file_id, identity, purpose, object_key, sha256, bytes, content_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (store_id, job_id, purpose, identity) DO NOTHING
        RETURNING file_id, ready, purpose, ${columns}`, [storeId, jobId, id, identity, purpose, objectKey, checksum, bytes.length, mime]);
      if (saved) return saved;
      const { rows: [prior] } = await db.query<ArtifactRow>(`
        SELECT file_id, ready, purpose, ${columns} FROM marketing.promo_job_media
        WHERE store_id = $1 AND job_id = $2 AND purpose = $3 AND identity = $4`, [storeId, jobId, purpose, identity]);
      if (!prior || prior.sha256 !== checksum || prior.bytes !== bytes.length || prior.content_type !== mime) {
        throw new Error('Promo artifact identity conflict');
      }
      return prior;
    });
    if (row.ready) return row.file_id;
    await storage.put(row.object_key, bytes, mime, signal);
    signal?.throwIfAborted();
    await inStore(pool, storeId, db => db.query(`
      UPDATE marketing.promo_job_media SET ready = true
      WHERE store_id = $1 AND job_id = $2 AND file_id = $3`, [storeId, jobId, row.file_id]));
    return row.file_id;
  }

  function artifacts(fallback: PromoArtifacts): PromoArtifacts {
    return {
      put: (scope, identity, purpose, mime, bytes, signal) => purpose === 'promo_input'
        ? fallback.put(scope, identity, purpose, mime, bytes, signal)
        : putArtifact(scope, identity, purpose, mime, bytes, signal),
      async read(scope, fileId, signal) {
        return await readArtifact(scope, fileId, signal) ?? fallback.read(scope, fileId, signal);
      },
    };
  }

  async function fixture(storeId: string, name: string) {
    return inStore(pool, storeId, async db => {
      const { rows: [row] } = await db.query<MediaRow>(`
        SELECT ${columns} FROM marketing.promo_fixture_media WHERE store_id = $1 AND name = $2`, [storeId, name]);
      return row;
    });
  }

  async function readMusic(storeId: string, file: string, signal?: AbortSignal) {
    const name = `music/${file}`;
    if (!fixtureName.test(name)) throw new Error('Invalid promo music filename');
    const row = await fixture(storeId, name);
    if (!row || row.content_type !== 'audio/mp4') throw new Error('Promo music unavailable');
    return (await read(row, signal)).bytes;
  }

  async function referenceNames(storeId: string) {
    return inStore(pool, storeId, async db => {
      const { rows } = await db.query<{ name: string }>(`
        SELECT name FROM marketing.promo_fixture_media WHERE store_id = $1 AND name LIKE 'reference/%'`, [storeId]);
      return new Set(rows.map(row => row.name));
    });
  }

  async function send(reply: FastifyReply, row: MediaRow, options: { range?: string; privateCache?: boolean } = {}) {
    const range = options.range ? byteRange(options.range, row.bytes) : undefined;
    if (range === null) return reply.code(416).header('content-range', `bytes */${row.bytes}`).send();
    const body = await open(row, undefined, range);
    reply.type(row.content_type).header('accept-ranges', 'bytes').header('x-content-type-options', 'nosniff');
    if (options.privateCache) reply.header('cache-control', 'private, max-age=86400').header('etag', `"${row.sha256}"`)
      .header('vary', 'Authorization');
    if (!range) return reply.header('content-length', row.bytes).send(body);
    return reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${row.bytes}`)
      .header('content-length', range.end - range.start + 1).send(body);
  }

  return { artifacts, findArtifact, putArtifact, readArtifact, fixture, referenceNames, readMusic, send };
}

export async function seedPromoFixtureMedia(pool: Pool, storage: ObjectStorage, storeId: string,
  files: Iterable<{ name: string; mime: string; bytes: Buffer }> | AsyncIterable<{ name: string; mime: string; bytes: Buffer }>) {
  if (!isUuid(storeId)) throw new Error('Invalid promo seed store');
  const ready: Array<{ name: string; mime: string; objectKey: string; checksum: string; size: number }> = [];
  for await (const { name, mime, bytes } of files) {
    if (!fixtureName.test(name) || !bytes.length || bytes.length > maxMediaBytes) throw new Error('Invalid promo fixture');
    const checksum = sha256(bytes);
    const objectKey = `stores/${storeId}/promo/fixtures/${checksum}/${name}`;
    await storage.put(objectKey, bytes, mime);
    ready.push({ name, mime, objectKey, checksum, size: bytes.length });
  }
  await inStore(pool, storeId, async db => {
    for (const { name, mime, objectKey, checksum, size } of ready) await db.query(`
      INSERT INTO marketing.promo_fixture_media (store_id, name, content_type, object_key, sha256, bytes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (store_id, name) DO UPDATE SET
        content_type = EXCLUDED.content_type, object_key = EXCLUDED.object_key, sha256 = EXCLUDED.sha256,
        bytes = EXCLUDED.bytes, updated_at = clock_timestamp()
      WHERE promo_fixture_media.sha256 <> EXCLUDED.sha256`, [storeId, name, mime, objectKey, checksum, size]);
  }, { serialize: true });
  return ready.length;
}

/** Copy a bounded batch of completed-job artifacts from the old Account volume, preserving their file ids. */
export async function backfillPromoJobMedia(pool: Pool, storage: ObjectStorage,
  legacy: Pick<PromoArtifacts, 'read'>, storeId: string) {
  if (!isUuid(storeId)) throw new Error('Invalid promo backfill store');
  const { rows } = await inStore(pool, storeId, db => db.query<{
    job_id: string; file_id: string; purpose: 'promo_output' | 'promo_checkpoint';
  }>(`
    SELECT candidate.job_id, candidate.file_id, candidate.purpose
    FROM (
      SELECT job_id, asset_id AS file_id, 'promo_output' AS purpose
      FROM marketing.promo_job WHERE store_id = $1 AND status = 'done'
      UNION ALL
      SELECT checkpoint.job_id, checkpoint.asset_id, 'promo_checkpoint'
      FROM marketing.promo_checkpoint AS checkpoint JOIN marketing.promo_job AS job USING (store_id, job_id)
      WHERE job.store_id = $1 AND job.status = 'done'
    ) AS candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM marketing.promo_job_media AS media
      WHERE media.store_id = $1 AND media.job_id = candidate.job_id AND media.file_id = candidate.file_id
    )
    ORDER BY candidate.job_id, candidate.file_id LIMIT 50`, [storeId]));
  for (const { job_id: jobId, file_id: fileId, purpose } of rows) {
    const { bytes, mime } = await legacy.read({ storeId, resourceId: jobId }, fileId);
    const expected = purpose === 'promo_output' ? 'video/mp4' : 'application/json';
    if (!bytes.length || bytes.length > maxMediaBytes || mime !== expected) throw new Error('Invalid legacy promo artifact');
    const checksum = sha256(bytes);
    const key = `stores/${storeId}/promo/jobs/${jobId}/${fileId}/${checksum}`;
    await storage.put(key, bytes, mime);
    // Publish the bucket row only after upload so the old copy remains readable on partial failure.
    await inStore(pool, storeId, db => db.query(`
      INSERT INTO marketing.promo_job_media
        (store_id, job_id, file_id, identity, purpose, object_key, sha256, bytes, content_type, ready)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
      ON CONFLICT (store_id, job_id, file_id) DO NOTHING`, [storeId, jobId, fileId, `legacy-${fileId}`, purpose, key, checksum, bytes.length, mime]));
  }
  return rows.length;
}
