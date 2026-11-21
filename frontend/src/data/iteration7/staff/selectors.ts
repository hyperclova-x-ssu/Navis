import type { DataSnapshot, DataTables } from '../../db/types';
import { dateRange, isIsoDate, NOW_TIME, TODAY } from '../../db/time';
import { deepFreeze } from '../../db/freeze';
import type { StaffSchedule, StaffScheduleModel, StaffScheduleQuery } from './types';

const activeRows = (t: DataTables) => {
  const active = new Set(t.staff.filter(s => s.archivedAt === null).map(s => s.staffId));
  return t.staffSchedule.filter(r => active.has(r.staffId));
};
export function staffCountAt(t: DataTables, date: string, hour: number): number {
  const time = `${String(hour).padStart(2, '0')}:00`;
  return new Set(activeRows(t).filter(r => r.date === date && r.kind === 'work' && r.start! <= time && time < r.end!).map(r => r.staffId)).size;
}
export function handoffTimes(rows: readonly StaffSchedule[]): string[] {
  const work = rows.filter(r => r.kind === 'work');
  return [...new Set(work.map(r => r.end!).filter(end => work.some(r => r.start === end)))].sort();
}
const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export interface ShiftConflict { readonly scheduleId: string; readonly kind: 'work' | 'off'; readonly start: string | null; readonly end: string | null }
/**
 * Rows of the same person and day that the candidate would collide with: any other row next to a day off,
 * a day off next to any work row, and two work intervals that share time. Back-to-back shifts (17:30|17:30) are
 * fine. `candidate.scheduleId` is the row being replaced, so it never collides with itself.
 */
export function findShiftConflicts(rows: readonly StaffSchedule[], candidate: { readonly scheduleId?: string; readonly staffId: string; readonly date: string; readonly kind: 'work' | 'off'; readonly start: string | null; readonly end: string | null }): readonly ShiftConflict[] {
  return rows.filter(row => {
    if (row.scheduleId === candidate.scheduleId || row.staffId !== candidate.staffId || row.date !== candidate.date) return false;
    if (row.kind === 'off' || candidate.kind === 'off') return true;
    return toMinutes(candidate.start!) < toMinutes(row.end!) && toMinutes(row.start!) < toMinutes(candidate.end!);
  }).map(row => ({ scheduleId: row.scheduleId, kind: row.kind, start: row.start, end: row.end }));
}
const cache = new WeakMap<DataSnapshot, Map<string, StaffScheduleModel>>();
export function selectStaffSchedule(snapshot: DataSnapshot, query: StaffScheduleQuery): StaffScheduleModel {
  if (!isIsoDate(query.startDate) || !isIsoDate(query.endDate) || query.startDate > query.endDate) throw new Error('INVALID_STAFF_PERIOD');
  const key = JSON.stringify([query.startDate, query.endDate, query.staffId]);
  let models = cache.get(snapshot);
  if (!models) cache.set(snapshot, models = new Map());
  const hit = models.get(key); if (hit) return hit;
  const t = snapshot.tables, all = activeRows(t), today = all.filter(r => r.date === TODAY);
  const rows = all.filter(r => r.date >= query.startDate && r.date <= query.endDate && (!query.staffId || r.staffId === query.staffId));
  const staff = t.staff.filter(s => s.archivedAt === null && (!query.staffId || s.staffId === query.staffId));
  const entityIds = new Set([...staff.map(s => s.staffId), ...rows.map(r => r.scheduleId)]);
  const result: StaffScheduleModel = deepFreeze({
    staff, rows, changes: t.staffScheduleChange.filter(c => (!query.staffId || entityIds.has(c.entityId) || c.before?.staffId === query.staffId || c.after?.staffId === query.staffId) && c.at.slice(0, 10) >= query.startDate && c.at.slice(0, 10) <= query.endDate),
    today: { workingCount: new Set(today.filter(r => r.kind === 'work').map(r => r.staffId)).size, offCount: new Set(today.filter(r => r.kind === 'off').map(r => r.staffId)).size, nextHandoffAt: handoffTimes(today).find(time => time >= NOW_TIME) ?? null },
    hourly: dateRange(query.startDate, query.endDate).flatMap(date => Array.from({ length: 24 }, (_, hour) => ({ date, hour, staffCount: query.staffId ? new Set(rows.filter(r => r.date === date && r.kind === 'work' && r.start! <= `${String(hour).padStart(2, '0')}:00` && `${String(hour).padStart(2, '0')}:00` < r.end!).map(r => r.staffId)).size : staffCountAt(t, date, hour) }))),
    period: { start: query.startDate, end: query.endDate },
  });
  models.set(key, result); return result;
}
