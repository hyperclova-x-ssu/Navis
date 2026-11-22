import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { displayTime, minutes, titleKey, type CalendarEvent, type CalendarSource, type Category, type Shift, type Staff } from './wire.ts';

export type Scope = { db: PoolClient; storeId: string };
export type RevisionSource = 'staff' | 'shifts' | 'calendar' | 'projections';
type Archived = { archivedAt: string | null };
type ShiftRecord = Shift & Archived;
type EventRecord = CalendarEvent & Archived;
export type Entity = { type: 'staff'; row: Staff } | { type: 'shifts'; row: ShiftRecord } | { type: 'calendar'; row: EventRecord };
export type Change = { before: Entity | null; after: Entity };
export type Preferences = { sourceVisibility: Record<CalendarSource, boolean>; categoryVisibility: Record<Category, boolean>; revision: number };
type Range = { start: string | null; end: string | null };
type Page = Range & { limit: number; cursor: string | null };

const columns = {
  staff: { table: 'staff', id: 'staff_id', fields: `staff_id AS "staffId", name, archived_at AS "archivedAt", revision` },
  shifts: { table: 'staff_shift', id: 'schedule_id', fields: `schedule_id AS "scheduleId", staff_id AS "staffId", to_char(shift_date, 'YYYY-MM-DD') AS date,
    kind, start_minute AS "startMinute", end_minute AS "endMinute", break_minutes AS "breakMinutes", archived_at AS "archivedAt", revision` },
  calendar: { table: 'calendar_event', id: 'event_id', fields: `event_id AS "eventId", kind, category_id AS "categoryId", title,
    to_char(starts_on, 'YYYY-MM-DD') AS date, start_minute AS "startMinute", memo, closure_kind AS "closureKind",
    to_char(closure_ends_on, 'YYYY-MM-DD') AS "closureEnd", archived_at AS "archivedAt", revision` },
} as const;

type StaffDb = Omit<Staff, 'archivedAt'> & { archivedAt: Date | null };
type ShiftDb = Omit<ShiftRecord, 'start' | 'end' | 'archivedAt'> & { startMinute: number | null; endMinute: number | null; archivedAt: Date | null };
type EventDb = Omit<EventRecord, 'time' | 'storeClosure' | 'archivedAt'> & {
  startMinute: number | null; closureKind: 'regular' | 'temporary' | null; closureEnd: string | null; archivedAt: Date | null;
};
const staffRow = ({ archivedAt, ...row }: StaffDb): Staff => ({ ...row, archivedAt: archivedAt?.toISOString() ?? null });
const shiftRow = ({ startMinute, endMinute, archivedAt, ...row }: ShiftDb): ShiftRecord => ({
  ...row, start: displayTime(startMinute), end: displayTime(endMinute), archivedAt: archivedAt?.toISOString() ?? null,
});
const eventRow = ({ startMinute, closureKind, closureEnd, archivedAt, ...row }: EventDb): EventRecord => ({
  ...row, time: displayTime(startMinute), storeClosure: closureKind && closureEnd ? { kind: closureKind, endDate: closureEnd } : null,
  archivedAt: archivedAt?.toISOString() ?? null,
});

export const entityId = ({ row }: Entity): string => 'scheduleId' in row ? row.scheduleId : 'eventId' in row ? row.eventId : row.staffId;
export const active = (entity: Entity | null) => entity?.row.archivedAt === null ? publicRow(entity.row) : null;
export function publicRow<T extends Staff | ShiftRecord | EventRecord>(row: T) {
  if ('eventId' in row || 'scheduleId' in row) {
    const { archivedAt: _archived, ...rest } = row;
    return rest;
  }
  return row;
}

export async function lockCalendarStaff({ db, storeId }: Scope, readOnly = false) {
  const lock = readOnly ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await db.query(`SELECT ${lock}(hashtextextended('customer.calendar_staff:' || $1::text, 0))`, [storeId]);
}

export async function sourceRevision({ db, storeId }: Scope, source: RevisionSource) {
  const { rows: [row] } = await db.query<{ revision: number }>(`
    SELECT revision FROM customer.calendar_staff_revision WHERE store_id = $1 AND source = $2`, [storeId, source]);
  return row?.revision ?? 0;
}

export async function bumpRevision({ db, storeId }: Scope, sources: readonly RevisionSource[]) {
  const { rows } = await db.query<{ source: RevisionSource; revision: number }>(`
    INSERT INTO customer.calendar_staff_revision (store_id, source, revision) SELECT $1, source, 1 FROM unnest($2::text[]) AS source
    ON CONFLICT (store_id, source) DO UPDATE SET revision = customer.calendar_staff_revision.revision + 1
    RETURNING source, revision`, [storeId, sources]);
  return Object.fromEntries(rows.map(row => [row.source, row.revision])) as Partial<Record<RevisionSource, number>>;
}

