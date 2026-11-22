import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';

/** Contract errors: `{code, reason, field?, details?}` with the HTTP status the client rolls back on. */
export class GroupsError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly field?: string;
  readonly details?: object;
  constructor(status: number, reason: string, field?: string, details?: object) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.field = field;
    this.details = details;
  }
}

export const errorCode = (status: number) => status === 400 ? 'VALIDATION' : status === 401 ? 'UNAUTHENTICATED'
  : status === 403 ? 'STORE_FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'SERVICE_UNAVAILABLE';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function invalid(reason: string, field?: string): never {
  throw new GroupsError(400, reason, field);
}

export function uuid(value: unknown, field: string, reason = 'INVALID_REQUEST') {
  const lower = typeof value === 'string' ? value.toLowerCase() : value;
  if (!isUuid(lower)) invalid(reason, field);
  return lower;
}

export function object(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('INVALID_REQUEST');
  return value;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function date(value: unknown, field: string, reason = 'INVALID_DATE') {
  if (!validDate(value)) invalid(reason, field);
  return value;
}

export function addDays(day: string, days: number) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

export function limit(value: unknown, fallback = 50) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200) invalid('INVALID_LIMIT', 'limit');
  return Number(value);
}

/** Percent with one decimal place, or null without a denominator. */
export const percent = (part: number, whole: number) => whole > 0 ? Math.round(part / whole * 1000) / 10 : null;

export function money(value: string | number | bigint | null) {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new GroupsError(503, 'TOTAL_UNAVAILABLE');
  return amount;
}

export type Clock = { timezone: string; dayStart: string };
export type ReadScope = { db: PoolClient; storeId: string; actorId: string; at: Date; day: string; clock: Clock };

/** The store's business date for `at`: the civil date in its time zone, shifted back by the business-day start. */
export function businessDay(at: Date, { timezone, dayStart }: Clock) {
  const [hours, minutes] = dayStart.split(':').map(Number);
  const shifted = new Date(at.getTime() - (hours * 60 + minutes) * 60_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short' }).format(shifted);
}

export function clockOf(req: FastifyRequest): Clock {
  const timezone = req.headers['x-navis-store-timezone'];
  const dayStart = req.headers['x-navis-business-day-start'];
  const zone = typeof timezone === 'string' && timezone ? timezone : 'Asia/Seoul';
  const start = typeof dayStart === 'string' && dayStart ? dayStart : '00:00';
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$/.test(start)) invalid('INVALID_CLOCK');
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    invalid('INVALID_CLOCK');
  }
  return { timezone: zone, dayStart: start.slice(0, 5) };
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Gateway workload bearer plus the gateway-asserted owner of the addressed store. */
export function ownerGuard(gatewayToken: string) {
  const expected = digest(gatewayToken);
  return async (req: FastifyRequest<{ Params: { storeId: string } }>, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!bearer || !timingSafeEqual(expected, digest(bearer))) {
      return reply.code(401).send({ code: 'UNAUTHENTICATED', reason: 'UNAUTHENTICATED' });
    }
    const store = req.headers['x-navis-store-id'];
    if (!isUuid(store) || req.params.storeId !== store || !isUuid(req.headers['x-navis-user-id'])
      || req.headers['x-navis-store-role'] !== 'owner') {
      return reply.code(403).send({ code: 'STORE_FORBIDDEN', reason: 'STORE_FORBIDDEN' });
    }
  };
}

/** Run `call` inside a savepoint so a failing optional source leaves the read transaction usable. */
export async function optional<T>(db: PoolClient, call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  await db.query('SAVEPOINT r19_source');
  try {
    const value = await call();
    await db.query('RELEASE SAVEPOINT r19_source');
    return { ok: true, value };
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT r19_source');
    return { ok: false };
  }
}
