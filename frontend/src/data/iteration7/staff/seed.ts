import { seedSupplement } from '../../db/cafe-fixtures';
const TODAY = '2026-10-26';
import type { StaffTables } from './types';

/** DATA_MODEL 19.2 fixture; no employee accounts or attendance records. */
export function createLegacyStaffSeed(): StaffTables {
  return {
    staff: ['박민수', '이서연', '김도현', '정하은', '최유진'].map((name, i) => ({ staffId: `staff-${i + 1}`, name, archivedAt: null })),
    staffSchedule: [
      ...[1, 2].map(i => ({ scheduleId: `staff-shift-${i}`, staffId: `staff-${i}`, date: TODAY, kind: 'work' as const, start: '08:00', end: '17:30', breakMinutes: 60 })),
      ...[3, 4].map(i => ({ scheduleId: `staff-shift-${i}`, staffId: `staff-${i}`, date: TODAY, kind: 'work' as const, start: '17:30', end: '21:00', breakMinutes: 0 })),
      { scheduleId: 'staff-shift-5', staffId: 'staff-5', date: TODAY, kind: 'off', start: null, end: null, breakMinutes: 0 },
    ],
    staffScheduleChange: [],
  };
}

export function createStaffSeed(): StaffTables {
  return {
    staff: seedSupplement.staff.map(row => ({ ...row, archivedAt: null })),
    staffSchedule: seedSupplement.shifts.map(row => ({
      ...row, scheduleId: row.shiftId, kind: 'work', breakMinutes: 0,
    })),
    staffScheduleChange: [],
  };
}
