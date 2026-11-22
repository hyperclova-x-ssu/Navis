import { randomUUID } from 'node:crypto';
import { isRecord } from '../../pos-client.ts';
import { checkRevision, conflict, date, invalid, missing, object, text, time, uuid } from '../07/wire.ts';
import { assertDistinct, assertMember, assertNoFirstOrder, bookLock, bumpBookingRevision, clearVisitUndoPhones, concurrentVisits, readCandidate, readLocalVisit,
  recordBookingChange, retainsVisitPhone, storeVisit, transitionCandidate, visitSummary, type Context } from './records.ts';
import { affectedSources, BookingUnavailable, guestPhone, parseTransition, sha, usageAt, visitFields, type ChangeKind,
  type LocalVisit, type ReadTables, type Transition } from './wire.ts';

const undoMs = 6_000;
const editable = new Set(['confirmed', 'needs-check', 'proposed']);
const noTable = { tableId: null, allocationWarning: null, capacityOverride: false } as const;
type Inverse = { kind: 'visit'; revision: number; before: LocalVisit | null } | { kind: 'proposal'; revision: number };
export type Receipt = { resourceId: string; revision: number; receiptId: string; affectedSources: string[]; changed: boolean;
  undoUntil?: string; reservationId?: string; suggestionId?: string; status?: string; tableId?: string | null; allocationWarning?: string | null;
  undoable?: false;
};
type Change = { visit: LocalVisit; before: LocalVisit | null; kind: ChangeKind; changed: boolean; undoable: boolean };
export type StoredCommand = { fingerprint: string; receipt_id: string; receipt: Receipt | null; provider_expired_at: Date | null };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export const fingerprint = (action: string, id: string | null, body: unknown) => sha([action, id, canonical(body)]);

export async function previousCommand({ db, storeId, actorId }: Context, key: string, hash: string) {
  const { rows: [previous] } = await db.query<StoredCommand>(`
    SELECT fingerprint, receipt_id, receipt, provider_expired_at FROM customer.booking_command WHERE store_id = $1 AND actor_id = $2 AND key = $3`,
  [storeId, actorId, key]);
  if (previous && previous.fingerprint !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
  if (previous?.provider_expired_at) throw conflict('BOOKING_PROVIDER_RETRY', 'reservationId');
  return previous;
}

function basicVisit(id: string): LocalVisit {
  return { reservationId: id, date: '', time: '', partySize: 0, revision: 0, status: 'confirmed', source: 'direct',
    memberId: null, guestName: null, guestPhone: null, request: null, ...noTable, preferredTableId: null, assignmentMode: 'auto',
    confirmedBy: 'auto', proposedTime: null, firstOrderId: null };
}

function normalizeUpdate(input: Record<string, unknown>, old: LocalVisit) {
  const row = { ...old, revision: old.revision + 1 };
  if ('memberId' in input && 'guest' in input) throw invalid('memberId', 'GUEST_OR_MEMBER');
  if ('memberId' in input) {
    row.memberId = uuid(input.memberId, 'memberId');
    row.guestName = row.guestPhone = null;
  }
  if ('guest' in input) {
    const guest = object(input.guest, ['name', 'phone']);
    row.memberId = null;
    row.guestName = text(guest.name, 'guest.name', 120, 'GUEST_INVALID');
    row.guestPhone = 'phone' in guest ? guestPhone(guest.phone) : old.guestPhone;
  }
  if (!row.memberId && !row.guestName && row.source !== 'phone_ai') throw invalid('memberId', 'GUEST_OR_MEMBER');
  if ('date' in input || !old.revision) row.date = date(input.date, 'date');
  if ('time' in input || !old.revision) row.time = time(input.time, 'time', 'TIME_INVALID');
  if ('partySize' in input || !old.revision) {
    if (typeof input.partySize !== 'number' || !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 1000) {
      throw invalid('partySize', 'PARTY_INVALID');
    }
    row.partySize = input.partySize;
  }
  if ('request' in input) row.request = input.request == null ? null : text(input.request, 'request', 500) || null;
  if ('tableChoice' in input || !old.revision) {
    const selected = input.tableChoice;
    if (selected === 'auto') {
      row.assignmentMode = 'auto';
      row.preferredTableId = null;
    } else {
      row.assignmentMode = 'manual';
      const tableId = object(selected, ['tableId']).tableId;
      if (typeof tableId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tableId)) throw invalid('tableChoice', 'TABLE_INVALID');
      row.preferredTableId = tableId;
    }
  }
  return row;
}

