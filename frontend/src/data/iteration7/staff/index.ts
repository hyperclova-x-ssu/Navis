import { emptyView, ready, type Projector } from '../../models/util';
import { selectStaffSchedule } from './selectors';
import { staffCalendarClock } from './clock';
export * from './types';
export { selectStaffSchedule, staffCountAt, handoffTimes, findShiftConflicts, type ShiftConflict } from './selectors';

export const projectStaffSchedule: Projector<'staff-schedule'> = (ctx, condition, variant) => {
  const date = staffCalendarClock(ctx.snapshot.tables).date;
  const period = condition.kind === 'dateRange' ? { startDate: condition.start, endDate: condition.end } : { startDate: date, endDate: date };
  const model = selectStaffSchedule(ctx.snapshot, period);
  return model.staff.length ? ready('staff-schedule', condition, variant, model) : emptyView('staff-schedule', variant, undefined, 'data.staff.action.add');
};
