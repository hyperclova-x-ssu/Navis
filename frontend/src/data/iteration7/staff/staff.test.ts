import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, dataBundles, selectStaffSchedule, TODAY, type DataCommand, type DataCommandResult } from '../../widget-data';
import { addDays, NOW } from '../../db/time';
import { seedSupplement } from '../../db/generated/supplement';
import { createTranslator, findDuplicateKeys } from '../../../i18n';

const value = (r: DataCommandResult) => {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.messageKey);
  return r.value as { staffId: string; scheduleId: string; scheduleIds: string[]; deletedScheduleIds: string[] };
};
const query = { startDate: TODAY, endDate: TODAY };
const [manager, , , , fifth] = seedSupplement.staff;
const managerShift = seedSupplement.shifts[0].shiftId;
const anotherDay = addDays(TODAY, 8);

function handoffScenario() {
  const work = seedSupplement.staff.slice(0, 4).map(({ staffId }, index) => ({
    scheduleId: `handoff-${index}`, staffId, date: TODAY, kind: 'work' as const,
    start: index < 2 ? '08:00' : '17:30', end: index < 2 ? '17:30' : '21:00', breakMinutes: index < 2 ? 60 : 0,
  }));
  return createWidgetDataStore({ staffSchedule: [...work, {
    scheduleId: 'day-off', staffId: fifth.staffId, date: TODAY, kind: 'off', start: null, end: null, breakMinutes: 0,
  }] });
}
describe('API-271 staff source', () => {
  it('publishes each staff message once and uses Korean fallback in every UI locale', () => {
    expect(findDuplicateKeys(...dataBundles).filter(row => row.key.includes('staff'))).toEqual([]);
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const tr = createTranslator(locale, ...dataBundles);
      expect(tr.t('data.state.staff-schedule.error')).toBe('근무표를 불러오지 못했어요');
      expect(tr.t('data.staff.error.NAME_REQUIRED')).toBe('직원 이름을 넣어 주세요');
      expect(tr.t('preview.variant.staff-schedule.no-staff')).toBe('비어 있음');
    }
  });
  it('creates a named employee once and rejects mismatched or stale retries', () => {
    const store = createWidgetDataStore();
    const command = { type: 'staff.create', name: ' 한지민 ', idempotencyKey: 'create', baseRevision: 0 } as const;
    const result = store.dispatch(command);
    const { staffId } = value(result);
    const after = store.getSnapshot();
    expect(after.tables.staff.find(s => s.staffId === staffId)?.name).toBe('한지민');
    expect(store.dispatch(command)).toMatchObject({ ok: true, duplicate: true });
    expect(store.getSnapshot()).toBe(after);
    expect(store.dispatch({ ...command, name: '다른 이름' })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    expect(store.dispatch({ ...command, idempotencyKey: 'stale' })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
  });
  it('starts with five cafe staff, two on at 14:00 and a 17:00 handoff', () => {
    const model = selectStaffSchedule(createWidgetDataStore().getSnapshot(), query);
    expect(model.staff.map(s => s.name)).toEqual(seedSupplement.staff.map(row => row.name));
    expect(model.today).toEqual({ workingCount: 5, offCount: 0, nextHandoffAt: '17:00' });
    expect(model.hourly.find(r => r.hour === 14)?.staffCount).toBe(2);
  });
  it.each([
    [{ type: 'staff.create', name: ' ', idempotencyKey: 'bad' }, 'NAME_REQUIRED'],
    [{ type: 'staff.saveSchedule', staffId: manager.staffId, date: TODAY, kind: 'work', start: '18:00', end: '14:00', breakMinutes: 0, idempotencyKey: 'bad' }, 'INVALID_SHIFT'],
    [{ type: 'staff.saveSchedule', staffId: manager.staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 240, idempotencyKey: 'bad' }, 'BREAK_TOO_LONG'],
    [{ type: 'staff.saveSchedule', staffId: manager.staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: -1, idempotencyKey: 'bad' }, 'INVALID_SHIFT'],
    [{ type: 'staff.saveSchedule', staffId: manager.staffId, date: '2026-02-30', kind: 'off', idempotencyKey: 'bad' }, 'INVALID_SHIFT'],
    [{ type: 'staff.saveSchedule', staffId: 'missing', date: TODAY, kind: 'off', idempotencyKey: 'bad' }, 'NOT_FOUND'],
    [{ type: 'staff.saveSchedule', staffId: manager.staffId, date: TODAY, kind: 'off' }, 'KEY_REQUIRED'],
    [{ type: 'staff.delete', staffId: manager.staffId, cascadeSchedules: false, idempotencyKey: 'bad' }, 'CASCADE_REQUIRED'],
  ])('rejects invalid writes without changing snapshots (%j)', (command, reason) => {
    const store = createWidgetDataStore(), before = store.getSnapshot();
    expect(store.dispatch(command as DataCommand)).toMatchObject({ ok: false, reason });
    expect(store.getSnapshot()).toBe(before);
  });
  it('renames without replacing IDs, edits breaks, filters dates and keeps timestamped history', () => {
    const store = createWidgetDataStore();
    value(store.dispatch({ type: 'staff.update', staffId: manager.staffId, name: '박민수 수정' }));
    value(store.dispatch({ type: 'staff.saveSchedule', scheduleId: managerShift, staffId: manager.staffId, date: TODAY, kind: 'work', start: '08:00', end: '17:30', breakMinutes: 30 }));
    const model = selectStaffSchedule(store.getSnapshot(), { ...query, staffId: manager.staffId });
    expect(model.staff[0]).toMatchObject({ staffId: manager.staffId, name: '박민수 수정' });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ scheduleId: managerShift, breakMinutes: 30 });
    expect(model.changes).toHaveLength(2);
    expect(model.changes.every(c => c.at === NOW && !('changedBy' in c))).toBe(true);
    expect(selectStaffSchedule(store.getSnapshot(), { startDate: anotherDay, endDate: anotherDay }).rows).toEqual([]);
  });
  // GD-2: the old version saved a second 14:00~18:00 row for the person who already worked 08:00~17:30 (the overlap defect itself).
  // The hours are now exercised by replacing the day-off row with a shift, which is what S3-152 asks for.
  it('counts distinct staff, uses end-exclusive hours and does not invent a break location', () => {
    const store = handoffScenario();
    const off = store.getSnapshot().tables.staffSchedule.find(r => r.date === TODAY && r.kind === 'off')!;
    value(store.dispatch({ type: 'staff.saveSchedule', scheduleId: off.scheduleId, staffId: off.staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 239 }));
    const model = selectStaffSchedule(store.getSnapshot(), query);
    expect(model.today.workingCount).toBe(5);
    expect(model.today.offCount).toBe(0);
    expect(model.hourly.find(r => r.hour === 14)?.staffCount).toBe(3);
    expect(model.hourly.find(r => r.hour === 18)?.staffCount).toBe(2);
  });
  it('atomically cascades staff deletion and undo restores rows while appending reversal history', () => {
    const store = createWidgetDataStore(), original = store.getSnapshot();
    const result = store.dispatch({ type: 'staff.delete', staffId: manager.staffId, cascadeSchedules: true, idempotencyKey: 'delete' });
    expect(value(result).deletedScheduleIds).toContain(managerShift);
    expect(store.getSnapshot().tables.staffSchedule.some(s => s.staffId === manager.staffId)).toBe(false);
    if (!result.ok) throw new Error('delete failed');
    expect(store.undo(result.undoToken!)).toMatchObject({ ok: true });
    expect(store.getSnapshot().tables.staff).toEqual(original.tables.staff);
    expect(store.getSnapshot().tables.staffSchedule).toEqual(original.tables.staffSchedule);
    const removed = original.tables.staffSchedule.filter(row => row.staffId === manager.staffId).length;
    expect(store.getSnapshot().tables.staffScheduleChange).toHaveLength(2 * (1 + removed));
    expect(store.dispatch({ type: 'staff.delete', staffId: manager.staffId, cascadeSchedules: true, idempotencyKey: 'delete' })).toMatchObject({ ok: false, reason: 'COMMAND_UNDONE' });
  });
  it('deletes one schedule reversibly and normalizes off rows to null times', () => {
    const store = createWidgetDataStore();
    const saved = store.dispatch({ type: 'staff.saveSchedule', staffId: manager.staffId, date: anotherDay, kind: 'off', idempotencyKey: 'off' });
    const { scheduleId } = value(saved);
    expect(store.getSnapshot().tables.staffSchedule.find(r => r.scheduleId === scheduleId)).toMatchObject({ start: null, end: null, breakMinutes: 0 });
    const deleted = store.dispatch({ type: 'staff.deleteSchedule', scheduleId, idempotencyKey: 'del-shift' });
    expect(deleted.ok && store.undo(deleted.undoToken!).ok).toBe(true);
    expect(store.getSnapshot().tables.staffSchedule.some(r => r.scheduleId === scheduleId)).toBe(true);
  });
  it('moves only an actual handoff and validates every affected row before publishing', () => {
    const store = handoffScenario(), before = store.getSnapshot();
    expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: '17:30', toTime: '08:15', idempotencyKey: 'invalid' })).toMatchObject({ ok: false, reason: 'BREAK_TOO_LONG' });
    expect(store.getSnapshot()).toBe(before);
    expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: '15:00', toTime: '18:00', idempotencyKey: 'missing' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const moved = value(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: '17:30', toTime: '18:00', idempotencyKey: 'move' }));
    expect(moved.scheduleIds).toHaveLength(4);
    expect(selectStaffSchedule(store.getSnapshot(), query).today.nextHandoffAt).toBe('18:00');
  });
  describe('GD-2 same-person shift guard', () => {
    const work = (store: ReturnType<typeof createWidgetDataStore>) => store.getSnapshot().tables.staffSchedule.find(r => r.date === TODAY && r.kind === 'work')!;
    const rowsOf = (store: ReturnType<typeof createWidgetDataStore>, staffId: string, date = TODAY) => store.getSnapshot().tables.staffSchedule.filter(r => r.staffId === staffId && r.date === date);
    it('refuses a shift that shares time with the same person\'s shift and says which row', () => {
      const store = createWidgetDataStore(), before = store.getSnapshot(), existing = work(store);
      const result = store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'work', start: existing.start!, end: existing.end!, breakMinutes: 0, idempotencyKey: 'overlap' });
      expect(result).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'STAFF_SHIFT_OVERLAP', messageKey: 'data.staff.error.STAFF_SHIFT_OVERLAP', field: 'start',
        details: { staffId: existing.staffId, date: TODAY, conflicts: [{ scheduleId: existing.scheduleId, kind: 'work', start: existing.start, end: existing.end }] } });
      expect(store.getSnapshot()).toBe(before);
      expect(createTranslator('ko', ...dataBundles).t('data.staff.error.STAFF_SHIFT_OVERLAP')).toBe('같은 직원의 근무 시간이 겹쳐요');
    });
    it('also refuses a partly overlapping interval and an edit that grows into a neighbour', () => {
      const store = createWidgetDataStore(), existing = work(store);
      expect(store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'work', start: '16:00', end: '22:00', breakMinutes: 0, idempotencyKey: 'partial' })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP' });
      const tail = value(store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'work', start: existing.end!, end: '21:00', breakMinutes: 0, idempotencyKey: 'tail' }));
      const before = store.getSnapshot();
      expect(store.dispatch({ type: 'staff.saveSchedule', scheduleId: tail.scheduleId, staffId: existing.staffId, date: TODAY, kind: 'work', start: '12:00', end: '21:00', breakMinutes: 0 })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP' });
      expect(store.getSnapshot()).toBe(before);
    });
    it('allows back-to-back shifts, the same hours for another person and the same hours on another day', () => {
      const store = createWidgetDataStore(), existing = work(store);
      const other = store.getSnapshot().tables.staff.find(s => s.staffId !== existing.staffId && !rowsOf(store, s.staffId).some(r => r.kind === 'off'))!;
      value(store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'work', start: existing.end!, end: '23:00', breakMinutes: 0, idempotencyKey: 'next' }));
      value(store.dispatch({ type: 'staff.saveSchedule', staffId: other.staffId, date: anotherDay, kind: 'work', start: existing.start!, end: existing.end!, breakMinutes: 0, idempotencyKey: 'other-day' }));
      value(store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: anotherDay, kind: 'work', start: existing.start!, end: existing.end!, breakMinutes: 0, idempotencyKey: 'same-hours' }));
      expect(rowsOf(store, existing.staffId)).toHaveLength(2);
    });
    it('refuses a day off next to a shift and a shift next to a day off for the same person and day', () => {
      const store = handoffScenario(), existing = work(store), off = store.getSnapshot().tables.staffSchedule.find(r => r.date === TODAY && r.kind === 'off')!;
      expect(store.dispatch({ type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'off', idempotencyKey: 'off-over-work' })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP', field: 'kind' });
      expect(store.dispatch({ type: 'staff.saveSchedule', staffId: off.staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 0, idempotencyKey: 'work-over-off' })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP', details: { conflicts: [{ scheduleId: off.scheduleId, kind: 'off' }] } });
      expect(store.dispatch({ type: 'staff.saveSchedule', staffId: off.staffId, date: TODAY, kind: 'off', idempotencyKey: 'second-off' })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP' });
    });
    it('replaces the actual row when asked to, so off becomes work and the change is undoable', () => {
      const store = handoffScenario(), original = store.getSnapshot(), off = original.tables.staffSchedule.find(r => r.date === TODAY && r.kind === 'off')!;
      const result = store.dispatch({ type: 'staff.saveSchedule', scheduleId: off.scheduleId, staffId: off.staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 0 });
      expect(value(result).scheduleId).toBe(off.scheduleId);
      expect(rowsOf(store, off.staffId)).toEqual([expect.objectContaining({ scheduleId: off.scheduleId, kind: 'work', start: '14:00', end: '18:00' })]);
      expect(result.ok && store.undo(result.undoToken!).ok).toBe(true);
      expect(store.getSnapshot().tables.staffSchedule).toEqual(original.tables.staffSchedule);
    });
    it('keeps a same-key replay on the original receipt even after the day is full', () => {
      const store = createWidgetDataStore(), existing = work(store);
      const command = { type: 'staff.saveSchedule', staffId: existing.staffId, date: TODAY, kind: 'work', start: existing.end!, end: '23:00', breakMinutes: 0, idempotencyKey: 'replay' } as const;
      const first = store.dispatch(command), after = store.getSnapshot();
      expect(first.ok).toBe(true);
      expect(store.dispatch(command)).toMatchObject({ ok: true, duplicate: true, value: (first as { value: unknown }).value });
      expect(store.getSnapshot()).toBe(after);
    });
    it('refuses to move a handoff when a moved shift would run into the same person\'s other shift', () => {
      const store = handoffScenario(), first = work(store);
      value(store.dispatch({ type: 'staff.saveSchedule', staffId: first.staffId, date: TODAY, kind: 'work', start: '18:00', end: '20:00', breakMinutes: 0, idempotencyKey: 'late' }));
      const before = store.getSnapshot();
      expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: first.end!, toTime: '19:00', idempotencyKey: 'handoff' })).toMatchObject({ ok: false, reason: 'STAFF_SHIFT_OVERLAP', field: 'toTime' });
      expect(store.getSnapshot()).toBe(before);
      expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: first.end!, toTime: '17:45', idempotencyKey: 'handoff-ok' })).toMatchObject({ ok: true });
    });
  });
});
