import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { validateMedia } from '../../../../frontend/server/media/validation.mjs';
import { uuid as uuidPattern, invalid, record } from '../reality/00/wire.ts';
import { accountErrors, notFound } from '../reality/00/routes.ts';
import { inStore } from '../transaction.ts';

const prefix = '/internal/v1/account/stores/:storeId/promo-input';
const ownerPhotos = `
  FROM account.attachment f JOIN account.store_member m ON (m.store_id, m.user_id) = (f.store_id, f.user_id)
  WHERE f.store_id=$1 AND f.user_id=$2 AND m.role='owner' AND f.purpose='promo-photo' AND f.state='complete'
`;
const digest = (value: string) => createHash('sha256').update(value).digest();

function id(value: unknown) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid('fileId');
  return value.toLowerCase();
}

function webpDimensions(bytes: Buffer) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP'
    || bytes.readUInt32LE(4) !== bytes.length - 8) return;
  let canvas: { width: number; height: number } | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > bytes.length) return;
    if (kind === 'VP8X' && size === 10 && offset === 12) {
      canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
    } else if (kind === 'VP8L' && size > 5 && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1);
      return canvas ?? { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (kind === 'VP8 ' && size > 10 && (bytes[start] & 1) === 0
      && bytes.subarray(start + 3, start + 6).equals(Buffer.from('9d012a', 'hex'))) {
      return canvas ?? { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
    } else if (kind === 'ANMF' && size > 16 && canvas) {
      return canvas;
    }
    offset = next;
  }
}

function dimensions(mime: string, bytes: Buffer) {
  try {
    const result = mime === 'image/webp' ? webpDimensions(bytes) : validateMedia('receipt', mime, bytes);
    if (result && 'width' in result && result.width > 0 && result.height > 0 && result.width <= 16384 && result.height <= 16384) {
      return { width: result.width, height: result.height };
    }
  } catch { /* The stored file has no readable dimensions. */ }
}

export function registerPromoInputRoutes(app: FastifyInstance, pool: Pool, token: string) {
  const expected = digest(`Bearer ${token}`);
  const onRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const credential = req.headers.authorization;
    if (!credential || !timingSafeEqual(expected, digest(credential))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
  };
  app.post<{ Params: { storeId: string } }>(prefix + '/ready', { onRequest, bodyLimit: 8192 }, (req, reply) =>
    accountErrors(reply, async () => {
      const storeId = id(req.params.storeId);
      const input = record(req.body, ['actorId', 'fileIds']);
      const actorId = id(input.actorId);
      if (!Array.isArray(input.fileIds) || input.fileIds.length > 160) throw invalid('fileIds');
      const fileIds = input.fileIds.map(id);
      const result = await inStore(pool, storeId, db => db.query<{ fileId: string }>(
        `SELECT f.file_id AS "fileId" ${ownerPhotos} AND f.file_id=ANY($3::uuid[])`, [storeId, actorId, fileIds]));
      return { fileIds: result.rows.map(row => row.fileId) };
    }));
  app.post<{ Params: { storeId: string; fileId: string } }>(prefix + '/:fileId/bytes', { onRequest, bodyLimit: 1024 }, (req, reply) =>
    accountErrors(reply, async () => {
      const storeId = id(req.params.storeId);
      const actorId = id(record(req.body, ['actorId']).actorId);
      const fileId = id(req.params.fileId);
      const { rows: [photo] } = await inStore(pool, storeId, db => db.query<{ mime: string; bytes: Buffer }>(
        `SELECT f.content_type AS mime, f.bytes ${ownerPhotos} AND f.file_id=$3`, [storeId, actorId, fileId]));
      const size = photo && dimensions(photo.mime, photo.bytes);
      if (!size) throw notFound();
      reply.type(photo.mime).header('x-navis-photo-width', size.width).header('x-navis-photo-height', size.height);
      return photo.bytes;
    }));
}
