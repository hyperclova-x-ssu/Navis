import { createHash, randomUUID } from 'node:crypto';
import {
  bumpRevision, duplicateEvent, entityId, loadEntities, lockCalendarStaff, persistChanges, readPreferences, relevantShifts, savePreferences,
  sourceRevision, type Change, type Entity, type RevisionSource, type Scope,
} from './records.ts';
import {
  categories, checkRevision, choice, conflict, confirmation, date, integer, invalid, minutes, missing, object, ScheduleError, sources,
  storeTime, text, time, titleKey, uuid, type Shift,
} from './wire.ts';

type Domain = 'staff' | 'calendar';
type Operation = 'create' | 'update' | 'delete' | 'handoff' | 'preferences' | 'undo';
type Context = Scope & { now: () => Date; timezone: string; actorId: string };
type Result = { resourceId: string; revision: number; changes: readonly Change[]; resourceIds?: Record<string, string | readonly string[]>;
  preferencesChanged?: boolean };
type Receipt = { resourceId: string; revision: number; receiptId: string; changed: boolean; affectedSources: readonly string[]; undoUntil?: string };
type StoredReceipt = { receipt: Receipt; inverse: readonly Change[] | null; undone_at: Date | null };
export type Command = { type: Entity['type'] | 'preferences' | 'handoff' | 'undo'; operation: Operation; domain: Domain; id?: string };

const staffSources = ['staff-schedule', 'calendar', 'customer-analysis', 'briefing'];
const calendarSources = ['calendar', 'notice-send', 'ai-response', 'briefing'];
const undoMs = 6000;
const eventFields = ['title', 'date', 'time', 'memo', 'storeClosure', 'categoryId', 'dateIntent', 'confirmDuplicate'];
const shiftFields = ['staffId', 'date', 'kind', 'start', 'end', 'breakMinutes'];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
  }
  return value;
}

export async function getEntity<T extends Entity['type']>(scope: Scope, type: T, id: string, field: string) {
  const [entity] = await loadEntities(scope, type, [id]);
  if (!entity || entity.row.archivedAt) throw missing(field);
  return entity as Extract<Entity, { type: T }>;
}

async function eventEntity(scope: Scope, id: string) {
  if (id.startsWith('shift:')) throw conflict('READ_ONLY_SOURCE', 'eventId');
  if (id.includes(':')) throw conflict('AUTO_EVENT_READ_ONLY', 'eventId');
  const eventId = uuid(id, 'eventId');
  const [event] = await loadEntities(scope, 'calendar', [eventId]);
  if (event?.type === 'calendar' && event.row.archivedAt === null) return event;
  const [shift] = await loadEntities(scope, 'shifts', [eventId]);
  if (shift?.row.archivedAt === null) throw conflict('READ_ONLY_SOURCE', 'eventId');
  throw missing('eventId');
}

function result(entity: Entity, changes: readonly Change[], resourceIds?: Result['resourceIds']): Result {
  return { resourceId: entityId(entity), revision: entity.row.revision, changes, resourceIds };
}

function revise(entity: Entity, revision: number, archivedAt = entity.row.archivedAt): Entity {
  return { ...entity, row: { ...entity.row, archivedAt, revision } } as Entity;
}

function archive(entity: Entity, at: string): Entity {
  return revise(entity, entity.row.revision + 1, at);
}

