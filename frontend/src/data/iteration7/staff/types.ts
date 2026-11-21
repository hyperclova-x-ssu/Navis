export interface Staff { readonly staffId: string; readonly name: string; readonly archivedAt: string | null }
export interface StaffSchedule {
  readonly scheduleId: string; readonly staffId: string; readonly date: string;
  readonly kind: 'work' | 'off'; readonly start: string | null; readonly end: string | null; readonly breakMinutes: number;
}
export interface StaffScheduleChange {
  readonly changeId: string; readonly at: string; readonly operation: 'create' | 'update' | 'delete';
  readonly entityId: string; readonly before: Staff | StaffSchedule | null; readonly after: Staff | StaffSchedule | null;
}
export interface StaffTables {
  readonly staff: readonly Staff[];
  readonly staffSchedule: readonly StaffSchedule[];
  readonly staffScheduleChange: readonly StaffScheduleChange[];
}
export interface StaffScheduleQuery { readonly startDate: string; readonly endDate: string; readonly staffId?: string }
export interface StaffScheduleModel {
  readonly staff: readonly Staff[]; readonly rows: readonly StaffSchedule[]; readonly changes: readonly StaffScheduleChange[];
  readonly today: { readonly workingCount: number; readonly offCount: number; readonly nextHandoffAt: string | null };
  readonly hourly: readonly { readonly date: string; readonly hour: number; readonly staffCount: number }[];
  readonly period: { readonly start: string; readonly end: string };
}
type ScheduleFields = { readonly staffId: string; readonly date: string; readonly kind: 'work' | 'off'; readonly start?: string | null; readonly end?: string | null; readonly breakMinutes?: number };
export type StaffCommand =
  | { readonly type: 'staff.create'; readonly name: string; readonly idempotencyKey: string }
  | { readonly type: 'staff.update'; readonly staffId: string; readonly name: string }
  | { readonly type: 'staff.delete'; readonly staffId: string; readonly cascadeSchedules: true; readonly idempotencyKey: string }
  | ({ readonly type: 'staff.saveSchedule'; readonly scheduleId?: string; readonly idempotencyKey?: string } & ScheduleFields)
  | { readonly type: 'staff.deleteSchedule'; readonly scheduleId: string; readonly idempotencyKey: string }
  | { readonly type: 'staff.moveHandoff'; readonly date: string; readonly fromTime: string; readonly toTime: string; readonly idempotencyKey: string };
