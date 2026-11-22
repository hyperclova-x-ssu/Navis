import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { approvalFingerprint, approvalInput, cardApprovals } from '../../../../packages/approvals/index.ts';
import type { NaverBinding } from '../../../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../../../packages/naver/transport/index.ts';
import { createOwnerGrantResolver } from '../../../account/naver/oauth.ts';
import { NaverError, selector, type OwnerContext } from '../../../account/naver/wire.ts';
import { createCustomerNaver, createWorksCalendar } from '../../naver/index.ts';
import { getEntity } from './commands.ts';
import { buildNaverCalendarEvent } from './exports.ts';
import type { CalendarPushReceipt, WorksList, WorksPushReceipt } from './naver-wire.ts';
import { loadEntities, lockCalendarStaff, type Scope } from './records.ts';
import { checkRevision, conflict, date, integer, invalid, missing, object, ScheduleError, uuid, type Shift } from './wire.ts';

export { buildNaverCalendarEvent } from './exports.ts';
type Operation = 'calendar.add' | 'works.create' | 'works.update' | 'works.delete';
type Context = Scope & OwnerContext & { now: () => Date; timezone: string };
type Receipt = CalendarPushReceipt | WorksPushReceipt;
type TransactionContext = Omit<Context, 'db'> & {
  transaction: <T>(run: (db: PoolClient) => Promise<T>) => Promise<T>;
};
type Pending = {
  actorId: string; approvalId: string; operation: Operation;
  fingerprint: string; receipt: WorksPushReceipt | null; window: [string, string] | null; running: boolean;
};
type Attempt = Pick<Pending, 'window' | 'receipt'> & { call(): Promise<Receipt> };
export type NaverCalendarOptions = {
  bindings: readonly Exclude<NaverBinding, { mode: 'live' }>[];
  readCalendarGrant: Parameters<typeof createOwnerGrantResolver>[0];
  resolveWorksTarget: (ctx: OwnerContext) => Promise<{ userId: string; calendarId: string } | undefined>;
};

const dayMs = 86_400_000;
const digest = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const calendarId = 'defaultCalendarId';
const approvals = cardApprovals('customer');

export function parseWorksWindow(query: unknown): [string, string] {
  const input = object(query, ['fromDateTime', 'untilDateTime']);
  function instant(field: string) {
    const value = input[field];
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw invalid(field, 'INVALID_DATE_RANGE');
    date(value.slice(0, 10), field);
    return value;
  }
  const start = instant('fromDateTime'), end = instant('untilDateTime');
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 31 * dayMs) throw invalid('untilDateTime', 'INVALID_DATE_RANGE');
  return [start, end];
}

const worksEventId = (storeId: string, teamKey: string, scheduleId: string) => digest(storeId, teamKey, scheduleId);

export function worksShiftEvent(storeId: string, teamKey: string, shift: Shift, name: string) {
  const eventId = worksEventId(storeId, teamKey, shift.scheduleId);
  const summary = `${name} ${shift.kind === 'off' ? '휴무' : '근무'}`;
  if (shift.start && shift.end) {
    const time = (value: string) => ({ dateTime: `${shift.date}T${value}:00`, timeZone: 'Asia/Seoul' as const });
    return { eventId, summary, start: time(shift.start), end: time(shift.end) };
  }
  if (shift.date === '9999-12-31') throw invalid('date', 'INVALID_DATE_RANGE');
  return { eventId, summary, start: { date: shift.date },
    end: { date: new Date(Date.parse(shift.date) + dayMs).toISOString().slice(0, 10) } };
}

