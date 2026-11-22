import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inStore, InsightError } from '../../scope.ts';
import { appendObservationEvent } from '../10/commands.ts';
import type { BriefingContext } from './briefing.ts';

type Ack = { acknowledgedAt: Date; receiptId: string };

export async function readAck(db: PoolClient, storeId: string, day: string): Promise<Ack | null> {
  const { rows: [ack] } = await db.query<Ack>(`
    SELECT acknowledged_at AS "acknowledgedAt", receipt_id AS "receiptId"
    FROM insight.briefing_ack WHERE store_id=$1 AND business_day=$2`, [storeId, day]);
  return ack ?? null;
}

export function acknowledge(pool: Pool, ctx: BriefingContext, day: string, key: string) {
  const { storeId, actorId, now } = ctx;
  return inStore(pool, storeId, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('insight.briefing:' || $1, 0))", [storeId]);
    const { rows: [command] } = await db.query<{ day: string }>(`
      SELECT business_day::text AS day FROM insight.briefing_ack_command
      WHERE store_id=$1 AND actor_id=$2 AND command_key=$3`, [storeId, actorId, key]);
    if (command && command.day !== day) throw new InsightError(409, 'IDEMPOTENCY_MISMATCH');
    if (!command && day !== ctx.businessDay) throw new InsightError(409, 'BRIEFING_DAY_CHANGED');

    let ack = await readAck(db, storeId, day);
    if (!ack) {
      ack = { acknowledgedAt: now, receiptId: randomUUID() };
      await db.query(`INSERT INTO insight.briefing_ack (store_id, business_day, actor_id, acknowledged_at, receipt_id)
        VALUES ($1,$2,$3,$4,$5)`, [storeId, day, actorId, now, ack.receiptId]);
      await appendObservationEvent(db, storeId, now, 'insight.briefing_acknowledged.v1', ack.receiptId,
        { businessDay: day, receiptId: ack.receiptId, revision: 1, affectedSources: ['briefing'] });
    }
    if (!command) await db.query(`INSERT INTO insight.briefing_ack_command (store_id, actor_id, command_key, business_day)
      VALUES ($1,$2,$3,$4)`, [storeId, actorId, key, day]);
    return { resourceId: ack.receiptId, revision: 1, affectedSources: ['briefing'], businessDay: day, ...ack };
  });
}
