import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withCustomerStore } from '../../claims.ts';
import { id, MemberError, object } from './wire.ts';

/**
 * Private Marketing read of CURRENT SMS contactability for a given member set (FIX-GAP-B, RV-GAP-B-3).
 * Marketing calls it at the notice preview, at the card press and again right before marketing-worker sends.
 * Advertising needs both `contactAllowed` and `marketingAllowed` (정보통신망법 §50 prior consent); informational
 * needs `contactAllowed`. Phones are returned only to the Marketing workload and only for eligible members. The
 * route is separate from the POS member credential so that no other workload can read phone lists.
 */
export const smsRecipientsRoute = '/internal/v1/customer/stores/:storeId/sms-recipients';
export const maxSmsRecipientQuery = 500;
const hash = (value: string) => createHash('sha256').update(value).digest();

type Row = { memberId: string; phone: string; contactAllowed: boolean; marketingAllowed: boolean; archived: boolean };

export function registerSmsRecipientRoute(app: FastifyInstance, pool: Pool, options: { marketingToken: string; otherTokens?: string[] }) {
  if (!options.marketingToken || options.otherTokens?.includes(options.marketingToken)) {
    throw new Error('The Marketing SMS recipient credential must be distinct');
  }
  const expected = hash(options.marketingToken);
  app.post<{ Params: { storeId: string } }>(smsRecipientsRoute, {
    bodyLimit: 64 * 1024,
    async onRequest(request: FastifyRequest<{ Params: { storeId: string } }>, reply) {
      reply.header('cache-control', 'no-store');
      const bearer = request.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
      if (!bearer || !timingSafeEqual(expected, hash(bearer))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
      if (request.headers['x-navis-store-id'] !== request.params.storeId.toLowerCase()) {
        return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
      }
    },
  }, async (request, reply) => {
    try {
      const storeId = id(request.params.storeId);
      const input = object(request.body, ['memberIds', 'purpose']);
      if (input.purpose !== 'advertising' && input.purpose !== 'informational') throw new MemberError(400, 'INVALID_REQUEST');
      if (!Array.isArray(input.memberIds) || input.memberIds.length > maxSmsRecipientQuery) throw new MemberError(400, 'INVALID_REQUEST');
      const memberIds = [...new Set(input.memberIds.map(id))];
      const advertising = input.purpose === 'advertising';
      const rows = memberIds.length ? await withCustomerStore(pool, storeId, async db => (await db.query<Row>(`
        SELECT member_id AS "memberId", phone, contact_allowed AS "contactAllowed", marketing_allowed AS "marketingAllowed",
          archived_at IS NOT NULL AS archived
        FROM customer.member WHERE store_id=$1 AND member_id = ANY($2::uuid[])`, [storeId, memberIds])).rows) : [];
      const byId = new Map(rows.map(row => [row.memberId, row]));
      const excluded = { notFound: 0, archived: 0, noContactConsent: 0, noMarketingConsent: 0 };
      const items: { memberId: string; phone: string }[] = [];
      for (const memberId of memberIds) {
        const row = byId.get(memberId);
        if (!row) excluded.notFound++;
        else if (row.archived) excluded.archived++;
        else if (!row.contactAllowed) excluded.noContactConsent++;
        else if (advertising && !row.marketingAllowed) excluded.noMarketingConsent++;
        else items.push({ memberId, phone: row.phone });
      }
      return { purpose: input.purpose, items, excluded, eligibleCount: items.length, requestedCount: memberIds.length };
    } catch (error) {
      if (error instanceof MemberError) return reply.code(error.status).send({ code: 'VALIDATION', reason: error.reason });
      throw error;
    }
  });
}