async function allocate(ctx: Context, readTables: ReadTables, row: LocalVisit, override = false) {
  const map = await readTables(ctx.storeId, ctx.actorId).catch(() => { throw new BookingUnavailable('BOOKING_TABLES_UNAVAILABLE'); });
  const concurrent = await concurrentVisits(ctx, row, map.enabled);
  if (!map.enabled) {
    const remaining = 30 - concurrent.reduce((sum, visit) => sum + visit.partySize, 0);
    if (remaining >= row.partySize && row.assignmentMode === 'auto') return { ...noTable, status: 'confirmed' } as const;
    const capacityOverride = override && concurrent.length === 0 && row.partySize > 30 && row.assignmentMode === 'auto';
    return { ...noTable, allocationWarning: row.assignmentMode === 'auto' ? 'SEAT_LIMIT' : 'NO_MATCHING_TABLE',
      capacityOverride, status: capacityOverride ? 'confirmed' : 'needs-check' } as const;
  }
  const layout = row.assignmentMode === 'manual' || row.preferredTableId
    ? map.tables.filter(table => table.tableId === row.preferredTableId || table.layoutTableId === row.preferredTableId) : map.tables;
  const table = layout.filter(table => table.seats >= row.partySize && concurrent.every(visit => visit.tableId !== table.tableId))
    .sort((a, b) => a.seats - b.seats || (a.number ?? Infinity) - (b.number ?? Infinity) ||
      a.label.localeCompare(b.label, 'ko-KR', { numeric: true }) || a.tableId.localeCompare(b.tableId))[0];
  if (table) return { ...noTable, tableId: table.tableId, status: 'confirmed' } as const;
  const capacityOverride = override && layout.length > 0 && layout.every(candidate => candidate.seats < row.partySize);
  return { ...noTable, allocationWarning: 'NO_MATCHING_TABLE', capacityOverride, status: capacityOverride ? 'confirmed' : 'needs-check' } as const;
}

function assertFuture(ctx: Context, row: LocalVisit) {
  if (Date.parse(usageAt(row.date, row.time)) < ctx.at.getTime()) throw invalid('time', 'BOOKING_PAST');
}

async function changeVisit(ctx: Context, readTables: ReadTables, raw: unknown, before: LocalVisit | null): Promise<Change> {
  const body = object(raw, before ? ['patch', 'expectedRevision', 'confirmDuplicate'] : [...visitFields, 'confirmDuplicate']);
  if (before) {
    checkRevision(body.expectedRevision, before.revision);
    if (!editable.has(before.status)) throw conflict('BOOKING_TRANSITION', 'reservationId');
    await assertNoFirstOrder(ctx, before);
  }
  const input = before ? object(body.patch, visitFields) : body;
  const { confirmDuplicate } = body;
  if (confirmDuplicate !== undefined && typeof confirmDuplicate !== 'boolean') throw invalid('confirmDuplicate');
  let visit = normalizeUpdate(input, before ?? basicVisit(randomUUID()));
  const slotChanged = !before || before.date !== visit.date || before.time !== visit.time;
  if (slotChanged) assertFuture(ctx, visit);
  if (visit.memberId && (!before || visit.memberId !== before.memberId || 'memberId' in input)) await assertMember(ctx, visit.memberId);
  if (!confirmDuplicate && (slotChanged || 'guest' in input || 'memberId' in input || before?.partySize !== visit.partySize)) {
    await assertDistinct(ctx, visit);
  }
  if (slotChanged || before?.partySize !== visit.partySize || 'tableChoice' in input) {
    const allocation = await allocate(ctx, readTables, visit);
    visit = { ...visit, ...allocation, confirmedBy: allocation.status === 'confirmed' ? visit.confirmedBy ?? 'auto' : null, proposedTime: null };
  }
  const changed = !before || sha({ ...visit, revision: before.revision }) !== sha(before);
  return { visit: changed ? visit : before!, before, kind: before ? 'updated' : 'created', changed, undoable: changed };
}

