import { TODAY } from '../../db/time';
import { emptyView, ready, type Projector } from '../../models/util';
import { selectStaffSchedule } from './selectors';
export * from './types';
export { selectStaffSchedule, staffCountAt, handoffTimes, findShiftConflicts, type ShiftConflict } from './selectors';

export const projectStaffSchedule: Projector<'staff-schedule'> = (ctx, condition, variant) => {
  const period = condition.kind === 'dateRange' ? { startDate: condition.start, endDate: condition.end } : { startDate: TODAY, endDate: TODAY };
  const model = selectStaffSchedule(ctx.snapshot, period);
  return model.staff.length ? ready('staff-schedule', condition, variant, model) : emptyView('staff-schedule', variant, undefined, 'data.staff.action.add');
};
