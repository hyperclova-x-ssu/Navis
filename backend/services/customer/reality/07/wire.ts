import { isRecord, isUuid } from '../../pos-client.ts';

export const categories = ['store-operations', 'purchasing', 'tax-admin'] as const;
export const sources = ['pickup', 'delivery', 'reservation', 'shift', 'deadline', 'direct'] as const;
export type Category = typeof categories[number];
export type CalendarSource = typeof sources[number];
export type Closure = { kind: 'regular' | 'temporary'; endDate: string };
export type Staff = { staffId: string; name: string; archivedAt: string | null; revision: number };
export type Shift = { scheduleId: string; staffId: string; date: string; kind: 'work' | 'off';
  start: string | null; end: string | null; breakMinutes: number; revision: number };
export type CalendarEvent = { eventId: string; kind: 'event' | 'todo'; categoryId: Category; title: string;
  date: string; time: string | null; memo: string | null; storeClosure: Closure | null; revision: number };

const codes = { 400: 'VALIDATION', 404: 'NOT_FOUND', 409: 'CONFLICT' } as const;
export class ScheduleError extends Error {
  readonly status: keyof typeof codes;
  readonly reason: string;
  readonly field?: string;
  readonly details?: object;

  constructor(status: keyof typeof codes, reason: string, field?: string, details?: object) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.field = field;
    this.details = details;
  }
  toJSON() {
    const { status, reason, field, details } = this;
    return { code: codes[status], reason, ...(field && { field }), ...(details && { details }) };
  }
}

export const invalid = (field: string, reason = 'INVALID_REQUEST') => new ScheduleError(400, reason, field);
export const missing = (field: string) => new ScheduleError(404, 'NOT_FOUND', field);
export const conflict = (reason: string, field?: string, details?: object) => new ScheduleError(409, reason, field, details);
export const idempotencyKey = /^[A-Za-z0-9_:.~-]{1,160}$/;

export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw invalid('body');
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(unknown);
  return value;
}

export function uuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw invalid(field);
  return value.toLowerCase();
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], field: string, reason?: string): T {
  const result = allowed.find(item => item === value);
  if (!result) throw invalid(field, reason);
  return result;
}

export function integer(value: unknown, field: string, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

export function checkRevision(value: unknown, actual: number) {
  if (integer(value, 'expectedRevision') !== actual) throw conflict('STALE_REVISION', 'expectedRevision', { revision: actual });
}

export function text(value: unknown, field: string, max: number, requiredReason?: string): string {
  if (typeof value !== 'string') throw invalid(field, requiredReason);
  const trimmed = value.trim();
  if (!trimmed && requiredReason) throw invalid(field, requiredReason);
  if ([...trimmed].length > max || trimmed.includes('\0')) throw invalid(field);
  return trimmed;
}

export function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) {
    throw invalid(field, 'INVALID_DATE');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field, 'INVALID_DATE');
  return value;
}

export function time(value: unknown, field: string, reason = 'INVALID_TIME'): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw invalid(field, reason);
  return value;
}

export const minutes = (value: string | null): number | null => value === null ? null : Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const displayTime = (value: number | null): string | null => value === null ? null
  : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const titleKey = (value: string) => value.normalize('NFC').toLowerCase().replace(/[\s·.,!?~\-_()[\]]+/g, '');

export function confirmation(value: unknown) {
  if (value !== true) throw invalid('confirmed', 'EXTRA_CONFIRMATION_REQUIRED');
}

export function storeTime(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (name: string) => parts.find(part => part.type === name)!.value;
  return { date: `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function period(input: Record<string, unknown>) {
  const start = input.startDate === undefined ? null : date(input.startDate, 'startDate');
  const end = input.endDate === undefined ? null : date(input.endDate, 'endDate');
  if (start && end && (end < start || Date.parse(end) - Date.parse(start) > 366 * 86_400_000)) {
    throw invalid('endDate', 'INVALID_DATE_RANGE');
  }
  return { start, end };
}

export function listing(input: Record<string, unknown>) {
  const limit = input.limit === undefined ? 100 : typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)
    ? Number(input.limit) : NaN;
  return { limit: integer(limit, 'limit', 1, 200), ...period(input) };
}