async function transitionVisit(ctx: Context, readTables: ReadTables, before: LocalVisit, type: Transition, proposedTime?: string): Promise<Change> {
  const visit: LocalVisit = { ...before, revision: before.revision + 1 };
  await assertNoFirstOrder(ctx, before);
  if (type === 'booking.cancel' && before.status === 'canceled') return { before, visit: before, kind: 'canceled', changed: false, undoable: false };
  if (type === 'booking.cancel' && editable.has(before.status)) {
    Object.assign(visit, noTable, { status: 'canceled' });
  } else if (type === 'booking.confirm' && before.status === 'needs-check') {
    const allocation = await allocate(ctx, readTables, before, true);
    if (allocation.status !== 'confirmed') throw conflict(allocation.allocationWarning, 'tableChoice');
    Object.assign(visit, allocation, { confirmedBy: 'person', proposedTime: null });
  } else if (type === 'booking.propose' && before.status === 'needs-check') {
    Object.assign(visit, noTable, { status: 'proposed', proposedTime });
  } else if ((type === 'booking.markCompleted' || type === 'booking.markNoShow') && before.status === 'confirmed') {
    if (Date.parse(usageAt(before.date, before.time)) >= ctx.at.getTime()) throw conflict('NOT_YET_TIME', 'reservationId');
    visit.status = type === 'booking.markCompleted' ? 'completed' : 'no-show';
  } else {
    throw conflict('BOOKING_TRANSITION', 'reservationId');
  }
  return { visit, before, kind: type === 'booking.cancel' ? 'canceled' : 'status', changed: true, undoable: true };
}

type ReceiptValue = Omit<Receipt, 'receiptId' | 'undoUntil'>;
type CandidateEffect = { value: ReceiptValue; inverse?: Inverse };
async function candidateCommand(ctx: Context, readTables: ReadTables, id: string, type: Transition, expected: number,
  proposedTime?: string): Promise<CandidateEffect> {
  const candidate = await readCandidate(ctx, id);
  if (!candidate) throw missing('reservationId');
  checkRevision(expected, candidate.revision);
  if (candidate.status !== 'pending') throw conflict('BOOKING_TRANSITION', 'suggestionId');
  if (type === 'booking.declineSuggestion') {
    await transitionCandidate(ctx, candidate, 'declined');
    await bumpBookingRevision(ctx);
    return { value: candidateReceipt(id, candidate.revision + 1, 'declined') };
  }
  if (type === 'booking.propose' && proposedTime) {
    if (Date.parse(usageAt(candidate.date, proposedTime)) < ctx.at.getTime()) throw invalid('time', 'BOOKING_PAST');
    await transitionCandidate(ctx, candidate, 'proposed', proposedTime);
    await bumpBookingRevision(ctx);
    const revision = candidate.revision + 1;
    return { value: candidateReceipt(id, revision, 'proposed'), inverse: { kind: 'proposal', revision } };
  }
  if (type !== 'booking.confirm') throw conflict('BOOKING_TRANSITION', 'suggestionId');
  const { date, time, partySize } = candidate;
  const visit = { ...basicVisit(id), date, time, partySize, source: 'phone_ai', confirmedBy: 'person', revision: 1 } as const;
  assertFuture(ctx, visit);
  const allocation = await allocate(ctx, readTables, visit, true);
  if (allocation.status !== 'confirmed') throw conflict(allocation.allocationWarning, 'tableChoice');
  const accepted = { ...visit, ...allocation };
  await storeVisit(ctx, null, accepted);
  await transitionCandidate(ctx, candidate, 'accepted');
  await recordBookingChange(ctx, null, visitSummary(accepted), 'created');
  return { value: { ...receiptValue(accepted, true), suggestionId: id } };
}

const candidateReceipt = (id: string, revision: number, status: string): ReceiptValue =>
  ({ resourceId: id, suggestionId: id, revision, status, changed: true, affectedSources: ['voice-booking', 'briefing'] });

function receiptValue(row: LocalVisit, changed: boolean) {
  return { resourceId: row.reservationId, reservationId: row.reservationId, status: row.status, tableId: row.tableId,
    allocationWarning: row.allocationWarning, revision: row.revision, changed, affectedSources: changed ? affectedSources : [] };
}

