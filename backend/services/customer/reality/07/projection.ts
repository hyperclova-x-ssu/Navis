import type { Pool, PoolClient } from 'pg';
import { PermanentStreamError, StreamConsumer, type RedisStreams, type StreamHandler } from '../../../../packages/streams/index.ts';
import { isRecord, isUuid } from '../../pos-client.ts';
import { bumpRevision, lockCalendarStaff, type Scope } from './records.ts';
import { choice, conflict, date, displayTime, integer, invalid, minutes, object, ScheduleError, time, uuid, type CalendarSource, type Category } from './wire.ts';

const sources = {
  'purchase-order': { producer: 'inventory', featureId: 'suppliers', categoryId: 'purchasing', visibility: 'delivery', title: '입고 예정' },
  reservation: { producer: 'customer', featureId: 'voice-booking', categoryId: 'store-operations', visibility: 'reservation', title: '방문 예약' },
  'custom-pickup': { producer: 'pos', featureId: 'custom-order', categoryId: 'store-operations', visibility: 'pickup', title: '픽업 예정' },
  'custom-production': { producer: 'pos', featureId: 'custom-order', categoryId: 'store-operations', visibility: 'pickup', title: '제작 예정' },
  'community-offer': { producer: 'marketing', featureId: 'community', categoryId: 'store-operations', visibility: 'deadline', title: '협업 일정' },
  notice: { producer: 'marketing', featureId: 'notice-send', categoryId: 'store-operations', visibility: 'deadline', title: '공지 일정' },
  'tax-due': { producer: 'pos', featureId: 'tax', categoryId: 'tax-admin', visibility: 'deadline', title: '세금 납부 기한' },
  'grant-deadline': { producer: 'insight', featureId: 'grants', categoryId: 'store-operations', visibility: 'deadline', title: '지원사업 마감' },
} as const satisfies Record<string, { producer: string; featureId: string; categoryId: Category; visibility: CalendarSource; title: string }>;

export type ProjectionSource = keyof typeof sources;
export type CalendarProjectionInput = { source: ProjectionSource; sourceId: string; revision: number;
  entry: { date: string; endDate?: string; time?: string | null } | null };
type Producer = typeof sources[ProjectionSource]['producer'];
const sourceNames = Object.keys(sources) as ProjectionSource[];

type ProjectionDb = { source: ProjectionSource; sourceId: string; sourceRevision: number; date: string | null; endDate: string | null; startMinute: number | null };
const fields = `source, source_id AS "sourceId", source_revision AS "sourceRevision", to_char(starts_on, 'YYYY-MM-DD') AS date,
  to_char(ends_on, 'YYYY-MM-DD') AS "endDate", start_minute AS "startMinute"`;

/** Call from the producer event transaction (or B06's same-DB write), with store context already set. */
export async function projectCalendarSource(db: PoolClient, storeId: string, producer: Producer, payload: unknown) {
  const input = object(payload, ['source', 'sourceId', 'revision', 'entry']);
  const source = choice(input.source, sourceNames, 'source');
  if (sources[source].producer !== producer && !(source === 'custom-pickup' && producer === 'customer')) throw invalid('source');
  const sourceId = uuid(input.sourceId, 'sourceId');
  const revision = integer(input.revision, 'revision', 1);
  const entry = input.entry === null ? null : object(input.entry, ['date', 'endDate', 'time']);
  const startsOn = entry ? date(entry.date, 'date') : null;
  const endsOn = entry?.endDate === undefined ? startsOn : date(entry.endDate, 'endDate');
  const startMinute = entry?.time == null ? null : minutes(time(entry.time, 'time'));
  if (startsOn && endsOn && endsOn < startsOn) throw invalid('endDate', 'INVALID_DATE_RANGE');

  const scope = { db, storeId };
  await lockCalendarStaff(scope);
  const result = await db.query(`
    INSERT INTO customer.calendar_projection (store_id, source, source_id, source_revision, starts_on, ends_on, start_minute)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (store_id, source, source_id) DO UPDATE SET source_revision = EXCLUDED.source_revision,
      starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, start_minute = EXCLUDED.start_minute
    WHERE customer.calendar_projection.source_revision < EXCLUDED.source_revision`,
  [storeId, source, sourceId, revision, startsOn, endsOn, startMinute]);
  if (result.rowCount) {
    await bumpRevision(scope, ['projections']);
    return true;
  }
  const { rows: [current] } = await db.query<ProjectionDb>(`SELECT ${fields} FROM customer.calendar_projection
    WHERE store_id = $1 AND source = $2 AND source_id = $3`, [storeId, source, sourceId]);
  if (current?.sourceRevision === revision && (current.date !== startsOn || current.endDate !== endsOn || current.startMinute !== startMinute)) {
    throw conflict('CALENDAR_PROJECTION_REVISION_CONFLICT');
  }
  return false;
}