export async function loadEntities({ db, storeId }: Scope, type: Entity['type'], ids: readonly string[]): Promise<Entity[]> {
  if (!ids.length) return [];
  const { table, id, fields } = columns[type];
  const sql = `SELECT ${fields} FROM customer.${table} WHERE store_id = $1 AND ${id} = ANY($2::uuid[])`;
  const values = [storeId, ids];
  if (type === 'staff') return (await db.query<StaffDb>(sql, values)).rows.map(row => ({ type, row: staffRow(row) }));
  if (type === 'shifts') return (await db.query<ShiftDb>(sql, values)).rows.map(row => ({ type, row: shiftRow(row) }));
  return (await db.query<EventDb>(sql, values)).rows.map(row => ({ type, row: eventRow(row) }));
}

export async function listStaff({ db, storeId }: Scope, { cursor, limit }: Pick<Page, 'cursor' | 'limit'>) {
  const { rows } = await db.query<StaffDb>(`
    SELECT ${columns.staff.fields} FROM customer.staff
    WHERE store_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR staff_id > $2)
    ORDER BY staff_id LIMIT $3`, [storeId, cursor, limit + 1]);
  return rows.map(staffRow);
}

export async function listShifts({ db, storeId }: Scope, { cursor, limit, start, end }: Page, staffId: string | null) {
  const { rows } = await db.query<ShiftDb>(`
    SELECT ${columns.shifts.fields} FROM customer.staff_shift
    WHERE store_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR schedule_id > $2)
      AND ($3::date IS NULL OR shift_date >= $3) AND ($4::date IS NULL OR shift_date <= $4)
      AND ($5::uuid IS NULL OR staff_id = $5)
    ORDER BY schedule_id LIMIT $6`, [storeId, cursor, start, end, staffId, limit + 1]);
  return rows.map(shiftRow);
}

export async function relevantShifts({ db, storeId }: Scope, options: { staffId: string } | { date: string } | { candidates: readonly Shift[] }) {
  let filter: string;
  let value: string;
  if ('staffId' in options) {
    filter = 'staff_id = $2';
    value = options.staffId;
  } else if ('date' in options) {
    filter = 'shift_date = $2';
    value = options.date;
  } else {
    filter = `(staff_id, shift_date) IN (SELECT "staffId", date FROM jsonb_to_recordset($2) AS row("staffId" uuid, date date))`;
    value = JSON.stringify(options.candidates.map(({ staffId, date }) => ({ staffId, date })));
  }
  const { rows } = await db.query<ShiftDb>(`
    SELECT ${columns.shifts.fields} FROM customer.staff_shift
    WHERE store_id = $1 AND archived_at IS NULL AND ${filter} ORDER BY schedule_id`, [storeId, value]);
  return rows.map(shiftRow);
}

export async function staffHistory({ db, storeId }: Scope, { cursor, limit, start, end }: Page, staffId: string | null) {
  const { rows } = await db.query<{ changeId: string; at: Date; entityId: string; operation: string; before: object | null; after: object | null }>(`
    SELECT change_id AS "changeId", changed_at AS at, entity_id AS "entityId", operation, before_row AS before, after_row AS after
    FROM customer.staff_schedule_history
    WHERE store_id = $1 AND ($2::uuid IS NULL OR change_id > $2)
      AND (($3::text IS NULL AND $4::text IS NULL) OR EXISTS (
        SELECT 1 FROM (VALUES (before_row->>'date'), (after_row->>'date')) AS dates(day)
        WHERE day IS NOT NULL AND ($3 IS NULL OR day >= $3) AND ($4 IS NULL OR day <= $4)))
      AND ($5::text IS NULL OR before_row->>'staffId' = $5 OR after_row->>'staffId' = $5)
    ORDER BY change_id LIMIT $6`, [storeId, cursor, start, end, staffId, limit + 1]);
  return rows.map(row => ({ ...row, at: row.at.toISOString() }));
}

export async function listEvents({ db, storeId }: Scope, { cursor, limit, start, end }: Page, closuresOnly = false) {
  const { rows } = await db.query<EventDb>(`
    SELECT ${columns.calendar.fields} FROM customer.calendar_event
    WHERE store_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR event_id > $2)
      AND ($3::date IS NULL OR COALESCE(closure_ends_on, starts_on) >= $3) AND ($4::date IS NULL OR starts_on <= $4)
      AND (NOT $5::boolean OR closure_kind IS NOT NULL)
    ORDER BY event_id LIMIT $6`, [storeId, cursor, start, end, closuresOnly, limit + 1]);
  return rows.map(eventRow);
}

export async function duplicateEvent({ db, storeId }: Scope, { eventId, kind, title, date }: CalendarEvent) {
  const { rows: [row] } = await db.query<EventDb>(`
    SELECT ${columns.calendar.fields} FROM customer.calendar_event
    WHERE store_id = $1 AND archived_at IS NULL AND starts_on = $2 AND kind = $3 AND title_key = $4 AND event_id <> $5
    ORDER BY event_id LIMIT 1`, [storeId, date, kind, titleKey(title), eventId]);
  return row ? eventRow(row) : undefined;
}

