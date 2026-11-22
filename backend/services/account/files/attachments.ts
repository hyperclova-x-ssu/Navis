import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { emitAccountEvent } from '../reality/00/outbox.ts';
import { accountErrors, accountRoot, accountStoreHandler, notFound, type AccountParams } from '../reality/00/routes.ts';
import { AccountError, integer, invalid, keyPattern, maxAttachmentBytes, option, record, uuid } from '../reality/00/wire.ts';
import { inStore } from '../transaction.ts';

const photoPurposes = ['menu-photo', 'promo-photo', 'custom-reference-photo'] as const;
const purposes = [...photoPurposes, 'receipt-evidence', 'tax-evidence', 'manual-evidence', 'grant-evidence'] as const;
const images = ['image/png', 'image/jpeg', 'image/webp'] as const;
const contentTypes = [...images, 'application/pdf'] as const;
const shaPattern = /^[0-9a-f]{64}$/;
const prefix = `${accountRoot}/files`;

type Metadata = { fileId: string; purpose: typeof purposes[number]; contentType: typeof contentTypes[number]; size: number; sha256: string };
type Attachment = Metadata & { state: 'pending' | 'complete' | 'revoked'; bytes?: Buffer };
const metadataColumns = 'file_id AS "fileId", purpose, content_type AS "contentType", size, sha256';

function formatMatches(bytes: Buffer, contentType: Metadata['contentType']) {
  switch (contentType) {
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/webp': return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'application/pdf': return bytes.toString('ascii', 0, 5) === '%PDF-';
  }
}

function parseMetadata(input: unknown) {
  const data = record(input, ['purpose', 'contentType', 'size', 'sha256']);
  const purpose = option(data.purpose, purposes, 'purpose');
  const contentType = option(data.contentType, photoPurposes.some(photoPurpose => purpose === photoPurpose) ? images : contentTypes, 'contentType');
  if (typeof data.sha256 !== 'string' || !shaPattern.test(data.sha256)) throw invalid('sha256', 'FILE_INVALID');
  return { purpose, contentType, size: integer(data.size, 1, maxAttachmentBytes, 'size'), sha256: data.sha256 };
}

function requireId(value: unknown, field: string) {
  if (typeof value !== 'string' || !uuid.test(value)) throw invalid(field);
  return value.toLowerCase();
}

async function findFile(client: PoolClient, store: string, id: unknown, includeBytes = false) {
  const fileId = requireId(id, 'fileId');
  // Column selection is fixed internally. State and metadata reads avoid fetching the stored bytes.
  const { rows: [file] } = await client.query<Attachment>(`
    SELECT ${metadataColumns}, state ${includeBytes ? ', bytes' : ''}
    FROM account.attachment WHERE store_id = $1 AND file_id = $2
  `, [store, fileId]);
  if (!file || file.state === 'revoked') throw notFound();
  return file;
}