async function staff(ctx: Context, { id, operation }: Command, raw: unknown, at: string): Promise<Result> {
  if (operation === 'create') {
    const input = object(raw, ['name']);
    const staffId = randomUUID();
    const row = { staffId, name: text(input.name, 'name', 120, 'NAME_REQUIRED'), archivedAt: null, revision: 1 };
    const after = { type: 'staff', row } as const;
    return result(after, [{ before: null, after }], { staffId });
  }

  const staffId = uuid(id, 'staffId');
  const before = await getEntity(ctx, 'staff', staffId, 'staffId');
  if (operation === 'delete') {
    const input = object(raw, ['expectedRevision', 'cascadeSchedules', 'confirmed', 'expectedScheduleRevision']);
    confirmation(input.confirmed);
    checkRevision(input.expectedRevision, before.row.revision);
    if (input.cascadeSchedules !== true) throw invalid('cascadeSchedules', 'CASCADE_REQUIRED');
    const scheduleRevision = await sourceRevision(ctx, 'shifts');
    if (integer(input.expectedScheduleRevision, 'expectedScheduleRevision') !== scheduleRevision) {
      throw conflict('STALE_REVISION', 'expectedScheduleRevision', { revision: scheduleRevision });
    }
    const shifts = (await relevantShifts(ctx, { staffId })).map(row => ({ type: 'shifts', row }) as const);
    const after = archive(before, at);
    return result(after, [{ before, after }, ...shifts.map(before => ({ before, after: archive(before, at) }))],
      { staffId, deletedStaffIds: [staffId], deletedScheduleIds: shifts.map(entityId) });
  }

  const input = object(raw, ['name', 'expectedRevision']);
  checkRevision(input.expectedRevision, before.row.revision);
  const name = text(input.name, 'name', 120, 'NAME_REQUIRED');
  if (name === before.row.name) return result(before, [], { staffId });
  const after = { type: 'staff', row: { ...before.row, name, revision: before.row.revision + 1 } } as const;
  return result(after, [{ before, after }], { staffId });
}

function validateShift(row: Shift) {
  if (row.kind === 'off') return;
  if (row.start === null || row.end === null || row.start >= row.end) throw invalid('end', 'INVALID_SHIFT');
  if (row.breakMinutes >= minutes(row.end)! - minutes(row.start)!) throw invalid('breakMinutes', 'BREAK_TOO_LONG');
}

function checkOverlap(rows: readonly Shift[], row: Shift, field: string) {
  const conflicts = rows.filter(peer => peer.scheduleId !== row.scheduleId && peer.staffId === row.staffId && peer.date === row.date
    && (peer.kind === 'off' || row.kind === 'off' || (row.start! < peer.end! && peer.start! < row.end!)))
    .map(({ scheduleId, kind, start, end }) => ({ scheduleId, kind, start, end }));
  if (conflicts.length) throw conflict('STAFF_SHIFT_OVERLAP', field, { staffId: row.staffId, date: row.date, conflicts });
}

async function shifts(ctx: Context, { id, operation }: Command, raw: unknown, at: string): Promise<Result> {
  const scheduleId = id === undefined ? randomUUID() : uuid(id, 'scheduleId');
  const before = id === undefined ? null : await getEntity(ctx, 'shifts', scheduleId, 'scheduleId');
  if (operation === 'delete' && before) {
    const input = object(raw, ['expectedRevision', 'confirmed']);
    confirmation(input.confirmed);
    checkRevision(input.expectedRevision, before.row.revision);
    const after = archive(before, at);
    return result(after, [{ before, after }], { scheduleId, deletedScheduleIds: [scheduleId] });
  }

  const input = object(raw, before ? [...shiftFields, 'expectedRevision'] : shiftFields);
  if (before) checkRevision(input.expectedRevision, before.row.revision);
  const staffId = uuid(input.staffId, 'staffId');
  await getEntity(ctx, 'staff', staffId, 'staffId');
  const kind = choice(input.kind, ['work', 'off'] as const, 'kind', 'INVALID_SHIFT');
  if (kind === 'off' && (input.start != null || input.end != null || (input.breakMinutes !== undefined && input.breakMinutes !== 0))) {
    throw invalid('kind', 'INVALID_SHIFT');
  }
  const row = { scheduleId, staffId, kind, date: date(input.date, 'date'), archivedAt: null,
    start: kind === 'work' ? time(input.start, 'start', 'INVALID_SHIFT') : null,
    end: kind === 'work' ? time(input.end, 'end', 'INVALID_SHIFT') : null,
    breakMinutes: input.breakMinutes === undefined ? 0 : integer(input.breakMinutes, 'breakMinutes', 0, 1439),
    revision: (before?.row.revision ?? 0) + 1 };
  validateShift(row);
  if (before && ['staffId', 'kind', 'date', 'start', 'end', 'breakMinutes'].every(key => row[key as keyof Shift] === before.row[key as keyof Shift])) {
    return result(before, [], { scheduleId });
  }
  checkOverlap(await relevantShifts(ctx, { candidates: [row] }), row, kind === 'off' ? 'kind' : 'start');
  const after = { type: 'shifts', row } as const;
  return result(after, [{ before, after }], { scheduleId });
}

