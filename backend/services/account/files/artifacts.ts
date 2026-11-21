import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inStore } from '../transaction.ts';
import type { PromoStorage } from './storage.ts';

export const maxArtifactBytes = 16 * 1024 * 1024;
export const maxPhotoBytes = 4 * 1024 * 1024;
export const mimeByPurpose = {
  promo_input: ['image/jpeg', 'image/png', 'image/webp'],
  promo_checkpoint: ['application/json', 'application/octet-stream'],
  promo_output: ['video/mp4'],
} as const;

export type Purpose = keyof typeof mimeByPurpose;
export interface ResourceScope {
  storeId: string;
  resourceId: string;
}
export interface Registration extends ResourceScope {
  artifactId: string;
  purpose: Purpose;
  mime: string;
  sizeBytes: number;
  sha256: string;
}
interface Artifact {
  file_id: string;
  resource_id: string;
  purpose: Purpose;
  storage_key: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  status: 'uploading' | 'ready' | 'deleted';
}

function receipt(artifact: Artifact) {
  return { fileId: artifact.file_id, status: artifact.status };
}

function matches(artifact: Artifact, bytes: Buffer) {
  return bytes.length === artifact.size_bytes && createHash('sha256').update(bytes).digest('hex') === artifact.sha256;
}

const fields = 'file_id, resource_id, purpose, storage_key, mime, size_bytes::int, sha256, status';

async function find(client: PoolClient, storeId: string, fileId: string, lock = false) {
  const result = await client.query<Artifact>(`
    SELECT ${fields}
    FROM account.file_object WHERE store_id = $1 AND file_id = $2
    ${lock ? 'FOR UPDATE' : ''}
  `, [storeId, fileId]);
  return result.rows[0];
}

export function createPromoArtifacts(pool: Pool, storage: PromoStorage) {
  async function verifiedBytes(artifact: Artifact) {
    const bytes = await storage.read(artifact.storage_key);
    return bytes && matches(artifact, bytes) ? bytes : undefined;
  }

  async function register(input: Registration) {
    const acceptedMime: readonly string[] = mimeByPurpose[input.purpose];
    if (!acceptedMime.includes(input.mime) || (input.purpose === 'promo_input' && input.sizeBytes > maxPhotoBytes)) {
      return 'INVALID_REQUEST' as const;
    }

    try {
      return await inStore(pool, input.storeId, async (client) => {
        const fileId = randomUUID();
        const identity = [input.storeId, input.purpose, input.resourceId, input.artifactId];
        const inserted = await client.query<Artifact>(`
          INSERT INTO account.file_object (store_id, purpose, resource_id, artifact_id,
            file_id, storage_key, mime, size_bytes, sha256)
          VALUES ($1, $2, $3, $4, $5, $5::uuid::text, $6, $7, $8)
          ON CONFLICT (store_id, purpose, resource_id, artifact_id) DO NOTHING
          RETURNING ${fields}
        `, [...identity, fileId, input.mime, input.sizeBytes, input.sha256]);
        if (inserted.rows[0]) return receipt(inserted.rows[0]);

        const result = await client.query<Artifact>(`
          SELECT ${fields} FROM account.file_object
          WHERE store_id = $1 AND purpose = $2 AND resource_id = $3 AND artifact_id = $4
          FOR UPDATE
        `, identity);
        const existing = result.rows[0];
        if (existing.sha256 !== input.sha256 || existing.mime !== input.mime || existing.size_bytes !== input.sizeBytes) {
          return 'ARTIFACT_CONFLICT' as const;
        }
        if (existing.status === 'deleted') {
          await client.query(`
            UPDATE account.file_object SET status = 'uploading', created_at = statement_timestamp()
            WHERE store_id = $1 AND file_id = $2
          `, [input.storeId, existing.file_id]);
          existing.status = 'uploading';
        }
        return receipt(existing);
      });
    } catch (error) {
      if (error instanceof Error && 'constraint' in error && error.constraint === 'file_object_store_fk') return 'NOT_FOUND' as const;
      throw error;
    }
  }

  function upload(storeId: string, fileId: string, bytes: Buffer) {
    return inStore(pool, storeId, async (client) => {
      const artifact = await find(client, storeId, fileId, true);
      if (!artifact || artifact.status === 'deleted') return 'NOT_FOUND' as const;
      if (!matches(artifact, bytes)) return 'INVALID_REQUEST' as const;
      if (artifact.status === 'ready') return (await verifiedBytes(artifact)) ? null : 'ARTIFACT_NOT_READY' as const;
      await storage.write(artifact.storage_key, bytes);
      return null;
    });
  }

  function verify(scope: ResourceScope, fileId: string) {
    return inStore(pool, scope.storeId, async (client) => {
      const artifact = await find(client, scope.storeId, fileId, true);
      if (!artifact || artifact.resource_id !== scope.resourceId || artifact.status === 'deleted') return 'NOT_FOUND' as const;
      if (!await verifiedBytes(artifact)) return 'ARTIFACT_NOT_READY' as const;
      if (artifact.status === 'uploading') {
        await client.query("UPDATE account.file_object SET status = 'ready' WHERE store_id = $1 AND file_id = $2", [scope.storeId, fileId]);
        artifact.status = 'ready';
      }
      return receipt(artifact);
    });
  }

  function read(storeId: string, fileId: string, purposes: readonly Purpose[], resourceId?: string) {
    return inStore(pool, storeId, async (client) => {
      const artifact = await find(client, storeId, fileId);
      if (!artifact || !purposes.includes(artifact.purpose) ||
          (resourceId !== undefined && artifact.resource_id !== resourceId) || artifact.status === 'deleted') {
        return 'NOT_FOUND' as const;
      }
      if (artifact.status !== 'ready') return 'ARTIFACT_NOT_READY' as const;
      const bytes = await verifiedBytes(artifact);
      return bytes ? { fileId: artifact.file_id, mime: artifact.mime, bytes } : 'ARTIFACT_NOT_READY' as const;
    });
  }

  function cleanup(storeId: string) {
    return inStore(pool, storeId, async (client) => {
      const { rows } = await client.query<Pick<Artifact, 'file_id' | 'storage_key'>>(`
        SELECT file_id, storage_key FROM account.file_object
        WHERE store_id = $1 AND status = 'uploading' AND created_at <= statement_timestamp() - interval '1 day'
        ORDER BY created_at, file_id LIMIT 50 FOR UPDATE SKIP LOCKED
      `, [storeId]);
      // A failed commit leaves only an uploading row, so the next cleanup can safely repeat removal.
      for (const artifact of rows) await storage.remove(artifact.storage_key);
      await client.query("UPDATE account.file_object SET status = 'deleted' WHERE store_id = $1 AND file_id = ANY($2::uuid[])",
        [storeId, rows.map((artifact) => artifact.file_id)]);
      return { deleted: rows.length };
    });
  }

  return { register, upload, verify, read, cleanup };
}