export function projectionCursor(value: unknown): [ProjectionSource | null, string | null] {
  if (value === undefined) return [null, null];
  if (typeof value !== 'string') throw invalid('cursor');
  const [source, id, ...rest] = value.split(':');
  if (rest.length) throw invalid('cursor');
  return [choice(source, sourceNames, 'cursor'), uuid(id, 'cursor')];
}

export async function listProjections({ db, storeId }: Scope, input: {
  start: string | null; end: string | null; limit: number; cursor: ReturnType<typeof projectionCursor>;
}) {
  const { start, end, limit, cursor: [source, id] } = input;
  const { rows } = await db.query<ProjectionDb & { date: string; endDate: string }>(`
    SELECT ${fields} FROM customer.calendar_projection
    WHERE store_id = $1 AND starts_on IS NOT NULL AND ($2::text IS NULL OR (source, source_id) > ($2, $3::uuid))
      AND ($4::date IS NULL OR ends_on >= $4) AND ($5::date IS NULL OR starts_on <= $5)
    ORDER BY source, source_id LIMIT $6`, [storeId, source, id, start, end, limit + 1]);
  return rows.map(({ source, sourceId, sourceRevision, date, endDate, startMinute }) => {
    const { featureId, categoryId, visibility, title } = sources[source];
    return { source, sourceId, sourceRevision, featureId, categoryId, visibility, date, endDate, time: displayTime(startMinute), title };
  });
}

function projectionHandler(producer: Producer, expected: ProjectionSource, field: 'calendarProjection' | 'productionProjection' = 'calendarProjection'): StreamHandler {
  return async (db, event) => {
    const { payload, storeId, scopeKey, aggregateId } = event;
    if (!isUuid(storeId) || storeId !== scopeKey || !isRecord(payload)) throw new PermanentStreamError('INVALID_CALENDAR_PROJECTION');
    const input = payload[field];
    if (input === undefined) return;
    if (!isRecord(input) || input.source !== expected || input.sourceId !== aggregateId) {
      throw new PermanentStreamError('INVALID_CALENDAR_PROJECTION');
    }
    try {
      await projectCalendarSource(db, storeId, producer, input);
    } catch (error) {
      if (error instanceof ScheduleError) throw new PermanentStreamError(error.reason);
      throw error;
    }
  };
}

const customPickup = projectionHandler('pos', 'custom-pickup');
const customProduction = projectionHandler('pos', 'custom-production', 'productionProjection');

export const calendarPosProjectionHandlers = {
  'pos.custom_pickup_changed.v1': async (db, event) => {
    await customPickup(db, event);
    await customProduction(db, event);
  },
  'pos.tax_due_changed.v1': projectionHandler('pos', 'tax-due'),
} satisfies Record<string, StreamHandler>;

const subscriptions = {
  inventory: { 'inventory.purchase_order_changed.v1': projectionHandler('inventory', 'purchase-order') },
  marketing: { 'marketing.partnership_changed.v1': projectionHandler('marketing', 'community-offer'),
    'marketing.message_status_changed.v1': projectionHandler('marketing', 'notice') },
  insight: { 'insight.grant_review_changed.v1': projectionHandler('insight', 'grant-deadline') },
};

export function createCalendarProjectionConsumers(database: Pool, redis: RedisStreams, name: string,
  producers: readonly (keyof typeof subscriptions)[] = Object.keys(subscriptions) as (keyof typeof subscriptions)[],
) {
  return producers.map(producer => new StreamConsumer({
    database, redis, name, producer, service: 'customer', group: 'customer', handlers: subscriptions[producer],
  }));
}