async function undo(ctx: Context, readTables: ReadTables, receiptId: string, raw: unknown): Promise<Change | ReceiptValue> {
  object(raw ?? {}, []);
  const { db, storeId, actorId, at } = ctx;
  const { rows: [original] } = await db.query<{ receipt: Receipt; inverse: Inverse | null; undone_at: Date | null }>(`
    SELECT receipt, inverse, undone_at FROM customer.booking_command WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3`,
  [storeId, actorId, receiptId]);
  if (!original) throw missing('receiptId');
  if (!original.inverse || !original.receipt?.undoUntil || original.undone_at) throw conflict('UNDO_UNAVAILABLE');
  if (Date.parse(original.receipt.undoUntil) <= at.getTime()) throw conflict('UNDO_EXPIRED');
  const finish = () => db.query(`UPDATE customer.booking_command SET undone_at = $4, inverse = NULL
    WHERE store_id = $1 AND actor_id = $2 AND receipt_id = $3`, [storeId, actorId, receiptId, at]);
  if (original.inverse.kind === 'proposal') {
    const candidate = await readCandidate(ctx, original.receipt.resourceId);
    if (candidate?.status !== 'proposed' || candidate.revision !== original.inverse.revision) throw conflict('UNDO_STALE');
    await transitionCandidate(ctx, candidate, 'pending');
    await bumpBookingRevision(ctx);
    await finish();
    return candidateReceipt(candidate.suggestionId, candidate.revision + 1, 'pending');
  }
  const current = await readLocalVisit(ctx, original.receipt.resourceId, true);
  if (!current || current.revision !== original.inverse.revision) throw conflict('UNDO_STALE');
  await assertNoFirstOrder(ctx, current);
  const prior = original.inverse.before;
  const visit: LocalVisit = prior ? { ...prior, revision: current.revision + 1 }
    : { ...current, ...noTable, status: 'canceled', revision: current.revision + 1 };
  if (visit.status === 'confirmed' && !visit.capacityOverride) {
    const target = { ...visit, preferredTableId: visit.tableId };
    const allocation = await allocate(ctx, readTables, target);
    if (allocation.status !== 'confirmed' || allocation.tableId !== visit.tableId) throw conflict('UNDO_TABLE_UNAVAILABLE');
  }
  await finish();
  return { before: current, visit, kind: visit.status === 'canceled' ? 'canceled' : 'updated', changed: true, undoable: false };
}

type LocalCommand = { action: 'create' | 'update' | 'transition' | 'undo'; id: string | null; raw: unknown; key: string };
export async function runLocalCommand(ctx: Context, readTables: ReadTables, { action, id, raw, key }: LocalCommand): Promise<Receipt> {
  await bookLock(ctx);
  const hash = fingerprint(action, id, raw);
  const previous = await previousCommand(ctx, key, hash);
  if (previous?.receipt) return previous.receipt;

  let change: Change | undefined;
  let value: ReceiptValue | undefined;
  let inverse: Inverse | null = null;
  if (action === 'undo') {
    const undone = await undo(ctx, readTables, id!, raw);
    if ('visit' in undone) change = undone;
    else value = undone;
  } else if (action === 'create') {
    change = await changeVisit(ctx, readTables, raw, null);
  } else {
    const before = await readLocalVisit(ctx, id!, true);
    if (action === 'update') {
      if (!before) throw missing('reservationId');
      change = await changeVisit(ctx, readTables, raw, before);
    } else {
      const { type, expectedRevision, time } = parseTransition(raw);
      if (!before || type === 'booking.declineSuggestion') {
        const candidate = await candidateCommand(ctx, readTables, id!, type, expectedRevision, time);
        value = candidate.value;
        inverse = candidate.inverse ?? null;
      } else {
        checkRevision(expectedRevision, before.revision);
        change = await transitionVisit(ctx, readTables, before, type, time);
      }
    }
  }

  if (change?.changed) {
    if (!retainsVisitPhone(change.visit.status)) {
      change.visit.guestPhone = null;
      if (change.before) change.before.guestPhone = null;
      await clearVisitUndoPhones(ctx, change.visit.reservationId);
    }
    await storeVisit(ctx, change.before, change.visit);
    await recordBookingChange(ctx, change.before && visitSummary(change.before), visitSummary(change.visit), change.kind);
  }
  if (change?.undoable) inverse = { kind: 'visit', revision: change.visit.revision, before: change.before };
  const receipt: Receipt = { ...(change ? receiptValue(change.visit, change.changed) : value!), receiptId: randomUUID(),
    ...(inverse && { undoUntil: new Date(ctx.at.getTime() + undoMs).toISOString() }) };
  const { db, storeId, actorId } = ctx;
  await db.query(`INSERT INTO customer.booking_command (store_id, actor_id, key, fingerprint, receipt_id, receipt, inverse)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [storeId, actorId, key, hash, receipt.receiptId, receipt, inverse]);
  return receipt;
}
