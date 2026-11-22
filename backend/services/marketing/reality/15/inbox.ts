import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isUuid } from '../../promo/contracts.ts';
import type { InboundEvent } from '../../naver/pn06-talktalk.ts';
import { inStore } from '../../transaction.ts';
import { insert, publishRecordChange, type Row } from './records.ts';

const redeliveryWindowMs = 5 * 60_000;
export const liveInboxPrefix = 'live-inbox-';

/** Bind this handler to the store of the separately authenticated callback at composition time. */
export function createTalkTalkInbox(pool: Pool, storeId: string, now = () => new Date(), live = false) {
  if (!isUuid(storeId)) throw new Error('TalkTalk inbox requires a configured store UUID');
  const scope = storeId.toLowerCase();

  return async (event: InboundEvent) => {
    if (event.kind !== 'inquiry') return;
    const at = now();
    const fingerprint = live ? createHash('sha256').update('talktalk-live:' + event.correlation).digest('hex') : event.correlation;
    await inStore(pool, scope, async db => {
      if (live) {
        await db.query("SET LOCAL lock_timeout = '750ms'; SET LOCAL statement_timeout = '1200ms'");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('talktalk-live:' || $1 || ':' || $2, 0))",
          [scope, fingerprint]);
      }
      const { rowCount } = await db.query(`SELECT 1 FROM marketing.talktalk_inbox_candidate
        WHERE store_id=$1 AND fingerprint=$2 AND received_at >= $3 LIMIT 1`,
      [scope, fingerprint, new Date(+at - redeliveryWindowMs)]);
      if (rowCount) return;

      const id = randomUUID();
      const row: Row = {
        id, kind: 'inquiry', source: 'talktalk', providerRef: (live ? liveInboxPrefix : 'inbox-') + id,
        revision: 1, status: 'waiting', updatedAt: at,
        data: { type: 'message', title: null, text: event.text, sourceUrl: null, draft: null, reply: null },
      };
      await insert(db, scope, row);
      await db.query(`INSERT INTO marketing.talktalk_inbox_candidate (store_id, inquiry_id, fingerprint, provider_user, received_at, is_live)
        VALUES ($1,$2,$3,$4,$5,$6)`, [scope, id, fingerprint, event.user, at, live]);
      await publishRecordChange(db, scope, row, 'saved');
    }, { serialize: !live });
  };
}

export async function talkTalkInboxRecipient(db: PoolClient, storeId: string, inquiryId: string) {
  const { rows: [candidate] } = await db.query<{ user: string; live: boolean }>(`
    SELECT provider_user AS "user", is_live AS live
    FROM marketing.talktalk_inbox_candidate WHERE store_id=$1 AND inquiry_id=$2`,
  [storeId, inquiryId]);
  return candidate;
}

export async function liveTalkTalkConversation(db: PoolClient, storeId: string, inquiryId: string, ref: string) {
  const { rows } = await db.query<{ id: string; status: string; inbound: string; reply: string | null;
    receivedAt: Date; repliedAt: Date }>(`
    SELECT record.id, record.status, record.data->>'text' AS inbound, record.data->'reply'->>'text' AS reply,
      item.received_at AS "receivedAt", record.updated_at AS "repliedAt"
    FROM marketing.talktalk_inbox_candidate target
    JOIN marketing.talktalk_inbox_candidate item
      ON item.store_id=target.store_id AND item.provider_user=target.provider_user AND item.is_live
    JOIN marketing.reply_notice_record record ON record.store_id=item.store_id AND record.id=item.inquiry_id
    WHERE target.store_id=$1 AND target.inquiry_id=$2 AND target.is_live
    ORDER BY (item.inquiry_id=$2) DESC, item.received_at DESC, item.inquiry_id DESC LIMIT 30`, [storeId, inquiryId]);
  const target = rows[0];
  if (target?.id !== inquiryId) return;
  const messages = rows.flatMap(row => [
    { text: row.inbound, from: 'user' as const, at: row.receivedAt },
    ...(row.reply ? [{ text: row.reply, from: 'partner' as const, at: row.repliedAt }] : []),
  ]).sort((a, b) => +a.at - +b.at);
  return { ref, status: target.status === 'done' ? 'completed' : 'waiting', messages };
}
