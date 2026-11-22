import type { Pool } from 'pg';
import { NaverAdapterError } from '../../../services/marketing/naver/errors.ts';
import { inStore } from '../../../services/marketing/transaction.ts';
import { advertisingNight } from '../naver/pn13-sens.ts';
import type { LiveSens, SensSettings } from '../naver/sens-live.ts';

const definitive = new Set(['INVALID_INPUT', 'NOT_CONFIGURED', 'LIVE_NOT_APPROVED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'REJECTED']);
const providerId = /^[A-Za-z0-9_-]{1,100}$/;

export function createCouponSmsDispatcher(options: {
  database: Pool; storeId: string; sens?: LiveSens;
  readSettings(storeId: string): Promise<SensSettings | null>;
  readRecipient(memberId: string): Promise<string | null>;
  now?: () => Date;
}) {
  const { database, storeId, sens } = options;
  const now = options.now ?? (() => new Date());
  return async function dispatch(signal: AbortSignal) {
    const at = now();
    const pending = await inStore(database, storeId, async db => {
      await db.query(`UPDATE marketing.coupon_message SET dispatch_state='unknown'
        WHERE store_id=$1 AND dispatch_state='sending' AND dispatch_started_at < $2 - interval '2 minutes'`, [storeId, at]);
      return db.query<{ message_id: string; provider_id: string }>(`SELECT message_id, provider_id FROM marketing.coupon_message
        WHERE store_id=$1 AND dispatch_state='accepted' AND dispatch_started_at > $2 - interval '7 days'
        ORDER BY dispatch_started_at LIMIT 20`, [storeId, at]);
    });
    const update = (id: string, expected: string, state: string, ref?: string) => inStore(database, storeId, db =>
      db.query(`UPDATE marketing.coupon_message SET dispatch_state=$4, provider_id=coalesce($5,provider_id)
        WHERE store_id=$1 AND message_id=$2 AND dispatch_state=$3`, [storeId, id, expected, state, ref ?? null]));

    if (!advertisingNight(at)) {
      const { rows } = await inStore(database, storeId, db => db.query<{
        message_id: string; customer_id: string; body: string; active: boolean;
      }>(`WITH due AS (
        SELECT m.message_id, (c.status='active' AND c.ends_on >= ($2::timestamptz AT TIME ZONE 'Asia/Seoul')::date) AS active
        FROM marketing.coupon_message m JOIN marketing.coupon c USING (store_id,coupon_id)
        WHERE m.store_id=$1 AND m.status='queued' AND m.dispatch_state='ready' AND m.scheduled_at <= $2
        ORDER BY m.scheduled_at, m.message_id LIMIT 10 FOR UPDATE OF m SKIP LOCKED
      ) UPDATE marketing.coupon_message m SET dispatch_state='sending', dispatch_started_at=$2
        FROM due WHERE m.store_id=$1 AND m.message_id=due.message_id
        RETURNING m.message_id, m.customer_id, m.body, due.active`, [storeId, at]));
      for (const row of rows) {
        signal.throwIfAborted();
        let state = 'blocked', ref: string | undefined;
        if (sens && row.active && !advertisingNight(now())) {
          const sources = await Promise.all([options.readSettings(storeId), options.readRecipient(row.customer_id)]).catch(() => null);
          if (sources?.[0] && sources[1]) {
            try {
              const result = await sens.sms({ settings: sources[0], to: [sources[1]], advertising: true,
                body: row.body.split('\n').slice(1, -1).join('\n'), approvedContent: row.body,
                approval: { confirmed: true }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
              ref = result.requestId;
              state = !result.sentCount ? 'not_sent_test_mode' : ref && providerId.test(ref) ? 'accepted' : 'unknown';
            } catch (error) {
              state = error instanceof NaverAdapterError && definitive.has(error.code) ? 'failed' : 'unknown';
            }
          }
        }
        await update(row.message_id, 'sending', state, state === 'accepted' ? ref : undefined);
      }
    }
    for (const row of pending.rows) {
      signal.throwIfAborted();
      const state = await sens?.smsResult(row.provider_id, 1, signal).catch(() => undefined);
      if (state) await update(row.message_id, 'accepted', state);
    }
  };
}