async function handoff(ctx: Context, raw: unknown): Promise<Result> {
  const input = object(raw, ['date', 'fromTime', 'toTime', 'expectedRevision']);
  const revision = await sourceRevision(ctx, 'shifts');
  checkRevision(input.expectedRevision, revision);
  const day = date(input.date, 'date');
  const from = time(input.fromTime, 'fromTime', 'INVALID_SHIFT');
  const to = time(input.toTime, 'toTime', 'INVALID_SHIFT');
  const rows = await relevantShifts(ctx, { date: day });
  if (!rows.some(row => row.end === from) || !rows.some(row => row.start === from)) throw missing('fromTime');
  const peers = rows.filter(row => row.start === from || row.end === from);
  const scheduleIds = peers.map(row => row.scheduleId);
  const resourceId = scheduleIds[0];
  if (from === to) return { resourceId, revision, changes: [], resourceIds: { scheduleIds } };
  const shifted = peers.map(row => ({ ...row, start: row.start === from ? to : row.start,
    end: row.end === from ? to : row.end, revision: row.revision + 1 }));
  const touched = new Set(scheduleIds);
  const afterRows = [...rows.filter(row => !touched.has(row.scheduleId)), ...shifted];
  for (const row of shifted) {
    validateShift(row);
    checkOverlap(afterRows, row, 'toTime');
  }
  const changes = shifted.map((row, index) => ({ before: { type: 'shifts', row: peers[index] }, after: { type: 'shifts', row } }) as const);
  return { resourceId, revision: revision + 1, changes, resourceIds: { scheduleIds } };
}

async function event(ctx: Context, { id, operation }: Command, raw: unknown, at: string): Promise<Result> {
  const before = id === undefined ? null : await eventEntity(ctx, id);
  const eventId = before?.row.eventId ?? randomUUID();
  if (operation === 'delete' && before) {
    const input = object(raw, ['expectedRevision', 'confirmed']);
    confirmation(input.confirmed);
    checkRevision(input.expectedRevision, before.row.revision);
    const after = archive(before, at);
    return result(after, [{ before, after }], { eventId });
  }

  const input = object(raw, before ? [...eventFields, 'expectedRevision'] : [...eventFields, 'kind']);
  if (before) checkRevision(input.expectedRevision, before.row.revision);
  const prior = before?.row;
  const kind = prior?.kind ?? choice(input.kind, ['event', 'todo'] as const, 'kind');
  const clock = storeTime(new Date(at), ctx.timezone);
  const day = input.date === undefined && (prior || kind === 'todo') ? prior?.date ?? clock.date : date(input.date, 'date');
  const start = input.time === undefined ? prior?.time ?? null : input.time === null ? null : time(input.time, 'time');
  if (kind === 'todo' && start !== null) throw invalid('time');
  const categoryId = input.categoryId === undefined ? prior?.categoryId ?? 'store-operations' : choice(input.categoryId, categories, 'categoryId', 'CATEGORY_INVALID');
  let storeClosure = prior?.storeClosure ?? null;
  if (input.storeClosure !== undefined) {
    const closure = input.storeClosure === null ? null : object(input.storeClosure, ['kind', 'endDate']);
    storeClosure = closure && { kind: choice(closure.kind, ['regular', 'temporary'] as const, 'storeClosure'), endDate: date(closure.endDate, 'storeClosure') };
  }
  if (storeClosure && (kind !== 'event' || categoryId !== 'store-operations' || storeClosure.endDate < day)) {
    throw invalid('storeClosure', 'INVALID_DATE_RANGE');
  }
  const title = input.title === undefined && prior ? prior.title : text(input.title, 'title', 200, 'TITLE_REQUIRED');
  const memo = input.memo === undefined ? prior?.memo ?? null : input.memo === null ? null : text(input.memo, 'memo', 2000) || null;
  if (input.dateIntent !== undefined && input.dateIntent !== 'historical') throw invalid('dateIntent');
  if (input.confirmDuplicate !== undefined && typeof input.confirmDuplicate !== 'boolean') throw invalid('confirmDuplicate');
  const dateChanged = day !== prior?.date;
  const timeChanged = start !== prior?.time;
  const historical = (dateChanged && day < clock.date) || ((dateChanged || timeChanged) && day === clock.date && start !== null && start < clock.time);
  if (historical && input.dateIntent !== 'historical') throw new ScheduleError(400, 'CALENDAR_PAST_DATE', 'date', { date: day, today: clock.date, time: start });

  const next = { eventId, kind, categoryId, title, date: day, time: start, memo, storeClosure, archivedAt: null, revision: (prior?.revision ?? 0) + 1 };
  if (input.confirmDuplicate !== true && (dateChanged || titleKey(title) !== titleKey(prior?.title ?? ''))) {
    const duplicate = await duplicateEvent(ctx, next);
    if (duplicate) throw conflict('CALENDAR_DUPLICATE', 'title', { eventId: duplicate.eventId, date: duplicate.date, time: duplicate.time, title: duplicate.title });
  }
  if (before && prior && prior.title === title && prior.memo === memo && !dateChanged && !timeChanged && prior.categoryId === categoryId
    && prior.storeClosure?.kind === storeClosure?.kind && prior.storeClosure?.endDate === storeClosure?.endDate) return result(before, [], { eventId });
  const after = { type: 'calendar', row: next } as const;
  return result(after, [{ before, after }], { eventId });
}

