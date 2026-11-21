import type { DataTables } from '../../db/types';
import type { HandlerContext, HandlerResult } from '../../commands/handlers';
import { isIsoDate, isTime, NOW } from '../../db/time';
import { findShiftConflicts } from './selectors';
import type { StaffCommand, StaffSchedule, StaffTables, StaffScheduleChange } from './types';

const failure = (reason: string, field?: string, code: 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' = 'VALIDATION'): HandlerResult => ({ ok: false, code, reason, field, messageKey: `data.staff.error.${reason}` });
/** Same-person overlap or day-off collision. `details.conflicts` lets the editor offer replacing that actual row. */
const overlap = (candidate: StaffSchedule, conflicts: ReturnType<typeof findShiftConflicts>, field: string): HandlerResult =>
  ({ ...failure('STAFF_SHIFT_OVERLAP', field, 'CONFLICT'), details: { staffId: candidate.staffId, date: candidate.date, conflicts } } as HandlerResult);
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function validate(row: StaffSchedule): HandlerResult | null {
  if (!isIsoDate(row.date) || !['work', 'off'].includes(row.kind)) return failure('INVALID_SHIFT', 'date');
  if (row.kind === 'off') return null;
  if (!isTime(row.start) || !isTime(row.end) || row.end! <= row.start! || !Number.isInteger(row.breakMinutes) || row.breakMinutes < 0) return failure('INVALID_SHIFT', 'end');
  return row.breakMinutes >= minutes(row.end!) - minutes(row.start!) ? failure('BREAK_TOO_LONG', 'breakMinutes') : null;
}
/** Also used by store undo, which retains history and records the inverse as new changes. */
export function appendStaffHistory(before: StaffTables, after: StaffTables, nextId: (prefix: string) => string): readonly StaffScheduleChange[] {
  const changes: StaffScheduleChange[] = [];
  for (const name of ['staff', 'staffSchedule'] as const) {
    const id = (row: (typeof before)[typeof name][number]) => 'scheduleId' in row ? row.scheduleId : row.staffId;
    const oldRows = new Map<string, StaffScheduleChange['before']>(before[name].map(r => [id(r), r]));
    const newRows = new Map<string, StaffScheduleChange['after']>(after[name].map(r => [id(r), r]));
    for (const entityId of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const old = oldRows.get(entityId) ?? null, current = newRows.get(entityId) ?? null;
      if (JSON.stringify(old) !== JSON.stringify(current)) changes.push({ changeId: nextId('staff-change'), at: NOW, operation: !old ? 'create' : !current ? 'delete' : 'update', entityId, before: old, after: current });
    }
  }
  return [...before.staffScheduleChange, ...changes];
}
function handle(ctx: HandlerContext, c: StaffCommand): HandlerResult {
  const t = ctx.tables;
  const complete = (tables: DataTables, value: unknown): HandlerResult => {
    const deleting = c.type === 'staff.delete' || c.type === 'staff.deleteSchedule';
    const name = c.type === 'staff.delete' ? t.staff.find(s => s.staffId === c.staffId)!.name : '근무';
    const last = name.charCodeAt(name.length - 1), particle = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0 ? '을' : '를';
    return { ok: true, tables: { ...tables, staffScheduleChange: appendStaffHistory(t, tables, ctx.nextId) }, undoable: true, value,
      noticeKey: c.type === 'staff.create' ? 'data.staff.notice.created' : c.type === 'staff.saveSchedule' ? 'data.staff.notice.scheduleSaved' : deleting ? 'data.staff.notice.deleted' : 'data.staff.notice.changed',
      ...(deleting ? { params: { name, particle } } : {}),
    };
  };
  if (c.type === 'staff.create' || c.type === 'staff.update') {
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) return failure('NAME_REQUIRED', 'name');
    if (c.type === 'staff.update') {
      if (!t.staff.some(s => s.staffId === c.staffId && s.archivedAt === null)) return failure('NOT_FOUND', 'staffId', 'NOT_FOUND');
      return complete({ ...t, staff: t.staff.map(s => s.staffId === c.staffId ? { ...s, name } : s) }, { staffId: c.staffId });
    }
    const staffId = ctx.nextId('staff');
    return complete({ ...t, staff: [...t.staff, { staffId, name, archivedAt: null }] }, { staffId });
  }
  if (c.type === 'staff.delete') {
    if (!t.staff.some(s => s.staffId === c.staffId)) return failure('NOT_FOUND', 'staffId', 'NOT_FOUND');
    if (c.cascadeSchedules !== true) return failure('CASCADE_REQUIRED', 'cascadeSchedules');
    const deletedScheduleIds = t.staffSchedule.filter(r => r.staffId === c.staffId).map(r => r.scheduleId);
    return complete({ ...t, staff: t.staff.filter(s => s.staffId !== c.staffId), staffSchedule: t.staffSchedule.filter(r => r.staffId !== c.staffId) }, { staffId: c.staffId, deletedStaffIds: [c.staffId], deletedScheduleIds });
  }
  if (c.type === 'staff.saveSchedule') {
    if (!t.staff.some(s => s.staffId === c.staffId && s.archivedAt === null)) return failure('NOT_FOUND', 'staffId', 'NOT_FOUND');
    if (c.scheduleId !== undefined && !t.staffSchedule.some(r => r.scheduleId === c.scheduleId)) return failure('NOT_FOUND', 'scheduleId', 'NOT_FOUND');
    const candidate: StaffSchedule = { scheduleId: c.scheduleId ?? '', staffId: c.staffId, date: c.date, kind: c.kind, start: c.kind === 'off' ? null : c.start ?? null, end: c.kind === 'off' ? null : c.end ?? null, breakMinutes: c.kind === 'off' ? 0 : c.breakMinutes ?? 0 };
    const invalid = validate(candidate); if (invalid) return invalid;
    const clash = findShiftConflicts(t.staffSchedule, candidate);
    if (clash.length) return overlap(candidate, clash, candidate.kind === 'off' ? 'kind' : 'start');
    const row = { ...candidate, scheduleId: c.scheduleId ?? ctx.nextId('staff-shift') };
    return complete({ ...t, staffSchedule: c.scheduleId ? t.staffSchedule.map(r => r.scheduleId === c.scheduleId ? row : r) : [...t.staffSchedule, row] }, { scheduleId: row.scheduleId });
  }
  if (c.type === 'staff.deleteSchedule') {
    if (!t.staffSchedule.some(r => r.scheduleId === c.scheduleId)) return failure('NOT_FOUND', 'scheduleId', 'NOT_FOUND');
    return complete({ ...t, staffSchedule: t.staffSchedule.filter(r => r.scheduleId !== c.scheduleId) }, { scheduleId: c.scheduleId, deletedScheduleIds: [c.scheduleId] });
  }
  if (!isIsoDate(c.date) || !isTime(c.fromTime) || !isTime(c.toTime)) return failure('INVALID_SHIFT', 'toTime');
  const work = t.staffSchedule.filter(r => r.date === c.date && r.kind === 'work');
  if (!work.some(r => r.end === c.fromTime) || !work.some(r => r.start === c.fromTime)) return failure('NOT_FOUND', 'fromTime', 'NOT_FOUND');
  const affected = work.filter(r => r.start === c.fromTime || r.end === c.fromTime);
  const moved = affected.map(r => ({ ...r, start: r.start === c.fromTime ? c.toTime : r.start, end: r.end === c.fromTime ? c.toTime : r.end }));
  for (const row of moved) { const invalid = validate(row); if (invalid) return invalid; }
  const after = t.staffSchedule.map(r => moved.find(m => m.scheduleId === r.scheduleId) ?? r);
  for (const row of moved) { const clash = findShiftConflicts(after, row); if (clash.length) return overlap(row, clash, 'toTime'); }
  return complete({ ...t, staffSchedule: after }, { scheduleIds: moved.map(r => r.scheduleId) });
}
export const staffHandlers = Object.fromEntries(['staff.create', 'staff.update', 'staff.delete', 'staff.saveSchedule', 'staff.deleteSchedule', 'staff.moveHandoff'].map(type => [type, handle])) as { readonly [K in StaffCommand['type']]: (ctx: HandlerContext, c: Extract<StaffCommand, { type: K }>) => HandlerResult };