export function createCalendarNaverCommands(options: NaverCalendarOptions) {
  if (options.bindings.some(binding => binding.mode !== 'fake' && binding.mode !== 'virtual')) {
    throw new Error('PN11 calendar requires FAKE or persona bindings');
  }
  const bindings = options.bindings.map(binding => ({ ...binding }));
  const transport = createNaverTransport({ bindings });
  const boundAccount = (storeId: string, operation: string) =>
    bindings.find(binding => binding.storeId === storeId && binding.operation === operation)?.providerAccount;
  async function works(ctx: OwnerContext) {
    const target = await options.resolveWorksTarget(ctx);
    if (!target) throw new NaverError(403, 'WORKS_CALENDAR_REQUIRED');
    const account = boundAccount(ctx.storeId, 'pn11.works.list');
    if (!account) throw new NaverError(403, 'WORKS_CALENDAR_REQUIRED');
    const key = digest('works', account, selector(target.userId), selector(target.calendarId));
    const adapter = createWorksCalendar({
      request(operation, storeId, path, init) {
        if (boundAccount(storeId, operation) !== account) throw new NaverError(403, 'WORKS_CALENDAR_REQUIRED');
        return transport.request(operation, storeId, path, init);
      },
    }, () => target);
    return { key, adapter };
  }

  function grant(ctx: TransactionContext) {
    return createOwnerGrantResolver(options.readCalendarGrant, ctx.now)(ctx, 'calendar');
  }

  async function list(ctx: TransactionContext, query: unknown): Promise<WorksList> {
    const window = parseWorksWindow(query);
    const { key, adapter } = await works(ctx);
    const { rows } = await ctx.transaction(db => db.query<{ receipt: WorksPushReceipt }>(`
      SELECT DISTINCT ON (resource_id) receipt FROM customer.pn11_calendar_receipt
      WHERE store_id=$1 AND actor_id=$2 AND target_key=$3 AND operation LIKE 'works.%'
      ORDER BY resource_id, receipt_seq DESC`, [ctx.storeId, ctx.actorId, key]));
    const owned = new Map(rows.filter(row => row.receipt.operation !== 'delete')
      .map(({ receipt }) => [receipt.eventId, receipt]));
    const results = await adapter.list(ctx, ...window);
    return { items: results.flatMap(result => result.eventComponents.flatMap(({ eventId, summary, start, end }) => {
      const receipt = owned.get(eventId);
      return receipt ? [{ scheduleId: receipt.scheduleId, revision: receipt.revision, sentAt: receipt.sentAt,
        eventId, summary, start, ...(end && { end }) }] : [];
    })) };
  }

  async function readCalendarReceipt(ctx: Context, resourceId: string) {
    await getEntity(ctx, 'calendar', resourceId, 'eventId');
    const { rows: [row] } = await ctx.db.query<{ receipt: CalendarPushReceipt }>(`
      SELECT receipt FROM customer.pn11_calendar_receipt WHERE store_id=$1 AND actor_id=$2
        AND resource_id=$3 AND operation='calendar.add'
      ORDER BY receipt_seq DESC LIMIT 1`, [ctx.storeId, ctx.actorId, resourceId]);
    return { receipt: row?.receipt ?? null };
  }

  async function destination(ctx: OwnerContext, operation: Operation) {
    const team = operation === 'calendar.add' ? null : await works(ctx);
    const calendarAccount = boundAccount(ctx.storeId, 'pn11.calendar.create');
    if (!team && !calendarAccount) throw new NaverError(403, 'NAVER_GRANT_REQUIRED');
    return { team, targetKey: team?.key ?? digest('calendar', calendarAccount, calendarId) };
  }

  function binding(ctx: OwnerContext, operation: Operation, targetRef: string, expectedRevision: number,
    targetKey: string, expectedStaffRevision?: number) {
    return { storeId: ctx.storeId, actorId: ctx.actorId, operation, targetRef, expectedRevision,
      fingerprint: approvalFingerprint({ targetKey, expectedStaffRevision }), requiresConfirmation: operation === 'works.delete' };
  }

  async function approve(ctx: TransactionContext, raw: unknown) {
    const input = approvalInput(raw);
    if (!['calendar.add', 'works.create', 'works.update', 'works.delete'].includes(input.operation)) throw invalid('operation');
    const operation = input.operation as Operation;
    const resourceId = uuid(input.targetRef, 'targetRef');
    const needsStaff = operation === 'works.create' || operation === 'works.update';
    const command = object(input.command, operation !== 'calendar.add' ? ['expectedStaffRevision'] : []);
    if (operation === 'works.delete' && command.expectedStaffRevision !== undefined) {
      integer(command.expectedStaffRevision, 'expectedStaffRevision', 1);
    }
    const expectedStaffRevision = needsStaff ? integer(command.expectedStaffRevision, 'expectedStaffRevision', 1) : undefined;
    const { targetKey } = await destination(ctx, operation);
    return ctx.transaction(async db => {
      const scoped = { ...ctx, db };
      await lockCalendarStaff(scoped);
      if (operation === 'calendar.add') {
        const { row } = await getEntity(scoped, 'calendar', resourceId, 'eventId');
        checkRevision(input.expectedRevision, row.revision);
      } else {
        const [entity] = await loadEntities(scoped, 'shifts', [resourceId]);
        if (entity?.type !== 'shifts' || (entity.row.archivedAt && operation !== 'works.delete')) throw missing('scheduleId');
        checkRevision(input.expectedRevision, entity.row.revision);
        if (needsStaff) {
          const { row } = await getEntity(scoped, 'staff', entity.row.staffId, 'staffId');
          checkRevision(expectedStaffRevision, row.revision);
        }
      }
      return approvals.issue(db, input, binding(ctx, operation, resourceId, input.expectedRevision, targetKey, expectedStaffRevision), ctx.now());
    });
  }

  async function write(ctx: TransactionContext, operation: Operation, resourceId: string, body: unknown, idempotencyKey: unknown): Promise<Receipt> {
    const isCalendar = operation === 'calendar.add';
    const secondConfirmation = operation === 'works.delete';
    const needsStaff = !isCalendar && !secondConfirmation;
    const input = object(body, ['approvalId', 'expectedRevision', ...(!isCalendar ? ['expectedStaffRevision'] : [])]);
    const approvalId = uuid(input.approvalId, 'approvalId');
    if (idempotencyKey !== approvalId) throw invalid('Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED');
    const expectedRevision = integer(input.expectedRevision, 'expectedRevision', 1);
    if (secondConfirmation && input.expectedStaffRevision !== undefined) {
      integer(input.expectedStaffRevision, 'expectedStaffRevision', 1);
    }
    const expectedStaffRevision = needsStaff ? integer(input.expectedStaffRevision, 'expectedStaffRevision', 1) : undefined;
    const owner = { storeId: ctx.storeId, actorId: ctx.actorId };
    const { team, targetKey } = await destination(owner, operation);
    const fingerprint = digest(operation, resourceId, expectedRevision, expectedStaffRevision, targetKey);
    const transact = <T>(run: (scoped: Context) => Promise<T>) => ctx.transaction(async db => {
      const scoped = { ...ctx, db };
      await lockCalendarStaff(scoped);
      return run(scoped);
    });

    async function source(scoped: Context) {
      if (isCalendar) {
        const { row } = await getEntity(scoped, 'calendar', resourceId, 'eventId');
        checkRevision(expectedRevision, row.revision);
        return { kind: 'calendar' as const, row };
      }
      const [entity] = await loadEntities(scoped, 'shifts', [resourceId]);
      if (entity?.type !== 'shifts' || (entity.row.archivedAt && !secondConfirmation)) throw missing('scheduleId');
      const shift = entity.row;
      checkRevision(expectedRevision, shift.revision);
      const staff = needsStaff ? (await getEntity(scoped, 'staff', shift.staffId, 'staffId')).row : null;
      if (staff) checkRevision(expectedStaffRevision, staff.revision);
      return { kind: 'works' as const, shift, staff };
    }

    async function insertReceipt(db: PoolClient, pending: Pick<Pending, 'actorId' | 'approvalId' | 'operation' | 'fingerprint'>, receipt: Receipt) {
      await db.query(
        'INSERT INTO customer.pn11_calendar_receipt ' +
        '(store_id, actor_id, approval_id, target_key, operation, resource_id, fingerprint, receipt, sent_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [ctx.storeId, pending.actorId, pending.approvalId, targetKey, pending.operation,
          resourceId, pending.fingerprint, receipt, receipt.sentAt]);
      await db.query('DELETE FROM customer.pn11_calendar_pending WHERE store_id=$1 AND approval_id=$2',
        [ctx.storeId, pending.approvalId]);
    }

    async function reconcile(pending: Pending) {
      if (!team || pending.operation !== 'works.create' || !pending.window) throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
      const receipt = pending.receipt;
      if (!receipt) throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
      const events = await team.adapter.list(owner, ...pending.window);
      if (!events.some(event => event.eventComponents.some(component => component.eventId === receipt.eventId))) {
        throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
      }
      await transact(async ({ db }) => {
        const active = await db.query('SELECT 1 FROM customer.pn11_calendar_pending WHERE store_id=$1 AND approval_id=$2',
          [ctx.storeId, pending.approvalId]);
        if (active.rowCount) await insertReceipt(db, pending, receipt);
      });
    }

    const card = { key: approvalId, ...(secondConfirmation && { extraConfirmed: true as const }) };
    async function prepare({ db, ...scoped }: Context) {
      const { rows: [prior] } = await db.query<{ actorId: string; fingerprint: string; receipt: Receipt }>(
        'SELECT actor_id AS "actorId", fingerprint, receipt FROM customer.pn11_calendar_receipt WHERE store_id=$1 AND approval_id=$2',
        [ctx.storeId, approvalId]);
      if (prior) {
        if (prior.actorId !== ctx.actorId) throw missing('approvalId');
        if (prior.fingerprint !== fingerprint) throw conflict('APPROVAL_CONFLICT', 'approvalId');
        return { state: 'completed' as const, receipt: prior.receipt };
      }

      const { rows: [pending] } = await db.query<Pending>(
        'SELECT actor_id AS "actorId", approval_id AS "approvalId", operation, fingerprint, receipt, ' +
        'list_window AS "window", coalesce(running_until > clock_timestamp(), false) AS running ' +
        'FROM customer.pn11_calendar_pending WHERE store_id=$1 AND ' +
        '(approval_id=$2 OR (target_key=$3 AND resource_id=$4)) ORDER BY (approval_id=$2) DESC LIMIT 1',
        [ctx.storeId, approvalId, targetKey, resourceId]);
      if (pending) {
        if (pending.actorId !== ctx.actorId) throw missing('approvalId');
        if (pending.approvalId === approvalId && pending.fingerprint !== fingerprint) {
          throw conflict('APPROVAL_CONFLICT', 'approvalId');
        }
        if (pending.running) throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
        // Reconciliation only records a previously approved create. A new provider write still requires its own card.
        if (pending.operation === 'works.create') return { state: 'pending' as const, pending };
        if (pending.approvalId !== approvalId) throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
      } else if (!await approvals.consume(db,
        binding(owner, operation, resourceId, expectedRevision, targetKey, expectedStaffRevision), approvalId, ctx.now())) {
        throw new NaverError(403, 'CARD_REQUIRED');
      }

      const current = await source({ ...scoped, db });
      const sentAt = ctx.now();
      const audit = { resourceId, receiptId: approvalId, revision: expectedRevision, sentAt: sentAt.toISOString() };
      let attempt: Attempt;
      if (current.kind === 'calendar') {
        const { ical } = buildNaverCalendarEvent(current.row, ctx.storeId, sentAt, ctx.timezone);
        attempt = {
          receipt: null,
          window: null,
          async call() {
            const accessToken = await grant(ctx);
            const calendar = createCustomerNaver({
              request(op, storeId, path, init) {
                const headers = new Headers(init?.headers);
                headers.set('authorization', 'Bearer ' + accessToken);
                return transport.request(op, storeId, path, { ...init, headers });
              },
            });
            const result = await calendar.addCalendarEvent(owner, card, calendarId, ical);
            if (!result.calendarId || !result.icalUid) throw new NaverError(502, 'INVALID_NAVER_RESPONSE');
            return { ...audit, eventId: resourceId, processType: result.processType, affectedSources: ['calendar'] };
          },
        };
      } else {
        if (!team) throw new NaverError(403, 'WORKS_CALENDAR_REQUIRED');
        const { shift, staff } = current;
        const eventId = worksEventId(ctx.storeId, targetKey, shift.scheduleId);
        const action = operation === 'works.create' ? 'create' : operation === 'works.update' ? 'update' : 'delete';
        const { rows: [previous] } = await db.query<{ operation: Operation }>(
          "SELECT operation FROM customer.pn11_calendar_receipt WHERE store_id=$1 AND actor_id=$2 " +
          "AND target_key=$3 AND resource_id=$4 AND operation LIKE 'works.%' ORDER BY receipt_seq DESC LIMIT 1",
          [ctx.storeId, ctx.actorId, targetKey, resourceId]);
        if (action === 'create' && previous) throw conflict('WORKS_ALREADY_EXPORTED', 'scheduleId');
        if (action !== 'create' && (!previous || previous.operation === 'works.delete')) throw missing('scheduleId');
        const event = staff ? worksShiftEvent(ctx.storeId, targetKey, shift, staff.name) : null;
        const receipt: WorksPushReceipt = { ...audit, scheduleId: resourceId, eventId, operation: action, affectedSources: ['staff-schedule'] };
        attempt = {
          receipt,
          window: action === 'create' ? [shift.date + 'T00:00:00+09:00',
            new Date(Date.parse(shift.date) + dayMs).toISOString().slice(0, 10) + 'T00:00:00+09:00'] : null,
          async call() {
            if (action === 'delete') await team.adapter.remove(owner, card, eventId);
            else {
              if (!event) throw new NaverError(409, 'INVALID_WORKS_SHIFT');
              const result = await team.adapter[action](owner, card, event);
              if (result.eventComponents.length !== 1 || result.eventComponents[0].eventId !== eventId) {
                throw new NaverError(502, 'INVALID_NAVER_RESPONSE');
              }
            }
            return receipt;
          },
        };
      }
      if (pending) {
        await db.query(
          "UPDATE customer.pn11_calendar_pending SET running_until=clock_timestamp() + interval '3 minutes' WHERE store_id=$1 AND approval_id=$2",
          [ctx.storeId, approvalId]);
      } else {
        await db.query(
          'INSERT INTO customer.pn11_calendar_pending ' +
          '(store_id, actor_id, approval_id, target_key, operation, resource_id, fingerprint, receipt, list_window, running_until) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp() + interval '3 minutes')",
          [ctx.storeId, ctx.actorId, approvalId, targetKey, operation, resourceId, fingerprint, attempt.receipt, attempt.window]);
      }
      return { state: 'prepared' as const, attempt };
    }

    let prepared = await transact(prepare);
    if (prepared.state === 'pending') {
      await reconcile(prepared.pending);
      prepared = await transact(prepare);
    }
    if (prepared.state === 'completed') return prepared.receipt;
    if (prepared.state === 'pending') throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');

    let receipt: Receipt;
    try {
      receipt = await prepared.attempt.call();
    } catch (error) {
      const rejected = error instanceof NaverError && error.status < 500 && error.status !== 408 && error.status !== 429
        && !(operation === 'works.create' && error.status === 409);
      await transact(({ db }) => db.query(rejected
        ? 'DELETE FROM customer.pn11_calendar_pending WHERE store_id=$1 AND approval_id=$2'
        : 'UPDATE customer.pn11_calendar_pending SET running_until=NULL WHERE store_id=$1 AND approval_id=$2',
      [ctx.storeId, approvalId]));
      if (rejected) throw error;
      throw conflict('NAVER_OUTCOME_PENDING', 'approvalId');
    }
    const stale = await transact(async scoped => {
      let changed: ScheduleError | undefined;
      try {
        await source(scoped);
      } catch (error) {
        if (!(error instanceof ScheduleError)) throw error;
        changed = error;
      }
      await insertReceipt(scoped.db, { ...owner, approvalId, operation, fingerprint }, receipt);
      return changed;
    });
    if (stale) throw stale;
    return receipt;
  }
  return { approve, list, readCalendarReceipt, write };
}
