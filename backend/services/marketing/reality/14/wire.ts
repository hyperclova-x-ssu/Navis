import { createHash } from 'node:crypto';

const codes = { 400: 'VALIDATION', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'UNPROCESSABLE', 503: 'UNAVAILABLE' } as const;
export type Status = keyof typeof codes;

export class CouponError extends Error {
  readonly status: Status;
  readonly reason: string;
  readonly field?: string;
  readonly details?: object;

  constructor(status: Status, reason: string, field?: string, details?: object) {
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

export const invalid = (field: string, reason = 'INVALID_REQUEST') => new CouponError(400, reason, field);
export const missing = (reason: string, field?: string) => new CouponError(404, reason, field);
export const conflict = (reason: string, field?: string, details?: object) => new CouponError(409, reason, field, details);
export const unavailable = (reason: string, field?: string) => new CouponError(503, reason, field);

export const idempotencyKey = /^[A-Za-z0-9_:.~-]{1,160}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function object(value: unknown, allowed: readonly string[], field = 'body'): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(field);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(field === 'body' ? unknown : `${field}.${unknown}`);
  return value;
}

export function uuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw invalid(field);
  return value.toLowerCase();
}

export function integer(value: unknown, field: string, min = 0, max = 2_147_483_647, reason?: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(field, reason);
  return value;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], field: string, reason?: string): T {
  const found = allowed.find(item => item === value);
  if (!found) throw invalid(field, reason);
  return found;
}

export function text(value: unknown, field: string, max: number, reason = 'INVALID_TEXT'): string {
  if (typeof value !== 'string') throw invalid(field, reason);
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > max || trimmed.includes('\0')) throw invalid(field, reason);
  return trimmed;
}

export function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) throw invalid(field, 'INVALID_DATE');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalid(field, 'INVALID_DATE');
  return value;
}

export function checkRevision(value: unknown, actual: number) {
  if (integer(value, 'expectedRevision', 1) !== actual) throw conflict('STALE_REVISION', 'expectedRevision', { revision: actual });
}

export function confirmation(value: unknown) {
  if (value !== true) throw invalid('confirmed', 'EXTRA_CONFIRMATION_REQUIRED');
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Stable UUID for one revision of a business resource, used as the outbox aggregate for repeated changes. */
export function revisionAggregate(id: string, revision: number) {
  const hex = createHash('sha256').update(`${id}:${revision}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type StoreClock = { date: string; time: string; weekday: number; hour: number; minute: number; businessDate: string };

/** Store-local wall clock and business date (the gateway supplies timezone and day start). */
export function storeClock(at: Date, timezone: string, businessDayStart = '00:00'): StoreClock {
  const parts = (instant: Date) => {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      weekday: 'short', hourCycle: 'h23',
    }).formatToParts(instant);
    const get = (name: string) => formatted.find(part => part.type === name)!.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')),
      weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1 };
  };
  const local = parts(at);
  // Account sends `HH:MM:SS`; tests and older callers send `HH:MM`.
  const [startHour, startMinute] = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(businessDayStart)
    ? businessDayStart.split(':').slice(0, 2).map(Number) : [0, 0];
  const businessDate = parts(new Date(at.getTime() - (startHour * 60 + startMinute) * 60_000)).date;
  return { ...local, time: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`, businessDate };
}

export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function listing(query: unknown, extra: readonly string[] = []) {
  const input = object(query, ['limit', 'cursor', ...extra], 'query');
  const limit = input.limit === undefined ? 50 : typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit) ? Number(input.limit) : NaN;
  return { input, limit: integer(limit, 'limit', 1, 200), cursor: input.cursor === undefined ? null : uuid(input.cursor, 'cursor') };
}