async function preferences(ctx: Context, raw: unknown): Promise<Result> {
  const input = object(raw, ['source', 'categoryId', 'visible', 'expectedRevision']);
  const prior = await readPreferences(ctx);
  checkRevision(input.expectedRevision, prior.revision);
  const { visible } = input;
  if (typeof visible !== 'boolean') throw invalid('visible');
  if ((input.source === undefined) === (input.categoryId === undefined)) throw invalid('source');
  const next = { sourceVisibility: { ...prior.sourceVisibility }, categoryVisibility: { ...prior.categoryVisibility }, revision: prior.revision + 1 };
  let changed: boolean;
  if (input.source !== undefined) {
    const source = choice(input.source, sources, 'source');
    changed = next.sourceVisibility[source] !== visible;
    next.sourceVisibility[source] = visible;
  } else {
    const category = choice(input.categoryId, categories, 'categoryId', 'CATEGORY_INVALID');
    changed = next.categoryVisibility[category] !== visible;
    next.categoryVisibility[category] = visible;
  }
  if (changed) await savePreferences(ctx, next);
  return { resourceId: ctx.storeId, revision: changed ? next.revision : prior.revision, changes: [], preferencesChanged: changed };
}

async function undo(ctx: Context, command: Command, raw: unknown, at: string): Promise<Result> {
  object(raw ?? {}, []);
  const receiptId = uuid(command.id, 'receiptId');
  const { rows: [original] } = await ctx.db.query<StoredReceipt>(`SELECT receipt, inverse, undone_at
    FROM customer.calendar_staff_command WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3 AND domain = $4`,
  [ctx.storeId, ctx.actorId, receiptId, command.domain]);
  if (!original) throw missing('receiptId');
  const { inverse, receipt, undone_at: undoneAt } = original;
  if (!receipt.undoUntil || !inverse || undoneAt) throw conflict('UNDO_UNAVAILABLE');
  if (new Date(at) >= new Date(receipt.undoUntil)) throw conflict('UNDO_EXPIRED');

  const types = new Set(inverse.map(change => change.after.type));
  const current = new Map<string, Entity>();
  for (const type of types) {
    const ids = inverse.filter(change => change.after.type === type).map(change => entityId(change.after));
    for (const entity of await loadEntities(ctx, type, ids)) current.set(entityId(entity), entity);
  }
  const changes = inverse.map(change => {
    const latest = current.get(entityId(change.after));
    if (!latest || latest.row.revision !== change.after.row.revision) throw conflict('UNDO_UNAVAILABLE');
    const after = change.before ? revise(change.before, latest.row.revision + 1) : archive(latest, at);
    return { before: latest, after };
  });
  for (const { after } of changes) {
    if (after.type === 'staff' && after.row.archivedAt && (await relevantShifts(ctx, { staffId: after.row.staffId })).length) {
      throw conflict('UNDO_UNAVAILABLE');
    }
  }
  const shifts = changes.flatMap(({ after }) => after.type === 'shifts' && after.row.archivedAt === null ? [after.row] : []);
  if (shifts.length) {
    const ids = new Set(shifts.map(row => row.staffId));
    const staff = new Map((await loadEntities(ctx, 'staff', [...ids])).map(row => [entityId(row), row]));
    for (const { after } of changes) if (after.type === 'staff') staff.set(entityId(after), after);
    if (shifts.some(row => staff.get(row.staffId)?.row.archivedAt !== null)) throw conflict('UNDO_UNAVAILABLE');
    const touched = new Set(changes.map(({ after }) => entityId(after)));
    const rows = [...(await relevantShifts(ctx, { candidates: shifts })).filter(row => !touched.has(row.scheduleId)), ...shifts];
    for (const row of shifts) checkOverlap(rows, row, 'start');
  }

  if (ctx.now() >= new Date(receipt.undoUntil)) throw conflict('UNDO_EXPIRED');
  await ctx.db.query(`UPDATE customer.calendar_staff_command SET undone_at = $3, inverse = NULL
    WHERE store_id = $1 AND receipt_id = $2`, [ctx.storeId, receiptId, at]);
  const primary = changes.find(change => entityId(change.after) === receipt.resourceId)!;
  return result(primary.after, changes);
}

