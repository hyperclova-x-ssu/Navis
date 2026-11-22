import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { InsightError, isDate } from '../../scope.ts';
import { appendObservationEvent, type Receipt, type WriteContext } from './commands.ts';
import { invalid, number, object } from './wire.ts';

type Clock = { timezone: string; dayStart: string };
const sources = ['cctv.reviews', 'briefing'];

export async function listReviews(db: PoolClient, storeId: string, date: string) {
  const { rows } = await db.query(`
    SELECT review_id AS "reviewId", hour, revision, marked_at AS "markedAt" FROM insight.cctv_review
    WHERE store_id=$1 AND business_date=$2 AND marked_at IS NOT NULL ORDER BY hour`, [storeId, date]);
  return rows;
}

async function changed(ctx: WriteContext, reviewId: string, date: string, hour: number, revision: number, marked: boolean) {
  await appendObservationEvent(ctx.db, ctx.storeId, ctx.at, 'insight.cctv_review_changed.v1', reviewId,
    { reviewId, date, hour, revision, marked });
  return { resourceId: reviewId, revision, affectedSources: sources };
}

export async function markReview(ctx: WriteContext, body: unknown, clock: Clock) {
  const { db, storeId, at } = ctx;
  const { date, hour: rawHour } = object(body, ['date', 'hour']);
  const hour = number(rawHour, 0, 23);
  if (!isDate(date) || !Number.isInteger(hour)) invalid();
  const { rows: [target] } = await db.query<{ today: boolean; measured: boolean }>(`
    WITH bounds AS (
      SELECT ($2::date + $5::time) AT TIME ZONE $4 AS starts_at,
        (($2::date + 1) + $5::time) AT TIME ZONE $4 AS ends_at,
        (($6::timestamptz AT TIME ZONE $4) - ($5::time - time '00:00'))::date AS business_date
    )
    SELECT business_date=$2::date AS today, EXISTS (
      SELECT 1 FROM insight.people_count_bucket p
      WHERE p.store_id=$1 AND p.bucket_start >= starts_at AND p.bucket_start < least(ends_at, $6)
        AND extract(hour FROM p.bucket_start AT TIME ZONE $4)=$3
        AND p.status IN ('ok', 'partial') AND p.observed_until > p.bucket_start
    ) AS measured FROM bounds`, [storeId, date, hour, clock.timezone, clock.dayStart, at]);
  if (!target.today) throw new InsightError(400, 'CCTV_TODAY_ONLY');
  if (!target.measured) throw new InsightError(404, 'CCTV_HOUR_UNMEASURED');
  const reviewId = randomUUID();
  const { rows: [review] } = await db.query<{ revision: number }>(`
    INSERT INTO insight.cctv_review (store_id, business_date, hour, review_id, revision, marked_at) VALUES ($1,$2,$3,$4,1,$5)
    ON CONFLICT (store_id, business_date, hour) DO UPDATE SET review_id=EXCLUDED.review_id,
      revision=cctv_review.revision+1, marked_at=EXCLUDED.marked_at WHERE cctv_review.marked_at IS NULL
    RETURNING revision`, [storeId, date, hour, reviewId, at]);
  if (!review) throw new InsightError(409, 'CCTV_REVIEW_ALREADY_MARKED');
  const receipt = await changed(ctx, reviewId, date, hour, review.revision, true);
  return { ...receipt, undoUntil: new Date(at.getTime() + 6000).toISOString() };
}

export async function undoReview(ctx: WriteContext, receiptId: string, body: unknown) {
  const { db, storeId, actorId, at } = ctx;
  if (body !== undefined) object(body, []);
  const { rows: [original] } = await db.query<{ receipt: Receipt }>(`
    SELECT receipt FROM insight.observation_command WHERE store_id=$1 AND actor_id=$2 AND receipt_id=$3`, [storeId, actorId, receiptId]);
  if (!original?.receipt.undoUntil) throw new InsightError(404, 'RECEIPT_NOT_FOUND');
  const { resourceId, revision, undoUntil } = original.receipt;
  if (at.getTime() >= Date.parse(undoUntil)) throw new InsightError(409, 'UNDO_EXPIRED');
  const { rows: [review] } = await db.query<{ date: string; hour: number; revision: number }>(`
    UPDATE insight.cctv_review SET marked_at=NULL, revision=revision+1
    WHERE store_id=$1 AND review_id=$2 AND revision=$3 AND marked_at IS NOT NULL
    RETURNING business_date::text AS date, hour, revision`, [storeId, resourceId, revision]);
  if (!review) throw new InsightError(409, 'STALE_REVISION');
  return changed(ctx, resourceId, review.date, review.hour, review.revision, false);
}