export function registerAttachments(
  app: FastifyInstance, pool: Pool, verifyWorkload: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  { inventoryToken, posToken, insightToken }: { inventoryToken?: string; posToken?: string; insightToken?: string } = {},
) {
  app.register(async scope => {
    const options = { onRequest: verifyWorkload };
    for (const type of contentTypes) scope.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post<{ Params: AccountParams }>(prefix, options, accountStoreHandler(pool, true, async (client, actor, request) => {
      const storeId = actor.store_id;
      const { 'idempotency-key': key } = request.headers;
      if (typeof key !== 'string' || !keyPattern.test(key)) throw invalid('idempotencyKey', 'IDEMPOTENCY_KEY_REQUIRED');
      const metadata = parseMetadata(request.body);
      const { rows: [previous] } = await client.query<Attachment>(`
        SELECT ${metadataColumns} FROM account.attachment
        WHERE store_id = $1 AND user_id = $2 AND idempotency_key = $3
      `, [storeId, actor.sub, key]);
      if (previous) {
        const { fileId, ...original } = previous;
        if (original.purpose !== metadata.purpose || original.contentType !== metadata.contentType
          || original.size !== metadata.size || original.sha256 !== metadata.sha256) {
          throw new AccountError(409, 'CONFLICT', 'IDEMPOTENCY_CONFLICT');
        }
        // Preserve the original upload reservation on a retry, including after removal.
        return { ...original, fileId };
      }
      const fileId = randomUUID();
      await client.query(`
        INSERT INTO account.attachment (store_id, file_id, user_id, idempotency_key, purpose, content_type, size, sha256)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [storeId, fileId, actor.sub, key, metadata.purpose, metadata.contentType, metadata.size, metadata.sha256]);
      return { ...metadata, fileId };
    }, true));

    scope.put<{ Params: AccountParams }>(`${prefix}/:fileId/content`, { ...options, bodyLimit: maxAttachmentBytes },
      accountStoreHandler(pool, true, async (client, { store_id: storeId }, request, reply) => {
        const file = await findFile(client, storeId, request.params.fileId);
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length !== file.size
          || request.headers['content-type']?.split(';')[0] !== file.contentType || !formatMatches(bytes, file.contentType)
          || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw invalid('content', 'FILE_INVALID');
        if (file.state === 'pending') {
          await client.query('UPDATE account.attachment SET bytes = $3 WHERE store_id = $1 AND file_id = $2',
            [storeId, file.fileId, bytes]);
        }
        reply.code(204);
        return null;
      }, true));

    scope.post<{ Params: AccountParams }>(`${prefix}/:fileId/complete`, options, accountStoreHandler(pool, true, async (client, { store_id: storeId }, request) => {
      record(request.body ?? {}, []);
      const { fileId, state, bytes, ...metadata } = await findFile(client, storeId, request.params.fileId, true);
      if (!bytes) throw new AccountError(409, 'CONFLICT', 'FILE_NOT_READY');
      if (state === 'pending') {
        await client.query("UPDATE account.attachment SET state = 'complete' WHERE store_id = $1 AND file_id = $2", [storeId, fileId]);
        await emitAccountEvent(client, 'account.file_changed.v1', fileId, { storeId, fileId, purpose: metadata.purpose, state: 'complete' });
      }
      return { fileId, ...metadata };
    }, true));

    scope.get<{ Params: AccountParams }>(`${prefix}/:fileId/content`, options, accountStoreHandler(pool, true, async (client, { store_id: storeId }, request, reply) => {
      const file = await findFile(client, storeId, request.params.fileId, true);
      if (file.state !== 'complete' || !file.bytes) throw notFound();
      reply.type(file.contentType).header('x-content-type-options', 'nosniff').header('content-disposition', 'attachment');
      return file.bytes;
    }));

    scope.delete<{ Params: AccountParams }>(`${prefix}/:fileId`, options, accountStoreHandler(pool, true, async (client, { store_id: storeId }, request, reply) => {
      const fileId = requireId(request.params.fileId, 'fileId');
      const { rows: [deleted] } = await client.query<{ purpose: Metadata['purpose'] }>(`
        UPDATE account.attachment SET state = 'revoked', bytes = NULL
        WHERE store_id = $1 AND file_id = $2 AND state <> 'revoked' RETURNING purpose
      `, [storeId, fileId]);
      if (deleted) await emitAccountEvent(client, 'account.file_changed.v1', fileId,
        { storeId, fileId, purpose: deleted.purpose, state: 'revoked' });
      reply.code(204);
      return null;
    }, true));
  });

  for (const [purpose, token] of [
    ['menu-photo', inventoryToken], ['custom-reference-photo', posToken], ['manual-evidence', insightToken],
  ] as const) {
    if (!token) continue;
    const digest = (value: string) => createHash('sha256').update(value).digest();
    const expected = digest(`Bearer ${token}`);
    app.post<{ Params: { storeId: string; fileId: string } }>(`${prefix}/:fileId/${purpose}-verify`, {
      onRequest: async (request, reply) => {
        const received = request.headers.authorization;
        if (!received || !timingSafeEqual(expected, digest(received))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      },
    }, (request, reply) => accountErrors(reply, async () => {
      const storeId = requireId(request.params.storeId, 'storeId');
      const fileId = requireId(request.params.fileId, 'fileId');
      const actor = requireId(record(request.body, ['actorId']).actorId, 'actorId');
      const visible = await inStore(pool, storeId, client => client.query(`
        SELECT 1 FROM account.attachment f JOIN account.store_member m USING (store_id)
        WHERE f.store_id = $1 AND f.file_id = $2 AND m.user_id = $3 AND m.role = 'owner'
          AND f.state = 'complete' AND f.purpose = $4 AND (NOT $5::boolean OR f.user_id = $3)
          AND (NOT $6::boolean OR f.content_type = ANY($7::text[]))
      `, [storeId, fileId, actor, purpose, purpose !== 'menu-photo', purpose === 'manual-evidence', images]));
      if (!visible.rowCount) throw notFound();
      reply.code(204);
      return null;
    }));
  }
  if (posToken) {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    const expected = digest(`Bearer ${posToken}`);
    app.post<{ Params: { storeId: string; fileId: string } }>(`${prefix}/:fileId/evidence-verify`, {
      bodyLimit: 1024,
      onRequest: async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const supplied = request.headers.authorization;
        if (!supplied || !timingSafeEqual(expected, digest(supplied))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      },
    }, (request, reply) => accountErrors(reply, async () => {
      const storeId = requireId(request.params.storeId, 'storeId');
      const fileId = requireId(request.params.fileId, 'fileId');
      const { actorId, purpose } = record(request.body, ['actorId', 'purpose']);
      const owner = requireId(actorId, 'actorId');
      if (purpose !== 'tax-evidence') throw invalid('purpose');
      const { rows: [file] } = await inStore(pool, storeId, db => db.query<Metadata>(`
        SELECT ${metadataColumns} FROM account.attachment f JOIN account.store_member m USING (store_id)
        WHERE f.store_id=$1 AND f.file_id=$2 AND m.user_id=$3 AND m.role='owner'
          AND f.purpose='tax-evidence' AND f.state='complete'`, [storeId, fileId, owner]));
      if (!file) throw notFound();
      return file;
    }));
  }
}