async function perform(ctx: Context, command: Command, raw: unknown, at: string): Promise<Result> {
  switch (command.type) {
    case 'staff': return staff(ctx, command, raw, at);
    case 'shifts': return shifts(ctx, command, raw, at);
    case 'calendar': return event(ctx, command, raw, at);
    case 'handoff': return handoff(ctx, raw);
    case 'preferences': return preferences(ctx, raw);
    case 'undo': return undo(ctx, command, raw, at);
  }
}

export async function execute(ctx: Context, key: string, command: Command, input: unknown) {
  await lockCalendarStaff(ctx);
  const hash = createHash('sha256').update(JSON.stringify(canonical([command, input ?? {}]))).digest('hex');
  const { db, storeId, actorId } = ctx;
  const { rows: [duplicate] } = await db.query<{ command_hash: string; receipt: Receipt }>(`
    SELECT command_hash, receipt FROM customer.calendar_staff_command WHERE store_id = $1 AND actor_id = $2 AND command_key = $3`, [storeId, actorId, key]);
  if (duplicate) {
    if (duplicate.command_hash !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
    return duplicate.receipt;
  }

  const at = ctx.now().toISOString();
  const { resourceId, revision, changes, resourceIds, preferencesChanged } = await perform(ctx, command, input, at);
  const changed = changes.length > 0 || preferencesChanged === true;
  const affectedSources = !changed ? [] : command.type === 'preferences' ? ['calendar'] : command.domain === 'calendar' ? calendarSources : staffSources;
  const inverse = changes.length && command.type !== 'undo' ? changes : null;
  const receipt: Receipt = { resourceId, revision, receiptId: randomUUID(), changed, affectedSources, ...resourceIds,
    ...(inverse && { undoUntil: new Date(ctx.now().getTime() + undoMs).toISOString() }) };
  if (changes.length) await persistChanges(ctx, changes, at);
  if (changed) {
    const changedSources = new Set<RevisionSource>(changes.map(change => change.after.type));
    if (preferencesChanged) changedSources.add('calendar');
    const revisions = await bumpRevision(ctx, [...changedSources]);
    const source = command.domain === 'calendar' ? 'calendar' : changedSources.has('shifts') ? 'shifts' : 'staff';
    const eventType = command.domain === 'staff' ? 'customer.staff_schedule_changed.v1' : 'customer.calendar_changed.v1';
    await db.query(`WITH sequence AS (
        INSERT INTO customer.outbox_scope (scope_key, last_seq) VALUES ($1, 1)
        ON CONFLICT (scope_key) DO UPDATE SET last_seq = customer.outbox_scope.last_seq + 1 RETURNING last_seq
      ) INSERT INTO customer.outbox (store_id, scope_key, event_id, store_seq, event_type, aggregate_id, occurred_at, payload)
      SELECT $1::uuid, $1::text, $2, last_seq, $3, $4, $5, $6 FROM sequence`, [storeId, randomUUID(), eventType, resourceId, at,
      { resourceId, revision, sourceRevision: revisions[source], operation: command.operation, affectedSources }]);
  }
  await db.query(`INSERT INTO customer.calendar_staff_command (store_id, actor_id, command_key, command_hash, receipt_id,
    recorded_at, receipt, domain, inverse) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [storeId, actorId, key, hash, receipt.receiptId, at, receipt, command.domain, inverse && JSON.stringify(inverse)]);
  return receipt;
}