export async function readPreferences({ db, storeId }: Scope): Promise<Preferences> {
  const { rows: [row] } = await db.query<Preferences>(`
    SELECT source_visibility AS "sourceVisibility", category_visibility AS "categoryVisibility", revision
    FROM customer.calendar_preferences WHERE store_id = $1`, [storeId]);
  return row ?? { sourceVisibility: { pickup: true, delivery: true, reservation: false, shift: true, deadline: true, direct: true },
    categoryVisibility: { 'store-operations': true, purchasing: true, 'tax-admin': true }, revision: 0 };
}

export async function savePreferences({ db, storeId }: Scope, next: Preferences) {
  await db.query(`INSERT INTO customer.calendar_preferences (store_id, source_visibility, category_visibility, revision)
    VALUES ($1, $2, $3, $4) ON CONFLICT (store_id) DO UPDATE SET source_visibility = EXCLUDED.source_visibility,
    category_visibility = EXCLUDED.category_visibility, revision = EXCLUDED.revision`,
  [storeId, next.sourceVisibility, next.categoryVisibility, next.revision]);
}

export async function persistChanges({ db, storeId }: Scope, changes: readonly Change[], at: string) {
  const staff = changes.flatMap(({ after }) => after.type === 'staff' ? [after.row] : []);
  const shifts = changes.flatMap(({ after }) => after.type === 'shifts' ? [after.row] : []);
  const calendar = changes.flatMap(({ after }) => after.type === 'calendar' ? [after.row] : []);
  if (staff.length) await db.query(`
    INSERT INTO customer.staff (store_id, staff_id, name, archived_at, revision)
    SELECT $1, "staffId", name, "archivedAt", revision
    FROM jsonb_to_recordset($2) AS row("staffId" uuid, name text, "archivedAt" timestamptz, revision int)
    ON CONFLICT (store_id, staff_id) DO UPDATE SET name = EXCLUDED.name, archived_at = EXCLUDED.archived_at, revision = EXCLUDED.revision`,
  [storeId, JSON.stringify(staff)]);
  if (shifts.length) await db.query(`
    INSERT INTO customer.staff_shift (store_id, schedule_id, staff_id, shift_date, kind, start_minute, end_minute, break_minutes, archived_at, revision)
    SELECT $1, "scheduleId", "staffId", date, kind, "startMinute", "endMinute", "breakMinutes", "archivedAt", revision
    FROM jsonb_to_recordset($2) AS row("scheduleId" uuid, "staffId" uuid, date date, kind text, "startMinute" int, "endMinute" int,
      "breakMinutes" int, "archivedAt" timestamptz, revision int)
    ON CONFLICT (store_id, schedule_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, shift_date = EXCLUDED.shift_date, kind = EXCLUDED.kind,
      start_minute = EXCLUDED.start_minute, end_minute = EXCLUDED.end_minute, break_minutes = EXCLUDED.break_minutes,
      archived_at = EXCLUDED.archived_at, revision = EXCLUDED.revision`,
  [storeId, JSON.stringify(shifts.map(row => ({ ...row, startMinute: minutes(row.start), endMinute: minutes(row.end) })))]);
  if (calendar.length) await db.query(`
    INSERT INTO customer.calendar_event (store_id, event_id, kind, category_id, title, title_key, starts_on, start_minute, memo,
      closure_kind, closure_ends_on, archived_at, revision)
    SELECT $1, "eventId", kind, "categoryId", title, "titleKey", date, "startMinute", memo, "closureKind", "closureEnd", "archivedAt", revision
    FROM jsonb_to_recordset($2) AS row("eventId" uuid, kind text, "categoryId" text, title text, "titleKey" text, date date, "startMinute" int,
      memo text, "closureKind" text, "closureEnd" date, "archivedAt" timestamptz, revision int)
    ON CONFLICT (store_id, event_id) DO UPDATE SET category_id = EXCLUDED.category_id, title = EXCLUDED.title, title_key = EXCLUDED.title_key,
      starts_on = EXCLUDED.starts_on, start_minute = EXCLUDED.start_minute, memo = EXCLUDED.memo, closure_kind = EXCLUDED.closure_kind,
      closure_ends_on = EXCLUDED.closure_ends_on, archived_at = EXCLUDED.archived_at, revision = EXCLUDED.revision`,
  [storeId, JSON.stringify(calendar.map(row => ({ ...row, titleKey: titleKey(row.title), startMinute: minutes(row.time),
    closureKind: row.storeClosure?.kind, closureEnd: row.storeClosure?.endDate })))]);

  const history = changes.filter(({ after }) => after.type !== 'calendar').map(change => {
    const before = active(change.before);
    const after = active(change.after);
    return { before, after, changeId: randomUUID(), entityId: entityId(change.after), operation: before ? (after ? 'update' : 'delete') : 'create' };
  });
  if (history.length) await db.query(`
    INSERT INTO customer.staff_schedule_history (store_id, change_id, changed_at, entity_id, operation, before_row, after_row)
    SELECT $1, "changeId", $2, "entityId", operation, before, after
    FROM jsonb_to_recordset($3) AS row("changeId" uuid, "entityId" uuid, operation text, before jsonb, after jsonb)`,
  [storeId, at, JSON.stringify(history)]);
}
