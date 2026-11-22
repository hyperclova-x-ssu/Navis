import { ApprovalError, approvalInput } from '../../../../packages/approvals/index.ts';
import { approveMarketingCard } from './card-approvals.ts';
import { LocalError } from '../13/sources.ts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { isUuid } from '../../promo/contracts.ts';
import { inStore } from '../../transaction.ts';
import { commandFingerprint } from './commands.ts';
import type { Approval } from './ports.ts';
import { get } from './records.ts';
import { cardOperations, destructiveOperations, noticeCommand, NoticeError, object, uuid, type Operation } from './wire.ts';

type Row = {
  actorId: string; resourceId: string; operation: string; revision: number; fingerprint: string;
  expiresAt: Date; confirmedAt: Date | null;
};
export const cardApprovalLifetimeMs = 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest();

export function verifyNoticeApproval(now: () => Date) {
  return async (input: Approval, db: PoolClient) => {
    const result = await db.query(`
      SELECT 1 FROM marketing.notice_reply_approval
      WHERE store_id=$1 AND approval_id=$2 AND actor_id=$3 AND resource_id=$4 AND operation=$5 AND revision=$6
        AND fingerprint=$7 AND expires_at>$8 AND ($9::boolean IS FALSE OR confirmed_at IS NOT NULL)`,
    [input.storeId, input.approvalId, input.actorId, input.resourceId, input.operation, input.revision,
      input.fingerprint, now(), input.secondConfirmation]);
    return Boolean(result.rowCount);
  };
}

export function registerNoticeApprovals(app: FastifyInstance, pool: Pool, token: string, now = () => new Date(), smsCardToken?: string) {
  if (smsCardToken !== undefined && (!smsCardToken || smsCardToken === token)) {
    throw new Error('SMS scheduling approvals require a distinct verified-card workload token');
  }
  const smsToken = smsCardToken && hash(`Bearer ${smsCardToken}`);
  const expected = hash(`Bearer ${token}`);
  app.post<{ Params: { storeId: string } }>('/internal/v1/marketing/stores/:storeId/approvals', {
    bodyLimit: 64 * 1024,
    onRequest: async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!timingSafeEqual(expected, hash(req.headers.authorization ?? ''))) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
      if (!isUuid(req.params.storeId) || req.headers['x-navis-store-id'] !== req.params.storeId
        || !isUuid(req.headers['x-navis-user-id']) || req.headers['x-navis-store-role'] !== 'owner') {
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }
    },
  }, async (req, reply) => {
    const { storeId } = req.params;
    const actorId = req.headers['x-navis-user-id'] as string;
    try {
      const input = approvalInput(req.body);
      return await inStore(pool, storeId, db => approveMarketingCard(db, { storeId, actorId }, input, now()), { serialize: true });
    } catch (error) {
      if (error instanceof ApprovalError || error instanceof NoticeError || error instanceof LocalError) {
        return reply.code(error.status).send({ code: error.code, reason: error.code });
      }
      throw error;
    }
  });
  app.post<{ Params: { storeId: string } }>('/internal/v1/marketing/stores/:storeId/notice-reply-approvals', {
    bodyLimit: 8192,
    onRequest: async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const credential = req.headers.authorization;
      const signature = credential && hash(credential);
      if (!signature || !(timingSafeEqual(expected, signature) || smsToken && timingSafeEqual(smsToken, signature))) {
        return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      }
      if (!isUuid(req.params.storeId) || req.headers['x-navis-store-id'] !== req.params.storeId
        || !isUuid(req.headers['x-navis-user-id']) || req.headers['x-navis-store-role'] !== 'owner') {
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }
    },
  }, async (req, reply) => {
    const { storeId } = req.params;
    const actorId = req.headers['x-navis-user-id'] as string;
    try {
      const input = object(req.body, ['approvalId', 'operation', 'resourceId', 'command', 'stage']);
      const approvalId = uuid(input.approvalId);
      const resourceId = uuid(input.resourceId);
      const operation = input.operation as Operation;
      if (!cardOperations.has(operation) || (input.stage !== 'press' && input.stage !== 'confirm')) {
        throw new NoticeError(400, 'INVALID_REQUEST');
      }
      const command = object(input.command, operation === 'inquiry.editReply' ? ['expectedRevision', 'text']
        : operation === 'notice.send' ? ['expectedRevision', 'scheduledFor'] : ['expectedRevision']);
      const parsed = noticeCommand(operation, { ...command, approvalId });
      const isSms = operation === 'notice.cancelSms' || operation === 'notice.send' && parsed.scheduledFor !== undefined;
      const credential = hash(req.headers.authorization!);
      if (isSms || !timingSafeEqual(expected, credential)) {
        throw new NoticeError(403, 'CARD_REQUIRED');
      }
      const fingerprint = commandFingerprint(operation, resourceId, parsed);
      const destructive = destructiveOperations.has(operation);
      return await inStore(pool, storeId, async db => {
        const at = now();
        const { rows: [prior] } = await db.query<Row>(`
          SELECT actor_id AS "actorId", resource_id AS "resourceId", operation, revision, fingerprint,
            expires_at AS "expiresAt", confirmed_at AS "confirmedAt"
          FROM marketing.notice_reply_approval WHERE store_id=$1 AND approval_id=$2`, [storeId, approvalId]);
        if (prior && prior.actorId !== actorId) throw new NoticeError(404, 'NOT_FOUND');
        if (prior && (prior.resourceId !== resourceId || prior.operation !== operation || prior.fingerprint !== fingerprint)) {
          throw new NoticeError(409, 'APPROVAL_CONFLICT');
        }
        if (prior && prior.expiresAt <= at) throw new NoticeError(409, 'APPROVAL_EXPIRED');
        if (input.stage === 'confirm' && (!prior || !destructive)) throw new NoticeError(404, 'NOT_FOUND');
        if (!prior || (input.stage === 'confirm' && !prior.confirmedAt)) {
          const kind = operation.startsWith('notice.') ? 'notice' : 'inquiry';
          const row = await get(db, storeId, kind, resourceId);
          if (row.revision !== parsed.expectedRevision) throw new NoticeError(409, 'STALE_REVISION');
        }
        if (prior) {
          if (input.stage === 'confirm' && !prior.confirmedAt) {
            await db.query('UPDATE marketing.notice_reply_approval SET confirmed_at=$3 WHERE store_id=$1 AND approval_id=$2',
              [storeId, approvalId, at]);
          }
          return { approvalId, expiresAt: prior.expiresAt, requiresConfirmation: destructive && !prior.confirmedAt && input.stage === 'press' };
        }
        const expiresAt = new Date(+at + cardApprovalLifetimeMs);
        await db.query(`
          INSERT INTO marketing.notice_reply_approval (store_id, approval_id, actor_id, resource_id, operation, revision,
            fingerprint, created_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [storeId, approvalId, actorId, resourceId, operation, parsed.expectedRevision, fingerprint, at, expiresAt]);
        return { approvalId, expiresAt, requiresConfirmation: destructive };
      }, { serialize: true });
    } catch (error) {
      if (error instanceof NoticeError) return reply.code(error.status).send({ code: error.code, reason: error.code });
      throw error;
    }
  });
}
